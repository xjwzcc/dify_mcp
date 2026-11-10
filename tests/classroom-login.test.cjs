'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process'),{once}=require('node:events');
test('32 classroom browser sessions retain a separate password-attempt budget',{timeout:60000},async t=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'classroom-login-'));
  const socket=path.join(data,'admin.sock'),base='http://127.0.0.1:19980';
  let child,output='';
  async function stop(){if(child&&child.exitCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}}
  t.after(async()=>{await stop();fs.rmSync(data,{recursive:true,force:true});});
  async function start(){
    child=spawn(process.execPath,['server.cjs'],{cwd:path.resolve(__dirname,'..'),stdio:['ignore','pipe','pipe'],env:{...process.env,
      STORAGE_BACKEND:'nas',NODE_ENV:'test',ENABLE_MCP:'0',ENABLE_TEACHER_CHAT:'0',DATA_DIR:data,ACCOUNTS_ADMIN_SOCKET:socket,
      PORT:'19980',CATERING_PORT:'19981',HOTEL_PORT:'19982',ACCOUNTS_PORT:'19984',HOST:'127.0.0.1',
      TEACHER_PASSWORD:'ClassroomTest2026!',CATERING_CLASS_CODE:'TESTMENU',HOTEL_CLASS_CODE:'TESTHOTEL'}});
    child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
    for(let i=0;i<80;i++){
      if(child.exitCode!==null)throw Error(output);
      try{if((await fetch(base+'/healthz')).ok)return;}catch{}
      await new Promise(r=>setTimeout(r,100));
    }
    throw Error('startup timeout '+output);
  }
  async function post(route,data,cookie){const r=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(data)});
    return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
  await start();
  assert.equal((await post('/student/api/register',{username:'CLASSROOM001',name:'测试学生',password:'student123',confirmPassword:'student123'})).status,200);
  await stop();await start();
  for(let i=0;i<32;i++){
    const login=await post('/student/api/login',{username:'CLASSROOM001',password:'student123'});
    assert.equal(login.status,200,'classroom login '+i);
    for(const course of ['hotel','catering'])assert.equal((await post('/student/api/enter',{course},login.cookie)).status,200,'course entry '+i+' '+course);
  }
  for(let i=0;i<8;i++)assert.equal((await post('/student/api/login',{username:'CLASSROOM001',password:'incorrect-password'})).status,401);
  assert.equal((await post('/student/api/login',{username:'CLASSROOM001',password:'incorrect-password'})).status,429,'password attempt limit remains 40');
});
