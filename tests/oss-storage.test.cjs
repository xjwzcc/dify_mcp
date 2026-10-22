'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { OssJournal, OssClient, signV4, sha256 } = require('../storage/oss.cjs');
const { openDatabase } = require('../storage/database.cjs');
const { createMock } = require('./helpers/oss-mock.cjs');
async function fixture(t) {
  const mock = await createMock(); t.after(() => mock.close());
  const journal = new OssJournal('catering', mock.env); await journal.initialize();
  const storage = await openDatabase('catering', ':memory:', mock.env);
  storage.db.exec('CREATE TABLE records(id TEXT PRIMARY KEY,value TEXT)'); await storage.ready();
  t.after(() => storage.db.close());
  await journal.restore();
  return { mock, journal, storage };
}
test('V4 signer matches the official canonical hash and independently computed HMAC vector', () => {
  // https://help.aliyun.com/zh/oss/developer-reference/recommend-to-use-signature-version-4
  const signed = signV4({ method: 'PUT', bucket: 'examplebucket', key: 'exampleobject', region: 'cn-hangzhou',
    accessKeyId: 'example', accessKeySecret: 'yourAccessKeySecret', additional: ['content-disposition', 'content-length'], headers: {
      'content-disposition': 'attachment', 'content-length': '3', 'content-md5': 'ICy5YqxZB1uWSwcVLSNLcA==',
      'content-type': 'text/plain', 'x-oss-content-sha256': 'UNSIGNED-PAYLOAD', 'x-oss-date': '20250411T064124Z'
    } });
  assert.equal(sha256(signed.canonical), 'c46d96390bdbc2d739ac9363293ae9d710b14e48081fcb22cd8ad54b63136eca');
  // The docs redact the real secret: their displayed SigningKey/Signature do not use
  // the literal "yourAccessKeySecret". This vector was computed independently with Python hmac.
  assert.ok(signed.authorization.endsWith('Signature=d3694c2dfc5371ee6acd35e88c4871ac95a7ba01d3a2f476768fe61218590097'));
});
test('only official matching endpoints are permitted outside loopback tests', () => {
  const env = { OSS_BUCKET: 'forcc', OSS_REGION: 'cn-shanghai' };
  assert.equal(new OssClient(env).base, 'https://forcc.oss-cn-shanghai.aliyuncs.com');
  for (const endpoint of ['https://evil.example', 'https://oss-cn-hangzhou.aliyuncs.com', 'http://oss-cn-shanghai.aliyuncs.com', 'https://oss-cn-shanghai.aliyuncs.com/a'])
    assert.throws(() => new OssClient({ ...env, OSS_ENDPOINT: endpoint }));
  assert.throws(() => new OssClient({ ...env, FC_REGION: 'cn-hangzhou', OSS_ENDPOINT: 'https://oss-cn-shanghai-internal.aliyuncs.com' }), /Cross-region/);
});
test('uninitialized namespaces, public ACL and enabled/suspended versioning fail closed', async t => {
  const mock = await createMock(); t.after(() => mock.close());
  await assert.rejects(openDatabase('hotel', ':memory:', mock.env), /not initialized/);
  for (const versioning of ['Enabled', 'Suspended']) {
    mock.fault.versioning = versioning;
    await assert.rejects(new OssJournal('hotel', mock.env).initialize(), /never enabled/);
  }
  mock.fault.versioning = ''; mock.fault.acl = 'public-read';
  await assert.rejects(new OssJournal('hotel', mock.env).initialize(), /private/);
  assert.equal(mock.objects.size, 0);
});
test('encrypted changes, throttling and lost PUT acknowledgement survive cold recovery', async t => {
  const { mock, journal, storage } = await fixture(t);
  mock.fault.throttle = 1; mock.fault.lostPutResponse = true;
  const session = storage.db.createSession();
  storage.db.exec("INSERT INTO records VALUES('S1','saved classroom state')");
  await journal.append('changeset', Buffer.from(session.changeset()).toString('base64')); session.close();
  const restored = await openDatabase('catering', ':memory:', mock.env); t.after(() => restored.db.close());
  assert.equal(restored.db.prepare('SELECT value FROM records').get().value, 'saved classroom state');
  assert.ok([...mock.objects.values()].every(bytes => !bytes.includes('saved classroom state')));
});
test('concurrent sequence claims cannot overwrite the winning commit', async t => {
  const { mock, journal } = await fixture(t);
  const second = new OssJournal('catering', mock.env); await second.restore();
  const outcomes = await Promise.allSettled([
    journal.append('snapshot', [{ name: 'one', sql: 'CREATE TABLE one(id TEXT PRIMARY KEY)', rows: [] }]),
    second.append('snapshot', [{ name: 'two', sql: 'CREATE TABLE two(id TEXT PRIMARY KEY)', rows: [] }])
  ]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(outcomes.find(r => r.status === 'rejected').reason.message, /Another OSS writer/);
  assert.equal(mock.objects.size, 3);
  const restored = await openDatabase('catering', ':memory:', mock.env); restored.db.close();
});
test('wrong encryption key, corrupt object and sequence gap stop recovery', async t => {
  const { mock, journal } = await fixture(t);
  await assert.rejects(openDatabase('catering', ':memory:', { ...mock.env, OSS_STORAGE_KEY: 'cd'.repeat(32) }));
  const key = journal.objectKey(2), original = mock.objects.get(key);
  mock.objects.set(key, Buffer.from('corrupt'));
  await assert.rejects(openDatabase('catering', ':memory:', mock.env), /commit size/);
  mock.objects.set(key, original); mock.objects.delete(journal.objectKey(1));
  await assert.rejects(openDatabase('catering', ':memory:', mock.env), /gap/);
});
test('pagination and periodic snapshots bound recovery replay', async t => {
  const { mock, journal } = await fixture(t);
  for (let i = 0; i < 52; i++) await journal.append('snapshot', [{ name: 'records', sql: 'CREATE TABLE records(id TEXT PRIMARY KEY,value TEXT)', rows: [{ __storage_rowid: 1, id: 'last', value: String(i) }] }]);
  mock.fault.pageSize = 7;
  const before = mock.stats.gets, restored = await openDatabase('catering', ':memory:', mock.env);
  assert.equal(restored.db.prepare('SELECT value FROM records').get().value, '51');
  assert.equal(mock.stats.gets - before, 1);
  assert.ok(mock.stats.lists > 7); restored.db.close();
});
test('unconfirmed writes roll back, suppress cookies/events and block stale reads', async t => {
  const { mock, storage } = await fixture(t);
  let events = 0;
  const server = http.createServer(storage.wrap(async (req, res) => {
    if (req.method === 'POST') {
      storage.db.exec("INSERT INTO records VALUES('S1','pending')"); storage.afterCommit(() => events++);
    }
    res.writeHead(200, { 'Set-Cookie': 'must-not-escape=1' }); res.end('ok');
  }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  mock.fault.failPuts = true;
  const result = await fetch(url, { method: 'POST' });
  assert.equal(result.status, 503); assert.equal(result.headers.get('set-cookie'), null);
  assert.equal(events, 0); assert.equal(storage.db.prepare('SELECT COUNT(*) n FROM records').get().n, 0);
  assert.equal((await fetch(url)).status, 503);
});
test('lost acknowledgement with failed reconciliation is recovered from actual durable state', async t => {
  const { mock, journal } = await fixture(t);
  mock.fault.lostPutResponse = true; mock.fault.failGets = true;
  await assert.rejects(journal.append('snapshot', [{ name: 'records', sql: 'CREATE TABLE records(id TEXT PRIMARY KEY,value TEXT)', rows: [{ __storage_rowid: 1, id: 'S1', value: 'durable' }] }]));
  mock.fault.failGets = false;
  const restored = await openDatabase('catering', ':memory:', mock.env);
  assert.equal(restored.db.prepare('SELECT value FROM records').get().value, 'durable'); restored.db.close();
});
