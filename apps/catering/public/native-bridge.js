/* 原业务页面适配：保留原始 S 数据与业务函数，服务器确认后再显示同步完成。 */
(async function(){
  const customer=location.pathname==='/catering/customer.html';
  gateCheck=function(cb){if(cb)cb(false,'')};gateBoot=function(cb){cb(true)};paintSchedNote=function(){};
  if(customer){loadOpen();OPEN_STATE=true;initAppBody();document.getElementById('appFooter').textContent='苏州旅游职业学院 · 教学顾客体验端 · 订单码需发送给对应小组收入，不产生真实支付';return;}
  const status=document.createElement('div');status.style.cssText='position:fixed;right:12px;bottom:10px;background:#174e3c;color:white;padding:7px 13px;border-radius:7px;z-index:900;font:12px Microsoft YaHei';document.body.append(status);
  const response=await fetch('/catering/api/snapshot');if(!response.ok){status.textContent='登录失效，请返回课堂入口';return;}
  const info=await response.json();if(info.user.role!=='student'){status.textContent='请使用学生账号进入业务实训';return;}
  let base=info.state,version=base.version||0,queue=Promise.resolve(),pending=0;let readOnly=false;
  ACC=info.user.id;ACC_NAME=info.user.name+'的餐厅';isGuest=false;S=base.original||defaultState();OPEN_STATE=S.open!==false;
  setOpen=function(v){OPEN_STATE=!!v;S.open=OPEN_STATE;syncOpenBtn();save();render()};
  function mapped(){return{...base,version,original:JSON.parse(JSON.stringify(S)),menu:S.menu.map(d=>({id:d.id,name:d.name,category:d.cat,price:+d.price,cost:0,stock:0,allergen:'原项目未设此字段',description:d.desc||'',on:!d.soldOut})),orders:S.orders.map(o=>{const items=o.items.map(i=>({...i,cost:0})),total=items.reduce((a,i)=>a+i.price*i.qty,0);return{id:o.no,table:o.table,note:o.orderNote||'',items,total,payable:total,status:({new:'待接单',cooking:'制作中',done:'待结账',paid:'已结账'})[o.status]||o.status,time:new Date(o.ts).toISOString()}}),logs:[{time:new Date().toISOString(),action:'保存原版餐饮业务：菜品 '+S.menu.length+'，订单 '+S.orders.length},...(base.logs||[])].slice(0,300)}}
  save=function(){if(readOnly){status.textContent='当前页面已停止写入，请重新进入业务页面';return false;}const payload=mapped();pending++;status.textContent='正在同步到教师端…';queue=queue.then(async()=>{payload.version=version;const r=await fetch('/catering/api/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:payload})});const result=await r.json();if(!r.ok){readOnly=true;throw Error(result.error||'保存失败');}version=result.version;base=payload;base.version=version;pending--;status.textContent=pending?'正在同步…':'已保存到服务器 · 教师可见';}).catch(err=>{status.textContent='保存失败：'+err.message;parent.postMessage({type:'emenu-save-error',message:err.message},location.origin)});return true;};
  logout=function(){parent.postMessage({type:'emenu-exit-business'},location.origin)};
  const mode=new URLSearchParams(location.search).get('section')||'menu';view=mode==='guest'?'g':'b';subView=mode==='guest'?'menu':mode;
  showApp();switchView(view);status.textContent='已加载服务器存档';
  document.getElementById('appFooter').textContent='苏州旅游职业学院 · 原项目业务模块 · 本页面仅用于教学，所有收款均为模拟';
  if(!base.original)save();
  window.addEventListener('beforeunload',e=>{if(pending){e.preventDefault();e.returnValue='尚有操作未保存';}});
  window.addEventListener('message',e=>{if(e.origin!==location.origin||e.source!==parent||e.data?.type!=='emenu-flush')return;queue.then(()=>parent.postMessage({type:'emenu-flushed',ok:!pending&&!readOnly&&cart.length===0},location.origin));});
})();
