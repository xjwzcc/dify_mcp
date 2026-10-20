'use strict';
// 班级权限独立存储；每次请求重新读取，确保已登录学生也受教师开关约束。
module.exports=({sql,body,json,error,audit,changed,config})=>{
 const crypto=require('node:crypto'),modules=['employees','recruit','schedule','payroll','performance','training','relations'];
 sql.exec(`CREATE TABLE IF NOT EXISTS classes(id TEXT PRIMARY KEY,record TEXT NOT NULL);`);
 if(!sql.prepare('PRAGMA table_info(users)').all().some(c=>c.name==='class_id'))sql.exec("ALTER TABLE users ADD COLUMN class_id TEXT NOT NULL DEFAULT 'default'");
 const initial={id:'default',name:'默认教学班',code:process.env.CLASS_CODE||config.classCode,entry:true,enrollment:true,write:true,submit:true,score:true,stage:'综合实训',modules};
 sql.prepare('INSERT OR IGNORE INTO classes VALUES(?,?)').run(initial.id,JSON.stringify(initial));
 const all=()=>sql.prepare('SELECT record FROM classes ORDER BY rowid').all().map(r=>JSON.parse(r.record));
 const get=id=>{const r=sql.prepare('SELECT record FROM classes WHERE id=?').get(id);if(!r)throw error(400,'班级不存在');return JSON.parse(r.record);};
 const access=u=>{if(u.role==='teacher')return null;const {code,...safe}=get(u.class_id||'default');return safe;};
 const requireAccess=(u,kind,module)=>{if(u.role==='teacher')return;const c=access(u);if(!c.entry)throw error(423,'本班入口已关闭，请等待教师开放');if(kind&&!c[kind])throw error(423,'当前阶段「'+c.stage+'」尚未开放'+({write:'业务操作',submit:'工单提交',score:'任务评分'}[kind]||kind));if(module&&!c.modules.includes(module))throw error(423,'当前阶段尚未开放此业务模块');};
 function checkState(u,next,previous){
  requireAccess(u,'write');const c=access(u),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),can=(...m)=>m.some(x=>c.modules.includes(x));
  const map={jobs:['recruit'],candidates:['recruit'],shifts:['schedule'],schedulePolicies:['schedule'],leaveRequests:['schedule'],pay:['payroll'],performance:['performance'],courses:['training'],exitCases:['relations'],decisions:['relations'],effects:['recruit','relations'],events:modules};
  for(const k of new Set([...Object.keys(next),...Object.keys(previous)])){
   if(k==='taskResults'||k==='employees'||same(next[k],previous[k]))continue;
   if(!map[k]||!can(...map[k]))throw error(423,'当前阶段禁止修改字段：'+k);
  }
  if(!same(next.employees,previous.employees)){
   const old=new Map(previous.employees.map(e=>[e.id,e])),ids=new Set(next.employees.map(e=>e.id));
   if(previous.employees.some(e=>!ids.has(e.id))&&!can('employees'))throw error(423,'当前阶段不允许删除员工');
   for(const e of next.employees){const p=old.get(e.id);if(!p){if(!can('recruit','employees'))throw error(423,'当前阶段不允许新增员工');continue;}
    for(const k of new Set([...Object.keys(p),...Object.keys(e)])){if(same(e[k],p[k]))continue;
     const permit=['score','interview'].includes(k)?can('performance'):['ot','otReason'].includes(k)?can('schedule','payroll','relations'):['nightQualified','attendance','attNote'].includes(k)?can('schedule'):['status','contract'].includes(k)?can('relations','employees'):['exitStep','exitReason','exitDate'].includes(k)?can('relations'):can('employees');
     if(!permit)throw error(423,'当前阶段不允许修改员工字段：'+k);
    }
   }
  }
 }
 async function route(req,res,path,u){
  if(path==='/api/classes'&&req.method==='GET'){json(res,200,{classes:all().map(c=>({...c,students:sql.prepare("SELECT COUNT(*) n FROM users WHERE role='student' AND class_id=?").get(c.id).n}))});return true;}
  if(path==='/api/classes'&&req.method==='POST'){
   if(u.role!=='teacher')throw error(403,'仅教师可管理班级');const b=await body(req),id=b.id||crypto.randomUUID(),old=b.id?get(b.id):null;
   if(typeof b.name!=='string'||!b.name.trim()||b.name.length>60||typeof b.code!=='string'||b.code.length<4||b.code.length>80||typeof b.stage!=='string'||!b.stage.trim()||b.stage.length>60||!Array.isArray(b.modules)||b.modules.some(m=>!modules.includes(m))||['entry','enrollment','write','submit','score'].some(k=>typeof b[k]!=='boolean'))throw error(400,'班级配置不合法，口令须为4—80字');
   const c={id,name:b.name.trim(),code:b.code,stage:b.stage.trim(),modules:[...new Set(b.modules)],...Object.fromEntries(['entry','enrollment','write','submit','score'].map(k=>[k,b[k]]))};
   sql.prepare('INSERT INTO classes VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(id,JSON.stringify(c));audit(u,old?'更新班级阶段':'创建班级',c.name+' / '+c.stage);changed('assignments');json(res,200,{ok:true});return true;
  }
  if(path==='/api/classes/move'&&req.method==='POST'){
   if(u.role!=='teacher')throw error(403,'仅教师可调整归班');const b=await body(req);get(b.classId);const r=sql.prepare("UPDATE users SET class_id=? WHERE id=? AND role='student'").run(b.classId,b.studentId);if(!r.changes)throw error(404,'学生不存在');audit(u,'调整学生归班',b.studentId+' → '+get(b.classId).name);changed('assignments');json(res,200,{ok:true});return true;
  }
  return false;
 }
 return{all,get,access,requireAccess,checkState,route};
};
