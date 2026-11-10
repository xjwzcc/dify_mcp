'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process'),{once}=require('node:events');
const {manage}=require('../scripts/manage-teachers.cjs');
for(const backend of ['nas','oss']) test(`teacher administrator permissions and lifecycle (${backend})`,{timeout:90000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'teacher-admin-'));
  const clockFile=path.join(dir,'clock.cjs'),offsetFile=path.join(dir,'offset');
  fs.writeFileSync(offsetFile,'0');
  fs.writeFileSync(clockFile,`const fs=require('node:fs'),now=Date.now;Date.now=()=>now()+Number(fs.readFileSync(${JSON.stringify(offsetFile)},'utf8'));`);
  const mock=backend==='oss'?await require('./helpers/oss-mock.cjs').createMock():null;
  const env={...process.env,...mock?.env,NODE_ENV:'test',STORAGE_BACKEND:backend,DATA_DIR:dir,ENABLE_MCP:'0',ENABLE_TEACHER_CHAT:'0',
    HOST:'127.0.0.1',PORT:'19880',CATERING_PORT:'19881',HOTEL_PORT:'19882',ACCOUNTS_PORT:'19884',
    ACCOUNTS_ADMIN_SOCKET:path.join(dir,'admin.sock'),TEACHER_PASSWORD:'LegacyTestTeacher123',CATERING_CLASS_CODE:'ADMINMENU',HOTEL_CLASS_CODE:'ADMINHOTEL',NODE_OPTIONS:`--require ${clockFile}`};
  if(mock)await require('../scripts/init-oss.cjs').initOss({empty:true},env);
  let child,log='';
  async function start(){
    child=spawn(process.execPath,['server.cjs'],{cwd:path.resolve(__dirname,'..'),env,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',c=>log+=c);child.stderr.on('data',c=>log+=c);
    for(let i=0;i<150;i++){if(child.exitCode!==null)throw Error(log);try{if((await fetch('http://127.0.0.1:19880/healthz')).ok)return;}catch{}await new Promise(r=>setTimeout(r,60));}throw Error(log);
  }
  async function stop(){if(child?.exitCode===null){const end=once(child,'exit');child.kill('SIGTERM');await end;}}
  t.after(async()=>{await stop();await mock?.close();fs.rmSync(dir,{recursive:true,force:true});});
  async function call(route,data,cookie,headers={}){
    const r=await fetch('http://127.0.0.1:19880'+route,{method:data===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...headers},body:data===undefined?undefined:JSON.stringify(data)});
    const text=await r.text();return{status:r.status,body:r.headers.get('content-type')?.includes('application/json')?JSON.parse(text):text,cookie:r.headers.getSetCookie()[0]?.split(';')[0]};
  }
  const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body));return r;};
  const endpoint='/teacher/api/admin/teachers';
  await start();
  const consoleAdmin=b=>manage(b,env.ACCOUNTS_ADMIN_SOCKET);
  for(const username of ['teacher_admin','normal_teacher'])await consoleAdmin({action:'create',username,name:'老师',password:'TeacherTest123!'});
  const root=ok(await call('/teacher/api/login',{username:'teacher_admin',password:'TeacherTest123!'}));
  const normal=ok(await call('/teacher/api/login',{username:'normal_teacher',password:'TeacherTest123!'}));
  const student=ok(await call('/student/api/register',{username:'STUDENT1',name:'学生',password:'StudentTest123!',confirmPassword:'StudentTest123!',canManageTeachers:true}));
  await t.test('only approved teacher_admin may access management; no role escalation',async()=>{
    assert.equal(root.body.user.canManageTeachers,true);assert.equal(normal.body.user.canManageTeachers,false);assert.equal(student.body.user.canManageTeachers,false);
    assert.equal((await call(endpoint)).status,401);
    assert.equal((await call(endpoint,undefined,normal.cookie)).status,403);
    assert.equal((await call(endpoint,undefined,student.cookie.replace('teaching_student=','teaching_teacher='))).status,401);
    assert.equal((await call('/student/api/admin/teachers',undefined,student.cookie)).status,403);
    for(const action of ['create','update','enable','disable','reset-password','approve'])
      assert.equal((await call(endpoint,{action,username:'normal_teacher',role:'admin',canManageTeachers:true},normal.cookie,{'X-Console-Admin':'true'})).status,403);
    assert.equal((await call(endpoint,{action:'create',username:'evilteacher',name:'坏'},root.cookie,{Origin:'https://other.test'})).status,403);
    for(const username of ['teacher_admin','TEACHER_ADMIN'])assert.equal((await call('/student/api/register',{username,name:'冒充',password:'StudentTest123!',confirmPassword:'StudentTest123!'})).status,400);
    assert.equal((await call(endpoint,{action:'create',username:'STUDENT1',name:'老师'},root.cookie)).status,409);
    assert.equal((await call(endpoint,{action:'enable',username:'STUDENT1'},root.cookie)).status,403);
    assert.equal((await call(endpoint,{action:'create',username:'evilteacher',name:'老师',canManageTeachers:true},root.cookie)).status,403);
    for(const action of ['create','update','disable','enable','reset-password'])assert.equal((await call(endpoint,{action,username:'teacher_admin',name:'改名'},root.cookie)).status,403);
    assert.match(ok(await call('/teacher/admin/')).body,/教师账号管理/);
    assert.equal((await call('/student/admin/')).status,404);
  });
  let generated,changed,first,second,catering,hotel;
  await t.test('create, rename, reset and revoke all existing teacher/course sessions',async()=>{
    generated=ok(await call(endpoint,{action:'create',username:'web_teacher',name:'新教师'},root.cookie)).body;
    assert.match(generated.password,/^[A-Za-z0-9_-]{24}$/);assert.equal(generated.user.canManageTeachers,false);assert.equal(generated.approved,true);
    assert.equal((await call(endpoint,{action:'create',username:'web_teacher',name:'覆盖'},root.cookie)).status,409);
    first=ok(await call('/teacher/api/login',{username:'web_teacher',password:generated.password}));
    second=ok(await call('/teacher/api/login',{username:'web_teacher',password:generated.password}));
    catering=ok(await call('/teacher/api/enter',{course:'catering'},first.cookie));
    hotel=ok(await call('/teacher/api/enter',{course:'hotel'},second.cookie));
    ok(await call(endpoint,{action:'update',username:'web_teacher',name:'更名教师'},root.cookie));
    assert.equal(ok(await call('/teacher/api/session',undefined,first.cookie)).body.user.name,'更名教师');
    changed=ok(await call(endpoint,{action:'reset-password',username:'web_teacher'},root.cookie)).body.password;
    assert.notEqual(changed,generated.password);
    for(const cookie of [first.cookie,second.cookie])assert.equal((await call('/teacher/api/session',undefined,cookie)).status,401);
    assert.equal((await call('/catering/api/snapshot',undefined,catering.cookie)).status,401);
    assert.equal((await call('/hotel/api/session',undefined,hotel.cookie)).status,401);
    assert.equal((await call('/teacher/api/login',{username:'web_teacher',password:generated.password})).status,401);
    first=ok(await call('/teacher/api/login',{username:'web_teacher',password:changed}));
    assert.equal(first.body.user.canManageTeachers,false);
    const list=ok(await call(endpoint,undefined,root.cookie)).body;
    assert.equal(JSON.stringify(list).includes(changed),false);assert.equal(JSON.stringify(list).includes('provision'),false);
  });
  // Restart also resets the login rate window, and exercises remote durable recovery.
  await stop();await start();
  await t.test('disable persists across restart; re-enable keeps identity and data',async()=>{
    ok(await call(endpoint,undefined,root.cookie));
    hotel=ok(await call('/teacher/api/enter',{course:'hotel'},first.cookie));
    const binding=ok(await call('/teacher/api/session',undefined,first.cookie)).body.bindings;
    ok(await call(endpoint,{action:'disable',username:'web_teacher'},root.cookie));
    assert.equal((await call('/hotel/api/session',undefined,hotel.cookie)).status,401);
    assert.equal((await call('/teacher/api/session',undefined,first.cookie)).status,401);
    assert.equal((await call('/teacher/api/login',{username:'web_teacher',password:changed})).status,403);
    await stop();await start();
    const list=ok(await call(endpoint,undefined,root.cookie)).body.teachers;
    assert.equal(list.find(t=>t.username==='web_teacher').approved,false);
    changed=ok(await call(endpoint,{action:'reset-password',username:'web_teacher'},root.cookie)).body.password;
    assert.equal((await call('/teacher/api/login',{username:'web_teacher',password:changed})).status,403);
    ok(await call(endpoint,{action:'enable',username:'web_teacher'},root.cookie));
    const login=ok(await call('/teacher/api/login',{username:'web_teacher',password:changed}));
    assert.equal(login.body.user.name,'更名教师');assert.deepEqual(login.body.bindings,binding);
    assert.equal((await call('/teacher/api/session',undefined,first.cookie)).status,401);
    if(mock)for(const value of mock.objects.values())assert.equal(value.includes(Buffer.from(changed)),false);
  });
  await t.test('revokes long-lived hotel sessions after account sessions have expired and been pruned',async()=>{
    const teacher=ok(await call('/teacher/api/login',{username:'web_teacher',password:changed}));
    const launch=ok(await call('/teacher/api/enter',{course:'hotel'},teacher.cookie));
    fs.writeFileSync(offsetFile,String(9*3600000));
    const currentRoot=ok(await call('/teacher/api/login',{username:'teacher_admin',password:'TeacherTest123!'}));
    assert.equal((await call('/teacher/api/session',undefined,teacher.cookie)).status,401);
    ok(await call('/hotel/api/session',undefined,launch.cookie));
    ok(await call(endpoint,{action:'disable',username:'web_teacher'},currentRoot.cookie));
    assert.equal((await call('/hotel/api/session',undefined,launch.cookie)).status,401);
  });
});
