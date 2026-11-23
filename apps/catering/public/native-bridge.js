/* 原业务页面适配：保留原始 S 数据与业务函数，服务器确认后再显示同步完成。 */
(async function(){
  gateCheck=function(cb){if(cb)cb(false,'')};gateBoot=function(cb){cb(true)};paintSchedNote=function(){};
  if(location.pathname.endsWith('/customer.html')){loadOpen();OPEN_STATE=true;initAppBody();document.getElementById('appFooter').textContent='苏州旅游职业学院 · 教学顾客体验端 · 订单码需发送给对应小组收入，不产生真实支付';return;}
  const panel=document.createElement('div');
  panel.style.cssText='position:fixed;right:12px;bottom:10px;max-width:calc(100% - 24px);background:#174e3c;color:white;padding:7px 13px;border-radius:7px;z-index:900;font:12px Microsoft YaHei';
  const status=document.createElement('div');
  status.setAttribute('role','status');
  const actions=document.createElement('div');
  actions.style.marginTop='6px';
  actions.hidden=true;
  const retry=document.createElement('button'),backup=document.createElement('button');
  retry.type=backup.type='button';
  retry.className=backup.className='mini';
  retry.textContent='重试保存';
  backup.textContent='下载业务备份';
  actions.append(retry,' ',backup);
  panel.append(status,actions);
  document.body.append(panel);
  status.textContent='正在加载服务器存档…';
  let ready=false;
  window.addEventListener('message',async e=>{
    if(e.origin!==location.origin||e.source!==parent||e.data?.type!=='emenu-flush')return;
    let message='';
    try {
      if(ready){
        await flush();
        if(cart.length)message='请先提交或清空购物车';
      }
    } catch(err) {
      message=err.message;
    }
    parent.postMessage({type:'emenu-flushed',ok:!message,message},location.origin);
  });
  let info;
  try {
    const response=await fetch('/catering/api/snapshot?view=business',{signal:AbortSignal.timeout(15000)});
    if(response.status===401){status.textContent='登录已失效，请返回课堂入口';return;}
    if(!response.ok)throw Error();
    info=await response.json();
  } catch {
    status.textContent='无法加载服务器存档，请检查网络后重新进入业务页面';
    return;
  }
  if(info.user.role!=='student'){status.textContent='请使用学生账号进入业务实训';return;}
  const studentId=info.user.id;
  const {original,version:loadedVersion=0}=info.state;
  let version=loadedVersion,dirty=false,sending=null,conflict=false,failure='',replacePending=false,batch=null;
  ACC=studentId;ACC_NAME=info.user.name+'的餐厅';isGuest=false;S=original||defaultState();if(S.tables&&S.tables.length)TABLES=S.tables.slice();else S.tables=TABLES.slice();if(!S.voucher||typeof S.voucher!=='object')S.voucher=defaultState().voucher;OPEN_STATE=S.open!==false;
  let baseline=copyState(S),source=S;
  setOpen=function(v){OPEN_STATE=!!v;S.open=OPEN_STATE;syncOpenBtn();save();render()};
  function copyState(value){
    if(Array.isArray(value))return value.map(copyState);
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,entry])=>[key,copyState(entry)]));
    return value;
  }
  function copyDraft(){
    const draft=copyState(S);
    if(!draft.tables?.length)draft.tables=defaultState().tables;
    if(!draft.voucher||typeof draft.voucher!=='object')draft.voucher=defaultState().voucher;
    return draft;
  }
  function equal(a,b){
    if(a===b)return true;
    if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
    const keys=Object.keys(a);
    return keys.length===Object.keys(b).length&&keys.every(key=>Object.hasOwn(b,key)&&equal(a[key],b[key]));
  }
  function recordsDiff(before,after,key){
    const old=new Map(before.map(record=>[record[key],record]));
    const next=new Map(after.map(record=>[record[key],record]));
    if(old.size!==before.length||next.size!==after.length)return null;
    const edits=[];
    for(const [id,value] of old){
      const updated=next.get(id)??null;
      if(!equal(value,updated))edits.push({id,before:value,after:updated});
    }
    for(const [id,value] of next){
      if(!old.has(id))edits.push({id,before:null,after:value});
    }
    return edits;
  }
  function changesFor(draft){
    // Replacements and removals of categories/tables depend on the entire saved version.
    if(replacePending||S!==source||!baseline.cats.every((value,i)=>draft.cats[i]===value)||
      !baseline.tables.every((value,i)=>draft.tables[i]===value))return null;
    const menu=recordsDiff(baseline.menu,draft.menu,'id'),orders=recordsDiff(baseline.orders,draft.orders,'no');
    if(!menu||!orders)return null;
    const changes={menu,orders,cats:draft.cats.slice(baseline.cats.length),tables:draft.tables.slice(baseline.tables.length)};
    if(!equal(baseline.voucher,draft.voucher))changes.voucher={before:baseline.voucher,after:draft.voucher};
    if((baseline.open!==false)!==(draft.open!==false))changes.open={before:baseline.open!==false,after:draft.open!==false};
    return changes;
  }
  async function upload(body){
    let response;
    try {
      response=await fetch('/catering/api/business-state',{method:'POST',headers:{'Content-Type':'application/json'},body,signal:AbortSignal.timeout(15000)});
    } catch {
      throw Error('无法连接服务器，请检查网络后重试');
    }
    const result=await response.json().catch(()=>null);
    if(!response.ok){
      const fallback=response.status===413?'业务数据过大，请缩小菜品照片后重试':'服务器暂时无法保存，请稍后重试';
      throw Object.assign(Error(result?.error||fallback),{status:response.status});
    }
    if(!Number.isSafeInteger(result?.version)||typeof result.merged!=='boolean')throw Error('未收到服务器的保存确认');
    return result;
  }
  function flush(){
    if(sending)return sending;
    if(conflict)return Promise.reject(Error(failure));
    if(!dirty&&!batch)return Promise.resolve();
    retry.disabled=true;
    status.textContent='正在保存到服务器…';
    sending=Promise.resolve().then(async()=>{
      while(batch||dirty){
        if(!batch){
          const draft=copyDraft();
          const changes=changesFor(draft);
          const payload=changes?{changes}:{replacement:draft};
          batch={draft,source:S,replace:!changes,body:JSON.stringify({studentId,version,...payload})};
          dirty=false;
          replacePending=false;
        }
        const result=await upload(batch.body);
        // If someone else saved first, this page still has its own earlier view.
        // Do not use the merged version to authorize a later whole-state replacement.
        if(!result.merged)version=result.version;
        baseline=batch.draft;
        source=batch.source;
        batch=null;
      }
      failure='';
      actions.hidden=true;
      status.textContent='已保存到服务器 · 教师可见';
    }).catch(err=>{
      conflict=err.status===409;
      if(err.status>=400&&err.status<500){
        dirty=true;
        replacePending ||= !!batch?.replace;
        batch=null;
      }
      failure=conflict?err.message+'。请先下载业务备份，再重新进入。':
        '保存未完成：'+err.message+'。请保留页面，可重试保存或下载业务备份。';
      retry.hidden=conflict;
      actions.hidden=false;
      status.textContent=failure;
      parent.postMessage({type:'emenu-save-error',message:failure},location.origin);
      throw Error(failure);
    }).finally(()=>{
      sending=null;
      retry.disabled=false;
    });
    return sending;
  }
  save=function(replace=false){
    dirty=true;
    replacePending ||= replace===true;
    if(!conflict)flush().catch(()=>{});
    return true;
  };
  retry.onclick=()=>flush().catch(()=>{});
  backup.onclick=()=>exportData();
  logout=function(){parent.postMessage({type:'emenu-exit-business'},location.origin)};
  const mode=new URLSearchParams(location.search).get('section')||'menu';view=mode==='guest'?'g':'b';subView=mode==='guest'?'menu':mode;
  showApp();switchView(view);status.textContent='已加载服务器存档';
  document.getElementById('appFooter').textContent='苏州旅游职业学院 · 原项目业务模块 · 本页面仅用于教学，所有收款均为模拟';
  ready=true;
  if(!original)save();
  window.addEventListener('beforeunload',e=>{if(dirty||batch||sending){e.preventDefault();e.returnValue='尚有操作未保存';}});
})();
