'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createMock } = require('./helpers/oss-mock.cjs');
const { backupEcs, restoreEcs, DATABASES, CONFIGS, PART_BYTES, seal, unseal, BackupClient } = require('../scripts/backup-ecs.cjs');

async function fixture(t) {
  const mock = await createMock(); t.after(() => mock.close());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecs-backup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'data'); fs.mkdirSync(source);
  const open = [];
  for (const name of DATABASES) {
    const file = path.join(source, name); fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE content(id TEXT PRIMARY KEY, value BLOB);');
    db.prepare('INSERT INTO content VALUES (?, ?)').run('student', 'saved classroom work'); open.push(db);
  }
  t.after(() => open.forEach(db => db.close()));
  for (const name of CONFIGS) fs.writeFileSync(path.join(source, name), JSON.stringify({ stableConfig: name }));
  fs.writeFileSync(path.join(source, 'EXPORT_COMPLETE'), 'ok');
  const env = { ...mock.env, DATA_DIR: source, OSS_BACKUP_WORK_DIR: path.join(root, 'work') };
  return { mock, root, source, env, open };
}
test('online WAL snapshots round-trip all three databases and configs, including multipart data', async t => {
  const f = await fixture(t);
  f.open[0].prepare('INSERT INTO content VALUES (?, ?)').run('large', Buffer.alloc(PART_BYTES + 100, 73));
  const before = f.open.map(db => db.prepare('SELECT count(*) AS n FROM content').get().n);
  const result = await backupEcs(f.env);
  assert.ok(result.manifestKey.endsWith('/manifest.bin'));
  assert.ok([...f.mock.objects.keys()].some(k => k.endsWith('/1.bin')));
  assert.ok([...f.mock.objects.values()].every(v => !v.includes(Buffer.from('saved classroom work'))));
  const dest = path.join(f.root, 'restored');
  await restoreEcs(result.manifestKey, dest, f.env);
  for (const [i, name] of DATABASES.entries()) {
    const db = new DatabaseSync(path.join(dest, name), { readOnly: true });
    assert.equal(db.prepare('SELECT count(*) AS n FROM content').get().n, before[i]);
    assert.equal(db.prepare("SELECT value FROM content WHERE id='student'").get().value, 'saved classroom work'); db.close();
    assert.equal(f.open[i].prepare('SELECT count(*) AS n FROM content').get().n, before[i]);
  }
  for (const name of CONFIGS) assert.deepEqual(fs.readFileSync(path.join(dest, name)), fs.readFileSync(path.join(f.source, name)));
  assert.ok(fs.existsSync(path.join(dest, 'EXPORT_COMPLETE')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.env.OSS_BACKUP_WORK_DIR, 'last-success.json'))).manifestKey, result.manifestKey);
  assert.ok(!fs.readdirSync(f.env.OSS_BACKUP_WORK_DIR).some(n => n.startsWith('snapshot-')));
  await assert.rejects(restoreEcs(result.manifestKey, f.source, f.env), /new directory/);
  const second = await backupEcs(f.env); assert.notEqual(second.manifestKey, result.manifestKey);
  assert.ok(f.mock.objects.has(result.manifestKey));
});
test('missing source, failed uploads and corrupted parts never produce a startable restore or success receipt', async t => {
  const f = await fixture(t);
  fs.unlinkSync(path.join(f.source, CONFIGS[0]));
  await assert.rejects(backupEcs(f.env)); assert.equal(f.mock.objects.size, 0);
  fs.writeFileSync(path.join(f.source, CONFIGS[0]), '{}');
  f.mock.fault.failPuts = true;
  await assert.rejects(backupEcs(f.env));
  assert.ok(!fs.existsSync(path.join(f.env.OSS_BACKUP_WORK_DIR, 'last-success.json')));
  assert.ok(![...f.mock.objects.keys()].some(k => k.endsWith('/manifest.bin')));
  f.mock.fault.failPuts = false; f.mock.fault.lostPutResponse = true;
  const result = await backupEcs(f.env);
  const part = [...f.mock.objects.keys()].find(k => !k.endsWith('/manifest.bin'));
  f.mock.objects.get(part)[30] ^= 1;
  const dest = path.join(f.root, 'corrupt');
  await assert.rejects(restoreEcs(result.manifestKey, dest, f.env));
  assert.ok(!fs.existsSync(path.join(dest, 'EXPORT_COMPLETE')));
});
test('encryption binds object paths, rejects wrong keys and restricts backup prefix', async t => {
  const key = Buffer.alloc(32, 1), raw = Buffer.from('private configuration');
  const encrypted = seal(raw, key, 'a');
  assert.deepEqual(unseal(encrypted, key, 'a'), raw);
  assert.throws(() => unseal(encrypted, key, 'b'));
  assert.throws(() => unseal(encrypted, Buffer.alloc(32, 2), 'a'));
  const f = await fixture(t);
  await assert.rejects(backupEcs({ ...f.env, OSS_BACKUP_PREFIX: 'teaching/v1/accounts/commits' }), /dedicated/);
  f.mock.fault.acl = 'public-read'; await assert.rejects(backupEcs(f.env), /private/);
});
test('insufficient disk refuses a new backup and preserves the last verified backup', async t => {
  const f = await fixture(t), result = await backupEcs(f.env);
  const receipt = fs.readFileSync(path.join(f.env.OSS_BACKUP_WORK_DIR, 'last-success.json'));
  const originalStatfs = fs.statfsSync;
  t.after(() => { fs.statfsSync = originalStatfs; });
  fs.statfsSync = () => ({ bavail: 1, bsize: 4096 });
  await assert.rejects(backupEcs(f.env), /Insufficient backup disk space/);
  assert.deepEqual(fs.readFileSync(path.join(f.env.OSS_BACKUP_WORK_DIR, 'last-success.json')), receipt);
  assert.ok(f.mock.objects.has(result.manifestKey));
});
test('ECS role credentials are cached, refreshable and invalid expiration is rejected', async t => {
  const f = await fixture(t), originalFetch = global.fetch; let calls = 0;
  t.after(() => { global.fetch = originalFetch; });
  let expiration = new Date(Date.now() + 3600000).toISOString();
  global.fetch = async (url, options) => {
    if (!String(url).startsWith('http://100.100.100.200/')) return originalFetch(url, options);
    calls++;
    if (String(url).endsWith('/api/token')) return new Response('metadata-token');
    assert.equal(options.headers['X-aliyun-ecs-metadata-token'], 'metadata-token');
    return Response.json({ Code: 'Success', AccessKeyId: 'mock-key', AccessKeySecret: 'mock-secret', SecurityToken: 'token', Expiration: expiration });
  };
  const client = new BackupClient({ ...f.env, OSS_ECS_ROLE: 'BackupRole' });
  await client.checkBucket(); assert.equal(calls, 2);
  await client.checkBucket(); assert.equal(calls, 2);
  client.expiration = 0; await client.checkBucket(); assert.equal(calls, 4);
  client.expiration = 0; expiration = 'invalid'; await assert.rejects(client.checkBucket(), /Invalid ECS role/);
});
