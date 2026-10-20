'use strict';
// 无第三方依赖：Node 24内置HTTP、SQLite与密码哈希；事务落盘后才反馈保存成功。
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),os=require('node:os');
const {DatabaseSync,backup}=require('node:sqlite');
const {seed,evaluate}=require('./domain.cjs');
const PORT=Number(process.env.PORT||8787),HOST=process.env.HOST||'0.0.0.0';
const dataDir=process.env.DATA_DIR||path.join(__dirname,'data');fs.mkdirSync(dataDir,{recursive:true});
const configPath=path.join(dataDir,'config.json');
if(!fs.existsSync(configPath))fs.writeFileSync(configPath,JSON.stringify({teacherPassword:process.env.TEACHER_PASSWORD||crypto.randomBytes(18).toString('base64url'),classCode:process.env.CLASS_CODE||crypto.randomBytes(9).toString('base64url')},null,2));
const config=JSON.parse(fs.readFileSync(configPath,'utf8'));
const sql=new DatabaseSync(path.join(dataDir,'hotel.sqlite'));
sql.exec(`PRAGMA journal_mode=${process.env.SQLITE_JOURNAL_MODE==='DELETE'?'DELETE':'WAL'};PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL,role TEXT NOT NULL,password TEXT NOT NULL,state TEXT,version INTEGER NOT NULL DEFAULT 1,updated TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS logs(seq INTEGER PRIMARY KEY AUTOINCREMENT,op_id TEXT UNIQUE,user_id TEXT NOT NULL,name TEXT NOT NULL,time TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS assignments(id TEXT PRIMARY KEY,title TEXT NOT NULL,date TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS revisions(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL,version INTEGER NOT NULL,state TEXT NOT NULL,time TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value INTEGER NOT NULL);INSERT OR IGNORE INTO metadata VALUES('revision',0);`);
const now=()=>new Date().toISOString(), hash=p=>{const salt=crypto.randomBytes(16).toString('hex');return salt+':'+crypto.scryptSync(p,salt,64).toString('hex');};
function checkPassword(p,h){try{const [salt,digest]=h.split(':');return crypto.timingSafeEqual(crypto.scryptSync(p,salt,64),Buffer.from(digest,'hex'));}catch{return false;}}
sql.prepare('INSERT OR IGNORE INTO users(id,name,role,password,state,updated) VALUES(?,?,?,?,?,?)').run('teacher','授课教师','teacher',hash(config.teacherPassword),null,now());
sql.prepare('INSERT OR IGNORE INTO assignments VALUES(?,?,?)').run('A0','完成四个业务情境；每次操作将自动同步到教师端。','2026-10-20');
const clients=new Set(),rates=new Map();
const error=(status,message)=>Object.assign(new Error(message),{status});
function transaction(fn){sql.exec('BEGIN IMMEDIATE');try{const result=fn();sql.exec('COMMIT');return result;}catch(e){sql.exec('ROLLBACK');throw e;}}
function changed(userId){sql.exec("UPDATE metadata SET value=value+1 WHERE key='revision'");const revision=sql.prepare("SELECT value FROM metadata WHERE key='revision'").get().value;for(const c of clients){if(c.role==='teacher'||c.id===userId||userId==='assignments')c.res.write('data: '+JSON.stringify({revision,userId})+'\n\n');}}
function audit(user,action,detail,id=crypto.randomUUID()){sql.prepare('INSERT OR IGNORE INTO logs(op_id,user_id,name,time,action,detail) VALUES(?,?,?,?,?,?)').run(id,user.id,user.name,now(),action,String(detail).slice(0,10000));}
function cleanJSON(o,depth=0){if(depth>30)throw error(400,'数据嵌套过深');if(o&&typeof o==='object'){for(const k of Object.keys(o)){if(['__proto__','constructor','prototype'].includes(k))throw error(400,'非法数据键');cleanJSON(o[k],depth+1);}}}
function validateState(s){
 cleanJSON(s);if(!s||typeof s!=='object')throw error(400,'业务数据无效');
 for(const key of ['employees','jobs','candidates','courses','events'])if(!Array.isArray(s[key])||s[key].length>5000)throw error(400,'业务列表无效：'+key);
 for(const key of ['pay','shifts','performance','decisions','effects'])if(!s[key]||typeof s[key]!=='object'||Array.isArray(s[key]))throw error(400,'业务字段无效：'+key);
 const ids=new Set();for(const e of s.employees){if(!e||!/^E[A-Z0-9]+$/.test(e.id)||ids.has(e.id)||typeof e.name!=='string'||!e.name.trim()||e.name.length>60||!['在职','请假','离职'].includes(e.status)||!Number.isFinite(e.base)||e.base<0||e.base>100000||!Number.isFinite(e.score)||e.score<0||e.score>100||!Number.isFinite(e.ot)||e.ot<0||e.ot>1000)throw error(400,'员工字段不合法');ids.add(e.id);}
 if(['E0002','E0005','E0011'].some(id=>!ids.has(id)))throw error(400,'任务员工档案不可删除');
 for(const arr of [s.jobs,s.candidates,s.courses]){const seen=new Set();for(const x of arr){if(!x||typeof x.id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(x.id)||seen.has(x.id))throw error(400,'业务编号无效');seen.add(x.id);}}
 for(const j of s.jobs)if(typeof j.title!=='string'||!Number.isInteger(j.count)||j.count<1||j.count>1000)throw error(400,'招聘职位无效');
 if(!s.jobs.some(j=>j.id==='J0'))throw error(400,'任务职位不可删除');
 for(const c of s.candidates)if(!s.jobs.some(j=>j.id===c.job)||!Number.isFinite(c.skill)||c.skill<0||c.skill>100||!Number.isFinite(c.exp)||c.exp<0)throw error(400,'候选人数据无效');
 for(const shifts of Object.values(s.shifts))if(!Array.isArray(shifts)||shifts.length!==7||shifts.some(x=>!['早班','中班','夜班','休'].includes(x)))throw error(400,'排班数据无效');
 for(const [k,v] of Object.entries(s.pay))if(!Number.isFinite(v)||v<0)throw error(400,'薪酬参数无效');
 if(s.pay.monthlyHours<1||s.pay.insurance>1)throw error(400,'薪酬参数超出范围');
 for(const k of ['service','turnover'])if(!Number.isFinite(s.effects[k]))throw error(400,'情境影响数据无效');
 for(const r of Object.values(s.performance))if(!r||!Array.isArray(r.kpis)||r.kpis.length!==3||r.kpis.some(k=>!Number.isFinite(k.score)||k.score<0||k.score>100||!Number.isFinite(k.weight)||k.weight<=0)||r.kpis.reduce((a,k)=>a+k.weight,0)!==100||['cause','action','note','review'].some(k=>typeof r[k]!=='string'))throw error(400,'绩效记录不合法');
 for(const c of s.courses)if(!Array.isArray(c.members)||!c.ratings||c.members.some(id=>typeof id!=='string'))throw error(400,'培训记录无效');
 return s;
}
async function body(req){let data='';for await(const part of req){data+=part;if(Buffer.byteLength(data)>4*1024*1024)throw error(413,'提交数据超过4MB');}try{return JSON.parse(data||'{}');}catch{throw error(400,'请求JSON无效');}}
function json(res,status,value,headers={}){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(JSON.stringify(value));}
function auth(req){const cookie=String(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('hotel_session='));if(!cookie)return null;const token=crypto.createHash('sha256').update(cookie.slice(14)).digest('hex');return sql.prepare('SELECT u.*,s.token AS token FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?').get(token,Date.now());}
const classes=require('./classes.cjs')({sql,body,json,error,audit,changed,config});
function snapshot(user){const u=sql.prepare('SELECT * FROM users WHERE id=?').get(user.id);return{session:{id:u.id,name:u.name,teacher:u.role==='teacher',classId:u.class_id,access:classes.access(u)},student:u.role==='student'?{id:u.id,name:u.name,state:JSON.parse(u.state),version:u.version,updated:u.updated}:null,assignments:sql.prepare('SELECT * FROM assignments ORDER BY rowid').all()};}
function requireTeacher(u){if(u.role!=='teacher')throw error(403,'仅教师可执行此操作');}
function cookie(value,secure=false){return 'hotel_session='+value+'; HttpOnly; SameSite=Strict; Path=/hotel/; Max-Age=2592000'+(secure?'; Secure':'');}
const learningRoute=require('./learning.cjs')({sql,body,json,error,audit,changed,evaluate,now,classes});
const server=http.createServer(async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');
 try{
 const url=new URL(req.url,'http://localhost'),route=url.pathname.replace(/^\/hotel(?=\/|$)/,'')||'/';
 if(req.method!=='GET'&&req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)throw error(403,'拒绝跨站请求');
 if(route==='/api/classes/public'&&req.method==='GET')return json(res,200,{classes:classes.all().map(c=>({id:c.id,name:c.name,entry:c.entry,enrollment:c.enrollment,stage:c.stage}))});
 if(route==='/api/health')return json(res,200,{ok:true,product:'hotel-hr-v2',storage:'SQLite',time:now()});
 if(route==='/api/login'&&req.method==='POST'){
   const ip=req.socket.remoteAddress,rate=rates.get(ip)||{n:0,at:Date.now()};if(Date.now()-rate.at>60000){rate.n=0;rate.at=Date.now();}if(++rate.n>40)throw error(429,'尝试过于频繁，请稍后重试');rates.set(ip,rate);
   const b=await body(req);const teacher=b.role==='teacher',id=teacher?'teacher':String(b.id||'').trim(),name=String(b.name||'').trim(),password=String(b.password||'');
   if(!/^[A-Za-z0-9_-]{1,40}$/.test(id)||['__proto__','constructor','prototype'].includes(id)||(!teacher&&id==='teacher'))throw error(400,'学号格式无效');
   let u=sql.prepare('SELECT * FROM users WHERE id=?').get(id);
   const selected=teacher?null:classes.get(b.classId||u?.class_id||'default');
   if(!teacher){if(u&&u.class_id!==selected.id)throw error(403,'该学号属于其他班级，请选择原班级或联系教师调整');if(!selected.entry)throw error(423,'该班暂未开放进入');if(!u&&!selected.enrollment)throw error(423,'该班已关闭新生注册');}
   if(!u){if(teacher||b.classCode!==selected.code)throw error(403,'班级口令不正确');if(!name||name.length>30||password.length<6||password.length>128)throw error(400,'首次进入须填写姓名并设置至少6位密码');sql.prepare('INSERT INTO users(id,name,role,password,state,updated) VALUES(?,?,?,?,?,?)').run(id,name,'student',hash(password),JSON.stringify(seed()),now());sql.prepare('UPDATE users SET class_id=? WHERE id=?').run(selected.id,id);u=sql.prepare('SELECT * FROM users WHERE id=?').get(id);}
   if(password.length>128||!checkPassword(password,u.password)||(!teacher&&name!==u.name))throw error(401,'姓名、学号或密码不匹配，请核对；忘记密码请联系教师');
   const token=crypto.randomBytes(32).toString('hex');sql.prepare('INSERT INTO sessions VALUES(?,?,?)').run(crypto.createHash('sha256').update(token).digest('hex'),u.id,Date.now()+30*86400000);audit(u,'登录','通过网址进入课堂系统');changed(u.id);
   return json(res,200,snapshot(u),{'Set-Cookie':cookie(token,process.env.SECURE_COOKIE==='1')});
 }
 if(route.startsWith('/api/')){
   const u=auth(req);if(!u)throw error(401,'登录已失效，请重新登录；已保存的数据仍在服务器');
   if(route.startsWith('/api/classes')){if(u.role!=='teacher')throw error(403,'仅教师可管理班级');if(await classes.route(req,res,route,u))return;}
   if(!['/api/session','/api/logout','/api/events'].includes(route))classes.requireAccess(u);
   if(await learningRoute(req,res,route,u))return;
   if(route==='/api/session'&&req.method==='GET')return json(res,200,snapshot(u));
   if(route==='/api/logout'&&req.method==='POST'){sql.prepare('DELETE FROM sessions WHERE token=?').run(u.token);return json(res,200,{ok:true},{'Set-Cookie':'hotel_session=; Path=/hotel/; HttpOnly; SameSite=Strict; Max-Age=0'});}
   if(route==='/api/events'&&req.method==='GET'){
     res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});res.write('data: '+JSON.stringify({connected:true})+'\n\n');const c={id:u.id,role:u.role,res};clients.add(c);
     const timer=setInterval(()=>{if(!sql.prepare('SELECT token FROM sessions WHERE token=? AND expires>?').get(u.token,Date.now()))res.end();else res.write(': heartbeat\n\n');},20000);req.on('close',()=>{clearInterval(timer);clients.delete(c);});return;
   }
   if(route==='/api/state'&&req.method==='PUT'){
     if(u.role!=='student')throw error(403,'教师不能覆盖学生业务数据');const b=await body(req);if(b.studentId!==u.id)throw error(409,'浏览器已切换账号，已阻止把本页数据写入其他学生档案');
     const result=transaction(()=>{const current=sql.prepare('SELECT * FROM users WHERE id=?').get(u.id);if(b.version!==current.version)throw error(409,'其他页面已更新该学号数据，请先处理版本冲突，服务器记录没有被覆盖');const s=validateState(b.state);classes.checkState(u,s,JSON.parse(current.state));s.taskResults=JSON.parse(current.state).taskResults;
       const logs=Array.isArray(b.logs)?b.logs:[];if(logs.length>500)throw error(400,'单次操作日志过多');
       for(const l of logs){if(!l||typeof l.id!=='string'||l.id.length>100||typeof l.action!=='string'||typeof l.detail!=='string')throw error(400,'操作记录格式无效');audit(u,l.action.slice(0,100),l.detail,u.id+':'+l.id);}
       sql.prepare('INSERT INTO revisions(user_id,version,state,time) VALUES(?,?,?,?)').run(u.id,current.version,current.state,now());
       sql.prepare('DELETE FROM revisions WHERE user_id=? AND id NOT IN (SELECT id FROM revisions WHERE user_id=? ORDER BY id DESC LIMIT 20)').run(u.id,u.id);
       const version=current.version+1,updated=now();sql.prepare('UPDATE users SET state=?,version=?,updated=? WHERE id=?').run(JSON.stringify(s),version,updated,u.id);return{version,updated,taskResults:s.taskResults};});changed(u.id);return json(res,200,result);
   }
   if(route==='/api/tasks/submit'&&req.method==='POST'){
     if(u.role!=='student')throw error(403,'请使用学生账号');const b=await body(req);if(b.studentId!==u.id)throw error(409,'浏览器已切换账号，请重新登录当前学生');if(!['task1','task2','task3','task4'].includes(b.id))throw error(400,'未知任务');
     classes.requireAccess(u,'score',({task1:'recruit',task2:'schedule',task3:'performance',task4:'relations'})[b.id]);
     const r=transaction(()=>{const current=sql.prepare('SELECT * FROM users WHERE id=?').get(u.id);if(b.version!==current.version)throw error(409,'版本已变化，请刷新后评分');const s=JSON.parse(current.state);if(s.taskResults[b.id])return snapshot(u);const p=evaluate(s,b.id);if(!p.checks.every(Boolean))throw error(400,'业务步骤尚未完成，服务器拒绝结算');s.taskResults[b.id]={score:p.score,date:now()};sql.prepare('UPDATE users SET state=?,version=version+1,updated=? WHERE id=?').run(JSON.stringify(s),now(),u.id);audit(u,'任务评分',b.id+' / '+p.score+'分（服务器判定）');return snapshot(u);});changed(u.id);return json(res,200,r);
   }
   if(route==='/api/assignments'&&req.method==='GET')return json(res,200,{assignments:sql.prepare('SELECT * FROM assignments ORDER BY rowid').all()});
   if(route==='/api/assignments'&&req.method==='POST'){requireTeacher(u);const b=await body(req);if(typeof b.title!=='string'||b.title.trim().length<5||b.title.length>1000)throw error(400,'任务要求须为5—1000字');sql.prepare('INSERT INTO assignments VALUES(?,?,?)').run(crypto.randomUUID(),b.title.trim(),now().slice(0,10));audit(u,'下发任务',b.title);changed('assignments');return json(res,200,{ok:true});}
   if(route==='/api/teacher'&&req.method==='GET'){
     requireTeacher(u);const students=sql.prepare("SELECT id,name,class_id,state,version,updated FROM users WHERE role='student' ORDER BY updated DESC").all().map(r=>{const s=JSON.parse(r.state);return{id:r.id,name:r.name,classId:r.class_id,version:r.version,updated:r.updated,results:s.taskResults,progress:Object.fromEntries(['task1','task2','task3','task4'].map(id=>[id,evaluate(s,id).checks])),summary:{employees:s.employees.filter(e=>e.status!=='离职').length,hires:s.candidates.filter(c=>c.stage==='已录用').length,performance:Object.keys(s.performance).length},logCount:sql.prepare('SELECT COUNT(*) AS n FROM logs WHERE user_id=?').get(r.id).n};});
     return json(res,200,{students,logs:sql.prepare("SELECT seq AS id,user_id AS student,name,time,action,detail FROM logs ORDER BY seq DESC LIMIT 200").all(),assignments:sql.prepare('SELECT * FROM assignments ORDER BY rowid').all(),revision:sql.prepare("SELECT value FROM metadata WHERE key='revision'").get().value});
   }
   if(route==='/api/teacher/student'&&req.method==='GET'){requireTeacher(u);const st=sql.prepare("SELECT * FROM users WHERE id=? AND role='student'").get(url.searchParams.get('id'));if(!st)throw error(404,'找不到该学生');return json(res,200,{student:snapshot(st).student,logs:sql.prepare('SELECT seq AS id,user_id AS student,name,time,action,detail FROM logs WHERE user_id=? ORDER BY seq DESC').all(st.id)});}
   if(route==='/api/teacher/reset-password'&&req.method==='POST'){requireTeacher(u);const b=await body(req);if(typeof b.password!=='string'||b.password.length<6||b.password.length>128)throw error(400,'密码至少6位');const result=sql.prepare("UPDATE users SET password=? WHERE id=? AND role='student'").run(hash(b.password),b.id);if(!result.changes)throw error(404,'找不到学生');sql.prepare('DELETE FROM sessions WHERE user_id=?').run(b.id);audit(u,'重置学生密码',b.id);return json(res,200,{ok:true});}
   if(route==='/api/teacher/change-password'&&req.method==='POST'){requireTeacher(u);const b=await body(req);if(!checkPassword(String(b.current||''),u.password)||typeof b.password!=='string'||b.password.length<8||b.password.length>128)throw error(400,'原密码不正确，或新密码不足8位');sql.prepare('UPDATE users SET password=? WHERE id=?').run(hash(b.password),u.id);audit(u,'修改教师密码','已修改');return json(res,200,{ok:true});}
   if(route==='/api/teacher/backup'&&req.method==='GET'){requireTeacher(u);const filename=path.join(dataDir,'backup-'+Date.now()+'.sqlite');await backup(sql,filename);res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="hotel-backup.sqlite"','Cache-Control':'no-store'});const stream=fs.createReadStream(filename);stream.on('close',()=>fs.unlink(filename,()=>{}));stream.pipe(res);return;}
   if(route==='/api/migrate'&&req.method==='POST'){
     if(u.role!=='student')throw error(403,'请使用自己的学生账号');const b=await body(req);if(b.id!==u.id||b.name!==u.name)throw error(400,'旧档案姓名和学号必须与当前账号一致');
     classes.checkState(u,b.state,JSON.parse(u.state));classes.requireAccess(u,'score');if(classes.access(u).modules.length!==7)throw error(423,'旧档迁移仅在全部业务模块开放时允许');
     transaction(()=>{const current=sql.prepare('SELECT * FROM users WHERE id=?').get(u.id);if(current.version!==1)throw error(409,'此账号已操作过，禁止用旧档覆盖；请联系教师处理');const oldResults=b.state?.taskResults||{},s=validateState(b.state);s.taskResults={};for(const id of ['task1','task2','task3','task4'])if(oldResults[id]){const p=evaluate(s,id);if(p.checks.every(Boolean))s.taskResults[id]={score:p.score,date:now()};}sql.prepare('UPDATE users SET state=?,version=2,updated=? WHERE id=?').run(JSON.stringify(s),now(),u.id);audit(u,'迁移离线存档','已迁移业务状态；任务成绩已由服务器重新核算');});changed(u.id);return json(res,200,snapshot(u));
   }
   throw error(404,'接口不存在');
 }
 if(req.method!=='GET')throw error(405,'请求方法无效');
 const files={'/teacher':'index.html','/student':'index.html','/':'index.html','/index.html':'index.html','/app.js':'app.js','/online.js':'online.js','/teaching.js':'teaching.js','/classroom.js':'classroom.js','/mobile.js':'mobile.js','/mobile.css':'mobile.css'};
 if(!files[route])throw error(404,'页面不存在');const filename=path.join(__dirname,'public',files[route]);res.writeHead(200,{'Content-Type':route.endsWith('.js')?'application/javascript; charset=utf-8':route.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-cache'});fs.createReadStream(filename).pipe(res);
 }catch(e){if(!res.headersSent)json(res,e.status||500,{error:e.status?e.message:'服务器暂时无法处理请求，请保留页面稍后重试'});else res.end();if(!e.status)console.error(e);}
});
const housekeeping=setInterval(()=>{sql.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());for(const [k,v] of rates)if(Date.now()-v.at>60000)rates.delete(k);},60000);housekeeping.unref();
server.listen(PORT,HOST,()=>{console.log('Hotel HR online ready: http://localhost:'+PORT);for(const arr of Object.values(os.networkInterfaces()))for(const a of arr)if(a.family==='IPv4'&&!a.internal)console.log('LAN URL: http://'+a.address+':'+PORT);console.log('Database: '+path.join(dataDir,'hotel.sqlite'));});
function shutdown(){for(const c of clients)c.res.end();server.close(()=>{sql.close();process.exit(0);});setTimeout(()=>process.exit(0),3000).unref();}process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
