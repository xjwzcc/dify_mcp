'use strict';
// 联网适配层：服务端为主存档；浏览器仅保留尚未提交的个人操作副本。
const legacy={render,modal,exportReport,tasks};
const net={version:0,ack:'',pending:[],sending:null,saveTimer:null,retryTimer:null,events:null,conflict:false,status:'正在连接服务器',teacherRows:[],teacherLogs:[],lastSync:'',refreshTimer:null};
const cacheKey=id=>'lanting_online_pending_v2_'+id;
// 使用页面内确认框，适配课堂投影、嵌入浏览器和移动端，避免原生弹窗阻塞操作。
function askConfirm(message){return new Promise(resolve=>{const d=document.createElement('dialog');d.innerHTML='<div class="dialogbody"><h2>确认操作</h2><p></p><div class="row" style="justify-content:flex-end;margin-top:20px"><button class="secondary" type="button" data-answer="no">取消</button><button type="button" data-answer="yes">确认继续</button></div></div>';d.querySelector('p').textContent=message;const finish=answer=>{d.close();d.remove();resolve(answer);};d.querySelector('[data-answer="no"]').onclick=()=>finish(false);d.querySelector('[data-answer="yes"]').onclick=()=>finish(true);d.oncancel=e=>{e.preventDefault();finish(false);};document.body.appendChild(d);d.showModal();});}
async function api(url,options={}){
 let r;try{r=await fetch(url,{credentials:'same-origin',headers:{'Content-Type':'application/json'},...options});}catch{throw new Error('无法连接服务器，请保留页面；未上传操作会自动重试');}
 const data=await r.json();if(!r.ok){const e=new Error(data.error||'请求失败');e.status=r.status;throw e;}return data;
}
function syncStatus(text,bad=false){net.status=text;const el=$('#syncStatus');if(el){el.textContent=text;el.className='badge '+(bad?'bad':'');}}
function pendingCopy(){if(!session||session.teacher)return;try{const dirty=JSON.stringify(state())!==net.ack||net.pending.length;if(dirty)localStorage.setItem(cacheKey(session.id),JSON.stringify({version:net.version,state:state(),logs:net.pending}));else localStorage.removeItem(cacheKey(session.id));}catch{syncStatus('本机备份失败，请保持页面并重试保存',true);}}
save=function(){if(!session||session.teacher)return true;pendingCopy();if(JSON.stringify(state())!==net.ack||net.pending.length){syncStatus('待保存 · 正在上传');clearTimeout(net.saveTimer);net.saveTimer=setTimeout(()=>flush().catch(()=>{}),180);}return true;};
log=function(action,detail){if(!session||session.teacher)return;const l={id:uid(),time:new Date().toISOString(),student:session.id,name:session.name,action,detail:String(detail)};db.logs.push(l);net.pending.push(l);save();};
async function flush(){
 if(!session||session.teacher)return;if(net.conflict)throw new Error('存在版本冲突，请先处理');
 if(net.sending){await net.sending;if(JSON.stringify(state())!==net.ack||net.pending.length)return flush();return;}
 clearTimeout(net.saveTimer);clearTimeout(net.retryTimer);
 if(JSON.stringify(state())===net.ack&&!net.pending.length)return;
 net.sending=(async()=>{
   while(session&&!session.teacher&&(JSON.stringify(state())!==net.ack||net.pending.length)){
     const snapshot=JSON.parse(JSON.stringify(state())),logs=net.pending.slice(0,500),sentIds=new Set(logs.map(l=>l.id));
     syncStatus('正在保存到服务器…');
     const r=await api('/api/state',{method:'PUT',body:JSON.stringify({studentId:session.id,version:net.version,state:snapshot,logs})});
     net.version=r.version;snapshot.taskResults=r.taskResults;state().taskResults=r.taskResults;net.ack=JSON.stringify(snapshot);net.pending=net.pending.filter(l=>!sentIds.has(l.id));net.lastSync=r.updated;pendingCopy();
   }
   syncStatus('已保存到服务器 · '+new Date(net.lastSync).toLocaleTimeString('zh-CN'));
 })();
 try{await net.sending;}catch(e){pendingCopy();syncStatus(e.status===409?'版本冲突 · 点击“处理保存问题”':'保存未完成 · 已保留待上传副本',true);if(e.status===409)net.conflict=true;else net.retryTimer=setTimeout(()=>flush().catch(()=>{}),5000);throw e;}finally{net.sending=null;}
}
function applySnapshot(r){if(session&&session.id!==r.session.id){net.conflict=true;throw new Error('此浏览器已切换账号，请先备份本页并重新打开网址登录；已阻止跨账号覆盖');}session=r.session;db={version:2,students:{},logs:[],assignments:r.assignments,reports:{}};if(r.student){db.students[session.id]=r.student;net.version=r.student.version;net.ack=JSON.stringify(r.student.state);net.lastSync=r.student.updated;}net.pending=[];net.conflict=false;}
async function enter(r){
 applySnapshot(r);if(!session.teacher){
   let cached;try{cached=JSON.parse(localStorage.getItem(cacheKey(session.id))||'null');}catch{}
   if(cached&&cached.state){if(cached.version===net.version){db.students[session.id].state=cached.state;net.pending=Array.isArray(cached.logs)?cached.logs:[];}else if(JSON.stringify(cached.state)===net.ack){localStorage.removeItem(cacheKey(session.id));}else{db.students[session.id].state=cached.state;net.pending=cached.logs||[];net.conflict=true;}}
 }
 page=session.teacher?'teacher':'dashboard';render();if(session.teacher)await refreshTeacher();connectEvents();
 if(net.conflict){syncStatus('发现未上传操作与服务器版本冲突',true);showSyncProblem();}else if(!session.teacher)await flush().catch(()=>{});
}
renderLogin=function(){
 session=null;if(net.events)net.events.close();clearInterval(net.refreshTimer);net.events=null;
 $('#app').innerHTML=`<div class="login"><section class="loginhero"><div style="color:var(--gold);letter-spacing:4px;margin-bottom:28px">LANTING HOTEL · LIVE CLASS</div><h1>每一次实训，<br>都被认真记录。</h1><p>酒店人力资源课程 · 联网实训系统</p><div class="row" style="margin:28px 0">300 间客房 · 250 名员工 · 九大模块</div><p>学生操作自动入库，教师课堂实时查看。<br>刷新、换电脑后登录，继续自己的酒店管理进度。</p></section><section class="loginbox"><h2>进入课堂</h2><p class="muted">首次登录自动建立账号，请记住自己设置的密码。</p><div class="tabs"><button id="studentTab">学生实训</button><button class="secondary" id="teacherTab">教师管理</button></div><form id="loginform"></form><div class="notice smalltext" style="margin-top:22px">服务器统一存档 · 实时同步 · 业务日期 ${TODAY}<br>已有账号直接填写原姓名、学号和密码；忘记密码由教师重置。</div></section></div>`;
 let teacherMode=false;
 function paint(){const t=teacherMode;$('#loginform').innerHTML=t?field('教师账号','id','teacher','text','required readonly')+field('教师密码','password','','password','required autocomplete="current-password"')+'<button style="width:100%">进入教师端</button>':field('姓名','name','','text','required maxlength="30" autocomplete="name"')+field('学号','id','','text','required maxlength="40" pattern="[A-Za-z0-9_-]+" autocomplete="username"')+field('个人密码（首次进入请设置，至少6位）','password','','password','required minlength="6" maxlength="128" autocomplete="current-password"')+field('班级口令（首次进入必填，由教师提供）','classCode','','text','maxlength="80"')+'<button style="width:100%">登录 / 首次进入</button>';$('#studentTab').className=t?'secondary':'';$('#teacherTab').className=t?'':'secondary';}
 $('#studentTab').onclick=()=>{teacherMode=false;paint();};$('#teacherTab').onclick=()=>{teacherMode=true;paint();};paint();
 $('#loginform').onsubmit=async e=>{e.preventDefault();const button=e.target.querySelector('button[type="submit"],button');button.disabled=true;try{const values=Object.fromEntries(new FormData(e.target));const r=await api('/api/login',{method:'POST',body:JSON.stringify({...values,role:teacherMode?'teacher':'student'})});await enter(r);}catch(err){toast(err.message);button.disabled=false;}};
};
render=function(){
 legacy.render();const header=$('header .row');if(header)header.insertAdjacentHTML('beforeend','<span id="syncStatus" class="badge"></span>');
 syncStatus(session.teacher?'实时连接 · 数据来自服务器':net.status);
 $('#logoutBtn').onclick=async()=>{if(!await askConfirm('退出当前账号？系统会先把待保存操作提交到服务器。'))return;try{await flush();await api('/api/logout',{method:'POST',body:'{}'});renderLogin();}catch(e){toast('退出未完成：'+e.message);}};
 if(!session.teacher){const area=$('header>div:last-child');area.insertAdjacentHTML('beforeend','<button class="small secondary" id="syncProblemBtn">处理保存问题</button>');$('#syncProblemBtn').onclick=showSyncProblem;}
 const foot=$('.navfoot');if(foot)foot.innerHTML='联网教学实训<br>300 ROOMS / FULL SERVICE<br><br>业务日期 '+TODAY+'<br>服务器存档 · 个人独立酒店';
};
// 异步表单等待真实保存结果；业务表单仍复用原模块，失败操作留在待上传队列。
modal=function(title,body,submit,label='保存'){
 legacy.modal(title,body,submit?async v=>submit(v):null,label);
 if(submit){const form=$('#modalform');form.onsubmit=async e=>{e.preventDefault();const b=form.querySelector('button[type="submit"]');b.disabled=true;try{const result=await submit(Object.fromEntries(new FormData(form)));if(result!==false){await flush();$('#modal').close();}}catch(err){toast(err.message);save();}finally{if(b.isConnected)b.disabled=false;}};}
};
function showSyncProblem(){modal('保存状态与恢复',`<p>${esc(net.status)}</p><p>当前存档版本：${net.version}。已确认保存的内容保存在服务器；待上传内容另有本机副本。</p><div class="row"><button type="button" onclick="flush().then(()=>toast('已保存')).catch(e=>toast(e.message))">重试保存</button><button type="button" class="secondary" onclick="exportFullBackup()">下载个人完整备份</button><button type="button" class="danger" onclick="useServerCopy()">保留服务器版本</button></div><p class="muted smalltext" style="margin-top:16px">版本冲突常见于同一学号在多个页面同时修改。先下载本机备份，再选择服务器版本，可避免覆盖已保存记录。</p>`);}
async function useServerCopy(){if(!await askConfirm('用服务器已保存版本替换本页待上传操作？建议先下载个人完整备份。'))return;try{const r=await api('/api/session');localStorage.removeItem(cacheKey(session.id));applySnapshot(r);$('#modal').close();render();syncStatus('已恢复服务器存档');}catch(e){toast(e.message);}}
function exportFullBackup(){download('酒店实训_完整备份_'+session.id+'.json',JSON.stringify({format:'lanting-full-v2',id:session.id,name:session.name,state:state(),version:net.version,logs:db.logs},null,2));}
exportReport=async function(){try{await flush();legacy.exportReport();}catch(e){toast(e.message);}};
tasks=function(){legacy.tasks();const btn=$('#content .titleline .row');if(btn)btn.innerHTML=`<span class="badge">积分 ${totalScore(state())} / 400 · 服务器计分</span><button class="secondary" onclick="document.getElementById('migrateFile').click()">导入旧版完整存档</button><button class="secondary" onclick="exportFullBackup()">个人完整备份</button>`;const old=$('#assignmentFile');if(old)old.remove();$('#content').insertAdjacentHTML('beforeend','<input id="migrateFile" type="file" accept=".json" hidden onchange="migrateFile(this)">');};
submitTask=async function(id){const t=taskDefs().find(t=>t.id===id);if(state().taskResults[id])return showScore(t,state().taskResults[id]);const p=taskProgress(id);if(!p.checks.every(Boolean))return modal('任务尚未完成','<ul>'+t.steps.filter((x,i)=>!p.checks[i]).map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul>');if(!await askConfirm('提交并按服务器已保存的业务记录评分？首次成绩锁定。'))return;try{await flush();const r=await api('/api/tasks/submit',{method:'POST',body:JSON.stringify({studentId:session.id,id,version:net.version})});applySnapshot(r);tasks();showScore(t,state().taskResults[id]);syncStatus('成绩已保存，教师端同步更新');}catch(e){toast(e.message);}};
async function migrateFile(input){const file=input.files[0];if(!file)return;try{if(file.size>4*1024*1024)throw Error('文件不能超过4MB');const b=JSON.parse(await file.text());if(!b.state)throw Error('此文件仅含成绩，无法恢复全部状态。请在旧版入口导出“完整存档”。');if(!await askConfirm('将旧版完整存档迁移到当前账号？仅允许尚未开始操作的新账号，成绩由服务器重新判定。'))return;const r=await api('/api/migrate',{method:'POST',body:JSON.stringify(b)});applySnapshot(r);render();toast('旧档已迁入服务器');}catch(e){toast(e.message);}}
ranking=function(){return net.teacherRows.map(r=>({...r,score:Object.values(r.results).reduce((a,x)=>a+x.score,0),source:'服务器',logs:[]})).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));};
teacher=function(){
 if(!session.teacher)return;const rows=ranking(),logs=net.teacherLogs;
 $('#content').innerHTML=title('课堂实时管理','学生操作自动入库；排行榜、任务进度和业务记录实时刷新','<button onclick="assignTask()">＋ 下发课堂任务</button><button class="secondary" onclick="exportClass()">导出班级成绩</button><button class="secondary" onclick="backupDatabase()">备份全班数据库</button><button class="secondary" onclick="changeTeacherPassword()">修改教师密码</button>')+
 `<div class="cards" style="grid-template-columns:repeat(3,1fr)"><div class="card"><div class="label">已登录实训学生</div><div class="metric">${rows.length}</div></div><div class="card"><div class="label">已完成任务</div><div class="metric">${rows.reduce((a,r)=>a+Object.keys(r.results).length,0)}</div></div><div class="card"><div class="label">已保存操作</div><div class="metric">${rows.reduce((a,r)=>a+r.logCount,0)}</div></div></div><section class="card" style="margin-top:20px"><div class="row between"><h3>班级实训进度与积分</h3><span class="muted smalltext">最后更新 ${esc(net.lastSync?new Date(net.lastSync).toLocaleTimeString('zh-CN'):'连接中')}</span></div><div class="tablewrap"><table><thead><tr><th>名次</th><th>姓名 / 学号</th><th>招聘</th><th>排班</th><th>绩效</th><th>员工关系</th><th>积分</th><th>最新保存</th><th>查看</th></tr></thead><tbody>${rows.map((r,i)=>`<tr><td>${i+1}</td><td>${esc(r.name)} / ${esc(r.id)}</td>${['task1','task2','task3','task4'].map(k=>`<td>${r.results[k]?'<b>'+r.results[k].score+'分</b>':'<span class="muted">'+r.progress[k].filter(Boolean).length+'/'+r.progress[k].length+'步</span>'}</td>`).join('')}<td><b>${r.score}</b></td><td>${esc(new Date(r.updated).toLocaleString('zh-CN'))}</td><td><div class="row"><button class="small" onclick="viewStudent('${r.id}')">业务与日志</button><button class="small secondary" onclick="resetStudentPassword('${r.id}')">重置密码</button></div></td></tr>`).join('')||'<tr><td colspan="9" class="empty">学生通过同一网址登录后将自动出现在这里。</td></tr>'}</tbody></table></div></section><section class="card"><h3>已下发课堂任务</h3>${db.assignments.map(a=>`<div class="notice">${esc(a.title)}<br><span class="muted smalltext">${esc(a.date)}</span></div>`).join('')}</section><section class="card"><h3>最近操作记录（200条，个人详情可查看全部）</h3>${logTable(logs)}</section>`;
};
async function refreshTeacher(){if(!session?.teacher)return;const r=await api('/api/teacher');net.teacherRows=r.students;net.teacherLogs=r.logs;db.assignments=r.assignments;net.lastSync=new Date().toISOString();if(window.refreshLearning)await refreshLearning();renderPage();syncStatus('实时连接 · '+new Date().toLocaleTimeString('zh-CN')+'已更新');}
viewStudent=async function(id){try{const r=await api('/api/teacher/student?id='+encodeURIComponent(id)),s=r.student.state;modal('实训详情 · '+r.student.name,`<p>学号 ${esc(id)} · 版本 ${r.student.version} · ${esc(new Date(r.student.updated).toLocaleString('zh-CN'))}</p><div class="grid"><div class="notice">在册员工 ${s.employees.filter(e=>e.status!=='离职').length} 人<br>新录用 ${s.candidates.filter(c=>c.stage==='已录用').length} 人</div><div class="notice">已考核 ${Object.keys(s.performance).length} 人<br>培训报名 ${s.courses.reduce((a,c)=>a+c.members.length,0)} 人次</div></div><h3>任务成绩</h3><p>${taskDefs().map(t=>esc(t.title)+'：'+(s.taskResults[t.id]?.score??'未提交')).join(' / ')}</p><h3>最近业务动态</h3>${s.events.slice(-10).map(x=>'<p>'+esc(x)+'</p>').join('')||'<p class="muted">暂无动态</p>'}<h3>绩效面谈</h3>${Object.entries(s.performance).map(([eid,p])=>'<p>'+esc(s.employees.find(e=>e.id===eid)?.name||eid)+'：'+esc(p.score)+'分；'+esc(p.note)+'</p>').join('')||'<p class="muted">暂无记录</p>'}<h3>完整操作记录（${r.logs.length}条）</h3>${logTable(r.logs)}`);}catch(e){toast(e.message);}};
assignTask=function(){modal('实时下发课堂任务','<label class="field">任务要求<textarea name="title" minlength="5" maxlength="1000" required></textarea></label>',async v=>{await api('/api/assignments',{method:'POST',body:JSON.stringify(v)});await refreshTeacher();toast('已推送到所有已登录学生');});};
function resetStudentPassword(id){modal('重置学生密码 · '+id,field('新的临时密码','password','','password','required minlength="6" maxlength="128"'),async v=>{await api('/api/teacher/reset-password',{method:'POST',body:JSON.stringify({id,...v})});toast('密码已重置，请将新密码告知该学生；原登录会话已失效');});}
function changeTeacherPassword(){modal('修改教师密码',field('原密码','current','','password','required')+field('新密码（至少8位）','password','','password','required minlength="8" maxlength="128"'),async v=>{await api('/api/teacher/change-password',{method:'POST',body:JSON.stringify(v)});toast('教师密码已更新');});}
function backupDatabase(){const a=document.createElement('a');a.href='/api/teacher/backup';a.download='hotel-backup.sqlite';a.click();}
function connectEvents(){
 if(net.events)net.events.close();clearInterval(net.refreshTimer);net.events=new EventSource('/api/events');
 net.events.onmessage=async e=>{try{const msg=JSON.parse(e.data);if(msg.connected)return;
   if(session?.teacher){await refreshTeacher();return;}
   if(msg.userId==='assignments'){const r=await api('/api/assignments');db.assignments=r.assignments;if(window.refreshLearning)await refreshLearning();if(!$('#modal').open)renderPage();toast('课堂任务或教师反馈已更新');return;}
   if(!net.sending&&!net.conflict&&JSON.stringify(state())===net.ack&&!net.pending.length){const r=await api('/api/session');if(r.student.version>net.version){applySnapshot(r);if(!$('#modal').open)renderPage();syncStatus('已同步其他页面最新进度');}}
 }catch(e){syncStatus(e.message,true);}};
 net.events.onerror=()=>syncStatus('实时连接重连中 · 自动保存仍会重试',true);
 net.events.onopen=()=>syncStatus(session?.teacher?'实时连接已建立':net.conflict?'存在版本冲突':(net.pending.length?'待上传操作正在重试':'已连接服务器'));
 net.refreshTimer=setInterval(async()=>{try{if(session?.teacher)await refreshTeacher();else if(session){await flush();const r=await api('/api/session');db.assignments=r.assignments;if(r.student.version>net.version){if($('#modal').open)return;applySnapshot(r);renderPage();syncStatus('已同步最新进度');}}}catch(e){syncStatus(e.message,true);}},10000);
}
window.addEventListener('online',()=>flush().catch(()=>{}));
window.addEventListener('pagehide',pendingCopy);
window.addEventListener('beforeunload',e=>{if(session&&!session.teacher&&(JSON.stringify(state())!==net.ack||net.pending.length)){pendingCopy();e.preventDefault();e.returnValue='还有待上传操作';}});
init=async function(){try{const r=await api('/api/session');await enter(r);}catch(e){renderLogin();if(e.status!==401)toast(e.message);}};
// 由teaching.js完成教学扩展后初始化。
