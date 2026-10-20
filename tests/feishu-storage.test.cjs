'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { openDatabase } = require('../storage/database.cjs');
const { FeishuJournal } = require('../storage/feishu.cjs');
const { createMock } = require('./helpers/feishu-mock.cjs');
test('checkpoint preserves deleted AUTOINCREMENT high-water marks', () => {
  const { DatabaseSync } = require('node:sqlite');
  const { snapshot, restoreSnapshot } = require('../storage/database.cjs');
  const source = new DatabaseSync(':memory:'), target = new DatabaseSync(':memory:');
  try {
    source.exec("CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,value TEXT); INSERT INTO events VALUES(100,'deleted'); DELETE FROM events");
    restoreSnapshot(target, snapshot(source));
    assert.equal(target.prepare("INSERT INTO events(value) VALUES('next')").run().lastInsertRowid, 101);
  } finally { source.close(); target.close(); }
});
async function fixture(t) {
  const mock = await createMock();
  t.after(() => mock.close());
  const storage = await openDatabase('catering', ':memory:', mock.env);
  storage.db.exec('CREATE TABLE records(id TEXT PRIMARY KEY,value TEXT)');
  await storage.ready();
  t.after(() => storage.db.close());
  return { mock, storage };
}
test('encrypted chunked commits survive throttle, lost acknowledgement and cold recovery', async t => {
  const { mock, storage } = await fixture(t);
  const journal = new FeishuJournal('catering', mock.env);
  await journal.restore();
  mock.fault.throttle = 1;
  mock.fault.lostHeadResponse = true;
  const session = storage.db.createSession();
  const random = require('node:crypto').randomBytes(80000).toString('base64');
  storage.db.prepare('INSERT INTO records VALUES(?,?)').run('S1', random);
  await journal.append('changeset', Buffer.from(session.changeset()).toString('base64'));
  session.close();
  const restored = await openDatabase('catering', ':memory:', mock.env);
  t.after(() => restored.db.close());
  assert.equal(restored.db.prepare('SELECT value FROM records WHERE id=?').get('S1').value, random);
  assert.equal(journal.head.seq, 2);
  assert.ok(mock.stats.creates > 5, 'payload was split across multiple records');
  assert.equal(mock.stats.auth, 3, 'each client cached its token');
  assert.equal(JSON.stringify([...mock.tables.get('table_catering').values()]).includes(random.slice(0, 100)), false);
});
test('wrong key, missing chunk and concurrent head replacement stop recovery/writes', async t => {
  const { mock } = await fixture(t);
  await assert.rejects(openDatabase('catering', ':memory:', { ...mock.env, FEISHU_STORAGE_KEY: 'cd'.repeat(32) }));
  const journal = new FeishuJournal('catering', mock.env); await journal.restore();
  const records = mock.tables.get('table_catering');
  const headRecord = records.get('head_catering');
  const original = JSON.parse(headRecord.fields.payload);
  headRecord.fields.payload = JSON.stringify({ ...original, seq: 99 });
  await assert.rejects(journal.append('changeset', ''), /Another writer/);
  headRecord.fields.payload = JSON.stringify(original);
  const manifest = JSON.parse(records.get(original.id).fields.payload);
  records.delete(manifest.chunks[0]);
  await assert.rejects(openDatabase('catering', ':memory:', mock.env), /Feishu API failed/);
});
test('failed write rolls back, returns 503, suppresses events and blocks stale reads', async t => {
  const { mock, storage } = await fixture(t);
  let notices = 0;
  const server = http.createServer(storage.wrap(async (req, res) => {
    if (req.method === 'POST') {
      storage.db.prepare('INSERT INTO records VALUES(?,?)').run('S1', 'not committed');
      storage.afterCommit(() => notices++);
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'must-not-escape=1' });
    res.end(JSON.stringify({ ok: true }));
  }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  mock.fault.failChunks = true;
  const response = await fetch(url, { method: 'POST' });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(storage.db.prepare('SELECT COUNT(*) n FROM records').get().n, 0);
  assert.equal(notices, 0);
  assert.equal((await fetch(url)).status, 503);
  mock.fault.failChunks = false;
  const restored = await openDatabase('catering', ':memory:', mock.env);
  t.after(() => restored.db.close());
  assert.equal(restored.db.prepare('SELECT COUNT(*) n FROM records').get().n, 0);
});
test('unconfirmed head publication never emits a success; restart recovers the actual committed state', async t => {
  const { mock, storage } = await fixture(t);
  const head = mock.tables.get('table_catering').get('head_catering');
  // Simulate a stale head read after a successful remote publication by intercepting the test client only.
  const journal = new FeishuJournal('catering', mock.env); await journal.restore();
  const originalRead = journal.readHead.bind(journal);
  let reads = 0;
  journal.readHead = async () => ++reads === 1 ? originalRead() : (() => { throw Error('read unavailable'); })();
  await assert.rejects(journal.append('snapshot', [{ name: 'records', sql: 'CREATE TABLE records(id TEXT PRIMARY KEY,value TEXT)',
    rows: [{ __storage_rowid: 1, id: 'S1', value: 'remote commit' }] }]), /could not be confirmed/);
  assert.equal(JSON.parse(head.fields.payload).seq, 2);
  const recovered = await openDatabase('catering', ':memory:', mock.env);
  t.after(() => recovered.db.close());
  assert.equal(recovered.db.prepare('SELECT value FROM records').get().value, 'remote commit');
  assert.equal(storage.db.prepare('SELECT COUNT(*) n FROM records').get().n, 0);
});
