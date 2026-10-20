'use strict';
// 教学工单、提交、批阅与师生留言独立建表，兼容已有业务存档与400分情境成绩。
module.exports=function({sql,body,json,error,audit,changed,evaluate,now,classes}){
 sql.exec(`CREATE TABLE IF NOT EXISTS workorders(id TEXT PRIMARY KEY,record TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS submissions(order_id TEXT NOT NULL,student_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(order_id,student_id));
 CREATE TABLE IF NOT EXISTS classroom_messages(id TEXT PRIMARY KEY,student_id TEXT NOT NULL,sender TEXT NOT NULL,name TEXT NOT NULL,content TEXT NOT NULL,time TEXT NOT NULL);`);
 const crypto=require('node:crypto');
 const templates=[['recruit','招聘岗位设计与人才甄选','根据吴山苑酒店前厅服务标准，设计前台接待岗位并完成有依据的甄选。','岗位说明书与招聘条件\n简历差距分析与结构化面试问题\n面试评价及录用理由','岗位设计30；甄选证据40；流程记录30'],['schedule','旺季排班与缺岗协调','结合入住率、请假和技能覆盖，设计有休息安排的周排班与替岗方案。','设置每日最低在岗及夜班人数\n登记请假并落实替岗\n核对夜转早、连续出勤、加班和工资','人员覆盖40；休息安排30；补偿记录30'],['performance','绩效评价与改进面谈','用事实完成KPI评价，形成可执行的改进计划。','设定KPI与权重\n记录事实与员工意见\n落实改进责任人与复盘日期','证据匹配40；面谈质量30；改进计划30'],['relations','离职交接与加班争议处理','区分离职通知、工作交接、工资结算和争议救济，完整记录办理依据。','核对申请日期与通知规则\n逐项办理资产、业务和权限交接\n核实工资、争议与离职证明','程序合理30；结算依据40；员工权益30']];
 templates.forEach((x,i)=>{const id='WO'+(i+1);sql.prepare('INSERT OR IGNORE INTO workorders VALUES(?,?)').run(id,JSON.stringify({id,module:x[0],title:x[1],objective:x[2],steps:x[3],rubric:x[4],maxScore:100,due:'',target:'all',requireCompletion:false,status:'已发布',createdAt:now(),updatedAt:now()}));});
 const isTeacher=u=>{if(u.role!=='teacher')throw error(403,'仅教师可执行');};
 const read=id=>{const row=sql.prepare('SELECT record FROM workorders WHERE id=?').get(id);if(!row)throw error(404,'工单不存在');return JSON.parse(row.record);};
 const visible=(o,u)=>u.role==='teacher'||o.target==='all'||o.target==='class:'+u.class_id||o.target.split(',').includes(u.id);
 const linked={recruit:'task1',schedule:'task2',performance:'task3',relations:'task4'};
 return async function(req,res,route,u){
  if(route==='/api/workorders'&&req.method==='GET'){
   const orders=sql.prepare('SELECT record FROM workorders ORDER BY rowid DESC').all().map(r=>JSON.parse(r.record)).filter(o=>u.role==='teacher'||o.status!=='草稿'&&visible(o,u));
   const submissions=(u.role==='teacher'?sql.prepare('SELECT record FROM submissions').all():sql.prepare('SELECT record FROM submissions WHERE student_id=?').all(u.id)).map(r=>JSON.parse(r.record));
   json(res,200,{orders,submissions});return true;
  }
  if(route==='/api/workorders'&&req.method==='POST'){
   isTeacher(u);const b=await body(req);
   for(const [k,min,max] of [['title',4,100],['objective',10,1500],['steps',10,3000],['rubric',5,1500]])if(typeof b[k]!=='string'||b[k].trim().length<min||b[k].length>max)throw error(400,'工单字段长度不符合要求：'+k);
   if(!linked[b.module]||!Number.isInteger(b.maxScore)||b.maxScore<1||b.maxScore>100||!['草稿','已发布','已关闭'].includes(b.status)||typeof b.requireCompletion!=='boolean')throw error(400,'模块、分值或工单状态不合法');
   if(b.due&&(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(b.due)||!Number.isFinite(Date.parse(b.due))))throw error(400,'截止时间不合法');
   const target=String(b.target||'all').trim();if(target.startsWith('class:'))classes.get(target.slice(6));else if(target!=='all'){const ids=target.split(',').map(s=>s.trim());if(!ids.length||ids.length>200||ids.some(id=>!sql.prepare("SELECT id FROM users WHERE id=? AND role='student'").get(id)))throw error(400,'指定学号不存在，请用英文逗号分隔已注册学生学号');}
   const previous=b.id?read(b.id):null;if(previous&&sql.prepare('SELECT order_id FROM submissions WHERE order_id=? LIMIT 1').get(b.id)&&(previous.module!==b.module||previous.maxScore!==b.maxScore||previous.target!==target||previous.requireCompletion!==b.requireCompletion))throw error(409,'已有提交的工单不能改变模块、满分、对象或完成门槛；可复制新工单');
   const o={id:previous?.id||crypto.randomUUID(),title:b.title.trim(),objective:b.objective.trim(),steps:b.steps.trim(),rubric:b.rubric.trim(),module:b.module,maxScore:b.maxScore,target:target==='all'?'all':target.split(',').map(s=>s.trim()).join(','),due:b.due||'',status:b.status,requireCompletion:b.requireCompletion,createdAt:previous?.createdAt||now(),updatedAt:now()};
   sql.prepare('INSERT INTO workorders VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(o.id,JSON.stringify(o));audit(u,'设计教学工单',o.title+' / '+o.status);changed('assignments');json(res,200,{order:o});return true;
  }
  if(route==='/api/workorders/submit'&&req.method==='POST'){
   if(u.role!=='student')throw error(403,'请以学生身份提交');const b=await body(req),o=read(b.orderId);if(b.studentId!==u.id)throw error(409,'账号已切换');if(!visible(o,u)||o.status!=='已发布')throw error(403,'此工单未向你开放提交');if(o.due&&Date.now()>Date.parse(o.due+'+08:00'))throw error(400,'已超过截止时间，请联系教师延期');if(typeof b.evidence!=='string'||b.evidence.trim().length<30||b.evidence.length>6000)throw error(400,'请提交30—6000字的成果与反思说明');
   classes.requireAccess(u,'submit',o.module);const s=JSON.parse(sql.prepare('SELECT state FROM users WHERE id=?').get(u.id).state),progress=evaluate(s,linked[o.module]);if(o.requireCompletion&&!progress.checks.every(Boolean))throw error(400,'请先完成关联业务情境的全部步骤');
   const old=sql.prepare('SELECT record FROM submissions WHERE order_id=? AND student_id=?').get(o.id,u.id);const prev=old?JSON.parse(old.record):null;if(prev&&prev.status!=='退回修改')throw error(409,'工单已提交；如需修订请教师先退回');
   const r={orderId:o.id,studentId:u.id,name:u.name,evidence:b.evidence.trim(),submittedAt:now(),status:'待批阅',score:null,feedback:'',attempt:(prev?.attempt||0)+1,history:prev?[...(prev.history||[]),{evidence:prev.evidence,feedback:prev.feedback,score:prev.score,submittedAt:prev.submittedAt,reviewedAt:prev.reviewedAt}]:[],business:{checks:progress.checks,employees:s.employees.length,hires:s.candidates.filter(c=>c.stage==='已录用').length,performance:Object.keys(s.performance).length,exitStep:s.employees.find(e=>e.id==='E0011').exitStep}};
   sql.prepare('INSERT INTO submissions VALUES(?,?,?) ON CONFLICT(order_id,student_id) DO UPDATE SET record=excluded.record').run(o.id,u.id,JSON.stringify(r));audit(u,'提交教学工单',o.title+' / 第'+r.attempt+'次提交');changed('assignments');json(res,200,{submission:r});return true;
  }
  if(route==='/api/workorders/review'&&req.method==='POST'){
   isTeacher(u);const b=await body(req),o=read(b.orderId),row=sql.prepare('SELECT record FROM submissions WHERE order_id=? AND student_id=?').get(o.id,b.studentId);if(!row)throw error(404,'未找到学生提交');const r=JSON.parse(row.record);if(r.attempt!==b.attempt)throw error(409,'学生已有新的提交，请重新打开批阅');if(!['已评价','退回修改'].includes(b.status)||typeof b.feedback!=='string'||b.feedback.trim().length<5||b.feedback.length>3000||!Number.isFinite(b.score)||b.score<0||b.score>o.maxScore)throw error(400,'请填写有效分数和至少5字反馈');
   Object.assign(r,{score:b.score,feedback:b.feedback.trim(),status:b.status,reviewedAt:now()});sql.prepare('UPDATE submissions SET record=? WHERE order_id=? AND student_id=?').run(JSON.stringify(r),o.id,b.studentId);audit(u,'批阅教学工单',b.studentId+' / '+o.title+' / '+b.status+' / '+b.score);changed('assignments');json(res,200,{submission:r});return true;
  }
  if(route==='/api/classroom/messages'&&req.method==='GET'){
   const rows=u.role==='teacher'?sql.prepare('SELECT * FROM classroom_messages ORDER BY time DESC LIMIT 300').all():sql.prepare("SELECT * FROM classroom_messages WHERE student_id=? OR student_id=? OR student_id='all' ORDER BY time DESC LIMIT 100").all(u.id,'class:'+u.class_id);json(res,200,{messages:rows});return true;
  }
  if(route==='/api/classroom/messages'&&req.method==='POST'){
   const b=await body(req);if(typeof b.content!=='string'||b.content.trim().length<5||b.content.length>2000)throw error(400,'留言须为5—2000字');const target=u.role==='teacher'?String(b.studentId||'all'):u.id;if(u.role==='teacher'&&target.startsWith('class:'))classes.get(target.slice(6));else if(target!=='all'&&!sql.prepare("SELECT id FROM users WHERE id=? AND role='student'").get(target))throw error(400,'学生不存在');if(u.role==='student'&&b.studentId!==u.id)throw error(409,'账号已切换');
   sql.prepare('INSERT INTO classroom_messages VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(),target,u.role,u.name,b.content.trim(),now());audit(u,u.role==='teacher'?'教师指导留言':'学生提问',target+' / '+b.content);changed('assignments');json(res,200,{ok:true});return true;
  }
  return false;
 };
};
