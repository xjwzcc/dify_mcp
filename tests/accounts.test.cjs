'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
for (const backend of ['nas', 'oss']) test(`unified registration and binding (${backend})`, { timeout: 120000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-test-'));
  const mock = backend === 'oss' ? await require('./helpers/oss-mock.cjs').createMock() : null;
  const env = { ...process.env, ...mock?.env, NODE_ENV: 'test', STORAGE_BACKEND: backend, DATA_DIR: dir, ENABLE_MCP: '0',
    PORT: '19870', CATERING_PORT: '19871', HOTEL_PORT: '19872', ACCOUNTS_PORT: '19874', HOST: '127.0.0.1', SECURE_COOKIE: '1',
    TEACHER_PASSWORD: 'AccountTestTeacher!', CATERING_CLASS_CODE: 'ACCTMENU', HOTEL_CLASS_CODE: 'ACCTHOTEL' };
  if (mock) await require('../scripts/init-oss.cjs').initOss({ empty: true }, env);
  let child, output=''; const base='http://127.0.0.1:19870';
  async function start() {
    child=spawn(process.execPath,['server.cjs'],{cwd:path.resolve(__dirname,'..'),env,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);
    for(let i=0;i<150;i++){if(child.exitCode!==null)throw Error(output);try{if((await fetch(base+'/healthz')).ok)return;}catch{}await new Promise(r=>setTimeout(r,80));}throw Error(output);
  }
  async function stop(){if(child&&child.exitCode===null){const end=once(child,'exit');child.kill('SIGTERM');await end;}}
  t.after(async()=>{await stop();await mock?.close();fs.rmSync(dir,{recursive:true,force:true});});
  async function call(route,data,cookie,extra={}) {
    const r=await fetch(base+route,{method:data===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...extra},body:data===undefined?undefined:JSON.stringify(data)});
    const text=await r.text();return{status:r.status,body:r.headers.get('content-type')?.includes('application/json')?JSON.parse(text):text,cookies:r.headers.getSetCookie(),cookie:r.headers.getSetCookie()[0]?.split(';')[0]};
  }
  const account=(username,role='student',extra={})=>({username,name:'统一账号测试',password:'StudentPass123!',confirmPassword:'StudentPass123!',role,...extra});
  const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body));return r;};
  await start();
  let student, teacher, catering, hotel, invitation;
  await t.test('legacy data, public entry and bridge isolation',async()=>{
    assert.match(ok(await call('/accounts/')).body,/统一账号/);
    assert.match(ok(await call('/')).body,/学生 \/ 教师注册/);
    assert.equal((await call('/catering/api/account-bridge',{action:'session',id:'teacher'})).status,404);
    assert.equal((await call('/hotel/api/account-bridge',{action:'session',id:'teacher'})).status,404);
    // Even reaching a child directly does not grant access without the boot secret.
    assert.equal((await fetch('http://127.0.0.1:19871/api/account-bridge',{method:'POST',body:'{}'})).status,404);
    const old={id:'OLD100',name:'原学生',password:'OriginalPass123',classCode:'ACCTMENU'};
    catering=ok(await call('/catering/api/login',old));hotel=ok(await call('/hotel/api/login',{...old,classCode:'ACCTHOTEL'}));
    const state=ok(await call('/catering/api/snapshot',undefined,catering.cookie)).body.state;state.restaurant='绑定必须保留的餐厅';
    ok(await call('/catering/api/state',{state},catering.cookie));
    ok(await call('/catering/api/submit',{taskId:'T1',content:'本次完成了菜单分类与定价，并核对订单与出餐流程，结合操作证据进行业务复盘，保留该成果验证账号绑定。'},catering.cookie));
    const oldTeacher=ok(await call('/catering/api/login',{role:'teacher',password:env.TEACHER_PASSWORD}));
    ok(await call('/catering/api/review',{id:'T1_OLD100',score:94,feedback:'绑定前的评价',status:'已评价'},oldTeacher.cookie));
  });
  await t.test('registration validation, one-time teacher invitations and duplicate accounts',async()=>{
    assert.equal((await call('/accounts/api/register',account('BAD','admin'))).status,400);
    assert.equal((await call('/accounts/api/register',account('TEACHER1','teacher'))).status,403);
    assert.equal((await call('/accounts/api/register',account('BADPASS','student',{confirmPassword:'different'}))).status,400);
    assert.equal((await call('/accounts/api/register',account('CROSS'),undefined,{Origin:'https://other.test'})).status,403);
    assert.equal((await call('/accounts/api/invitations',{legacyPassword:'wrong'})).status,401);
    invitation=ok(await call('/accounts/api/invitations',{legacyPassword:env.TEACHER_PASSWORD})).body.invitation;
    teacher=ok(await call('/accounts/api/register',account('TEACHER1','teacher',{invitation})));
    assert.equal(teacher.body.user.role,'teacher');
    assert.equal((await call('/accounts/api/register',account('TEACHER2','teacher',{invitation}))).status,403);
    student=ok(await call('/accounts/api/register',account('NEW100')));
    assert.equal(student.body.user.role,'student');
    assert.equal((await call('/accounts/api/register',account('NEW100'))).status,409);
    assert.equal((await call('/accounts/api/invitations',{legacyPassword:env.TEACHER_PASSWORD},student.cookie)).status,403);
    assert.match(student.cookies[0],/HttpOnly; SameSite=Strict; Path=\/accounts\//);assert.match(student.cookies[0],/Secure/);
  });
  await t.test('verified binding preserves old identity, state and grade across both courses',async()=>{
    assert.equal((await call('/accounts/api/bind',{course:'catering',mode:'existing',localId:'OLD100',password:'wrong'},student.cookie)).status,401);
    assert.equal((await call('/accounts/api/bind',{course:'catering',mode:'existing',localId:'teacher',password:env.TEACHER_PASSWORD},student.cookie)).status,401);
    for(const course of ['catering','hotel'])ok(await call('/accounts/api/bind',{course,mode:'existing',localId:'OLD100',password:'OriginalPass123'},student.cookie));
    assert.equal((await call('/accounts/api/bind',{course:'hotel',mode:'enroll'},student.cookie)).status,409);
    catering=ok(await call('/accounts/api/enter',{course:'catering'},student.cookie));hotel=ok(await call('/accounts/api/enter',{course:'hotel'},student.cookie));
    assert.equal(catering.body.url,'/catering/student');
    const state=ok(await call('/catering/api/snapshot',undefined,catering.cookie)).body;
    assert.equal(state.user.id,'OLD100');assert.equal(state.state.restaurant,'绑定必须保留的餐厅');assert.equal(state.submissions[0].score,94);
    assert.equal(ok(await call('/hotel/api/session',undefined,hotel.cookie)).body.session.id,'OLD100');
    assert.equal((await call('/hotel/api/teacher',undefined,hotel.cookie)).status,403);
  });
  await t.test('restart recovers accounts, invitation use, bindings and sessions',async()=>{
    await stop();await start();
    const session=ok(await call('/accounts/api/session',undefined,student.cookie));assert.equal(session.body.bindings.length,2);
    assert.equal((await call('/accounts/api/register',account('TEACHER2','teacher',{invitation}))).status,403);
    const outsider=ok(await call('/accounts/api/register',account('OUTSIDER')));
    assert.equal((await call('/accounts/api/bind',{course:'catering',mode:'existing',localId:'OLD100',password:'OriginalPass123'},outsider.cookie)).status,409);
    const login=ok(await call('/accounts/api/login',{username:'NEW100',password:'StudentPass123!'}));
    assert.equal(login.body.bindings.length,2);
    assert.equal((await call('/accounts/api/login',{username:'NEW100',password:'wrong'})).status,401);
    catering=ok(await call('/accounts/api/enter',{course:'catering'},student.cookie));
    assert.equal(ok(await call('/catering/api/snapshot',undefined,catering.cookie)).body.submissions[0].score,94);
    if(mock){const keys=[...mock.objects.keys()].filter(k=>k.includes('/accounts/'));assert.ok(keys.length>1);for(const key of keys)assert.ok(!mock.objects.get(key).includes(Buffer.from('StudentPass123!')));}
  });
  await t.test('new student enrollment, unique teacher identity and logout revocation',async()=>{
    const fresh=ok(await call('/accounts/api/register',account('FRESH100')));
    assert.equal((await call('/accounts/api/bind',{course:'catering',mode:'enroll',classCode:'wrong'},fresh.cookie)).status,403);
    ok(await call('/accounts/api/bind',{course:'catering',mode:'enroll',classCode:'ACCTMENU'},fresh.cookie));
    ok(await call('/accounts/api/bind',{course:'hotel',mode:'enroll',classId:'default',classCode:'ACCTHOTEL'},fresh.cookie));
    for(const course of ['catering','hotel']){
      const launch=ok(await call('/accounts/api/enter',{course},teacher.cookie));assert.equal(launch.body.url,`/${course}/teacher`);
      const info=ok(await call(course==='catering'?'/catering/api/snapshot':'/hotel/api/session',undefined,launch.cookie)).body;
      const user=info.user||info.session;assert.match(user.id,/^t_[a-f0-9]{32}$/);assert.equal(user.name,'统一账号测试');
    }
    ok(await call('/accounts/api/invitations',{},teacher.cookie));
    ok(await call('/accounts/api/logout',{},student.cookie));
    assert.equal((await call('/accounts/api/session',undefined,student.cookie)).status,401);
    assert.equal((await call('/catering/api/snapshot',undefined,catering.cookie)).status,401);
    assert.equal((await call('/hotel/api/session',undefined,hotel.cookie)).status,401);
  });
});
