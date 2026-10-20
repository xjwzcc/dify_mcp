'use strict';
// 仅改变布局和访问入口，沿用既有账号、服务器保存及班级权限。
const mobileBase={render,renderLogin,go};
function enhancePhoneView(){
 document.body.classList.toggle('student-view',Boolean(session&&!session.teacher));
 if(!session||session.teacher)return;
 if(!document.querySelector('.phone-brand')){const brand=document.createElement('div');brand.className='phone-brand';brand.textContent='苏州旅游职业学院 · 吴山苑酒店';document.querySelector('header')?.prepend(brand);}
 if(!document.querySelector('.phone-nav')){
  const bar=document.createElement('div');bar.className='phone-nav';bar.setAttribute('role','navigation');bar.setAttribute('aria-label','手机快捷导航');
  for(const [id,icon,label] of [['dashboard','◈','看板'],['workorders','▤','工单'],['tasks','⚑','任务'],['menu','☰','全部模块']]){const b=document.createElement('button');b.type='button';b.dataset.mobilePage=id;b.innerHTML=`<span aria-hidden="true">${icon}</span>${label}`;b.onclick=()=>{if(id==='menu')document.body.classList.toggle('menu');else go(id);};bar.append(b);}
  document.querySelector('#app').append(bar);
  const shade=document.createElement('button');shade.type='button';shade.className='phone-shade';shade.setAttribute('aria-label','关闭模块菜单');shade.onclick=()=>document.body.classList.remove('menu');document.querySelector('#app').append(shade);
 }
 document.querySelectorAll('[data-mobile-page]').forEach(b=>b.classList.toggle('active',b.dataset.mobilePage===page));
 document.querySelectorAll('#content .tablewrap').forEach(w=>{
  const table=w.querySelector('table');if(!table)return;
  const roster=Boolean(w.querySelector('select.shift'));w.classList.toggle('mobile-roster',roster);w.classList.toggle('mobile-records',!roster);
  if(roster){if(!w.previousElementSibling?.classList.contains('table-scroll-tip')){const tip=document.createElement('p');tip.className='table-scroll-tip';tip.textContent='左右滑动查看整周班表 · 员工列固定 · 点击班次即可调整';w.before(tip);}w.setAttribute('tabindex','0');w.setAttribute('aria-label','周排班表，可左右滑动');return;}
  const labels=Array.from(table.querySelectorAll('thead th'),th=>th.textContent.trim());
  table.querySelectorAll('tbody tr').forEach(tr=>Array.from(tr.children).forEach((td,i)=>{const label=labels[i]||'记录';if(td.dataset.label!==label)td.dataset.label=label;}));
 });
}
render=function(){mobileBase.render();enhancePhoneView();};
renderLogin=function(){document.body.classList.remove('student-view','menu');mobileBase.renderLogin();const role=new URLSearchParams(location.search).get('role');if(role==='teacher')document.querySelector('#teacherTab')?.click();};
go=function(p){mobileBase.go(p);window.scrollTo({top:0,behavior:'instant'});};
// 业务模块局部刷新后也补齐列表标签，不触碰业务数据。
let phoneEnhanceQueued=false;
new MutationObserver(()=>{if(phoneEnhanceQueued)return;phoneEnhanceQueued=true;requestAnimationFrame(()=>{phoneEnhanceQueued=false;enhancePhoneView();});}).observe(document.querySelector('#app'),{childList:true,subtree:true});
document.addEventListener('keydown',e=>{if(e.key==='Escape')document.body.classList.remove('menu');});
// 专用入口不会误入另一身份的工作台；仍须经服务器验证账号密码。
const sharedInit=init;
init=async function(){const role=new URLSearchParams(location.search).get('role');if(!['teacher','student'].includes(role))return sharedInit();try{const r=await api('/api/session');if(Boolean(r.session.teacher)!==(role==='teacher')){renderLogin();return;}await enter(r);}catch(e){renderLogin();if(e.status!==401)toast(e.message);}};
init();
