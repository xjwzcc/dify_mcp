'use strict';
const app = document.querySelector('#admin-app');
const endpoint = '/teacher/api/admin/teachers';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let teachers = [], busy = false, edit = null;
async function api(path, data) {
  let response;
  try { response = await fetch(path, data === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}); }
  catch { throw Error('网络连接失败，请检查网络；如刚刚创建账号，请刷新列表确认结果。'); }
  const value = await response.json();
  if (!response.ok) throw Object.assign(Error(value.error || '操作未完成'), {status:response.status});
  return value;
}
function setBusy(value) {
  busy = value; app.setAttribute('aria-busy', String(value));
  app.querySelectorAll('button,input').forEach(el => el.disabled = value);
}
function notice(message, success = false) {
  const el = document.querySelector('#notice'); if (!el) return;
  el.textContent = message; el.hidden = !message; el.classList.toggle('success', success);
}
function denied(message) {
  teachers = []; edit = null;
  app.innerHTML = `<section class="admin-message"><h1>教师账号管理</h1><p role="alert">${esc(message)}</p><a class="secondary" href="/teacher/?next=admin">返回教师登录</a></section>`;
}
function handleError(e) {
  if (e.status === 401 || e.status === 403) denied(e.message);
  else notice(e.message);
}
function renderRows() {
  const q = document.querySelector('#search').value.trim().toLowerCase();
  const filtered = teachers.filter(t => (t.username + ' ' + t.name).toLowerCase().includes(q));
  document.querySelector('#count').textContent = `共 ${teachers.length} 个教师账号 · ${teachers.filter(t=>t.approved).length} 个已启用`;
  document.querySelector('#teacher-list').innerHTML = filtered.length ? filtered.map(t => `<section class="teacher-row" aria-label="${esc(t.username)}"><div class="teacher-info"><h2>${esc(t.name)}</h2><p>${esc(t.username)}</p></div><div class="row-actions"><span class="badge ${t.approved?'':'off'}">${t.canManageTeachers?'管理员':t.approved?'已启用':'未启用'}</span>${t.canManageTeachers?'<span class="hint">当前管理员 · 受保护</span>':`<button class="secondary" data-action="update" data-user="${esc(t.username)}">修改姓名</button><button class="secondary" data-action="reset-password" data-user="${esc(t.username)}">重置密码</button><button class="${t.approved?'danger':'secondary'}" data-action="${t.approved?'disable':'enable'}" data-user="${esc(t.username)}">${t.approved?'停用':'启用'}</button>`}</div></section>`).join('') : '<p class="empty">没有找到匹配的教师账号。</p>';
}
function render() {
  app.innerHTML = `<section class="admin-heading"><div><span class="eyebrow">管理员 · teacher_admin</span><h1>教师账号管理</h1><p>为老师开通账号，统一管理登录权限。</p></div><button class="primary" data-action="create">创建教师账号</button></section><p id="notice" role="alert" hidden></p><section id="credentials" class="credentials" aria-live="polite" hidden></section><section id="editor" class="editor" hidden></section><div class="toolbar"><label for="search">搜索教师<input id="search" type="search" placeholder="输入姓名或账号" autocomplete="off"></label><p id="count"></p><button class="secondary" data-refresh>刷新列表</button></div><div id="teacher-list" class="teacher-list"></div><p class="hint">仅 teacher_admin 可以管理账号。停用后不能登录，教学数据保留；新建教师拥有现有教学管理权限。</p>`;
  renderRows();
}
function closeEditor() {
  const previous = edit; edit = null; const el = document.querySelector('#editor'); el.hidden = true; el.innerHTML = '';
  const button = [...app.querySelectorAll('[data-action]')].find(b=>b.dataset.action===previous?.action && (b.dataset.user||'')===(previous?.username||''));
  button?.focus();
}
function openEditor(action, username) {
  const teacher = teachers.find(t=>t.username===username);
  if (action !== 'create' && (!teacher || teacher.canManageTeachers)) return;
  edit = {action,username}; notice('');
  const titles = {create:'创建教师账号',update:'修改姓名',disable:'停用教师账号',enable:'启用教师账号','reset-password':'重置教师密码'};
  const descriptions = {create:'填写账号和姓名。系统将生成随机密码，创建成功后请保存并私下交付给老师。',update:'修改教师登录首页显示的姓名，账号和教学存档保持不变。',disable:'停用后将退出该教师当前的所有登录，禁止继续登录，保留教学数据。',enable:'请先确认此账号属于教师。启用后可使用原密码登录教师端。','reset-password':'将生成新密码，并退出该教师当前的所有登录。原密码立即失效；停用状态不会自动解除。'};
  const el = document.querySelector('#editor'); el.hidden = false;
  el.innerHTML = `<h2 tabindex="-1">${titles[action]}</h2><p>${descriptions[action]}</p><form id="manage-form">${action==='create'?'<label for="new-username">教师账号</label><input id="new-username" name="username" required pattern="[A-Za-z0-9_-]{3,40}" maxlength="40" autocomplete="off" autocapitalize="none" spellcheck="false"><p class="hint">3–40 位字母、数字、下划线或连字符；创建后账号不可修改。</p>':`<p>操作账号：<strong>${esc(username)}</strong>（${esc(teacher.name)}）</p>`}${['create','update'].includes(action)?`<label for="teacher-name">姓名</label><input id="teacher-name" name="name" value="${esc(teacher?.name||'')}" required maxlength="30" autocomplete="off">`:''}<div class="form-actions"><button type="submit" class="${action==='disable'?'danger':'primary'}">${action==='create'?'创建账号':action==='update'?'保存姓名':'确认'+(action==='disable'?'停用':action==='enable'?'启用':'重置密码')}</button><button type="button" class="secondary" data-cancel>取消</button></div></form>`;
  (el.querySelector('input') || el.querySelector('h2')).focus();
}
async function refresh() { teachers = (await api(endpoint)).teachers; renderRows(); }
function showPassword(result) {
  const el = document.querySelector('#credentials'); el.hidden = false;
  el.innerHTML = `<h2>请保存登录信息</h2><p>账号：<strong>${esc(result.user.username)}</strong></p><p>密码（仅此次显示）：</p><code>${esc(result.password)}</code><p class="hint">教师登录地址：${esc(location.origin)}/teacher/。密码不写入浏览器存储，关闭本提示后无法再次查看。</p><div class="form-actions"><button class="secondary" data-copy>复制登录信息</button><button class="secondary" data-dismiss>我已保存，关闭</button></div>`;
}
app.addEventListener('input', e => { if (e.target.id === 'search') renderRows(); });
app.addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b || busy) return;
  if (b.hasAttribute('data-cancel')) return closeEditor();
  if (b.hasAttribute('data-dismiss')) { const el=document.querySelector('#credentials'); el.hidden=true; el.innerHTML=''; return; }
  if (b.dataset.action) return openEditor(b.dataset.action,b.dataset.user);
  if (b.hasAttribute('data-copy')) {
    try { await navigator.clipboard.writeText(document.querySelector('#credentials').innerText); notice('登录信息已复制，请私下交付教师。',true); }
    catch { notice('无法自动复制，请选中上方账号和密码手动复制。'); } return;
  }
  if (b.hasAttribute('data-refresh')) { setBusy(true); try {await refresh(); notice('列表已刷新',true);} catch(err){handleError(err);} finally{setBusy(false);} }
});
app.addEventListener('submit', async e => {
  e.preventDefault(); if (busy || !edit || e.target.id!=='manage-form') return;
  const operation = {...edit,...Object.fromEntries(new FormData(e.target))};
  setBusy(true); notice('');
  try {
    const result = await api(endpoint,operation);
    closeEditor();
    if (result.password) showPassword(result);
    notice('操作成功',true);
    // Keep the generated password visible even if refreshing the list fails.
    try {await refresh();} catch(err){handleError(err);}
  } catch(err) { handleError(err); }
  finally {setBusy(false);}
});
(async()=>{
  try {
    const session = await api('/teacher/api/session');
    if (session.user.role!=='teacher' || !session.user.canManageTeachers) {denied('仅 teacher_admin 可以访问此后台。'); return;}
    render(); setBusy(true); await refresh();
  } catch(err) { if(!document.querySelector('#notice')) denied(err.message); else handleError(err); }
  finally {setBusy(false);}
})();
