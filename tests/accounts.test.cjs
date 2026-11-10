'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const {manage} = require('../scripts/manage-teachers.cjs');
for (const backend of ['nas', 'oss']) test(`unified registration and binding (${backend})`, { timeout: 120000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-test-'));
  const mock = backend === 'oss' ? await require('./helpers/oss-mock.cjs').createMock() : null;
  const env = { ...process.env, ...mock?.env, NODE_ENV: 'test', STORAGE_BACKEND: backend, DATA_DIR: dir, ENABLE_MCP: '0',
    PORT: '19870', CATERING_PORT: '19871', HOTEL_PORT: '19872', ACCOUNTS_PORT: '19874', HOST: '127.0.0.1', SECURE_COOKIE: '1',
    ACCOUNTS_ADMIN_SOCKET: '/tmp/acct-admin-' + process.pid + '-' + backend + '.sock', TEACHER_PASSWORD: 'AccountTestTeacher!', CATERING_CLASS_CODE: 'ACCTMENU', HOTEL_CLASS_CODE: 'ACCTHOTEL' };
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
  const admin = input => manage(input,env.ACCOUNTS_ADMIN_SOCKET);
  const account=(username,role='student',extra={})=>({username,name:'统一账号测试',password:'StudentPass123!',confirmPassword:'StudentPass123!',role,...extra});
  const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body));return r;};
  // Create real pre-upgrade course records through standalone legacy apps, then stop
  // every writer before the gateway starts (also exercises the OSS journal).
  let student, teacher, catering, hotel, oldTeacher, oldHotelTeacher;
  for (const [course,port] of [['catering','19871'],['hotel','19872']]) {
    const legacy=spawn(process.execPath,[`apps/${course}/server.cjs`],{env:{...env,PORT:port,DATA_DIR:path.join(dir,course),CLASS_CODE:course==='hotel'?'ACCTHOTEL':'ACCTMENU',UNIFIED_ACCOUNTS:'0'},stdio:['ignore','pipe','pipe']});
    let log='';legacy.stderr.on('data',c=>log+=c);legacy.stdout.on('data',c=>log+=c);
    try {
      for(let i=0;i<100;i++){if(legacy.exitCode!==null)throw Error(log);try{if((await fetch(`http://127.0.0.1:${port}/api/health`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));}
      async function legacyCall(route,data,cookie){const r=await fetch(`http://127.0.0.1:${port}/${course}/api/${route}`,{method:data?'POST':'GET',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:data?JSON.stringify(data):undefined});return {status:r.status,body:await r.json(),cookie:r.headers.getSetCookie()[0]?.split(';')[0]};}
      const old={id:'OLD100',name:'原学生',password:'OriginalPass123',classCode:course==='hotel'?'ACCTHOTEL':'ACCTMENU'};
      const st=ok(await legacyCall('login',old)), tr=ok(await legacyCall('login',{role:'teacher',password:env.TEACHER_PASSWORD}));
      if(course==='catering') {
        oldTeacher=tr;
        const state=ok(await legacyCall('snapshot',undefined,st.cookie)).body.state;state.restaurant='绑定必须保留的餐厅';
        ok(await legacyCall('state',{state},st.cookie));
        ok(await legacyCall('submit',{taskId:'T1',content:'本次完成了菜单分类与定价，并核对订单与出餐流程，结合操作证据进行业务复盘，保留该成果验证账号绑定。'},st.cookie));
        ok(await legacyCall('review',{id:'T1_OLD100',score:94,feedback:'绑定前的评价',status:'已评价'},tr.cookie));
      } else oldHotelTeacher=tr;
    } finally {if(legacy.exitCode===null){const end=once(legacy,'exit');legacy.kill('SIGTERM');await end;}}
  }
  // Pre-upgrade self-registered teacher fixture; approval must not be inferred.
  fs.mkdirSync(path.join(dir,'accounts'),{recursive:true});
  const seed=new DatabaseSync(path.join(dir,'accounts/accounts.sqlite'));
  seed.exec(`CREATE TABLE accounts(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL,password TEXT NOT NULL,provision TEXT NOT NULL);
    CREATE TABLE sessions(token TEXT PRIMARY KEY,id TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE bindings(account_id TEXT NOT NULL,course TEXT NOT NULL,local_id TEXT NOT NULL,name TEXT NOT NULL,PRIMARY KEY(account_id,course),UNIQUE(course,local_id));
    CREATE TABLE invitations(hash TEXT PRIMARY KEY,creator TEXT NOT NULL,expires INTEGER NOT NULL,used_by TEXT);
    CREATE TABLE course_sessions(session_id TEXT NOT NULL,course TEXT NOT NULL,token TEXT NOT NULL,PRIMARY KEY(session_id,course));`);
  const salt=crypto.randomBytes(16).toString('hex');
  seed.prepare('INSERT INTO accounts VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(),'LEGACYTEACHER','原注册教师','teacher',salt+':'+crypto.scryptSync('StudentPass123!',salt,32).toString('hex'),crypto.randomBytes(32).toString('hex'));
  if(mock)await new (require('../storage/oss.cjs').OssJournal)('accounts',env).initialize(require('../storage/database.cjs').snapshot(seed));
  seed.close();
  await start();
  await t.test('legacy data, public entry and bridge isolation',async()=>{
    assert.match(ok(await call('/accounts/')).body,/登录与注册/);
    for(const course of ['catering','hotel'])assert.match(ok(await call('/'+course+'/student')).body,/\/accounts\/entry.js/);
    assert.match(ok(await call('/')).body,/登录 \/ 注册/);
    assert.equal((await call('/catering/api/account-bridge',{action:'session',id:'teacher'})).status,404);
    assert.equal((await call('/hotel/api/account-bridge',{action:'session',id:'teacher'})).status,404);
    // Even reaching a child directly does not grant access without the boot secret.
    assert.equal((await fetch('http://127.0.0.1:19871/api/account-bridge',{method:'POST',body:'{}'})).status,404);
    for(const course of ['catering','hotel'])assert.equal((await call('/'+course+'/api/login',{role:'teacher',password:env.TEACHER_PASSWORD})).status,410);
    assert.equal((await call('/catering/api/snapshot',undefined,oldTeacher.cookie)).status,401);
    assert.equal((await call('/hotel/api/session',undefined,oldHotelTeacher.cookie)).status,401);
    for(const [course,cookie] of [['catering',oldTeacher.cookie],['hotel',oldHotelTeacher.cookie]])
      assert.equal((await call('/'+course+'/api/chat/capabilities',undefined,cookie)).status,401);
  });
  await t.test('student self-registration and console-only teacher provisioning',async()=>{
    assert.equal((await call('/student/api/register',account('BAD','admin'))).status,403);
    assert.equal((await call('/student/api/register',account('BADPASS','student',{confirmPassword:'different'}))).status,400);
    assert.equal((await call('/student/api/register',account('CROSS'),undefined,{Origin:'https://other.test'})).status,403);
    assert.equal((await call('/student/api/invitations',{})).status,410);
    assert.equal((await call('/teacher/api/register',account('TEACHER1','teacher'))).status,403);
    assert.equal((await call('/student/api/register',account('TEACHER1','teacher'))).status,403);
    assert.equal((await call('/accounts/api/register',account('TEACHER1','teacher'))).status,410);
    await admin({...account('TEACHER1','teacher'),action:'create'});
    teacher=ok(await call('/teacher/api/login',account('TEACHER1','teacher')));
    assert.equal(teacher.body.user.role,'teacher');
    student=ok(await call('/student/api/register',account('NEW100')));
    assert.equal(student.body.user.role,'student');
    assert.equal((await call('/student/api/register',account('NEW100'))).status,409);
    assert.match(student.cookies[0],/HttpOnly; SameSite=Strict; Path=\/student\//);assert.match(student.cookies[0],/Secure/);
  });
  await t.test('verified binding preserves old identity, state and grade across both courses',async()=>{
    assert.equal((await call('/student/api/bind',{course:'catering',mode:'existing',localId:'OLD100',password:'wrong'},student.cookie)).status,401);
    assert.equal((await call('/student/api/bind',{course:'catering',mode:'existing',localId:'teacher',password:env.TEACHER_PASSWORD},student.cookie)).status,401);
    for(const course of ['catering','hotel'])ok(await call('/student/api/bind',{course,mode:'existing',localId:'OLD100',password:'OriginalPass123'},student.cookie));
    assert.equal((await call('/student/api/bind',{course:'hotel',mode:'enroll'},student.cookie)).status,409);
    catering=ok(await call('/student/api/enter',{course:'catering'},student.cookie));hotel=ok(await call('/student/api/enter',{course:'hotel'},student.cookie));
    assert.equal(catering.body.url,'/catering/student');
    const state=ok(await call('/catering/api/snapshot',undefined,catering.cookie)).body;
    assert.equal(state.user.id,'OLD100');assert.equal(state.state.restaurant,'绑定必须保留的餐厅');assert.equal(state.submissions[0].score,94);
    assert.equal(ok(await call('/hotel/api/session',undefined,hotel.cookie)).body.session.id,'OLD100');
    assert.equal((await call('/hotel/api/teacher',undefined,hotel.cookie)).status,403);
  });
  await t.test('restart recovers accounts, roles, bindings and sessions',async()=>{
    await stop();await start();
    const session=ok(await call('/student/api/session',undefined,student.cookie));assert.equal(session.body.bindings.length,2);
    assert.equal((await call('/student/api/login',{username:'NEW100',password:'StudentPass123!',role:'teacher'})).status,403);
    assert.equal(ok(await call('/teacher/api/login',{username:'TEACHER1',password:'StudentPass123!',role:'teacher'})).body.user.role,'teacher');
    const outsider=ok(await call('/student/api/register',account('OUTSIDER')));
    assert.equal((await call('/student/api/bind',{course:'catering',mode:'existing',localId:'OLD100',password:'OriginalPass123'},outsider.cookie)).status,409);
    const login=ok(await call('/student/api/login',{username:'NEW100',password:'StudentPass123!',role:'student'}));
    assert.equal(login.body.bindings.length,2);
    assert.equal((await call('/student/api/login',{username:'NEW100',password:'wrong'})).status,401);
    catering=ok(await call('/student/api/enter',{course:'catering'},student.cookie));
    assert.equal(ok(await call('/catering/api/snapshot',undefined,catering.cookie)).body.submissions[0].score,94);
    if(mock){const keys=[...mock.objects.keys()].filter(k=>k.includes('/accounts/'));assert.ok(keys.length>1);for(const key of keys)assert.ok(!mock.objects.get(key).includes(Buffer.from('StudentPass123!')));}
  });

  await t.test('role endpoints, cookie substitution, private administration and legacy approval',async()=>{
    await stop();await start();
    assert.match(ok(await call('/teacher/')).body,/教师登录/);
    assert.match(ok(await call('/student/')).body,/学生登录与注册/);
    assert.equal((await call('/teacher/api/login',{username:'NEW100',password:'StudentPass123!'})).status,403);
    assert.equal((await call('/student/api/login',{username:'TEACHER1',password:'StudentPass123!'})).status,403);
    const forged=student.cookie.replace('teaching_student=','teaching_teacher=');
    assert.equal((await call('/teacher/api/session',undefined,forged)).status,401);
    assert.equal((await call('/teacher/api/enter',{course:'hotel',role:'teacher'},forged)).status,401);
    assert.equal((await call('/teacher/api/enter',{course:'hotel'},student.cookie)).status,401);
    for(const prefix of ['accounts','student','teacher'])assert.notEqual((await call('/'+prefix+'/api/admin/teachers',{...account('EVIL','teacher'),action:'create'},student.cookie,{'X-Console-Admin':'true'})).status,200);
    await assert.rejects(admin({action:'approve',username:'NEW100'}),/不能提升学生权限/);
    await assert.rejects(admin({...account('NEW100','teacher'),action:'create'}),/不能覆盖/);
    assert.equal((await call('/teacher/api/login',{username:'LEGACYTEACHER',password:'StudentPass123!'})).status,403);
    assert.equal((await admin({action:'list'})).teachers.find(t=>t.username==='LEGACYTEACHER').approved,false);
    await admin({action:'approve',username:'LEGACYTEACHER'});
    ok(await call('/teacher/api/login',{username:'LEGACYTEACHER',password:'StudentPass123!'}));
    assert.equal(fs.statSync(env.ACCOUNTS_ADMIN_SOCKET).mode & 0o777,0o600);
    await stop();await start();
    ok(await call('/teacher/api/login',{username:'LEGACYTEACHER',password:'StudentPass123!'}));
  });
  await t.test('new student enrollment, unique teacher identity and logout revocation',async()=>{
    const fresh=ok(await call('/student/api/register',account('FRESH100')));
    for(const course of ['catering','hotel']) {
      const launch=ok(await call('/student/api/enter',{course},fresh.cookie));
      assert.equal(launch.body.url,`/${course}/student`);
      ok(await call('/student/api/enter',{course},fresh.cookie)); // A repeat never duplicates the identity.
    }
    assert.equal(ok(await call('/student/api/session',undefined,fresh.cookie)).body.bindings.length,2);
    const collision=ok(await call('/student/api/register',account('OLD100')));
    assert.equal((await call('/student/api/enter',{course:'catering'},collision.cookie)).status,409);
    assert.equal(ok(await call('/student/api/session',undefined,collision.cookie)).body.bindings.length,0);
    for(const course of ['catering','hotel']){
      const launch=ok(await call('/teacher/api/enter',{course},teacher.cookie));assert.equal(launch.body.url,`/${course}/teacher`);
      const info=ok(await call(course==='catering'?'/catering/api/snapshot':'/hotel/api/session',undefined,launch.cookie)).body;
      const user=info.user||info.session;assert.match(user.id,/^t_[a-f0-9]{32}$/);assert.equal(user.name,'统一账号测试');
      assert.equal((await call('/'+course+'/api/chat/capabilities',undefined,launch.cookie)).status,200);
    }
    const hotelTeacher=ok(await call('/teacher/api/enter',{course:'hotel'},teacher.cookie));
    const classroom=ok(await call('/hotel/api/classes',undefined,hotelTeacher.cookie)).body.classes[0];
    ok(await call('/hotel/api/classes',{...classroom,enrollment:false},hotelTeacher.cookie));
    const closed=ok(await call('/student/api/register',account('CLOSED100')));
    assert.equal((await call('/student/api/enter',{course:'hotel'},closed.cookie)).status,423);
    assert.equal(ok(await call('/student/api/session',undefined,closed.cookie)).body.bindings.length,0);
    ok(await call('/hotel/api/classes',{...classroom,enrollment:true},hotelTeacher.cookie));
    ok(await call('/student/api/enter',{course:'hotel'},closed.cookie));
    ok(await call('/student/api/logout',{},student.cookie));
    assert.equal((await call('/student/api/session',undefined,student.cookie)).status,401);
    assert.equal((await call('/catering/api/snapshot',undefined,catering.cookie)).status,401);
    assert.equal((await call('/hotel/api/session',undefined,hotel.cookie)).status,401);
  });
});
