// 真实HTTP集成测试；使用独立临时SQLite数据库，不写入课堂数据库。
const {spawn}=require('node:child_process'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'hotel-hr-test-')),port=18788,base='http://127.0.0.1:'+port;
let child;
async function start(){child=spawn(process.execPath,[path.join(__dirname,'server.cjs')],{env:{...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:temp},stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Startup timeout')),10000);child.stdout.on('data',d=>{if(d.toString().includes('ready')){clearTimeout(timer);resolve();}});child.once('exit',c=>reject(Error('Server exit '+c)));});}
async function stop(){if(!child||child.exitCode!==null)return;const c=child;await new Promise(resolve=>{c.once('exit',resolve);c.kill();});}
async function call(route,{cookie,method='GET',data}={}){const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(data?{body:JSON.stringify(data)}:{})});const b=r.headers.get('content-type')?.includes('application/json')?await r.json():null;return{status:r.status,body:b,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
async function login(id,name,password='student123'){return call('/api/login',{method:'POST',data:{role:'student',id,name,password,classCode:'HR2026'}});}
(async()=>{try{
 await start();assert.equal((await call('/api/teacher')).status,401);
 const t=await call('/api/login',{method:'POST',data:{role:'teacher',password:'Hotel2026!'}});assert.equal(t.status,200);const teacher=t.cookie;
 const a=await login('T1001','测试甲'),b=await login('T1002','测试乙');assert.equal(a.status,200);assert.equal(b.status,200);const ca=a.cookie,cb=b.cookie;
 assert.equal((await login('T1001','测试甲','wrongpw')).status,401);
 assert.equal((await call('/api/teacher',{cookie:ca})).status,403);
 assert.equal(a.body.student.state.employees.length,250);
 const s=a.body.student.state;s.employees[0].base=5123;s.taskResults={task1:{score:100,date:new Date().toISOString()}};
 s.jobs[0].duties='办理入住退房、核对PMS账务并协调房态';s.jobs[0].questions='高峰期客房未准备好，如何协调？';
 s.schedulePolicies={'2026-10-19_前厅部':{occupancy:85,early:4,middle:4,night:3,maxHours:40,reason:'按晚间抵离客流配置'}};
 s.leaveRequests=[{employeeId:'E0002',start:'2026-10-19',end:'2026-10-25',status:'已批准',coverId:'E0001'}];
 s.exitCases={E0011:{application:{type:'一般辞职（非试用期）',date:'2026-10-20',lastDay:'2026-11-19',noticeDays:30}}};
 let put=await call('/api/state',{cookie:ca,method:'PUT',data:{studentId:'T1001',version:1,state:s,logs:[{id:'op1',action:'调整工资',detail:'5123'}]}});assert.equal(put.status,200);assert.equal(put.body.version,2);assert.deepEqual(put.body.taskResults,{});
 const read=await call('/api/session',{cookie:ca});assert.equal(read.body.student.state.employees[0].base,5123);
 assert.equal((await call('/api/session',{cookie:cb})).body.student.state.employees[0].base,4300);
 assert.equal((await call('/api/state',{cookie:ca,method:'PUT',data:{studentId:'T1001',version:1,state:s}})).status,409);
 assert.equal((await call('/api/tasks/submit',{cookie:ca,method:'POST',data:{studentId:'T1001',id:'task1',version:2}})).status,400);
 const result=await call('/api/teacher',{cookie:teacher});assert.equal(result.body.students.length,2);assert(result.body.logs.some(l=>l.action==='调整工资'&&l.student==='T1001'));
 const ev=await fetch(base+'/api/events',{headers:{Cookie:teacher}});const reader=ev.body.getReader();await reader.read();
 assert.equal((await call('/api/assignments',{cookie:teacher,method:'POST',data:{title:'集成测试：完成招聘后提交评分'}})).status,200);
 const event=await reader.read();assert(Buffer.from(event.value).toString().includes('assignments'));await reader.cancel();
 assert((await call('/api/assignments',{cookie:ca})).body.assignments.some(x=>x.title.includes('集成测试')));
 // 教师设计 → 定向发布 → 学生提交 → 退回 → 重交 → 评分，以及留言隐私隔离。
 const orderData={title:'前台接待岗位设计测试工单',objective:'根据岗位职责分析前台接待的工作任务并给出适岗证据。',steps:'完成岗位职责设计与招聘条件核对\n记录简历筛选证据与追问问题',rubric:'岗位设计30；证据分析40；流程记录30',module:'recruit',maxScore:100,target:'T1001',due:'',status:'草稿',requireCompletion:false};
 assert.equal((await call('/api/workorders',{cookie:ca,method:'POST',data:orderData})).status,403);
 const created=await call('/api/workorders',{cookie:teacher,method:'POST',data:orderData});assert.equal(created.status,200);const orderId=created.body.order.id;
 assert(!(await call('/api/workorders',{cookie:ca})).body.orders.some(o=>o.id===orderId));
 assert.equal((await call('/api/workorders',{cookie:teacher,method:'POST',data:{...orderData,id:orderId,status:'已发布'}})).status,200);
 assert((await call('/api/workorders',{cookie:ca})).body.orders.some(o=>o.id===orderId));assert(!(await call('/api/workorders',{cookie:cb})).body.orders.some(o=>o.id===orderId));
 const submission={orderId,studentId:'T1001',evidence:'我根据酒店接待职责设计了入住退房、账务核对与宾客沟通要求，并结合候选人经历判断岗位匹配，安排结构化面试核实差距。'};
 assert.equal((await call('/api/workorders/submit',{cookie:cb,method:'POST',data:{...submission,studentId:'T1002'}})).status,403);
 assert.equal((await call('/api/workorders/submit',{cookie:ca,method:'POST',data:submission})).status,200);
 assert.equal((await call('/api/workorders/submit',{cookie:ca,method:'POST',data:submission})).status,409);
 assert.equal((await call('/api/workorders/review',{cookie:teacher,method:'POST',data:{orderId,studentId:'T1001',attempt:1,status:'已评价',score:101,feedback:'超过满分的分数不应保存'}})).status,400);
 assert.equal((await call('/api/workorders/review',{cookie:teacher,method:'POST',data:{orderId,studentId:'T1001',attempt:1,status:'退回修改',score:65,feedback:'请补充岗位职责对应的具体简历证据和面试评分标准。'}})).status,200);
 assert.equal((await call('/api/workorders/submit',{cookie:ca,method:'POST',data:{...submission,evidence:submission.evidence+'根据教师反馈，补充PMS操作、基础英语和高峰期投诉处理的评价标准。'}})).status,200);
 assert.equal((await call('/api/workorders/review',{cookie:teacher,method:'POST',data:{orderId,studentId:'T1001',attempt:1,status:'已评价',score:90,feedback:'过期批阅应被拒绝'}})).status,409);
 assert.equal((await call('/api/workorders/review',{cookie:teacher,method:'POST',data:{orderId,studentId:'T1001',attempt:2,status:'已评价',score:92,feedback:'岗位要求与证据对应清楚，改进到位。'}})).status,200);
 const gradedOrder=(await call('/api/workorders',{cookie:ca})).body.submissions.find(s=>s.orderId===orderId);assert.equal(gradedOrder.score,92);assert.equal(gradedOrder.history.length,1);
 assert.equal((await call('/api/classroom/messages',{cookie:ca,method:'POST',data:{studentId:'T1001',content:'老师，岗位经验不足时如何设计补充测评问题？'}})).status,200);
 assert.equal((await call('/api/classroom/messages',{cookie:teacher,method:'POST',data:{studentId:'T1001',content:'可采用情景模拟和操作测试，先明确评分标准。'}})).status,200);
 assert.equal((await call('/api/classroom/messages',{cookie:cb})).body.messages.length,0);assert.equal((await call('/api/classroom/messages',{cookie:ca})).body.messages.length,2);
 const state=read.body.student.state;state.jobs[0].published=true;state.candidates.filter(c=>c.job==='J0').forEach(c=>{c.score=80;if(c.skill>=75&&c.exp>=1){c.stage='已录用';c.date='2026-10-22T10:00';}});
 put=await call('/api/state',{cookie:ca,method:'PUT',data:{studentId:'T1001',version:2,state,logs:[{id:'op1',action:'调整工资',detail:'不应重复记录'}]}});assert.equal(put.status,200);
 const grade=await call('/api/tasks/submit',{cookie:ca,method:'POST',data:{studentId:'T1001',version:3,id:'task1'}});assert.equal(grade.status,200);assert.equal(grade.body.student.state.taskResults.task1.score,100);
 const latest=await call('/api/teacher/student?id=T1001',{cookie:teacher});assert.equal(latest.status,200);assert.equal(latest.body.logs.filter(l=>l.action==='调整工资').length,1);
 const backup=await fetch(base+'/api/teacher/backup',{headers:{Cookie:teacher}});assert.equal(backup.status,200);assert(Buffer.from(await backup.arrayBuffer()).subarray(0,15).toString().includes('SQLite format 3'));
 const studentLogin=await login('T1001','测试甲');assert.equal(studentLogin.body.student.state.employees[0].base,5123);
 await stop();await start();const restored=await call('/api/session',{cookie:ca});assert.equal(restored.status,200);assert.equal(restored.body.student.state.employees[0].base,5123);assert.equal(restored.body.student.state.taskResults.task1.score,100);
 assert.equal((await call('/api/teacher',{cookie:teacher})).body.students.length,2);
 assert.equal(restored.body.student.state.schedulePolicies['2026-10-19_前厅部'].night,3);
 assert.equal(restored.body.student.state.exitCases.E0011.application.noticeDays,30);
 assert.equal(restored.body.student.state.jobs[0].duties,s.jobs[0].duties);
 assert.equal((await call('/api/classroom/messages',{cookie:ca})).body.messages.length,2);
 assert.equal((await call('/api/workorders',{cookie:ca})).body.submissions.find(s=>s.orderId===orderId).score,92);
 assert.equal((await call('/api/state',{cookie:cb,method:'PUT',data:{studentId:'T1001',version:1,state}})).status,409);
 assert.equal((await call('/api/teacher/reset-password',{cookie:teacher,method:'POST',data:{id:'T1002',password:'newpass123'}})).status,200);
 assert.equal((await call('/api/session',{cookie:cb})).status,401);assert.equal((await login('T1002','测试乙','newpass123')).status,200);
 assert.equal((await call('/api/teacher/change-password',{cookie:teacher,method:'POST',data:{current:'Hotel2026!',password:'teachernew123'}})).status,200);
 assert.equal((await call('/api/login',{method:'POST',data:{role:'teacher',password:'teachernew123'}})).status,200);
 const migrant=await login('T1003','旧档学生');const old=grade.body.student.state;
 const migrated=await call('/api/migrate',{cookie:migrant.cookie,method:'POST',data:{id:'T1003',name:'旧档学生',state:old}});assert.equal(migrated.status,200);assert.equal(migrated.body.student.state.taskResults.task1.score,100);
 assert.equal((await call('/api/migrate',{cookie:migrant.cookie,method:'POST',data:{id:'T1003',name:'旧档学生',state:old}})).status,409);
 console.log('PASS: SQLite writes, student isolation, auth, server-side grading, teacher visibility, SSE push, assignments, stale-write protection, log idempotency, database backup, session/state/grade persistence across restart, password reset.');
 }finally{await stop();fs.rmSync(temp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
