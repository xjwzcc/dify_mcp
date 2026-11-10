'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {JSDOM}=require('jsdom'),fs=require('node:fs');
const tick=()=>new Promise(r=>setTimeout(r,15));
const root={username:'teacher_admin',name:'教学管理员',role:'teacher',canManageTeachers:true,approved:true};
const regular={username:'teacher_a',name:'张老师',role:'teacher',canManageTeachers:false,approved:true};
function setup(t,handler,home=false){
  const dom=new JSDOM(home?'<div id="app"></div>':'<div id="admin-app"></div>',{url:'https://school.test/teacher/'+(home?'':'admin/'),runScripts:'outside-only'});
  t.after(()=>dom.window.close());const calls=[];
  dom.window.fetch=async(path,options)=>{const data=options?.body?JSON.parse(options.body):undefined;calls.push({path,data});const r=await handler(path,data);return {ok:r.status===200,status:r.status,json:async()=>r.body};};
  dom.window.eval(fs.readFileSync('apps/accounts/public/teacher/'+(home?'app.js':'admin/app.js'),'utf8'));
  return {d:dom.window.document,w:dom.window,calls};
}
const success=body=>({status:200,body});
test('only server-confirmed administrator sees the management link or teacher list',async t=>{
  for(const admin of [false,true]){
    const user=admin?root:regular;
    const home=setup(t,async()=>success({user,bindings:[]}),true);await tick();
    assert.equal(Boolean(home.d.querySelector('a[href="/teacher/admin/"]')),admin);
    const ui=setup(t,async(path)=>path.endsWith('/session')?success({user}):success({teachers:[root,regular]}));await tick();
    assert.equal(Boolean(ui.d.querySelector('#teacher-list')),admin);
    assert.equal(ui.calls.length,admin?2:1);
    if(admin)assert.equal(ui.d.querySelector('[data-user="teacher_admin"]'),null);
    else assert.match(ui.d.body.textContent,/仅 teacher_admin/);
  }
});
test('anonymous administrator URL offers login, without fetching teacher data',async t=>{
  const ui=setup(t,async()=>({status:401,body:{error:'登录已过期'}}));await tick();
  assert.equal(ui.calls.length,1);assert.equal(ui.d.querySelector('a').getAttribute('href'),'/teacher/?next=admin');
});
test('create prevents duplicate submission and preserves one-time password if list refresh fails',async t=>{
  let release,created=false;
  const ui=setup(t,async(path,data)=>{
    if(path.endsWith('/session'))return success({user:root});
    if(data){await new Promise(r=>release=r);created=true;return success({user:{...regular,username:data.username},password:'OnlyOncePass123'});}
    return created?{status:503,body:{error:'列表暂不可用'}}:success({teachers:[root,regular]});
  });await tick();const {d,w}=ui;
  d.querySelector('[data-action="create"]').click();
  d.querySelector('#new-username').value='new_teacher';d.querySelector('#teacher-name').value='新老师';
  const form=d.querySelector('form');const submit=()=>form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  submit();submit();assert.equal(form.querySelector('button').disabled,true);assert.equal(ui.calls.filter(c=>c.data).length,1);
  release();await tick();await tick();
  assert.equal(d.querySelector('#editor').hidden,true);assert.match(d.querySelector('#credentials').textContent,/OnlyOncePass123/);
  assert.match(d.querySelector('#notice').textContent,/列表暂不可用/);
  assert.equal(w.localStorage.length,0);assert.equal(w.sessionStorage.length,0);
  d.querySelector('[data-dismiss]').click();assert.equal(d.querySelector('#credentials').textContent,'');
});
test('mutations require explicit confirmation; names are escaped; disabled users can be enabled',async t=>{
  const rows=[root,{...regular,name:'<img src=x onerror=alert(1)>',approved:false}];
  const ui=setup(t,async(path,data)=>path.endsWith('/session')?success({user:root}):data?success({user:regular,approved:true}):success({teachers:rows}));await tick();
  const {d,w}=ui;
  assert.equal(d.querySelector('img'),null);
  d.querySelector('[data-action="enable"]').click();assert.equal(ui.calls.filter(c=>c.data).length,0);
  assert.match(d.querySelector('#editor').textContent,/先确认此账号属于教师/);
  d.querySelector('[data-cancel]').click();assert.equal(ui.calls.filter(c=>c.data).length,0);
  d.querySelector('[data-action="enable"]').click();d.querySelector('form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await tick();
  assert.deepEqual(ui.calls.find(c=>c.data).data,{action:'enable',username:'teacher_a'});
  d.querySelector('#search').value='找不到';d.querySelector('#search').dispatchEvent(new w.Event('input',{bubbles:true}));
  assert.match(d.querySelector('#teacher-list').textContent,/没有找到/);
});
test('expired administrator session clears private data and offers login',async t=>{
  const ui=setup(t,async(path,data)=>path.endsWith('/session')?success({user:root}):data?{status:401,body:{error:'请重新登录'}}:success({teachers:[root,regular]}));await tick();
  ui.d.querySelector('[data-action="disable"]').click();ui.d.querySelector('form').dispatchEvent(new ui.w.Event('submit',{bubbles:true,cancelable:true}));await tick();
  assert.equal(ui.d.querySelector('#teacher-list'),null);assert.equal(ui.d.querySelector('#credentials'),null);assert.match(ui.d.body.textContent,/请重新登录/);
});
