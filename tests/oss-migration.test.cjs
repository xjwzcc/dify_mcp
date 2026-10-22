'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { initOss } = require('../scripts/init-oss.cjs');
const { exportOss } = require('../scripts/export-oss.cjs');
const { OssJournal } = require('../storage/oss.cjs');
const { snapshot } = require('../storage/database.cjs');
const { createMock } = require('./helpers/oss-mock.cjs');
async function fixture(t) {
  const mock = await createMock(); t.after(() => mock.close());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); fs.mkdirSync(source);
  const env = { ...mock.env, TEACHER_PASSWORD: 'TestTeacher!', CATERING_CLASS_CODE: 'TESTMENU', HOTEL_CLASS_CODE: 'TESTHOTEL' };
  fs.writeFileSync(path.join(source, 'bootstrap.json'), JSON.stringify({ teacherPassword: env.TEACHER_PASSWORD, cateringCode: env.CATERING_CLASS_CODE, hotelCode: env.HOTEL_CLASS_CODE }));
  for (const [namespace, filename] of [['catering', 'emenu.sqlite'], ['hotel', 'hotel.sqlite']]) {
    fs.mkdirSync(path.join(source, namespace));
    const db = new DatabaseSync(path.join(source, namespace, filename));
    db.exec("CREATE TABLE users(id TEXT PRIMARY KEY,value TEXT); INSERT INTO users VALUES('teacher','original hash'),('S1','student data'); CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT); INSERT INTO events VALUES(100); DELETE FROM events;");
    db.close();
  }
  return { root, source, env, mock };
}
test('offline import/export preserves both classrooms and AUTOINCREMENT state without overwriting source', async t => {
  const { root, source, env, mock } = await fixture(t);
  const sourceBytes = fs.readFileSync(path.join(source, 'hotel/hotel.sqlite'));
  await initOss({ source }, env);
  await initOss({ source }, env); // Safe resume of the exact same never-started import.
  assert.equal(mock.objects.size, 2);
  const target = path.join(root, 'export');
  await exportOss(target, env);
  assert.equal(mock.objects.size, 2, 'export is read-only');
  assert.ok(fs.existsSync(path.join(target, 'EXPORT_COMPLETE')));
  for (const file of ['catering/emenu.sqlite', 'hotel/hotel.sqlite']) {
    const db = new DatabaseSync(path.join(target, file));
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(db.prepare("SELECT value FROM users WHERE id='S1'").get().value, 'student data');
    assert.equal(db.prepare('INSERT INTO events DEFAULT VALUES').run().lastInsertRowid, 101); db.close();
  }
  assert.deepEqual(fs.readFileSync(path.join(source, 'hotel/hotel.sqlite')), sourceBytes);
  await assert.rejects(exportOss(target, env), /EEXIST/);
  await assert.rejects(initOss({ empty: true }, env), /different or active/);
});
test('preflight catches a missing second source and mismatched credentials before any cloud write', async t => {
  const { source, env, mock } = await fixture(t);
  await assert.rejects(initOss({ source }, { ...env, HOTEL_CLASS_CODE: 'CHANGED!' }), /must match/);
  fs.unlinkSync(path.join(source, 'hotel/hotel.sqlite'));
  await assert.rejects(initOss({ source }, env));
  assert.equal(mock.objects.size, 0);
});
test('partial two-app migration can resume but never replaces an active destination', async t => {
  const { source, env, mock } = await fixture(t);
  const db = new DatabaseSync(path.join(source, 'catering/emenu.sqlite'), { readOnly: true });
  const tables = snapshot(db); db.close();
  const journal = new OssJournal('catering', env); await journal.initialize(tables);
  await initOss({ source }, env); assert.equal(mock.objects.size, 2);
  await journal.restore(); await journal.append('snapshot', tables);
  await assert.rejects(initOss({ source }, env), /different or active/);
  assert.equal(mock.objects.size, 3);
});
