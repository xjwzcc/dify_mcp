'use strict';
const app = document.querySelector('#app');
const params = new URLSearchParams(location.search);
const courses = { catering: ['餐饮信息系统', '菜单、点餐、后厨协作与经营复盘'], hotel: ['酒店人力资源系统', '招聘、排班、薪酬与人才培养'] };
const requestedCourse = Object.hasOwn(courses, params.get('course')) ? params.get('course') : null;
const role = 'teacher';
let session = null, busy = false, draft = {};
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function api(path, data) {
  let response;
  try { response = await fetch(path, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); }
  catch { throw Error('网络连接失败，请检查网络后重试'); }
  const value = await response.json();
  if (!response.ok) throw Object.assign(Error(value.error || '操作未完成，请重试'), { status: response.status });
  return value;
}
function notice(message, success = false) {
  const el = document.querySelector('#notice');
  if (!el) return;
  el.textContent = message; el.classList.toggle('success', success); el.hidden = !message;
}
function setBusy(value) {
  busy = value; app.setAttribute('aria-busy', String(value));
  app.querySelectorAll('button, input, select').forEach(el => { el.disabled = value || el.dataset.unavailable === 'true'; });
}
function field(label, name, extra = '', value = '') {
  return `<label for="${name}">${label}</label><input id="${name}" name="${name}" value="${esc(value)}" ${extra}>`;
}
function entry() {
  session = null;
  app.innerHTML = `<div class="entry-layout"><section class="intro"><span class="eyebrow">吴山苑 · 教师工作台</span><h1>专注课堂，<br>看见每一次成长。</h1><p>管理课堂，关注每一位学生。<br>请使用管理员为你创建的教师账号。</p><div class="course-note">餐饮服务 / 酒店管理<span>教学管理、任务评价与课堂反馈。</span></div></section>
    <section class="auth-card" aria-labelledby="form-title"><p class="eyebrow">教师专用入口</p>
    <h2 id="form-title">登录教师账号</h2><p class="subtitle">欢迎回来，继续你的教学工作。</p>
    <form id="auth-form">${field('教师账号', 'username', 'required maxlength="40" autocapitalize="none" spellcheck="false" autocomplete="username"', draft.username)}
    <label for="password">密码</label><div class="password-field"><input id="password" name="password" type="password" required maxlength="128" autocomplete="current-password"><button type="button" class="reveal" data-reveal="password" aria-label="显示密码" aria-pressed="false">显示</button></div>
    <p id="notice" role="alert" hidden></p><button class="primary full" type="submit">登录教师端 <span aria-hidden="true">→</span></button></form>
    <p class="mode-switch">教师账号由管理员统一创建。<br>如需开通或找回账号，请联系管理员。</p></section></div>`;
  app.setAttribute('aria-busy', 'false');
}
function dashboard() {
  const u = session.user;
  app.innerHTML = `<section class="welcome"><div><span class="eyebrow">教师端</span><h1>${esc(u.name)}，欢迎回来。</h1><p>选择课程，进入教学工作台。</p></div><button class="secondary" data-logout>退出登录</button></section><p id="notice" role="alert" hidden></p><div class="course-grid">${Object.entries(courses).map(([course, [title, description]], index) => `<section class="course-card"><span class="eyebrow">0${index + 1} / 教学管理</span><h2>${title}</h2><p>${description}</p><form data-enter="${course}"><button class="primary full" type="submit">进入教师端 <span aria-hidden="true">→</span></button></form></section>`).join('')}</div><p class="account-note">当前教师账号：${esc(u.username)}</p>`;
  app.setAttribute('aria-busy', 'false');
  if (u.canManageTeachers) {
    const link = document.createElement('a'); link.href = '/teacher/admin/'; link.className = 'secondary';
    link.textContent = '教师账号管理'; document.querySelector('.welcome').append(link);
  }
}
async function enterCourse(course, classId) {
  try {
    const result = await api('/teacher/api/enter', { course, ...(classId ? { classId } : {}) });
    location.assign(result.url);
  } catch (e) {
    if (e.status === 409) {
      const recovery = document.querySelector('#recover-' + course);
      if (recovery) { recovery.open = true; recovery.querySelector('input').focus(); }
    }
    throw e;
  }
}
async function signedIn(value) {
  if (value.user.role !== role) { entry(); notice('账号身份与当前入口不符，请使用对应地址登录'); return; }
  session = value; draft = {}; dashboard();
  if (params.get('next') === 'admin' && value.user.canManageTeachers) { location.assign('/teacher/admin/'); return; }
  if (requestedCourse) await enterCourse(requestedCourse);
}
app.addEventListener('click', async e => {
  const button = e.target.closest('button');
  if (!button || busy) return;
  if (button.dataset.reveal) {
    const input = document.getElementById(button.dataset.reveal), show = input.type === 'password';
    input.type = show ? 'text' : 'password'; button.textContent = show ? '隐藏' : '显示';
    button.setAttribute('aria-pressed', String(show)); button.setAttribute('aria-label', show ? '隐藏密码' : '显示密码'); return;
  }
  if (button.hasAttribute('data-logout')) {
    setBusy(true); notice('');
    try {
      if (button.hasAttribute('data-logout')) {
        try { await api('/teacher/api/logout', {}); } catch (err) { if (err.status !== 401) throw err; }
        entry();
      }
    } catch (err) { notice(err.message); }
    finally { setBusy(false); }
  }
});
app.addEventListener('submit', async e => {
  e.preventDefault(); if (busy) return;
  const form = e.target, values = Object.fromEntries(new FormData(form));
  setBusy(true); notice('');
  const submit = form.querySelector('[type="submit"]'), label = submit.textContent; submit.textContent = '正在处理…';
  try {
    if (form.id === 'auth-form') {
      const value = await api('/teacher/api/login', { ...values, role });
      form.reset(); await signedIn(value);
    } else if (form.dataset.enter) await enterCourse(form.dataset.enter, values.classId);

  } catch (err) {
    if (err.status === 401 && form.id !== 'auth-form') { entry(); notice('登录已过期，请重新登录'); }
    else notice(err.message);
  } finally { submit.textContent = label; setBusy(false); }
});
async function init() {
  try { await signedIn(await api('/teacher/api/session')); }
  catch (e) {
    if (session) notice(e.message);
    else { entry(); if (e.status !== 401) notice(e.message); }
  } finally { setBusy(false); }
}
init();
