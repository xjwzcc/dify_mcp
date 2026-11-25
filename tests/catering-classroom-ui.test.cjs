'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(require.resolve('../apps/catering/public/app.js'), 'utf8');
const response = body => ({ ok: true, json: async () => body });

function classroom(t, role, load) {
  const dom = new JSDOM('<div id="app"></div><div id="toast"></div>', {
    url: 'https://school.test/catering/' + role, runScripts: 'outside-only'
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  // jsdom has the open property but no dialog methods.
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const calls = [];
  const user = { id: 'S01', name: '测试账号', role };
  window.fetch = async path => {
    const url = new URL(path, window.location.origin);
    calls.push(url);
    return response({ user, ...load(url) });
  };
  window.eval(source);
  return { window, document: window.document, calls };
}

test('teacher navigation fetches only the requested page and opens submission detail on demand', async t => {
  const { document, calls } = classroom(t, 'teacher', url => {
    if (url.pathname.endsWith('/submission-detail')) return { id: 'T1_S01', name: '学生', title: '工单', content: '证据内容', evidence: { menu: [], orders: [] }, history: [] };
    const page = Number(url.searchParams.get('page'));
    const paging = { page, pages: 2, pageSize: 20, total: 21 };
    switch (url.searchParams.get('section')) {
      case 'overview': return { overview: { students: 21, classes: 1, active: 0, pending: 1, graded: 0 }, publishedTasks: 4 };
      case 'students': return { students: [], classes: [{ id: 'default', name: '默认教学班', count: 21 }], publishedTasks: 4, paging };
      case 'submissions': return { submissions: [{ id: 'T1_S01', name: '学生', title: '工单', status: '待批阅' }], paging };
      default: assert.fail(url.href);
    }
  });
  await nextTurn();
  assert.equal(calls[0].searchParams.get('section'), 'overview');
  document.querySelector('[data-id="学生数据面板"]').click();
  await nextTurn();
  assert.equal(calls.at(-1).searchParams.get('section'), 'students');
  document.querySelector('[data-act="page"][data-id="2"]').click();
  await nextTurn();
  assert.equal(calls.at(-1).searchParams.get('page'), '2');
  const classFilter = document.querySelector('[data-class-filter]');
  classFilter.value = 'default';
  classFilter.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
  await nextTurn();
  assert.equal(calls.at(-1).searchParams.get('page'), '1');
  assert.equal(calls.at(-1).searchParams.get('classId'), 'default');
  document.querySelector('[data-id="提交与批阅"]').click();
  await nextTurn();
  assert.equal(calls.at(-1).searchParams.get('section'), 'submissions');
  document.querySelector('[data-act="review"]').click();
  await nextTurn();
  assert.equal(calls.at(-1).pathname, '/catering/api/submission-detail');
  assert.equal(calls.at(-1).searchParams.get('id'), 'T1_S01');
  assert.match(document.querySelector('dialog[open]').textContent, /证据内容/);
});

test('student business navigation waits for the current iframe without refetching the parent snapshot', async t => {
  const { document, window, calls } = classroom(t, 'student', () => ({
    state: { menu: [], orders: [] }, submissions: [], tasks: [], messages: []
  }));
  await nextTurn();
  document.querySelector('[data-id="菜单与分类管理"]').click();
  await nextTurn();
  const frame = document.querySelector('#nativeFrame');
  assert.match(frame.src, /section=menu$/);
  assert.equal(calls.filter(url => url.pathname.endsWith('/snapshot')).length, 1);
  let flush;
  frame.contentWindow.postMessage = message => { flush = message.type; };
  document.querySelector('[data-id="后厨 KDS"]').click();
  assert.equal(flush, 'emenu-flush');
  assert.equal(document.querySelector('#nativeFrame'), frame);
  window.dispatchEvent(new window.MessageEvent('message', {
    origin: window.location.origin, source: frame.contentWindow, data: { type: 'emenu-flushed', ok: true }
  }));
  await nextTurn();
  assert.match(document.querySelector('#nativeFrame').src, /section=kds$/);
  assert.equal(calls.filter(url => url.pathname.endsWith('/snapshot')).length, 1);
});
