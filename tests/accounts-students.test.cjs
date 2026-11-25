'use strict';
/* 教师端学生账号管理：列表、同名重复识别所需字段、按学号二次确认删除。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { manage } = require('../scripts/manage-teachers.cjs');

test('教师可删除重复注册的学生统一账号，课程数据不受影响', { timeout: 60000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-students-'));
  const socket = process.platform === 'win32' ? '\\\\.\\pipe\\shixunlab-accounts-' + process.pid : path.join(dir, 'admin.sock');
  const env = { ...process.env, NODE_ENV: 'test', STORAGE_BACKEND: 'nas', DATA_DIR: dir, PORT: '19876', HOST: '127.0.0.1',
    ACCOUNTS_ADMIN_SOCKET: socket, CATERING_PORT: '19901', HOTEL_PORT: '19902', SECURE_COOKIE: '0', ENABLE_MCP: '0' };
  let child, output = '';
  child = spawn(process.execPath, ['apps/accounts/server.cjs'], { cwd: path.resolve(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', c => output += c); child.stderr.on('data', c => output += c);
  t.after(async () => { if (child.exitCode === null) { const end = once(child, 'exit'); child.kill('SIGTERM'); await end; } fs.rmSync(dir, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:19876';
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw Error(output);
    try { if ((await fetch(base + '/api/health')).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 60));
  }
  async function call(route, data, cookie) {
    const r = await fetch(base + route, { method: data === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: data === undefined ? undefined : JSON.stringify(data) });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null, cookie: r.headers.getSetCookie()[0]?.split(';')[0] };
  }
  const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r; };
  const password = 'StudentPass123!';
  const account = (username, name) => ({ username, name, password, confirmPassword: password });
  await manage({ action: 'create', username: 'TEACH1', name: '测试教师', password: 'TeacherPass123!' }, socket);
  const teacher = ok(await call('/teacher/api/login', { username: 'TEACH1', password: 'TeacherPass123!' }));
  for (const [username, name] of [['S001', '张三'], ['S002', '张三'], ['S003', '李四']])
    ok(await call('/student/api/register', account(username, name)));
  let list = ok(await call('/teacher/api/students', undefined, teacher.cookie));
  assert.equal(list.body.students.length, 3);
  assert.deepEqual(list.body.students.map(s => s.username).sort(), ['S001', 'S002', 'S003']);
  assert.equal(list.body.students.filter(s => s.name === '张三').length, 2);
  const student = ok(await call('/student/api/login', { username: 'S003', password }));
  // 学生 cookie 仅作用于 /student/，教师端接口对学生请求一律按未登录处理。
  assert.equal((await call('/teacher/api/students', undefined, student.cookie)).status, 401);
  assert.equal((await call('/teacher/api/students/delete', { username: 'S002', confirm: 'S02' }, teacher.cookie)).status, 400);
  assert.equal((await call('/teacher/api/students/delete', { username: 'S002', confirm: 'S001' }, teacher.cookie)).status, 400);
  const removed = ok(await call('/teacher/api/students/delete', { username: 'S002', confirm: 'S002' }, teacher.cookie));
  assert.equal(removed.body.ok, true);
  list = ok(await call('/teacher/api/students', undefined, teacher.cookie));
  assert.deepEqual(list.body.students.map(s => s.username).sort(), ['S001', 'S003']);
  assert.equal((await call('/student/api/login', { username: 'S002', password })).status, 401);
  assert.equal(ok(await call('/student/api/login', { username: 'S001', password })).body.user.name, '张三');
  assert.equal((await call('/teacher/api/students/delete', { username: 'S002', confirm: 'S002' }, teacher.cookie)).status, 404);
});
