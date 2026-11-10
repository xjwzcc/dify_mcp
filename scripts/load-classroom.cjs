#!/usr/bin/env node
'use strict';
// Always launches its own localhost application with newly created disposable data.
// No remote target option: this harness cannot write to the production database.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process'),{once}=require('node:events');
const crypto=require('node:crypto'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i+=2){if(!['--root','--out','--rounds','--think-ms','--data-parent'].includes(args[i])||!args[i+1])throw Error('invalid arguments');options[args[i].slice(2)]=args[i+1];}
const root=path.resolve(options.root||path.join(__dirname,'..'));
const out=path.resolve(options.out||path.join(os.tmpdir(),'classroom-load-'+Date.now()+'.json'));
const rounds=Number(options.rounds||60),think=Number(options['think-ms']||2000);
if(!Number.isInteger(rounds)||rounds<1||rounds>300||!Number.isInteger(think)||think<0||think>10000)throw Error('invalid duration');
const base='http://127.0.0.1:19100',data=fs.mkdtempSync(path.join(path.resolve(options['data-parent']||os.tmpdir()),'shixunlab-load-'));
const socket=path.join(data,'admin.sock'),password=crypto.randomBytes(20).toString('hex');
const report={started:new Date().toISOString(),node:process.version,platform:os.platform(),cpuCount:os.cpus().length,totalMemoryMiB:Math.round(os.totalmem()/1048576),students:30,teachers:2,rounds,thinkMs:think,scope:'isolated localhost application; generator runs on the same host; excludes public bandwidth, TLS and browser rendering',groups:{},errors:[],checks:{},resources:[]};
let child,log='',phase='setup',samples=[],monitor,started;
const states=Array.from({length:30},(_,i)=>({id:'LOADS'+String(i+1).padStart(3,'0'),role:'student',cookies:{}}));
const teachers=[{id:'LOADT1',role:'teacher',cookies:{}},{id:'LOADT2',role:'teacher',cookies:{}}];
function quantile(a,q){return a.length?Math.round(a[Math.max(0,Math.ceil(a.length*q)-1)]*100)/100:0;}
async function request(label,route,{user,course,body,method,measured=true}={}){
 const start=performance.now();let status=0,result;
 try{
  const r=await fetch(base+route,{method:method||(body?'POST':'GET'),headers:{'Content-Type':'application/json',...(user?{Cookie:user.cookies[course||'account']||''}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
  status=r.status;const raw=await r.text();result=raw?JSON.parse(raw):{};
  if(r.headers.get('set-cookie')&&user)user.cookies[course||'account']=r.headers.get('set-cookie').split(';')[0];
  if(!r.ok)throw Error('HTTP '+status+' '+(result.error||''));
  return result;
 }catch(e){if(measured&&phase!=='setup')report.errors.push({phase,label,status,message:e.message});throw e;}
 finally{if(measured&&phase!=='setup')samples.push({phase,label,ms:performance.now()-start,status,bytes:result?Buffer.byteLength(JSON.stringify(result)):0});}
}
async function start(){
 child=spawn(process.execPath,['server.cjs'],{cwd:root,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,NODE_ENV:'production',STORAGE_BACKEND:'nas',REQUIRE_NAS:'0',DATA_DIR:data,HOST:'127.0.0.1',PORT:'19100',CATERING_PORT:'19101',HOTEL_PORT:'19102',ACCOUNTS_PORT:'19104',ACCOUNTS_ADMIN_SOCKET:socket,ENABLE_MCP:'0',ENABLE_TEACHER_CHAT:'0',TEACHER_AGENT_MODE:'disabled',NODE_OPTIONS:'--max-old-space-size=192',TEACHER_PASSWORD:password,CATERING_CLASS_CODE:'LOADMENU',HOTEL_CLASS_CODE:'LOADHOTEL'}});
 child.stdout.on('data',b=>log=(log+b).slice(-20000));child.stderr.on('data',b=>log=(log+b).slice(-20000));
 for(let i=0;i<150;i++){if(child.exitCode!==null)throw Error('application exited: '+log);try{await request('health','/healthz',{measured:false});return;}catch{}await sleep(100);}
 throw Error('application startup timeout');
}
async function stop(){if(child&&child.exitCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}}
function resource(){
 if(os.platform()!=='linux'||!child)return;
 try{
  const pids=[child.pid],descendants=fs.readFileSync('/proc/'+child.pid+'/task/'+child.pid+'/children','utf8').trim().split(/\s+/).filter(Boolean).map(Number);pids.push(...descendants);
  let rss=0,ticks=0;for(const pid of pids){const s=fs.readFileSync('/proc/'+pid+'/stat','utf8').split(') ')[1].split(' ');ticks+=Number(s[11])+Number(s[12]);const m=fs.readFileSync('/proc/'+pid+'/status','utf8').match(/VmRSS:\s+(\d+)/);rss+=Number(m?.[1]||0);}
  const mem=fs.readFileSync('/proc/meminfo','utf8');report.resources.push({at:Date.now(),appRssMiB:Math.round(rss/1024*100)/100,appCpuTicks:ticks,hostMemAvailableMiB:Math.round(Number(mem.match(/MemAvailable:\s+(\d+)/)[1])/1024),hostLoad1:os.loadavg()[0]});
 }catch{}
}
// Preserve account cookies across enter responses (the two cookies have distinct paths).
async function session(user){await request('login','/'+user.role+'/api/login',{user,body:{username:user.id,password}});user.accountCookie=user.cookies.account;for(const course of ['hotel','catering']){await request('enter-'+course,'/'+user.role+'/api/enter',{user,body:{course}});user.cookies[course]=user.cookies.account;user.cookies.account=user.accountCookie;}}
async function studentRound(u,n){
 const h=await request('hotel-read','/hotel/api/session',{user:u,course:'hotel'});assert.equal(h.student.id,u.id);
 h.student.state.employees[0].base=5000+Number(u.id.slice(-3))*10+n;
 await request('hotel-save','/hotel/api/state',{user:u,course:'hotel',method:'PUT',body:{studentId:u.id,version:h.student.version,state:h.student.state,logs:[{id:'load-'+n,action:'压测保存',detail:'独立测试数据'}]}});
 const c=await request('catering-read','/catering/api/snapshot',{user:u,course:'catering'});assert.equal(c.user.id,u.id);
 c.state.restaurant='压测餐厅-'+u.id+'-'+n;
 await request('catering-save','/catering/api/state',{user:u,course:'catering',body:{state:c.state}});
 if(n===0)await request('submit','/catering/api/submit',{user:u,course:'catering',body:{taskId:'T1',content:'本次压力验证使用独立账号完成菜单分类与业务存档，核对订单信息和操作证据，并验证教师批阅结果保持正确。'}});
}
async function teacherRound(u,n,index){
 if(index===0){const h=await request('teacher-hotel-list','/hotel/api/teacher',{user:u,course:'hotel'});assert.equal(h.students.length,30);
 await request('teacher-student-detail','/hotel/api/teacher/student?id='+states[n%30].id,{user:u,course:'hotel'});
 if(n%10===0)await request('teacher-assignment','/hotel/api/assignments',{user:u,course:'hotel',body:{title:'压测专用课堂任务第'+n+'轮，请核对存档和业务记录。'}});
 }else{const c=await request('teacher-catering-list','/catering/api/snapshot',{user:u,course:'catering'});assert.equal(c.students.length,30);
 for(const s of c.submissions.filter(s=>s.status==='待批阅').slice(0,3))await request('teacher-review','/catering/api/review',{user:u,course:'catering',body:{id:s.id,score:90,status:'已评价',feedback:'压力验证测试批阅，数据仅用于独立压测副本。'}});
 }
}
async function main(){
 try{
  await start();
  for(const u of states)await request('register','/student/api/register',{body:{username:u.id,name:'压测学生'+u.id,password,confirmPassword:password}});
  const {manage}=require(path.join(root,'scripts/manage-teachers.cjs'));
  for(const u of teachers)await manage({action:'create',username:u.id,name:'压测教师'+u.id,password},socket);
  await stop();await start(); // setup registration must not consume the measured login budget
  // Provision course identities before the login burst, using real account/bridge APIs.
  for(const u of [...states,...teachers])await session(u);
  await stop();await start();
  monitor=setInterval(resource,500);resource();started=performance.now();phase='login';
  await Promise.all([...states,...teachers].map(session));report.checks.concurrentLogins=32;
  console.log('LOGIN_BURST_OK 30 students + 2 teachers');phase='operations';
  const jobs=[...states.map(async(u,index)=>{for(let n=0;n<rounds;n++){await studentRound(u,n);await sleep(think+(index%5)*30);}}),...teachers.map(async(u,index)=>{for(let n=0;n<rounds;n++){await teacherRound(u,n,index);await sleep(think);}})];
  const results=await Promise.allSettled(jobs);const failed=results.filter(r=>r.status==='rejected');if(failed.length)throw Error(failed.length+' virtual users failed: '+failed[0].reason.message);
  phase='verify';
  // Complete any outstanding reviews and verify all 30 final states independently.
  for(let n=0;n<10;n++)await teacherRound(teachers[1],n,1);
  for(const u of states){const h=await request('verify-hotel','/hotel/api/session',{user:u,course:'hotel'});assert.equal(h.student.state.employees[0].base,5000+Number(u.id.slice(-3))*10+rounds-1);const c=await request('verify-catering','/catering/api/snapshot',{user:u,course:'catering'});assert.equal(c.state.restaurant,'压测餐厅-'+u.id+'-'+(rounds-1));assert.equal(c.submissions[0].score,90);}
  report.checks.finalStudentStates=30;report.checks.reviewedSubmissions=30;
  await stop();await start();
  for(const u of states){const h=await request('restart-read','/hotel/api/session',{user:u,course:'hotel'});assert.equal(h.student.state.employees[0].base,5000+Number(u.id.slice(-3))*10+rounds-1);}
  report.checks.restartPersistentStudents=30;await stop();
  for(const file of ['accounts/accounts.sqlite','catering/emenu.sqlite','hotel/hotel.sqlite']){const db=new DatabaseSync(path.join(data,file),{readOnly:true});assert.equal(db.prepare('pragma integrity_check').get().integrity_check,'ok');db.close();}
  report.checks.integrityDatabases=3;report.passed=true;
 }catch(e){report.passed=false;report.failure=e.message;process.exitCode=1;}
 finally{
  clearInterval(monitor);report.elapsedSec=started?Math.round((performance.now()-started)/10)/100:0;
  await stop();
  for(const s of samples){const key=s.phase+':'+s.label;(report.groups[key]||=[]).push(s);}
  for(const [k,v]of Object.entries(report.groups)){const times=v.map(s=>s.ms).sort((a,b)=>a-b);report.groups[k]={requests:v.length,errors:v.filter(s=>s.status<200||s.status>=300).length,p50Ms:quantile(times,.5),p95Ms:quantile(times,.95),p99Ms:quantile(times,.99),maxMs:quantile(times,1),bodyBytes:v.reduce((n,s)=>n+s.bytes,0)};}
  report.requests=samples.length;report.httpErrors=samples.filter(s=>s.status<200||s.status>=300).length;
  report.latencyTargets={loginP95Ms:5000,operationP95Ms:1000};
  report.latencyTargetsMet=report.passed&&Object.entries(report.groups).filter(([k])=>k.startsWith('login:')||k.startsWith('operations:')).every(([k,v])=>v.p95Ms<=(k.startsWith('login:')?5000:1000));
  const cpu=[];for(let i=1;i<report.resources.length;i++){const a=report.resources[i-1],b=report.resources[i],ticks=b.appCpuTicks-a.appCpuTicks;if(ticks>=0)cpu.push(ticks*10/(b.at-a.at)*100);}
  report.appPeakCpuOneCorePct=Math.round(Math.max(0,...cpu));
  if(report.resources.length){report.appPeakRssMiB=Math.max(...report.resources.map(s=>s.appRssMiB));report.hostMinAvailableMiB=Math.min(...report.resources.map(s=>s.hostMemAvailableMiB));}
  report.ended=new Date().toISOString();fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  fs.rmSync(data,{recursive:true,force:true});console.log('CLASSROOM_LOAD_RESULT '+JSON.stringify({...report,resources:undefined}));console.log('REPORT '+out);
 }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
