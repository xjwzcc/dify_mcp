'use strict';
/* 教师端学生账号管理：列出统一账号、标记同名重复注册、按学号二次确认后删除。
   删除范围仅统一账号与登录状态，课程业务数据保留。 */
let students = [], target = null;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const toast = msg => { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 4200); };

async function api(url, body) {
  const r = await fetch('/teacher/api/' + url, body === undefined ? {signal: AbortSignal.timeout(20000)} :
    {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { location.href = '/teacher/'; throw Error('登录已失效'); }
  if (!r.ok) throw Error(j.error || '请求失败（' + r.status + '）');
  return j;
}

function names() {
  const count = new Map();
  students.forEach(s => count.set(s.name, (count.get(s.name) || 0) + 1));
  return count;
}

function row(s, dup) {
  const binds = (s.bindings || []).map(b => '<span class="chip">' + esc(b.course === 'catering' ? '餐饮' : b.course === 'hotel' ? '酒店' : b.course) + ' · ' + esc(b.localId) + '</span>').join(' ') || '<span class="muted">未绑定课程</span>';
  return '<div class="card" data-id="' + esc(s.username) + '">'
    + '<div class="main"><div class="who"><strong>' + esc(s.name) + '</strong>'
    + (dup ? '<span class="badge">同名 ×' + dup + '</span>' : '')
    + (s.online ? '<span class="dot">在线</span>' : '<span class="muted small">离线</span>')
    + '</div><div class="sub">学号 ' + esc(s.username) + '</div><div class="binds">' + binds + '</div></div>'
    + '<button class="danger" data-del="' + esc(s.username) + '">删除账号</button></div>';
}

function render() {
  const q = $('#q').value.trim().toLowerCase();
  const counts = names();
  const list = students.filter(s => !q || (s.name + ' ' + s.username).toLowerCase().includes(q));
  $('#mTotal').textContent = students.length;
  $('#mDup').textContent = students.filter(s => counts.get(s.name) > 1).length;
  $('#mOnline').textContent = students.filter(s => s.online).length;
  $('#list').innerHTML = list.length ? list.map(s => row(s, counts.get(s.name))).join('') : '<div class="empty">没有匹配的学生账号</div>';
}

function openDelete(username) {
  target = students.find(s => s.username === username);
  if (!target) return;
  $('#delName').textContent = target.name + '（' + target.username + '）';
  const input = $('#confirm'); input.value = ''; input.placeholder = target.username;
  $('#ok').disabled = true;
  $('#delDlg').showModal(); input.focus();
}

async function remove() {
  if (!target) return;
  const btn = $('#ok'); btn.disabled = true; btn.textContent = '正在删除…';
  try {
    await api('students/delete', {username: target.username, confirm: $('#confirm').value.trim()});
    toast('已删除账号 ' + target.username + '，课程内业务数据保留');
    $('#delDlg').close();
    await load();
  } catch (err) {
    toast(err.message);
    btn.disabled = false; btn.textContent = '确认删除';
  }
}

async function load() {
  const data = await api('students');
  students = data.students || [];
  render();
}

$('#q').addEventListener('input', render);
$('#list').addEventListener('click', e => {
  const b = e.target.closest('[data-del]');
  if (b) openDelete(b.dataset.del);
});
$('#confirm').addEventListener('input', e => { $('#ok').disabled = e.target.value.trim() !== (target && target.username); });
$('#cancel').addEventListener('click', () => $('#delDlg').close());
$('#delForm').addEventListener('submit', e => { e.preventDefault(); if (!$('#ok').disabled) remove(); });

api('session').then(d => { $('#who').textContent = d.user.name + ' · 教师'; }).catch(() => {});
load().catch(err => { toast(err.message); $('#list').innerHTML = '<div class="empty">' + esc(err.message) + '</div>'; });
