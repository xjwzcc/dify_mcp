'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const root = path.resolve(__dirname, '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'teaching-integration-'));
let child, output = '';
const backend = process.env.TEST_STORAGE_BACKEND || 'nas';
let mock;
const base = 'http://127.0.0.1:19970';
async function start() {
  child = spawn(process.execPath, ['server.cjs'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, STORAGE_BACKEND: backend, ...mock?.env, NODE_ENV: 'test', ENABLE_MCP: '0', DATA_DIR: data,
      PORT: '19970', CATERING_PORT: '19971', HOTEL_PORT: '19972', HOST: '127.0.0.1',
      TEACHER_PASSWORD: 'IntegrationTeacher2026!', CATERING_CLASS_CODE: 'TESTMENU',
      HOTEL_CLASS_CODE: 'TESTHOTEL', SQLITE_JOURNAL_MODE: 'DELETE', SECURE_COOKIE: '1' }
  });
  child.stdout.on('data', chunk => output += chunk);
  child.stderr.on('data', chunk => output += chunk);
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error(output);
    let response;
    try { response = await fetch(base + '/healthz'); } catch {}
    if (response) {
      assert.equal(response.status, 200, 'gateway must not accept traffic before child services finish recovery');
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Startup timeout: ' + output);
}
async function stop() {
  if (child && child.exitCode === null) {
    const done = once(child, 'exit'); child.kill('SIGTERM'); await done;
  }
}
async function call(route, { data: body, cookie, method, origin } = {}) {
  const response = await fetch(base + route, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  return { status: response.status, body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text,
    cookie: response.headers.get('set-cookie')?.split(';')[0], headers: response.headers };
}
test('merged gateway, role separation and durable classroom workflows', { timeout: 120000 }, async t => {
  if (backend === 'feishu') mock = await require('./helpers/feishu-mock.cjs').createMock();
  if (backend === 'oss') {
    mock = await require('./helpers/oss-mock.cjs').createMock();
    const { initOss } = require('../scripts/init-oss.cjs');
    await initOss({ empty: true }, { ...mock.env, TEACHER_PASSWORD: 'IntegrationTeacher2026!', CATERING_CLASS_CODE: 'TESTMENU', HOTEL_CLASS_CODE: 'TESTHOTEL' });
    mock.fault.delayGets = 300;
  }
  t.after(async () => { await stop(); await mock?.close(); fs.rmSync(data, { recursive: true, force: true }); });
  await start();
  if (backend === 'oss') mock.fault.delayGets = 0;
  let ct, cs, cb, ht, hs;
  await t.test('portal, role entries, assets, iframe and route isolation', async () => {
    assert.match((await call('/')).body, /吴山苑/);
    for (const route of ['/hotel/teacher', '/hotel/student', '/catering/teacher', '/catering/student',
      '/hotel/app.js', '/hotel/online.js', '/hotel/teaching.js', '/hotel/classroom.js', '/hotel/mobile.js', '/hotel/mobile.css',
      '/catering/app.js', '/catering/style.css', '/catering/customer.html', '/catering/native-bridge.js']) assert.equal((await call(route)).status, 200, route);
    assert.match((await call('/hotel/teacher')).body, /src="\/hotel\/online.js"/);
    assert.match((await call('/catering/student')).body, /src="\/catering\/app.js"/);
    assert.equal((await call('/api/session')).status, 404);
    for (const prefix of ['catering', 'hotel'])
      assert.equal((await call(`/${prefix}/teacher`, { data: {} })).status, 405);
    assert.equal((await call('/catering/original.html')).status, 401);
    for (const route of ['/data/bootstrap.json', '/catering/data/login.json', '/hotel/data/config.json', '/apps/hotel/server.cjs'])
      assert.equal((await call(route)).status, 404, route);
  });
  await t.test('teacher/student login and scoped secure cookies', async () => {
    ct = await call('/catering/api/login', { data: { role: 'teacher', password: 'IntegrationTeacher2026!' } });
    ht = await call('/hotel/api/login', { data: { role: 'teacher', password: 'IntegrationTeacher2026!' } });
    cs = await call('/catering/api/login', { data: { id: 'S001', name: '集成测试甲', password: 'student123', classCode: 'TESTMENU' } });
    cb = await call('/catering/api/login', { data: { id: 'S002', name: '集成测试乙', password: 'student123', classCode: 'TESTMENU' } });
    hs = await call('/hotel/api/login', { data: { id: 'S001', name: '集成测试甲', password: 'student123', classCode: 'TESTHOTEL' } });
    for (const login of [ct, ht, cs, cb, hs]) {
      assert.equal(login.status, 200, JSON.stringify(login.body));
      assert.match(login.headers.get('set-cookie'), /HttpOnly/);
      assert.match(login.headers.get('set-cookie'), /; Secure/);
    }
    assert.match(ct.headers.get('set-cookie'), /Path=\/catering\//);
    assert.match(ht.headers.get('set-cookie'), /Path=\/hotel\//);
    assert.equal((await call('/catering/api/snapshot', { cookie: ht.cookie })).status, 401);
    assert.equal((await call('/hotel/api/session', { cookie: ct.cookie })).status, 401);
    assert.equal((await call('/catering/api/login', { data: { id: 'teacher', password: 'IntegrationTeacher2026!' } })).status, 400);
    assert.equal((await call('/catering/api/task', { cookie: cs.cookie, data: { title: '越权' } })).status, 403);
    assert.equal((await call('/hotel/api/teacher', { cookie: hs.cookie })).status, 403);
    assert.equal((await call('/catering/api/message', { cookie: cs.cookie, data: { content: '跨站请求测试' }, origin: 'https://other.example' })).status, 403);
    assert.equal((await call('/catering/api/logout', { cookie: cs.cookie })).status, 405);
  });
  await t.test('catering state, submission and teacher feedback survive restart', async () => {
    const state = (await call('/catering/api/snapshot', { cookie: cs.cookie })).body.state;
    state.restaurant = '持久化测试餐厅';
    assert.equal((await call('/catering/api/state', { cookie: cs.cookie, data: { state } })).status, 200);
    assert.equal((await call('/catering/api/state', { cookie: cs.cookie, data: { state } })).status, 409);
    assert.equal((await call('/catering/api/submit', { cookie: cs.cookie, data: {
      taskId: 'T1', content: '本次实训核对了菜单分类与定价，完成菜品信息整理并记录操作证据，后续进一步优化前厅与后厨的协作过程。'
    } })).status, 200);
    assert.equal((await call('/catering/api/review', { cookie: ct.cookie, data: {
      id: 'T1_S001', score: 90, feedback: '已完成本次集成验证', status: '已评价'
    } })).status, 200);
    const other = (await call('/catering/api/snapshot', { cookie: cb.cookie })).body;
    assert.equal(other.submissions.length, 0);
    assert.notEqual(other.state.restaurant, state.restaurant);
    assert.equal((await call('/catering/original.html', { cookie: cs.cookie })).status, 200);
    assert.equal((await call('/catering/native-bridge.js', { cookie: cs.cookie })).status, 200);
  });
  await t.test('hotel save and streaming teacher events through gateway', async () => {
    const state = hs.body.student.state;
    state.employees[0].base = 5123;
    assert.equal((await call('/hotel/api/state', { method: 'PUT', cookie: hs.cookie, data: {
      studentId: 'S001', version: 1, state, logs: []
    } })).status, 200);
    const events = await fetch(base + '/hotel/api/events', { headers: { Cookie: ht.cookie }, signal: AbortSignal.timeout(5000) });
    assert.match(events.headers.get('content-type'), /text\/event-stream/);
    const reader = events.body.getReader();
    assert.match(Buffer.from((await reader.read()).value).toString(), /connected/);
    assert.equal((await call('/hotel/api/assignments', { cookie: ht.cookie, data: { title: '合并系统专项测试课堂任务' } })).status, 200);
    assert.match(Buffer.from((await reader.read()).value).toString(), /assignments/);
    await reader.cancel();
  });
  if (backend !== 'nas') await t.test('ten classes and ten concurrent student saves with checkpoint recovery', async () => {
    for (let i = 1; i < 10; i++) {
      const c = { id: undefined, name: '试点班' + i, code: 'PILOTCLASS', stage: '实训',
        entry: true, enrollment: true, write: true, submit: true, score: true,
        modules: ['employees', 'recruit', 'schedule', 'payroll', 'performance', 'training', 'relations'] };
      assert.equal((await call('/hotel/api/classes', { cookie: ht.cookie, data: c })).status, 200);
    }
    const list = (await call('/hotel/api/classes', { cookie: ht.cookie })).body.classes;
    assert.equal(list.length, 10);
    const students = await Promise.all(list.map((c, i) => call('/hotel/api/login', { data: {
      id: 'PILOT' + i, name: '模拟学生' + i, password: 'student123', classId: c.id,
      classCode: c.id === 'default' ? 'TESTHOTEL' : 'PILOTCLASS'
    } })));
    for (const student of students) assert.equal(student.status, 200);
    const saved = await Promise.all(students.map((student, i) => {
      student.body.student.state.employees[0].base = 6000 + i;
      return call('/hotel/api/state', { method: 'PUT', cookie: student.cookie, data: {
        studentId: 'PILOT' + i, version: 1, state: student.body.student.state, logs: []
      } });
    }));
    for (const result of saved) assert.equal(result.status, 200);
    assert.ok((backend === 'oss' ? mock.stats.creates : mock.stats.heads) > 25, 'checkpoint interval crossed');
  });
  await stop();
  if (backend !== 'nas') await t.test('offline export retains both databases for the NAS backend', async () => {
    const exportDir = path.join(data, 'nas-export');
    const { exportRemote } = require('../scripts/export-feishu.cjs');
    const env = { ...mock.env, TEACHER_PASSWORD: 'IntegrationTeacher2026!', CATERING_CLASS_CODE: 'TESTMENU', HOTEL_CLASS_CODE: 'TESTHOTEL' };
    const heads = backend === 'oss' ? mock.stats.creates : mock.stats.heads;
    await exportRemote(exportDir, env);
    assert.equal(backend === 'oss' ? mock.stats.creates : mock.stats.heads, heads, 'export must never write to remote storage');
    for (const [namespace, file, student] of [['catering', 'emenu.sqlite', 'S001'], ['hotel', 'hotel.sqlite', 'PILOT9']]) {
      const db = new DatabaseSync(path.join(exportDir, namespace, file));
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.ok(db.prepare('SELECT id FROM users WHERE id=?').get(student));
      db.close();
    }
    assert.ok(fs.existsSync(path.join(exportDir, 'EXPORT_COMPLETE')));
    await assert.rejects(exportRemote(exportDir, env), /EEXIST/);
  });
  if (backend === 'nas') for (const name of ['catering/emenu.sqlite', 'hotel/hotel.sqlite']) {
    const db = new DatabaseSync(path.join(data, name));
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    db.close();
  }
  else fs.rmSync(data, { recursive: true, force: true }); // Full FC-local-disk loss, not just a process restart.
  await start();
  await t.test('persistent users, records and sessions after full process restart', async () => {
    const snapshot = (await call('/catering/api/snapshot', { cookie: cs.cookie })).body;
    assert.equal(snapshot.state.restaurant, '持久化测试餐厅');
    assert.equal(snapshot.submissions[0].score, 90);
    const hotel = (await call('/hotel/api/session', { cookie: hs.cookie })).body;
    assert.equal(hotel.student.state.employees[0].base, 5123);
    assert.equal((await call('/hotel/api/teacher', { cookie: ht.cookie })).body.students.length, backend !== 'nas' ? 11 : 1);
    if (backend !== 'nas') for (let i = 0; i < 10; i++) {
      const record = await call('/hotel/api/teacher/student?id=PILOT' + i, { cookie: ht.cookie });
      assert.equal(record.body.student.state.employees[0].base, 6000 + i);
    }
    for (const [prefix, cookie] of [['catering', cs.cookie], ['hotel', hs.cookie]]) {
      const result = await call(`/${prefix}/api/logout`, { cookie, data: {} });
      assert.equal(result.status, 200);
      assert.match(result.headers.get('set-cookie'), new RegExp(`Path=/${prefix}/`));
      assert.equal((await call(`/${prefix}/api/${prefix === 'hotel' ? 'session' : 'snapshot'}`, { cookie })).status, 401);
    }
  });
});
