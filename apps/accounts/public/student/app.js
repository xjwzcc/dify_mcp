'use strict';
const app = document.querySelector('#app');
const params = new URLSearchParams(location.search);
const courses = { catering: ['餐饮信息系统', '菜单、点餐、后厨协作与经营复盘'], hotel: ['酒店人力资源系统', '招聘、排班、薪酬与人才培养'] };
const requestedCourse = Object.hasOwn(courses, params.get('course')) ? params.get('course') : null;
const role = 'student';
let mode = location.hash === '#register' ? 'register' : 'login';
let session = null, classes = [], classesError = '', busy = false, draft = {};
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const roleName = value => value === 'teacher' ? '教师' : '学生';
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
  const registering = mode === 'register';
  app.innerHTML = `<div class="entry-layout"><section class="intro"><span class="eyebrow">吴山苑 · 实训课堂</span><h1>准备好，<br>开始今天的实训。</h1><p>你的课程，你的实训进度。<br>注册一次，以后用账号和密码登录。</p><div class="intro-note"><span class="step">01</span><span>学生实训</span><i>—</i><span class="step">02</span><span>登录或注册</span></div><div class="course-note">餐饮服务 / 酒店管理<span>从业务操作，到教学反馈。</span></div></section>
    <section class="auth-card" aria-labelledby="form-title"><p class="eyebrow">学生实训入口</p>
    <h2 id="form-title">${registering ? '注册' : '登录'}${roleName(role)}账号</h2><p class="subtitle">${registering ? '填写以下信息，即可创建自己的账号。' : '欢迎回来，继续你的' + (role === 'teacher' ? '教学工作' : '实训进度') + '。'}</p>
    <form id="auth-form">${registering ? field('姓名', 'name', 'required maxlength="30" autocomplete="name"', draft.name) : ''}
    ${field('账号', 'username', 'required maxlength="40" autocapitalize="none" spellcheck="false" autocomplete="username"' + (registering ? ' minlength="3" pattern="[A-Za-z0-9_-]{3,40}" aria-describedby="username-hint"' : ''), draft.username)}
    ${registering ? '<p id="username-hint" class="hint">3–40 位字母、数字、下划线或连字符，可使用学号 / 工号。</p>' : ''}
    <label for="password">密码</label><div class="password-field"><input id="password" name="password" type="password" required maxlength="128" ${registering ? 'minlength="8" autocomplete="new-password" aria-describedby="password-hint"' : 'autocomplete="current-password"'}><button type="button" class="reveal" data-reveal="password" aria-label="显示密码" aria-pressed="false">显示</button></div>
    ${registering ? '<p id="password-hint" class="hint">至少 8 位，请记住注册时设置的密码。</p>' + field('确认密码', 'confirmPassword', 'type="password" required minlength="8" maxlength="128" autocomplete="new-password"') : ''}
    <p id="notice" role="alert" hidden></p><button class="primary full" type="submit">${registering ? '注册并进入' : '登录'}${roleName(role)}端 <span aria-hidden="true">→</span></button></form>
    <p class="mode-switch">${registering ? '已有账号？' : '还没有账号？'}<button type="button" class="text-button" data-mode="${registering ? 'login' : 'register'}">${registering ? '返回登录' : '立即注册'}</button></p></section></div>`;
  app.setAttribute('aria-busy', 'false');
}
function dashboard() {
  const u = session.user;
  app.innerHTML = `<section class="welcome"><div><span class="eyebrow">${roleName(u.role)}端</span><h1>${esc(u.name)}，欢迎回来。</h1><p>选择课程，${u.role === 'teacher' ? '进入教学工作台' : '开始今天的实训'}。</p></div><button class="secondary" data-logout>退出登录</button></section><p id="notice" role="alert" hidden></p><div class="course-grid">${Object.entries(courses).map(([course, [title, description]], index) => {
    const binding = session.bindings.find(b => b.course === course);
    const chooseClass = course === 'hotel' && !binding && u.role === 'student';
    return `<section class="course-card"><span class="eyebrow">0${index + 1} / ${course === 'hotel' ? '酒店管理' : '餐饮服务'}</span><h2>${title}</h2><p>${description}</p><form data-enter="${course}">${chooseClass ? (classesError ? `<p class="error">${esc(classesError)}</p><button type="button" class="text-button" data-retry>重新加载班级</button>` : `<label for="classId">教学班级</label><select id="classId" name="classId" required>${classes.length > 1 ? '<option value="">请选择你的班级</option>' : ''}${classes.map(c => `<option value="${esc(c.id)}" ${!c.entry || !c.enrollment ? 'disabled' : ''}>${esc(c.name)}${!c.entry || !c.enrollment ? '（暂未开放）' : ''}</option>`).join('')}</select>${classes.length === 0 ? '<p class="hint">暂无可加入的教学班，请联系教师。</p>' : ''}`) : ''}<button class="primary full" type="submit" ${chooseClass && (classesError || !classes.some(c => c.entry && c.enrollment)) ? 'disabled data-unavailable="true"' : ''}>进入${roleName(u.role)}端 <span aria-hidden="true">→</span></button></form>
    ${u.role === 'student' && !binding ? `<details id="recover-${course}"><summary>找回原课程记录</summary><p class="hint">仅以前使用过独立课程账号时需要。验证一次后，以后直接用当前账号登录。</p><form data-recover="${course}"><label for="old-${course}">原学号 / 账号</label><input id="old-${course}" name="localId" value="${esc(u.username)}" required maxlength="40" autocomplete="username"><label for="old-password-${course}">原课程密码</label><input id="old-password-${course}" name="password" type="password" required maxlength="128" autocomplete="current-password"><button class="secondary full" type="submit">找回并进入课程</button></form></details>` : ''}</section>`;
  }).join('')}</div><p class="account-note">当前账号：${esc(u.username)} · ${roleName(u.role)}<span>课程记录自动保存，下次登录后继续。</span></p>`;
  app.setAttribute('aria-busy', 'false');
}
async function loadClasses() {
  classes = []; classesError = '';
  if (session.user.role !== 'student' || session.bindings.some(b => b.course === 'hotel')) return;
  try { classes = (await api('/hotel/api/classes/public')).classes; }
  catch (e) { classesError = e.message; }
}
async function enterCourse(course, classId) {
  try {
    const result = await api('/student/api/enter', { course, ...(classId ? { classId } : {}) });
    location.assign(result.url);
  } catch (e) {
    if (e.status === 409) {
      const recovery = document.querySelector('#recover-' + course);
      if (recovery) { recovery.open = true; recovery.querySelector('input').focus(); }
    }
    throw e;
  }
}
async function signedIn(value, autoEnter = true) {
  if (value.user.role !== role) { entry(); notice('账号身份与当前入口不符，请使用对应地址登录'); return; }
  session = value; draft = {};
  await loadClasses(); dashboard();
  if (session.user.role !== role) { entry(); notice('账号身份与当前入口不符，请使用对应地址登录'); return; }
  if (!autoEnter || !requestedCourse) return;
  const bound = session.bindings.some(b => b.course === requestedCourse);
  if (requestedCourse !== 'hotel' || bound || role === 'teacher') return enterCourse(requestedCourse);
  if (!classesError && classes.length === 1 && classes[0].entry && classes[0].enrollment) return enterCourse('hotel', classes[0].id);
}
app.addEventListener('click', async e => {
  const button = e.target.closest('button');
  if (!button || busy) return;
  if (button.dataset.mode) {
    const form = document.querySelector('#auth-form');
    draft = { username: form.elements.username.value, name: form.elements.name?.value || draft.name };
    mode = button.dataset.mode === 'register' ? 'register' : 'login';
    history.replaceState(null, '', location.pathname + location.search + (mode === 'register' ? '#register' : ''));
    entry(); return;
  }
  if (button.dataset.reveal) {
    const input = document.getElementById(button.dataset.reveal), show = input.type === 'password';
    input.type = show ? 'text' : 'password'; button.textContent = show ? '隐藏' : '显示';
    button.setAttribute('aria-pressed', String(show)); button.setAttribute('aria-label', show ? '隐藏密码' : '显示密码'); return;
  }
  if (button.hasAttribute('data-logout') || button.hasAttribute('data-retry')) {
    setBusy(true); notice('');
    try {
      if (button.hasAttribute('data-logout')) {
        try { await api('/student/api/logout', {}); } catch (err) { if (err.status !== 401) throw err; }
        mode = 'login'; entry();
      }
      else { await loadClasses(); dashboard(); }
    } catch (err) { notice(err.message); }
    finally { setBusy(false); }
  }
});
app.addEventListener('submit', async e => {
  e.preventDefault(); if (busy) return;
  const form = e.target, values = Object.fromEntries(new FormData(form));
  if (form.id === 'auth-form' && mode === 'register' && values.password !== values.confirmPassword) { notice('两次输入的密码不一致，请重新确认'); form.elements.confirmPassword.focus(); return; }
  setBusy(true); notice('');
  const submit = form.querySelector('[type="submit"]'), label = submit.textContent; submit.textContent = '正在处理…';
  try {
    if (form.id === 'auth-form') {
      const value = await api('/student/api/' + mode, { ...values, role });
      form.reset(); await signedIn(value);
    } else if (form.dataset.enter) await enterCourse(form.dataset.enter, values.classId);
    else if (form.dataset.recover) {
      const course = form.dataset.recover;
      const value = await api('/student/api/bind', { ...values, course, mode: 'existing' });
      session.bindings = value.bindings; dashboard(); await enterCourse(course);
    }
  } catch (err) {
    if (err.status === 401 && form.id !== 'auth-form' && !form.dataset.recover) { mode = 'login'; entry(); notice('登录已过期，请重新登录'); }
    else notice(err.message);
  } finally { submit.textContent = label; setBusy(false); }
});
async function init() {
  try { await signedIn(await api('/student/api/session')); }
  catch (e) {
    if (session) notice(e.message);
    else { entry(); if (e.status !== 401) notice(e.message); }
  } finally { setBusy(false); }
}
init();
