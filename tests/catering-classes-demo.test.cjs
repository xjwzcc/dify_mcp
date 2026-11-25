'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const PORT = 19878;
const BASE = 'http://127.0.0.1:' + PORT;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catering-classes-'));
fs.writeFileSync(path.join(dir, 'login.json'), JSON.stringify({ teacherPassword: 'TestTeacher2026!', classCode: 'MENU2026' }));

let child;
function start() {
  child = spawn(process.execPath, [path.join(ROOT, 'apps/catering/server.cjs')], { env: { ...process.env, DATA_DIR: dir, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('error', reject);
    child.once('exit', code => reject(Error('server exit ' + code)));
  });
}
function stop() { return new Promise(resolve => { child.once('exit', resolve); child.kill(); }); }
async function call(route, body, cookie) {
  const r = await fetch(BASE + route, { method: body ? 'POST' : 'GET',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null), cookie: r.headers.get('set-cookie')?.split(';')[0] || '' };
}

test('班级归类、教学演示数据包与顾客支付方式', async t => {
  t.after(async () => { if (child && child.exitCode === null) await stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  await start();
  const teacher = await call('/catering/api/login', { role: 'teacher', password: 'TestTeacher2026!' });
  const student = await call('/catering/api/login', { id: 'S001', name: '张三', password: 'Student2026', classCode: 'MENU2026' });
  assert.equal(teacher.status, 200, JSON.stringify(teacher.data));
  assert.equal(student.status, 200, JSON.stringify(student.data));

  // 默认教学班存在，学生初始归入默认班
  let classes = await call('/catering/api/classes', undefined, teacher.cookie);
  assert.equal(classes.status, 200);
  assert.equal(classes.data.classes[0].id, 'default');
  let snapshot = await call('/catering/api/snapshot', undefined, teacher.cookie);
  assert.equal(snapshot.data.students[0].classId, 'default');

  // 新建班级并把学生归班
  const created = await call('/catering/api/classes', { name: '一班', note: '2026 级餐饮一班' }, teacher.cookie);
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const classId = created.data.class.id;
  const moved = await call('/catering/api/classes/move', { studentId: 'S001', classId }, teacher.cookie);
  assert.equal(moved.status, 200);
  snapshot = await call('/catering/api/snapshot', undefined, teacher.cookie);
  assert.equal(snapshot.data.students[0].classId, classId);
  assert.equal(snapshot.data.classes.find(c => c.id === classId).count, 1);

  // 学生无权管理班级；教师可读取教学演示数据包
  assert.equal((await call('/catering/api/classes', undefined, student.cookie)).status, 403);
  const demo = await call('/catering/api/teaching-demo', undefined, teacher.cookie);
  assert.equal(demo.status, 200);
  assert.equal(demo.data.demo, true);
  assert.equal(demo.data.state.original.orders.length, 30);
  assert.ok(demo.data.state.original.menu.length >= 14);
  assert.ok(demo.data.state.original.orders.some(o => o.payMethod === 'wx' && o.status === 'paid'));
  assert.equal((await call('/catering/api/teaching-demo', undefined, student.cookie)).status, 403);

  // 顾客扫码下单时选择支付方式，订单直达后厨并携带支付信息
  const code = await call('/catering/api/qr-code', {}, student.cookie);
  assert.equal(code.status, 200);
  const token = code.data.path.split('/').pop();
  const menu = (await call('/catering/api/qr/' + token, {})).data;
  const dish = menu.menu.find(d => !d.soldOut);
  const order = await call('/catering/api/qr/' + token + '/order', { table: 'A01', guests: 2, note: '少油', pay: 'wx', items: [{ id: dish.id, qty: 1 }] });
  assert.equal(order.status, 200, JSON.stringify(order.data));
  assert.equal(order.data.payMethod, 'wx');
  const status = await call('/catering/api/qr/' + token + '/status', { no: order.data.no });
  assert.equal(status.data.payMethod, 'wx');
  assert.equal(status.data.payName, '微信支付');
  assert.equal((await call('/catering/api/qr/' + token + '/order', { table: 'A01', guests: 2, pay: 'zzz', items: [{ id: dish.id, qty: 1 }] })).status, 400);

  snapshot = await call('/catering/api/snapshot', undefined, teacher.cookie);
  const me = (await call('/catering/api/student-view', { id: 'S001' }, teacher.cookie)).data;
  const placed = me.state.original.orders.find(o => o.no === order.data.no);
  assert.equal(placed.payMethod, 'wx');
  assert.equal(placed.payName, '微信支付');
  assert.ok(!snapshot.data.students.find(s => s.id === 'S001').state, '教师总览不应返回学生完整存档');

  // 归回默认班，学生数据不被删除
  assert.equal((await call('/catering/api/classes/move', { studentId: 'S001', classId: 'default' }, teacher.cookie)).status, 200);
  snapshot = await call('/catering/api/snapshot', undefined, teacher.cookie);
  const after = (await call('/catering/api/student-view', { id: 'S001' }, teacher.cookie)).data;
  assert.equal(snapshot.data.students[0].classId, 'default');
  assert.equal(after.state.original.menu.length, me.state.original.menu.length);
  assert.equal(snapshot.data.students[0].summary.menuCount, after.state.menu.length);

  await t.test('分页按班级过滤，工单证据只在详情返回', async () => {
    const db = new DatabaseSync(path.join(dir, 'emenu.sqlite'));
    try {
      const addStudent = db.prepare('INSERT INTO users(id,name,role,hash,state) VALUES(?,?,?,?,?)');
      const addSubmission = db.prepare('INSERT INTO submissions(id,record) VALUES(?,?)');
      const assign = db.prepare('INSERT INTO class_students(student_id,class_id) VALUES(?,?)');
      for (let i = 2; i <= 24; i++) {
        const studentId = 'S' + String(i).padStart(3, '0');
        const id = 'T1_' + studentId;
        const evidence = structuredClone(after.state);
        evidence.original.menu[0].img = 'fixture-photo';
        addStudent.run(studentId, '学生' + i, 'student', '', JSON.stringify(evidence));
        if (i > 21) assign.run(studentId, classId);
        const first = { id, studentId, evidence, history: [] };
        const second = { ...first, history: [first] };
        addSubmission.run(id, JSON.stringify({
          id, taskId: 'T1', studentId, name: '学生' + i, title: '工单',
          time: '2026-11-24T00:00:00Z', status: '待批阅', score: null, evidence, history: [first, second]
        }));
      }
    } finally { db.close(); }
    const route = '/catering/api/snapshot?view=classroom&section=';
    const read = async section => {
      const result = await call(route + section, undefined, teacher.cookie);
      assert.equal(result.status, 200, JSON.stringify(result.data));
      return result.data;
    };
    const initial = await read('overview');
    assert.equal(initial.overview.students, 24);
    assert.equal(initial.overview.pending, 23);
    assert.equal(initial.students, undefined);
    assert.equal(initial.submissions, undefined);

    const firstPage = await read('students');
    assert.equal(firstPage.students.length, 20);
    assert.equal(firstPage.students[0].id, 'S001');
    assert.ok(firstPage.students.every(row => row.summary && !Object.hasOwn(row, 'state')));
    assert.deepEqual((await read('students&classId=default&page=2')).students.map(row => row.id), ['S021']);
    assert.deepEqual((await read('students&classId=' + classId + '&page=99')).students.map(row => row.id), ['S022', 'S023', 'S024']);
    const classPage = await read('classes&classId=' + classId);
    assert.equal(classPage.paging.total, 3);
    assert.equal(classPage.classes.find(row => row.id === classId).orders, 3);
    assert.ok(classPage.students.every(row => !Object.hasOwn(row, 'summary')));
    const anotherOrder = await call('/catering/api/qr/' + token + '/order', {
      table: 'A01', pay: 'wx', items: [{ id: dish.id, qty: 1 }]
    });
    assert.equal(anotherOrder.status, 200);
    assert.equal((await read('students')).students[0].summary.orderCount, 2);
    assert.equal((await read('classes')).classes.find(row => row.id === 'default').orders, 22);

    const list = await read('submissions&page=2');
    assert.deepEqual(list.paging, { page: 2, pages: 2, pageSize: 20, total: 23 });
    assert.deepEqual(list.submissions.map(row => row.studentId), ['S022', 'S023', 'S024']);
    assert.ok(list.submissions.every(row => !Object.hasOwn(row, 'evidence') && !Object.hasOwn(row, 'history')));
    const detail = '/catering/api/submission-detail?id=T1_S024';
    assert.equal((await call(detail)).status, 401);
    assert.equal((await call(detail, undefined, student.cookie)).status, 404);
    const record = (await call(detail, undefined, teacher.cookie)).data;
    assert.equal(record.evidence.original.menu[0].img, 'fixture-photo');
    assert.equal(record.history.length, 2);
    assert.ok(record.history.every(revision => !Object.hasOwn(revision, 'history')));

    // The metadata is already cached. A submit, review and resubmit must all update it.
    const submit = { taskId: 'T1', content: '我已经核对菜单、订单和服务流程并整理了完整的模拟经营证据，提交教师审核。' };
    const review = { id: 'T1_S001', score: 90, feedback: '请进一步核对订单和菜单。' };
    const submitOnce = async () => assert.equal((await call('/catering/api/submit', submit, student.cookie)).status, 200);
    await submitOnce();
    for (let i = 0; i < 2; i++) {
      assert.equal((await call('/catering/api/review', { ...review, status: '退回修改' }, teacher.cookie)).status, 200);
      await submitOnce();
    }
    assert.equal((await call('/catering/api/review', { ...review, status: '已评价' }, teacher.cookie)).status, 200);
    const own = (await call('/catering/api/submission-detail?id=T1_S001', undefined, student.cookie)).data;
    assert.equal(own.score, 90);
    assert.equal(own.content, submit.content);
    assert.equal(own.evidence, undefined);
    assert.equal((await call('/catering/api/submission-detail?id=T1_S001', undefined, teacher.cookie)).data.history.length, 2);
    assert.equal((await read('overview')).overview.graded, 1);
    assert.deepEqual((await read('students')).students[0].submissionStats, { count: 1, graded: 1, totalScore: 90 });
  });
});
