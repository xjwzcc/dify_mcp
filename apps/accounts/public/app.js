'use strict';
const app = document.querySelector('#app'), notice = document.querySelector('#notice');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const field = (label, name, type = 'text', attrs = '') => `<label>${label}<input name="${name}" type="${type}" ${attrs}></label>`;
let current, mode = location.hash === '#register' ? 'register' : 'login', classes = [], working = false;
const say = message => { notice.textContent = message; };
async function api(route, body) {
  const response = await fetch('/accounts/api/' + route, body === undefined ? {} : { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
  const value = await response.json(); if (!response.ok) throw Error(value.error || '操作未完成'); return value;
}
function entry() {
  current = null; app.removeAttribute('aria-busy');
  const register = mode === 'register';
  app.innerHTML = `<div class="layout"><section class="intro"><h1>一个账号，<br>连接每一次实训。</h1><p class="muted">餐饮服务与酒店管理，共用个人账号。<br>换设备登录，继续自己的学习与教学。</p><p class="note">已有学号和作业？先注册统一账号，再验证原课程密码完成绑定。原有记录会保留。</p><p><a href="/catering/student">餐饮原账号入口</a> · <a href="/hotel/student">酒店原账号入口</a></p></section><section class="card"><div class="tabs"><button data-view="login" aria-pressed="${!register}">登录</button><button data-view="register" aria-pressed="${register}">注册账号</button></div><h2>${register?'创建个人账号':'欢迎回来'}</h2><form data-form="${mode}">${register?`<label>注册身份<select name="role"><option value="student">学生</option><option value="teacher">教师（需要邀请码）</option></select></label>${field('姓名','name','text','required maxlength="30" autocomplete="name"')}`:''}${field(register?'账号（新学生建议使用学号）':'统一账号','username','text','required minlength="3" maxlength="40" pattern="[A-Za-z0-9_-]+" autocomplete="username"')}${field('密码','password','password',`required minlength="8" maxlength="128" autocomplete="${register?'new-password':'current-password'}"`)}${register?field('确认密码','confirmPassword','password','required minlength="8" maxlength="128" autocomplete="new-password"')+'<div id="teacherInvite" hidden>'+field('教师邀请码','invitation','text','maxlength="80" autocomplete="off"')+'<p class="note">教师账号可管理两门课程的学生和教学数据。邀请码由已有教师提供，7 天内仅可使用一次。</p></div>':''}<button>${register?'注册并进入账号中心':'登录账号中心'}</button></form><details><summary>已有教师：生成注册邀请码</summary><p class="muted">首次开通个人教师账号时，使用原餐饮教师密码验证。已有统一教师账号可登录后生成。</p><form data-form="legacyInvite">${field('原餐饮教师密码','legacyPassword','password','required maxlength="128" autocomplete="current-password"')}<button class="secondary">验证并生成一次性邀请码</button></form><div id="invitation"></div></details></section></div>`;
}
function dashboard() {
  app.removeAttribute('aria-busy'); const {user, bindings} = current;
  app.innerHTML = `<div class="identity"><div><h1>${esc(user.name)}的账号中心</h1><p class="muted">${esc(user.username)} · ${user.role==='teacher'?'教师':'学生'}</p></div><button data-action="logout" class="secondary">退出统一账号</button></div><p>选择课程，进入已绑定的个人课堂。</p><div class="cards">${[['catering','餐饮信息系统'],['hotel','酒店人力资源系统']].map(([course,title])=>{
    const binding=bindings.find(b=>b.course===course);
    if(binding||user.role==='teacher')return `<section class="card"><h2>${title}</h2><p class="success">${binding?'已绑定 · '+esc(binding.name)+' / '+esc(binding.localId):'首次进入将建立个人教师身份'}</p><button data-action="enter" data-course="${course}">进入${user.role==='teacher'?'教师':'学生'}课堂</button></section>`;
    return `<section class="card"><h2>${title}</h2><p class="muted">尚未关联课程档案</p><form data-form="bind" data-course="${course}"><label>关联方式<select name="mode"><option value="existing">绑定原账号（保留作业与成绩）</option><option value="enroll">首次加入课程（创建新档案）</option></select></label><div data-existing>${field('原课程学号','localId','text','required maxlength="40" autocomplete="username"')}${field('原课程密码','password','password','required maxlength="128" autocomplete="current-password"')}</div><div data-enroll hidden><p class="note">新档案使用学号：${esc(user.username)}</p>${course==='hotel'?`<label>教学班级<select name="classId" disabled required><option value="">请选择班级</option>${classes.map(c=>`<option value="${esc(c.id)}">${esc(c.name)}${!c.entry||!c.enrollment?'（未开放注册）':''}</option>`).join('')}</select></label>`:''}${field('班级口令','classCode','text','disabled required maxlength="80" autocomplete="off"')}</div><button>确认关联</button></form></section>`;
  }).join('')}</div>${user.role==='teacher'?'<section class="card"><h2>邀请教师</h2><p>邀请码可开通两门课程的教师管理权限，仅分享给获授权的教师。每个邀请码 7 天内仅可使用一次。</p><button data-action="invite">生成一次性邀请码</button><div id="invitation"></div></section>':''}`;
  app.querySelectorAll('[name=localId]').forEach(el=>{el.value=user.username;});
}
function showInvitation(result) {
  const el=document.querySelector('#invitation');
  el.innerHTML=`<p class="note">请复制后交给受邀教师，本页关闭后不再显示明文。<br><code>${esc(result.invitation)}</code><br>有效期至 ${esc(new Date(result.expires).toLocaleString('zh-CN'))}</p>`;
  say('邀请码已生成。');
}
async function refresh() {
  current=await api('session');
  if(current.user.role==='student') { const response=await fetch('/hotel/api/classes/public'); if(!response.ok)throw Error('班级信息暂不可用，请刷新重试'); classes=(await response.json()).classes; }
  dashboard();
}
app.addEventListener('change',e=>{
  if(e.target.name==='role') { const box=document.querySelector('#teacherInvite'),enabled=e.target.value==='teacher'; box.hidden=!enabled; box.querySelector('input').required=enabled; }
  if(e.target.name==='mode') {
    const form=e.target.form,enroll=e.target.value==='enroll';
    for(const [selector,enabled] of [['[data-existing]',!enroll],['[data-enroll]',enroll]]) {
      const box=form.querySelector(selector);box.hidden=!enabled;box.querySelectorAll('input,select').forEach(el=>{el.disabled=!enabled;});
    }
  }
});
async function run(button,fn) { if(working)return;working=true;button.disabled=true;say('');try{await fn();}catch(e){say(e.message);}finally{working=false;button.disabled=false;} }
app.addEventListener('click',e=>{
  const button=e.target.closest('button');if(!button)return;
  if(button.dataset.view&&!working){mode=button.dataset.view;say('');entry();return;}
  if(!button.dataset.action)return;
  run(button,async()=>{
    if(button.dataset.action==='logout'){await api('logout',{});entry();say('已退出统一账号，并退出由本账号中心开启的课程会话。');}
    if(button.dataset.action==='enter'){const r=await api('enter',{course:button.dataset.course});location.assign(r.url);}
    if(button.dataset.action==='invite')showInvitation(await api('invitations',{}));
  });
});
app.addEventListener('submit',e=>{
  e.preventDefault();const form=e.target,kind=form.dataset.form,values=Object.fromEntries(new FormData(form));
  run(form.querySelector('button'),async()=>{
    if(kind==='register'||kind==='login') { if(kind==='register'&&values.password!==values.confirmPassword)throw Error('两次输入的密码不一致');await api(kind,values);await refresh();say(kind==='register'?'注册成功，请关联课程档案。':'登录成功。'); }
    if(kind==='bind'){await api('bind',{...values,course:form.dataset.course});await refresh();say('关联成功，原有作业和成绩已保留。');}
    if(kind==='legacyInvite'){showInvitation(await api('invitations',values));form.reset();}
  });
});
refresh().catch(()=>entry());
