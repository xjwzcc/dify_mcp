'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const PORT = 19872;
const BASE = 'http://127.0.0.1:' + PORT;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catering-qr-'));
fs.writeFileSync(path.join(dir, 'login.json'), JSON.stringify({ teacherPassword: 'TestTeacher2026!', classCode: 'MENU2026' }));

let child;
function start() {
  child = spawn(process.execPath, [path.join(ROOT, 'apps/catering/server.cjs')], {
    env: { ...process.env, DATA_DIR: dir, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('error', reject);
    child.once('exit', code => reject(Error('server exit ' + code)));
  });
}
function stop() {
  return new Promise(resolve => { child.once('exit', resolve); child.kill(); });
}
async function call(route, body, cookie, method) {
  const r = await fetch(BASE + route, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await r.json(); } catch { data = null; }
  return { status: r.status, data, cookie: r.headers.get('set-cookie')?.split(';')[0] || '' };
}

const existingOrder = {
  no: 'A01-001', table: 'A01', guests: 2, orderNote: '老订单，不应被改动',
  status: 'done', ts: 1700000000000, timeHM: '12:00',
  items: [{ name: '龙井虾仁（整份）', price: 88, qty: 1, mods: [], dishId: 'd1' }]
};
const initial = {
  version: 0, restaurant: '张三测试餐厅', logs: [],
  menu: [{ id: 'd1', name: '龙井虾仁', category: '热菜', price: 88, cost: 40, stock: 20, allergen: '虾', description: '测试菜品', on: true }],
  orders: [{ id: 'A01-001', table: 'A01', note: '老订单，不应被改动', status: '待结账', total: 88, payable: 88, time: '2023-11-15T04:00:00.000Z',
    items: [{ name: '龙井虾仁（整份）', price: 88, qty: 1, cost: 40, mods: [], dishId: 'd1' }] }],
  original: {
    restaurant: '张三测试餐厅', cats: ['热菜'], tables: ['A01', 'A02'], seq: 100, voucher: {}, open: true,
    menu: [{ id: 'd1', name: '龙井虾仁', cat: '热菜', price: 88, unit: '份', desc: '测试菜品', emoji: '🍤', specs: [{ n: '整份' }], specPrice: { '整份': 88 }, soldOut: false, img: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Q6wAAAABJRU5ErkJggg==' }],
    orders: [existingOrder]
  }
};

test('扫码点单直接进入学生后厨，教师可只读预览学生页面', async t => {
  t.after(async () => { if (child && child.exitCode === null) await stop(); });
  await start();
  assert.equal((await call('/catering/api/snapshot')).status, 401);

  const student = await call('/catering/api/login', { id: 'S001', name: '张三', password: 'Student2026', classCode: 'MENU2026' });
  const teacher = await call('/catering/api/login', { role: 'teacher', password: 'TestTeacher2026!' });
  assert.equal(student.status, 200, JSON.stringify(student.data));
  assert.equal(teacher.status, 200, JSON.stringify(teacher.data));

  const saved = await call('/catering/api/state', { state: initial }, student.cookie);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.version, 1);

  // 学生生成点单码：码由稳定密钥派生，写入后长期有效
  const code = await call('/catering/api/qr-code', {}, student.cookie);
  assert.equal(code.status, 200);
  assert.match(code.data.path, /^\/catering\/qr\/[A-Za-z0-9_-]{16,64}$/);
  const token = code.data.path.split('/').pop();

  // 顾客页面公开可访问，带正确的扫码脚本
  const page = await fetch(BASE + '/catering/qr/' + token);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /\/catering\/qr\.js/);
  assert.equal((await fetch(BASE + '/catering/qr/' + 'x'.repeat(22))).status, 404);

  // 菜单读取包含规格与营业状态
  const menu = await call('/catering/api/qr/' + token, {});
  assert.equal(menu.status, 200);
  assert.equal(menu.data.restaurant, '张三测试餐厅');
  assert.equal(menu.data.open, true);
  assert.deepEqual(menu.data.tables, ['A01', 'A02']);
  assert.equal(menu.data.menu[0].specs[0], '整份');
  assert.match(menu.data.menu[0].img, new RegExp('^/catering/api/qr/' + token + '/image\\?id=d1&v=[a-f0-9]{10}$'));
  const picture = await fetch(BASE + menu.data.menu[0].img);
  assert.equal(picture.status, 200);
  assert.equal(picture.headers.get('content-type'), 'image/png');
  assert.ok((await picture.arrayBuffer()).byteLength > 0);

  // 下单：服务端按菜单重新计价，订单直接追加到学生店铺
  const placed = await call('/catering/api/qr/' + token + '/order', {
    table: 'A02', guests: 3, note: '少油，忌葱', items: [{ id: 'd1', spec: '整份', qty: 2, mods: ['少油', '免葱'] }]
  });
  assert.equal(placed.status, 200, JSON.stringify(placed.data));
  assert.equal(placed.data.table, 'A02');
  assert.equal(placed.data.total, 176);
  assert.match(placed.data.no, /^A02-\d{3}$/);

  const after = await call('/catering/api/snapshot', null, student.cookie);
  const state = after.data.state;
  assert.equal(state.original.orders.length, 2);
  assert.deepEqual(state.original.orders[0], existingOrder, '历史订单必须保持原样');
  assert.equal(state.original.orders[1].no, placed.data.no);
  assert.equal(state.original.orders[1].status, 'new');
  assert.equal(state.original.orders[1].items[0].qty, 2);
  assert.equal(state.original.orders[1].orderNote, '少油，忌葱');
  assert.equal(state.restaurant, '张三测试餐厅');
  assert.deepEqual(state.original.menu, initial.original.menu, '菜单不能被改动');
  assert.equal(state.version, 2);
  assert.equal(state.original.seq, 102);
  assert.equal(state.orders.length, 2);

  // 学生业务页用轻量接口拉新订单，不重复下载整份菜单
  const delta = await call('/catering/api/qr-orders', {}, student.cookie);
  assert.equal(delta.status, 200);
  assert.equal(delta.data.version, 2);
  assert.equal(delta.data.seq, 102);
  assert.equal(delta.data.orders.length, 2);
  assert.equal((await call('/catering/api/qr-orders', {}, teacher.cookie)).status, 403);

  // 顾客可实时跟踪订单状态
  const status = await call('/catering/api/qr/' + token + '/status', { no: placed.data.no });
  assert.equal(status.status, 200);
  assert.equal(status.data.status, 'new');
  assert.equal(status.data.queue, 1);

  // 学生上报当前页面 → 教师端可见
  assert.equal((await call('/catering/api/presence', { page: '后厨 KDS', section: 'kds' }, student.cookie)).status, 200);
  const teacherSnap = await call('/catering/api/snapshot', null, teacher.cookie);
  const row = teacherSnap.data.students.find(s => s.id === 'S001');
  assert.equal(row.presence.page, '后厨 KDS');
  assert.equal(row.presence.section, 'kds');
  const detail = await call('/catering/api/student-view', { id: 'S001' }, teacher.cookie);
  assert.equal(detail.data.state.original.orders.length, 2);

  // 教师只读预览：教师可读，学生与匿名均被拒绝
  assert.equal((await call('/catering/api/student-view', { id: 'S001' }, teacher.cookie)).status, 200);
  assert.equal((await call('/catering/api/student-view', { id: 'S001' }, student.cookie)).status, 403);
  assert.equal((await call('/catering/view.html')).status, 403);
  assert.equal((await call('/catering/view.html', null, teacher.cookie)).status, 200);

  // 闭店后拒绝新单，且历史数据不变
  const closed = JSON.parse(JSON.stringify(state));
  closed.version = 2;
  closed.original.open = false;
  assert.equal((await call('/catering/api/state', { state: closed }, student.cookie)).status, 200);
  const rejected = await call('/catering/api/qr/' + token + '/order', { table: 'A01', items: [{ id: 'd1', qty: 1 }] });
  assert.equal(rejected.status, 409);
  assert.match(rejected.data.error, /暂停点单/);

  // 重启后订单仍在（数据落在学生存档里，不需要新增表或迁移）
  await stop();
  await start();
  const relogin = await call('/catering/api/login', { id: 'S001', name: '张三', password: 'Student2026', classCode: 'MENU2026' });
  assert.equal(relogin.status, 200);
  const restored = (await call('/catering/api/snapshot', null, relogin.cookie)).data.state;
  assert.equal(restored.original.orders.length, 2);
  assert.equal(restored.original.orders[1].no, placed.data.no);
  assert.equal(restored.original.orders[0].orderNote, '老订单，不应被改动');
});
