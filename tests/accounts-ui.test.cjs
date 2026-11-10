'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const fs = require('node:fs');
const source = fs.readFileSync('apps/accounts/public/student/app.js', 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
function setup(t, handler, url = 'https://school.test/student/') {
  const dom = new JSDOM('<div id="app"></div>', {url, runScripts:'outside-only'});
  t.after(() => dom.window.close());
  const calls=[];
  dom.window.fetch = async (path, options) => {
    const data=options?.body ? JSON.parse(options.body) : undefined;calls.push({path,data});
    const r=await handler(path,data);
    return {ok:r.status===200,status:r.status,json:async()=>r.body};
  };
  dom.window.eval(source);
  return {window:dom.window, document:dom.window.document,calls};
}
const signedOut = {status:401,body:{error:'请先登录'}};
const user = {username:'STUDENT1',name:'学生甲',role:'student'};
test('student entry registers only students without invitation or role toggle', async t => {
  const ui=setup(t,async(path,data)=>path.endsWith('/session')?signedOut:{status:401,body:{error:'账号或密码错误'}});
  await tick();
  const d=ui.document;
  assert.equal(d.querySelectorAll('form').length,1);
  assert.equal(d.querySelector('[data-role]'),null);
  d.querySelector('[data-mode="register"]').click();
  assert.equal(d.querySelector('h2').textContent,'注册学生账号');
  assert.deepEqual([...d.querySelectorAll('input')].map(i=>i.name),['name','username','password','confirmPassword']);
  d.querySelector('#name').value='测试教师';d.querySelector('#username').value='TEACHER1';
  d.querySelector('#password').value='TeacherPass123';d.querySelector('#confirmPassword').value='mismatch';
  d.querySelector('form').dispatchEvent(new ui.window.Event('submit',{bubbles:true,cancelable:true}));await tick();
  assert.match(d.querySelector('#notice').textContent,/不一致/);
  assert.equal(ui.calls.filter(c=>c.path.endsWith('/register')).length,0);
  d.querySelector('#confirmPassword').value='TeacherPass123';
  d.querySelector('form').dispatchEvent(new ui.window.Event('submit',{bubbles:true,cancelable:true}));await tick();
  assert.equal(ui.calls.at(-1).data.role,'student');
  assert.equal(ui.calls.at(-1).path,'/student/api/register');
  assert.equal('invitation' in ui.calls.at(-1).data,false);
  d.querySelector('[data-mode="login"]').click();
  assert.equal(d.querySelector('#username').value,'TEACHER1');
  assert.deepEqual([...d.querySelectorAll('input')].map(i=>i.name),['username','password']);
  d.querySelector('[data-reveal]').click();assert.equal(d.querySelector('#password').type,'text');
});
test('login sends chosen role, prevents duplicate submissions, then shows courses', async t=>{
  let release;
  const ui=setup(t,async(path,data)=>{
    if(path.endsWith('/session'))return signedOut;
    if(path.endsWith('/login')) {await new Promise(r=>release=r);return {status:200,body:{user,bindings:[]}};}
    return {status:200,body:{classes:[{id:'default',name:'默认教学班',entry:true,enrollment:true}]}};
  });await tick();const d=ui.document;
  d.querySelector('#username').value=user.username;d.querySelector('#password').value='Password123';
  const submit=()=>d.querySelector('form').dispatchEvent(new ui.window.Event('submit',{bubbles:true,cancelable:true}));
  submit();submit();assert.equal(d.querySelector('[type=submit]').disabled,true);
  assert.equal(ui.calls.filter(c=>c.path.endsWith('/login')).length,1);
  assert.equal(ui.calls.at(-1).data.role,'student');release();await tick();
  assert.equal(d.querySelectorAll('[data-enter]').length,2);
  assert.equal(d.querySelector('#recover-catering').open,false);
  assert.equal(d.querySelector('#classId').value,'default');
});
test('existing account collision reveals optional recovery and keeps authenticated identity',async t=>{
  const ui=setup(t,async path=>{
    if(path.endsWith('/session'))return {status:200,body:{user,bindings:[]}};
    if(path.endsWith('/public'))return {status:200,body:{classes:[]}};
    return {status:409,body:{error:'请验证原课程密码'}};
  });await tick();const d=ui.document;
  d.querySelector('[data-enter="catering"]').dispatchEvent(new ui.window.Event('submit',{bubbles:true,cancelable:true}));await tick();
  assert.equal(d.querySelector('#recover-catering').open,true);
  assert.match(d.querySelector('#notice').textContent,/原课程密码/);
  assert.ok(d.querySelector('[data-logout]'));
  assert.equal('classCode' in ui.calls.at(-1).data,false);
});
test('class service failure remains on course page with retry; retry recovers',async t=>{
  let failed=true;
  const ui=setup(t,async path=>path.endsWith('/session')?{status:200,body:{user,bindings:[]}}:failed?{status:503,body:{error:'班级暂不可用'}}:{status:200,body:{classes:[{id:'A',name:'一班',entry:true,enrollment:true}]}});
  await tick();const d=ui.document;
  assert.ok(d.querySelector('[data-retry]'));assert.ok(d.querySelector('[data-logout]'));
  assert.equal(d.querySelector('[data-enter="hotel"] [type=submit]').disabled,true);
  failed=false;d.querySelector('[data-retry]').click();await tick();
  assert.equal(d.querySelector('#classId').value,'A');
  assert.equal(d.querySelector('[data-enter="hotel"] [type=submit]').disabled,false);
});
test('course logout clears unified and legacy sessions; tolerates expired session',async t=>{
  const dom=new JSDOM('',{url:'https://school.test/catering/student',runScripts:'outside-only'});t.after(()=>dom.window.close());
  const paths=[];dom.window.fetch=async path=>{paths.push(path);return{ok:false,status:401};};
  dom.window.eval(fs.readFileSync('apps/accounts/public/entry.js','utf8'));
  await dom.window.teachingAuth.logout();
  assert.deepEqual(paths,['/student/api/logout','/catering/api/logout']);
});
test('expired account logout returns to login instead of trapping the user',async t=>{
  const ui=setup(t,async path=>path.endsWith('/session')?{status:200,body:{user,bindings:[{course:'hotel'}]}}:signedOut);
  await tick();ui.document.querySelector('[data-logout]').click();await tick();
  assert.ok(ui.document.querySelector('#auth-form'));
  assert.equal(ui.document.querySelector('[data-logout]'),null);
});
test('course links cannot silently display a different role',async t=>{
  const dom=new JSDOM('',{url:'https://school.test/hotel/student?role=teacher',runScripts:'outside-only'});t.after(()=>dom.window.close());
  dom.window.eval(fs.readFileSync('apps/accounts/public/entry.js','utf8'));
  const redirected=[];dom.window.teachingAuth.login=course=>redirected.push(course);
  assert.equal(dom.window.teachingAuth.acceptsRole('teacher'),false);
  assert.deepEqual(redirected,['hotel']);
  assert.equal(dom.window.teachingAuth.acceptsRole('student'),true);
});

test('teacher page never offers registration even with hash and role query tampering',async t=>{
  const dom=new JSDOM('<div id="app"></div>',{url:'https://school.test/teacher/?role=student#register',runScripts:'outside-only'});t.after(()=>dom.window.close());
  const calls=[];dom.window.fetch=async(path,options)=>{calls.push({path,data:options?.body?JSON.parse(options.body):null});return{ok:false,status:401,json:async()=>({error:'请先登录'})};};
  dom.window.eval(fs.readFileSync('apps/accounts/public/teacher/app.js','utf8'));await tick();
  const d=dom.window.document;
  assert.equal(d.querySelector('h2').textContent,'登录教师账号');
  assert.equal(d.querySelector('[data-mode]'),null);assert.equal(d.querySelector('[data-role]'),null);
  assert.match(d.body.textContent,/管理员统一创建/);
  d.querySelector('#username').value='TEACHER1';d.querySelector('#password').value='Password123';
  d.querySelector('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await tick();
  assert.equal(calls.at(-1).path,'/teacher/api/login');assert.equal(calls.at(-1).data.role,'teacher');
});
test('student UI rejects a teacher session before rendering course links',async t=>{
  const ui=setup(t,async()=>({status:200,body:{user:{...user,role:'teacher'},bindings:[]}}));await tick();
  assert.equal(ui.document.querySelector('[data-enter]'),null);
  assert.match(ui.document.querySelector('#notice').textContent,/身份与当前入口不符/);
});
