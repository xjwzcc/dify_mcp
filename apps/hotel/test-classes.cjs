// 独立临时数据库验证班级隔离和服务器阶段权限，不修改真实课堂数据。
const {spawn}=require('node:child_process'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'hotel-classes-')),port=18789;
let child;
async function call(route,cookie,method='GET',data){const r=await fetch('http://127.0.0.1:'+port+route,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(data?{body:JSON.stringify(data)}:{})});return{status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
async function start(){child=spawn(process.execPath,[path.join(__dirname,'server.cjs')],{env:{...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:temp},stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('启动超时')),10000);child.stdout.on('data',d=>{if(d.toString().includes('ready')){clearTimeout(timer);resolve();}});child.once('exit',reject);});}
async function stop(){if(child?.exitCode===null)await new Promise(resolve=>{child.once('exit',resolve);child.kill();});}
(async()=>{try{
 await start();const teacher=(await call('/api/login',null,'POST',{role:'teacher',password:'Hotel2026!'})).cookie;
 const login=(id,classId,code)=>call('/api/login',null,'POST',{id,name:id,password:'student123',classId,classCode:code});
 const legacy=await login('legacy',undefined,'HR2026');assert.equal(legacy.status,200);assert.equal(legacy.body.session.classId,'default');
 const original=legacy.body.student.state;
 const base={name:'酒店一班',code:'CLASS1',stage:'招聘实训',entry:true,enrollment:true,write:true,submit:true,score:true,modules:['recruit']};
 assert.equal((await call('/api/classes',teacher,'POST',base)).status,200);
 let list=(await call('/api/classes',teacher)).body.classes,c=list.find(c=>c.name===base.name);
 const b={...base,name:'酒店二班',code:'CLASS2',stage:'课前关闭',entry:false,modules:[]};await call('/api/classes',teacher,'POST',b);
 const c2=(await call('/api/classes',teacher)).body.classes.find(c=>c.name===b.name);
 assert.equal((await login('blocked',c2.id,'CLASS2')).status,423);
 assert.equal((await login('wrong',c.id,'CLASS2')).status,403);
 const a=await login('classA',c.id,'CLASS1'),cookie=a.cookie;assert.equal(a.status,200);assert.equal(a.body.session.access.code,undefined);
 assert.equal((await call('/api/classes',cookie)).status,403);assert.equal(JSON.stringify((await call('/api/classes/public')).body).includes('CLASS1'),false);
 assert.equal((await login('classA','default','HR2026')).status,403);
 const s=a.body.student.state;s.jobs[0].duties='前台岗位要求';
 let put=await call('/api/state',cookie,'PUT',{studentId:'classA',version:1,state:s,logs:[]});assert.equal(put.status,200,JSON.stringify(put.body));
 s.pay.nightRate=99;assert.equal((await call('/api/state',cookie,'PUT',{studentId:'classA',version:2,state:s,logs:[]})).status,423);s.pay.nightRate=60;
 c={...c,write:false,submit:false,score:false,stage:'收卷只读'};await call('/api/classes',teacher,'POST',c);
 assert.equal((await call('/api/state',cookie,'PUT',{studentId:'classA',version:2,state:s,logs:[]})).status,423);
 assert.equal((await call('/api/tasks/submit',cookie,'POST',{studentId:'classA',id:'task1',version:2})).status,423);
 const order={title:'一班招聘岗位设计',objective:'设计本班前台接待岗位并完成能力要求分析',steps:'编写岗位说明书并完成甄选证据分析',rubric:'岗位职责与能力要求100分',module:'recruit',maxScore:100,target:'class:'+c.id,status:'已发布',requireCompletion:false,due:''};
 const saved=await call('/api/workorders',teacher,'POST',order);assert.equal(saved.status,200);const orderId=saved.body.order.id;
 assert.equal((await call('/api/workorders',legacy.cookie)).body.orders.some(o=>o.id===orderId),false);
 assert.equal((await call('/api/workorders',cookie)).body.orders.some(o=>o.id===orderId),true);
 assert.equal((await call('/api/classroom/messages',teacher,'POST',{studentId:'class:'+c.id,content:'一班开始招聘实训，请先核对岗位职责。'})).status,200);
 assert.equal((await call('/api/classroom/messages',cookie)).body.messages.length,1);
 assert.equal((await call('/api/classroom/messages',legacy.cookie)).body.messages.length,0);
 assert.equal((await call('/api/workorders/submit',cookie,'POST',{orderId,studentId:'classA',evidence:'依据岗位设计完成前台职责分析与能力匹配评价，记录候选人的服务能力证据，并制定结构化问题。'})).status,423);
 c={...c,entry:false};await call('/api/classes',teacher,'POST',c);
 assert.equal((await call('/api/workorders',cookie)).status,423);assert.equal((await call('/api/session',cookie)).body.session.access.entry,false);
 assert.equal((await login('classA',c.id,'CLASS1')).status,423);assert.equal((await call('/api/session',legacy.cookie)).body.session.access.entry,true);
 c={...c,entry:true,enrollment:false,write:true,score:true,submit:true};await call('/api/classes',teacher,'POST',c);
 assert.equal((await login('newA',c.id,'CLASS1')).status,423);assert.equal((await login('classA',c.id,'CLASS1')).status,200);
 assert.equal((await call('/api/state',cookie,'PUT',{studentId:'classA',version:2,state:s,logs:[]})).status,200);
 c={...c,modules:['relations'],stage:'员工关系'};await call('/api/classes',teacher,'POST',c);s.employees.find(e=>e.id==='E0011').ot=20;
 assert.equal((await call('/api/state',cookie,'PUT',{studentId:'classA',version:3,state:s,logs:[]})).status,200);
 s.employees[0].base=99999;assert.equal((await call('/api/state',cookie,'PUT',{studentId:'classA',version:4,state:s,logs:[]})).status,423);
 await call('/api/classes/move',teacher,'POST',{studentId:'legacy',classId:c2.id});assert.deepEqual((await call('/api/session',legacy.cookie)).body.student.state,original);
 assert.equal((await call('/api/session',legacy.cookie)).body.session.access.entry,false);
 await stop();await start();assert.equal((await call('/api/session',cookie)).body.session.access.enrollment,false);assert.equal((await call('/api/session',legacy.cookie)).body.session.classId,c2.id);
 console.log('PASS: 旧账号默认归班、班级独立入口、口令隔离、禁止自行换班、在用会话关闭、只读保存锁、模块字段锁、工单提交锁、评分锁、专班工单可见性、新生注册开关、归班保留存档、重启持久化。');
 }catch(e){console.error(e);process.exitCode=1;}finally{await stop();fs.rmSync(temp,{recursive:true,force:true});}})();
