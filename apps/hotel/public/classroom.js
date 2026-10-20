'use strict';
// 教师控制由服务器校验；浏览器同时提供阶段提示、只读界面与待上传副本保护。
const classroom={classes:[],selected:'',public:[]};
const classModules={employees:'员工档案',recruit:'招聘管理',schedule:'排班考勤',payroll:'薪酬核算',performance:'绩效管理',training:'培训管理',relations:'员工关系'};
const stagePresets={
 '课前关闭':{entry:false,write:false,submit:false,score:false,modules:[]},
 '讲解观摩':{entry:true,write:false,submit:false,score:false,modules:Object.keys(classModules)},
 '招聘实训':{entry:true,write:true,submit:true,score:true,modules:['recruit']},
 '排班与薪酬':{entry:true,write:true,submit:true,score:true,modules:['schedule','payroll']},
 '绩效与培训':{entry:true,write:true,submit:true,score:true,modules:['performance','training']},
 '员工关系':{entry:true,write:true,submit:true,score:true,modules:['relations']},
 '综合实训':{entry:true,write:true,submit:true,score:true,modules:Object.keys(classModules)},
 '收卷只读':{entry:true,write:false,submit:false,score:false,modules:Object.keys(classModules)}
};
const classroomBase={api,render,renderPage,renderLogin,refreshLearning,ranking,flush,save,shifts,modal,editWorkorder};
const currentAccess=()=>session&&!session.teacher?session.access:null;
function stageAllowed(kind,module){const c=currentAccess();return !c||c.entry&&(!kind||c[kind])&&(!module||c.modules.includes(module));}
api=async function(url,options){return classroomBase.api(url,options);};
function classOptions(value,includeAll=false){return(includeAll?'<option value="">所有班级</option>':'')+classroom.classes.map(c=>`<option value="${esc(c.id)}" ${c.id===value?'selected':''}>${esc(c.name)}</option>`).join('');}
teacherNav.unshift(['classControl','◉','班级与阶段控制']);
refreshLearning=async function(){if(session?.teacher)classroom.classes=(await api('/api/classes')).classes;else if(currentAccess()&&!currentAccess().entry)return;await classroomBase.refreshLearning();};
ranking=function(){return classroomBase.ranking().filter(r=>!classroom.selected||r.classId===classroom.selected);};
renderLogin=function(){classroomBase.renderLogin();let choices=[];
 const decorate=()=>{const form=$('#loginform');if(!form||!form.querySelector('[name="classCode"]')||form.querySelector('[name="classId"]'))return;form.insertAdjacentHTML('afterbegin',`<label class="field">教学班级<select name="classId" required><option value="">请选择班级</option>${choices.map(c=>`<option value="${esc(c.id)}">${esc(c.name)} · ${esc(c.stage)}${c.entry?'':'（入口关闭）'}</option>`).join('')}</select></label><p class="smalltext muted">已有学号请选择原班级。首次进入使用本班口令；学号在全校系统内唯一。</p>`);};
 api('/api/classes/public').then(r=>{choices=r.classes;decorate();}).catch(e=>toast(e.message));
 $('#studentTab').addEventListener('click',decorate);
};
// 在本机保留受锁定影响的待上传操作，教师重新开放后可以继续保存。
flush=async function(){if(session&&!session.teacher&&!stageAllowed('write')&&(JSON.stringify(state())!==net.ack||net.pending.length)){pendingCopy();throw new Error('教师已暂停业务操作，待上传副本已保留；重新开放后可重试');}return classroomBase.flush();};
save=function(){if(session&&!session.teacher&&!stageAllowed('write'))return true;return classroomBase.save();};
shifts=function(e){if(!session?.teacher&&!stageAllowed('write','schedule')){const k=filters.week+'_'+e.id;if(state().shifts[k])return state().shifts[k];const s=state(),old=s.shifts;s.shifts={...old};try{return classroomBase.shifts(e).slice();}finally{s.shifts=old;}}return classroomBase.shifts(e);};
modal=function(title,body,submit,label){if(session&&!session.teacher&&submit){const kind=page==='workorders'?'submit':page==='interaction'?null:'write';if(!stageAllowed(kind,classModules[page]?page:null)){toast('教师尚未开放当前阶段操作');return;}}return classroomBase.modal(title,body,submit,label);};
renderPage=function(){
 if(session?.teacher&&page==='classControl'){classControlPage();addTeachingFooter();return;}
 if(session&&!session.teacher){const c=currentAccess();if(c&&!c.entry){$('#content').innerHTML=title('课堂入口暂未开放',c.name+' · '+c.stage)+`<section class="card"><h2>请等待教师开放本班</h2><p>已保存的业务记录与成绩保留；开放后自动恢复访问。</p><button onclick="exportFullBackup()">下载个人备份</button></section>`;addTeachingFooter();return;}
  if(classModules[page]&&!stageAllowed(null,page)){$('#content').innerHTML=title('本阶段尚未开放',classModules[page])+`<div class="card">当前阶段：${esc(c?.stage)}。请根据教师安排进入已开放模块。</div>`;addTeachingFooter();return;}
 }
 // 班级筛选作用于列表、日志、工单提交与私信；所有班级时保留完整课堂总览。
 const logs=net.teacherLogs,submissions=learning.submissions,messages=learning.messages,orders=learning.orders;
 if(session?.teacher&&classroom.selected){const ids=new Set(ranking().map(r=>r.id));net.teacherLogs=logs.filter(l=>ids.has(l.student));learning.submissions=submissions.filter(s=>ids.has(s.studentId));learning.messages=messages.filter(m=>m.student_id==='all'||m.student_id==='class:'+classroom.selected||ids.has(m.student_id));learning.orders=orders.filter(o=>o.target==='all'||o.target==='class:'+classroom.selected||o.target.split(',').some(id=>ids.has(id)));}
 try{classroomBase.renderPage();}finally{net.teacherLogs=logs;learning.submissions=submissions;learning.messages=messages;learning.orders=orders;}
 if(session?.teacher){$('#content').insertAdjacentHTML('afterbegin',`<div class="card row"><label>当前查看班级 <select aria-label="查看班级" onchange="classroom.selected=this.value;renderPage()">${classOptions(classroom.selected,true)}</select></label><span class="muted smalltext">进度、数据面板、批阅与排行榜按所选班级筛选</span></div>`);}
 else{
  const c=currentAccess();$('#content').insertAdjacentHTML('afterbegin',`<div class="notice">${esc(c?.name||'')} · 当前阶段：<b>${esc(c?.stage||'综合实训')}</b>　业务${c?.write?'可操作':'只读'} / 提交${c?.submit?'开放':'暂停'} / 评分${c?.score?'开放':'暂停'}</div>`);
  if(classModules[page]&&!stageAllowed('write',page))$('#content').querySelectorAll('button,input[onchange],select[onchange],textarea').forEach(el=>{if(!/详情|分析|导出|备份/.test(el.textContent))el.disabled=true;});
  $('#content').querySelectorAll('[onclick^="submitTask"]').forEach(el=>{const id=el.getAttribute('onclick').match(/task[1-4]/)?.[0],m={task1:'recruit',task2:'schedule',task3:'performance',task4:'relations'}[id];if(!stageAllowed('score',m))el.disabled=true;});
  $('#content').querySelectorAll('[onclick^="submitWorkorder"]').forEach(el=>{const o=learning.orders.find(o=>el.getAttribute('onclick').includes(o.id));if(!stageAllowed('submit',o?.module))el.disabled=true;});
 }
};
render=function(){classroomBase.render();if(session&&!session.teacher){$('nav').querySelectorAll('button').forEach(b=>{const p=b.dataset.page||b.getAttribute('onclick')?.match(/go\('([^']+)'\)/)?.[1];if(classModules[p]&&!stageAllowed(null,p))b.disabled=true;});if(!stageAllowed('write'))$('#logoutBtn').onclick=async()=>{if(!await askConfirm('退出并保留本机待上传副本？教师开放后可继续保存。'))return;pendingCopy();await api('/api/logout',{method:'POST',body:'{}'});renderLogin();};}};
function classControlPage(){
 $('#content').innerHTML=title('班级与阶段控制','按班级独立开放入口和业务阶段；变更将同步到已登录学生','<button onclick="editClass()">＋ 新建教学班</button>')+`<div class="grid">${classroom.classes.map(c=>`<section class="card"><div class="row between"><h2>${esc(c.name)}</h2><span class="badge ${c.entry?'':'bad'}">${c.entry?'入口开放':'入口关闭'}</span></div><p>阶段：<b>${esc(c.stage)}</b> · 已注册 ${c.students} 人</p><p>本班注册口令：<b>${esc(c.code)}</b> · ${c.enrollment?'允许新生注册':'停止新生注册'}</p><p>业务${c.write?'可操作':'只读'} · 工单提交${c.submit?'开放':'暂停'} · 任务评分${c.score?'开放':'暂停'}</p><p class="smalltext">开放模块：${c.modules.map(m=>classModules[m]).join('、')||'无'}</p><div class="row"><button onclick="editClass('${c.id}')">配置阶段与开关</button><button class="${c.entry?'danger':'secondary'}" onclick="toggleClass('${c.id}')">${c.entry?'关闭本班入口':'开放本班入口'}</button><button class="secondary" onclick="classroom.selected='${c.id}';go('teacherProgress')">查看本班进度</button></div></section>`).join('')}</div><section class="card"><h3>学生归班调整</h3><p>原有学生已自动归入默认教学班。调整归班保留全部业务记录、任务成绩和历史日志；学号全局唯一。</p><button class="secondary" onclick="moveClassStudent()">调整学生所属班级</button></section><div class="notice">入口开关对已有登录立即生效；“新生注册”只影响首次建号。收卷只读保留查看、备份及师生交流。通用工单面向所有班级，专班工单须选择指定教学班。</div>`;
}
function flag(label,key,value){return `<label class="row" style="margin:12px 0"><input type="checkbox" name="${key}" ${value?'checked':''}>${label}</label>`;}
function editClass(id){const c=classroom.classes.find(c=>c.id===id)||{name:'',code:'',stage:'课前关闭',entry:false,enrollment:true,write:false,submit:false,score:false,modules:[]};
 modal(id?'班级阶段与权限':'新建教学班',field('班级名称','name',c.name,'text','required maxlength="60"')+field('首次注册口令','code',c.code,'text','required minlength="4" maxlength="80"')+`<label class="field">阶段模板<select id="stagePreset" onchange="applyStagePreset(this.value)"><option value="">自定义配置</option>${Object.keys(stagePresets).map(k=>`<option ${k===c.stage?'selected':''}>${k}</option>`).join('')}</select></label>`+field('当前阶段名称','stage',c.stage,'text','required maxlength="60"')+`<div class="formgrid">${flag('允许本班学生进入','entry',c.entry)}${flag('允许新生注册','enrollment',c.enrollment)}${flag('允许业务修改和保存','write',c.write)}${flag('允许提交工单成果','submit',c.submit)}${flag('允许内置任务评分','score',c.score)}</div><h3>本阶段开放模块</h3><div class="formgrid">${Object.entries(classModules).map(([key,name])=>flag(name,'module_'+key,c.modules.includes(key))).join('')}</div><p class="smalltext muted">切换阶段前建议提醒学生完成保存。暂停期间的待上传操作保留在学生浏览器，开放后可重试。</p>`,async v=>{if(!await askConfirm('保存本班阶段开关？将立即影响本班已登录学生。'))return false;const form=$('#modalform');const b={id,name:v.name,code:v.code,stage:v.stage,modules:Object.keys(classModules).filter(k=>form.elements['module_'+k].checked),...Object.fromEntries(['entry','enrollment','write','submit','score'].map(k=>[k,form.elements[k].checked]))};await api('/api/classes',{method:'POST',body:JSON.stringify(b)});await refreshLearning();renderPage();toast('班级控制已保存并推送');});
}
function applyStagePreset(name){const p=stagePresets[name],f=$('#modalform');if(!p)return;f.elements.stage.value=name;for(const k of ['entry','write','submit','score'])f.elements[k].checked=p[k];for(const k of Object.keys(classModules))f.elements['module_'+k].checked=p.modules.includes(k);}
async function toggleClass(id){const c=classroom.classes.find(c=>c.id===id);if(!await askConfirm((c.entry?'关闭':'开放')+c.name+'的入口？已登录学生也将同步受控。'))return;try{await api('/api/classes',{method:'POST',body:JSON.stringify({...c,entry:!c.entry})});await refreshLearning();renderPage();toast('班级入口已更新');}catch(e){toast(e.message);}}
function moveClassStudent(){modal('调整学生归班',`<label class="field">学生<select name="studentId">${net.teacherRows.map(r=>`<option value="${esc(r.id)}">${esc(r.name)} / ${esc(r.id)} / ${esc(classroom.classes.find(c=>c.id===r.classId)?.name)}</option>`).join('')}</select></label><label class="field">转入班级<select name="classId">${classOptions('')}</select></label>`,async v=>{if(!await askConfirm('调整归班后，该学生将遵循新班级权限；原成绩保留。'))return false;await api('/api/classes/move',{method:'POST',body:JSON.stringify(v)});await refreshTeacher();toast('学生归班已更新');});}
editWorkorder=function(id){classroomBase.editWorkorder(id);const f=$('#modalform'),o=learning.orders.find(o=>o.id===id),audience=f.elements.audience;audience.insertAdjacentHTML('beforeend','<option>指定教学班</option>');if(o?.target.startsWith('class:'))audience.value='指定教学班';f.insertAdjacentHTML('afterbegin',`<label class="field">指定教学班<select name="classTarget">${classOptions(o?.target.slice(6)||classroom.selected)}</select></label>`);};
sendMessage=function(id){modal(session.teacher?'发送班级通知或个人指导':'向教师提问',(session.teacher?`<label class="field">接收对象<select name="studentId"><option value="all">所有班级</option>${classroom.classes.map(c=>`<option value="class:${c.id}" ${!id&&classroom.selected===c.id?'selected':''}>整班 · ${esc(c.name)}</option>`).join('')}${ranking().map(r=>`<option value="${esc(r.id)}" ${id===r.id?'selected':''}>${esc(r.name)} / ${esc(r.id)}</option>`).join('')}</select></label>`:'')+textArea('内容','content','','required minlength="5" maxlength="2000"'),async v=>{await api('/api/classroom/messages',{method:'POST',body:JSON.stringify({...v,studentId:session.teacher?v.studentId:session.id})});await refreshLearning();renderPage();toast('教学消息已保存并推送');});};
// 独立权限轮询不依赖保存队列；暂停、恢复和归班都不会被待上传操作阻塞。
async function refreshClassAccess(){if(!session||session.teacher)return;try{const before=JSON.stringify(session.access),r=await classroomBase.api('/api/session');if(!session||session.id!==r.session.id)return;session.access=r.session.access;session.classId=r.session.classId;if(before!==JSON.stringify(session.access)){pendingCopy();if($('#modal').open)$('#modal').close();render();toast('教师已更新班级阶段：'+session.access.stage);}}catch(e){if(e.status===401)syncStatus(e.message,true);}}
setInterval(refreshClassAccess,3000);
// 初始化由手机适配层执行。
