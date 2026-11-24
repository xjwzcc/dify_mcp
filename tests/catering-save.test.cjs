'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const seed = require('../apps/catering/native-seed.cjs');
const { businessState } = require('../apps/catering/business-state.cjs');

const html = readFileSync(require.resolve('../apps/catering/public/original.html'), 'utf8');
const bridge = readFileSync(require.resolve('../apps/catering/public/native-bridge.js'), 'utf8');

function response(status, data) {
  return { status, ok: status >= 200 && status < 300, json: async () => data };
}

function classroom(t, fetch, { page = 'original.html?section=menu', storageQuota = 1 } = {}) {
  const { window } = new JSDOM(html, {
    url: 'https://classroom.example/catering/' + page,
    runScripts: 'outside-only',
    storageQuota
  });
  t.after(() => window.close());
  // The bridge also talks to the realtime-ordering endpoints; answer them here so each
  // test's fetch mock only sees the save / snapshot traffic it is asserting on.
  const auxiliary = {
    '/catering/api/qr-code': { path: '/catering/qr/TESTTOKEN0000000000' },
    '/catering/api/presence': { ok: true },
    '/catering/api/qr-orders': { ok: true, version: 2, seq: 100, orders: [] }
  };
  window.fetch = async (url, options) => {
    const path = String(url).split('?')[0];
    if (Object.hasOwn(auxiliary, path)) return response(200, structuredClone(auxiliary[path]));
    return fetch(url, options);
  };
  window.eval(window.document.querySelector('script:not([src])').textContent);
  return window;
}

const snapshot = () => response(200, {
  user: { role: 'student', id: 'A', name: '学生甲' },
  state: { version: 2, original: seed(), menu: [], orders: [], logs: [] }
});

function editDish(window, name, id = 'd01') {
  window.openDishDlg(id);
  window.document.querySelector('#edName').value = name;
  window.saveDish();
}

function status(window) {
  return window.document.querySelector('[role="status"]').textContent;
}

test('the classroom keeps the local login hidden when the server session cannot load', async t => {
  const window = classroom(t, () => Promise.reject(Error('offline')));
  assert.equal(window.document.querySelector('#loginWrap').style.display, 'none');
  await window.eval(bridge);
  assert.match(status(window), /无法加载服务器存档/);
  assert.equal(window.document.querySelector('#loginWrap').style.display, 'none');
  assert.equal(window.document.querySelector('#appMain').style.display, 'none');
});

test('a rejected menu save preserves the draft and lets the student retry', async t => {
  const drafts = [];
  const alerts = [];
  const window = classroom(t, async (url, options) => {
    if (url === '/catering/api/snapshot?view=business') return snapshot();
    drafts.push(JSON.parse(options.body));
    return drafts.length === 1
      ? response(400, { error: '菜品价格、成本或库存无效' })
      : response(200, { version: 3, merged: false });
  });
  await window.eval(bridge);
  window.uiAlert = (...args) => alerts.push(args);
  editDish(window, '桂花糖藕改版');
  await nextTurn();
  assert.match(status(window), /保存未完成：菜品价格、成本或库存无效/);
  assert.deepEqual(alerts, []);
  assert.equal(window.S.menu[0].name, '桂花糖藕改版');
  assert.equal(window.S.menu.length, 5);
  window.dispatchEvent(new window.StorageEvent('storage', { key: window.lsKey() }));
  assert.equal(window.S.menu[0].name, '桂花糖藕改版');

  const retry = Array.from(window.document.querySelectorAll('button')).find(button => button.textContent === '重试保存');
  assert.equal(retry.parentElement.hidden, false);
  await retry.onclick();
  assert.match(status(window), /已保存到服务器/);
  assert.equal(retry.parentElement.hidden, true);
  assert.deepEqual(drafts.map(draft => [draft.studentId, draft.version, draft.changes.menu[0].after.name]), [
    ['A', 2, '桂花糖藕改版'],
    ['A', 2, '桂花糖藕改版']
  ]);
});

test('rapid edits send one latest change and a record conflict keeps the backup available', async t => {
  const drafts = [];
  let finishFirstSave;
  const messages = [];
  const window = classroom(t, async (url, options) => {
    if (url === '/catering/api/snapshot?view=business') return snapshot();
    drafts.push(JSON.parse(options.body));
    if (drafts.length === 1) return new Promise(resolve => { finishFirstSave = resolve; });
    return response(409, { error: '菜品已被其他同学修改' });
  });
  window.postMessage = message => messages.push(message);
  await window.eval(bridge);
  editDish(window, '第一次修改');
  await nextTurn();
  editDish(window, '第二次修改');
  editDish(window, '第三次修改');
  assert.equal(drafts.length, 1);
  finishFirstSave(response(200, { version: 3, merged: false }));
  await nextTurn();
  assert.deepEqual(drafts.map(draft => [draft.version, draft.changes.menu[0].after.name]), [
    [2, '第一次修改'],
    [3, '第三次修改']
  ]);

  window.dispatchEvent(new window.MessageEvent('message', {
    data: { type: 'emenu-flush' }, origin: window.location.origin, source: window
  }));
  await nextTurn();
  assert.equal(drafts.length, 2);
  assert.equal(messages.at(-1).ok, false);
  assert.match(messages.at(-1).message, /菜品已被其他同学修改/);
  const leave = new window.Event('beforeunload', { cancelable: true });
  assert.equal(window.dispatchEvent(leave), false);

  let backup;
  window.exportData = () => { backup = window.S.menu[0].name; };
  const button = Array.from(window.document.querySelectorAll('button')).find(button => button.textContent === '下载业务备份');
  assert.equal(button.parentElement.hidden, false);
  button.click();
  assert.equal(backup, '第三次修改');
});

test('two students sharing an account save different dishes and orders without sending untouched photos', async t => {
  const start = await snapshot().json();
  const photo = 'data:image/jpeg;base64,' + 'A'.repeat(200000);
  start.state.original.menu[2].img = photo;
  let state = start.state;
  const requests = [];
  const fetch = async (url, options) => {
    if (url === '/catering/api/snapshot?view=business') return response(200, structuredClone({ user: start.user, state }));
    assert.equal(url, '/catering/api/business-state');
    requests.push(options.body);
    try {
      const result = businessState(state, JSON.parse(options.body));
      state = result.state;
      return response(200, { version: state.version, merged: result.merged });
    } catch (error) {
      return response(error.status, { error: error.message });
    }
  };
  const a = classroom(t, fetch), b = classroom(t, fetch);
  await Promise.all([a.eval(bridge), b.eval(bridge)]);
  editDish(a, '学生甲的菜品', 'd01');
  editDish(b, '学生乙的菜品', 'd02');
  await nextTurn();
  assert.match(status(a), /已保存到服务器/);
  assert.match(status(b), /已保存到服务器/);
  assert.equal(state.original.menu[0].name, '学生甲的菜品');
  assert.equal(state.original.menu[1].name, '学生乙的菜品');
  assert.equal(state.original.menu[2].img, photo);
  assert.ok(requests.every(body => body.length < 4096));

  // Both pages started from the same legacy sequence and are ordering for the same table.
  for (const window of [a, b]) {
    window.cart.push({ dishId: 'd01', qty: 1, mods: [] });
    window.submitOrder();
  }
  await nextTurn();
  assert.equal(state.original.orders.length, 2);
  assert.equal(new Set(state.original.orders.map(order => order.no)).size, 2);
  assert.equal(state.original.seq, 102);
  assert.equal(state.orders.every(order => order.status === '待接单'), true);
  assert.ok(requests.every(body => body.length < 4096));

  b.S.menu = [];
  b.save(true);
  await nextTurn();
  assert.match(status(b), /无法覆盖整份业务数据/);
  assert.equal(state.original.menu.length, 5);
});

test('retry confirms a change already saved when the response was lost', async t => {
  const start = await snapshot().json();
  let state = start.state;
  let dropped = false;
  const window = classroom(t, async (url, options) => {
    if (url === '/catering/api/snapshot?view=business') return response(200, structuredClone(start));
    const result = businessState(state, JSON.parse(options.body));
    state = result.state;
    if (!dropped) { dropped = true; throw Error('response lost'); }
    return response(200, { version: state.version, merged: result.merged });
  });
  await window.eval(bridge);
  editDish(window, '首次修改');
  await nextTurn();
  assert.match(status(window), /无法连接服务器/);
  assert.equal(state.version, 3);
  editDish(window, '再次修改');
  await nextTurn();
  assert.match(status(window), /已保存到服务器/);
  assert.equal(state.version, 4);
  assert.equal(state.original.menu[0].name, '再次修改');
});

test('the QR guest page still opens and saves locally without a classroom account', async t => {
  const window = classroom(t, () => assert.fail('guest page requested a classroom session'), {
    page: 'customer.html?t=A01&u=A',
    storageQuota: 50000
  });
  await window.eval(bridge);
  assert.equal(window.isGuest, true);
  assert.equal(window.document.querySelector('#appMain').style.display, '');
  assert.equal(window.save(), true);
  assert.equal(JSON.parse(window.localStorage.getItem(window.lsKey())).menu.length, 5);
});

test('the catering API persists disjoint writes from two sessions and rejects a stale edit to the same dish', { timeout: 15000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'catering-shared-save-'));
  const port = 19985;
  const child = spawn(process.execPath, [require.resolve('../apps/catering/server.cjs')], {
    env: { ...process.env, STORAGE_BACKEND: 'nas', DATA_DIR: directory, HOST: '127.0.0.1', PORT: String(port),
      UNIFIED_ACCOUNTS: '0', SECURE_COOKIE: '0', CLASS_CODE: 'SHARED2026', TEACHER_PASSWORD: 'SharedSaveTest2026!' }
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit');
      child.kill();
      await stopped;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  await Promise.race([
    once(child.stdout, 'data'),
    once(child, 'exit').then(([code]) => { throw Error('Catering server exited (' + code + '): ' + stderr); })
  ]);

  async function request(route, cookie, body) {
    const reply = await fetch('http://127.0.0.1:' + port + '/catering/api/' + route, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }) },
      body: body && JSON.stringify(body)
    });
    return { ...await reply.json(), status: reply.status, cookie: reply.headers.get('set-cookie')?.split(';')[0] };
  }

  const credentials = { id: 'TEAM1', name: '课堂小组', password: 'TeamPassword2026', classCode: 'SHARED2026' };
  const a = await request('login', null, credentials);
  const b = await request('login', null, credentials);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.notEqual(a.cookie, b.cookie);
  const start = (await request('snapshot?view=business', a.cookie)).state;
  const edit = (index, name) => {
    const before = start.original.menu[index];
    return { studentId: credentials.id, version: start.version,
      changes: { menu: [{ id: before.id, before, after: { ...before, name } }], orders: [], cats: [], tables: [] } };
  };
  const result = await Promise.all([
    request('business-state', a.cookie, edit(0, '甲完成的菜品')),
    request('business-state', b.cookie, edit(1, '乙完成的菜品'))
  ]);
  assert.deepEqual(result.map(reply => reply.status), [200, 200]);
  assert.deepEqual(result.map(reply => reply.merged).sort(), [false, true]);
  assert.equal((await request('business-state', b.cookie, edit(0, '过时覆盖'))).status, 409);
  assert.equal((await request('business-state', b.cookie, { ...edit(0, '跨账号'), studentId: 'OTHER' })).status, 403);
  const saved = (await request('snapshot?view=business', a.cookie)).state;
  assert.deepEqual(saved.original.menu.slice(0, 2).map(dish => dish.name), ['甲完成的菜品', '乙完成的菜品']);
  assert.deepEqual(saved.menu.slice(0, 2).map(dish => dish.name), ['甲完成的菜品', '乙完成的菜品']);
  assert.equal(saved.version, start.version + 2);
});
