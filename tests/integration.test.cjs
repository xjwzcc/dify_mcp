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
const base = 'http://127.0.0.1:19970';
async function start() {
  child = spawn(process.execPath, ['server.cjs'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'test', ENABLE_MCP: '0', DATA_DIR: data,
      PORT: '19970', CATERING_PORT: '19971', HOTEL_PORT: '19972', HOST: '127.0.0.1',
      TEACHER_PASSWORD: 'IntegrationTeacher2026!', CATERING_CLASS_CODE: 'TESTMENU',
      HOTEL_CLASS_CODE: 'TESTHOTEL', SQLITE_JOURNAL_MODE: 'DELETE', SECURE_COOKIE: '1' }
  });
  child.stdout.on('data', chunk => output += chunk);
  child.stderr.on('data', chunk => output += chunk);
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error(output);
    try { if ((await fetch(base + '/healthz')).ok) return; } catch {}
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
test('merged gateway, role separation and durable classroom workflows', { timeout: 45000 }, async t => {
  t.after(async () => { await stop(); fs.rmSync(data, { recursive: true, force: true }); });
  await start();
  let ct, cs, cb, ht, hs;
  await t.test('portal, role entries, assets, iframe and route isolation', async () => {
    assert.match((await call('/')).body, /吴山苑/);
    for (const route of ['/hotel/teacher', '/hotel/student', '/catering/teacher', '/catering/student',
      '/hotel/app.js', '/hotel/online.js', '/hotel/teaching.js', '/hotel/classroom.js', '/hotel/mobile.js', '/hotel/mobile.css',
      '/catering/app.js', '/catering/style.css', '/catering/customer.html', '/catering/native-bridge.js']) assert.equal((await call(route)).status, 200, route);
    assert.match((await call('/hotel/teacher')).body, /src="\/hotel\/online.js"/);
    assert.match((await call('/catering/student')).body, /src="\/catering\/app.js"/);
    assert.equal((await call('/api/session')).status, 404);
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
  await stop();
  for (const name of ['catering/emenu.sqlite', 'hotel/hotel.sqlite']) {
    const db = new DatabaseSync(path.join(data, name));
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    db.close();
  }
  await start();
  await t.test('persistent users, records and sessions after full process restart', async () => {
    const snapshot = (await call('/catering/api/snapshot', { cookie: cs.cookie })).body;
    assert.equal(snapshot.state.restaurant, '持久化测试餐厅');
    assert.equal(snapshot.submissions[0].score, 90);
    const hotel = (await call('/hotel/api/session', { cookie: hs.cookie })).body;
    assert.equal(hotel.student.state.employees[0].base, 5123);
    assert.equal((await call('/hotel/api/teacher', { cookie: ht.cookie })).body.students.length, 1);
    for (const [prefix, cookie] of [['catering', cs.cookie], ['hotel', hs.cookie]]) {
      const result = await call(`/${prefix}/api/logout`, { cookie, data: {} });
      assert.equal(result.status, 200);
      assert.match(result.headers.get('set-cookie'), new RegExp(`Path=/${prefix}/`));
      assert.equal((await call(`/${prefix}/api/${prefix === 'hotel' ? 'session' : 'snapshot'}`, { cookie })).status, 401);
    }
  });
});
