/* 原业务页面适配：保留原始 S 数据与业务函数，服务器确认后再显示同步完成。
   三种进入方式：学生本人业务页（默认）、扫码顾客端（customer.html）、教师只读预览（view.html）。 */
(async function(){
  const params=new URLSearchParams(location.search||'');
  const previewId=params.get('preview')||'';
  const demo=params.get('demo')==='1';
  const SECTION_LABEL={menu:'菜单与分类管理',guest:'顾客点餐实训',kds:'后厨 KDS',stat:'营业统计与结账',code:'点单二维码',tables:'桌号管理',check:'菜单体检',insight:'数据决策'};
  gateCheck=function(cb){if(cb)cb(false,'')};gateBoot=function(cb){cb(true)};paintSchedNote=function(){};
  if(location.pathname.endsWith('/customer.html')){loadOpen();OPEN_STATE=true;initAppBody();document.getElementById('appFooter').textContent='苏州旅游职业学院 · 教学顾客体验端 · 订单码需发送给对应小组收入，不产生真实支付';return;}

  /* 文案适配：原页面里"顾客拿订单码→学生手工粘贴"的说明已不适用于实时点单，渲染后替换。 */
  const plainRender=render;
  render=function(){plainRender();patchCopy();};
  function patchCopy(){
    const tools=document.querySelector('#bossView .mgmtTools span');
    if(tools&&tools.textContent.indexOf('订单码')>=0){
      tools.textContent='顾客扫码下单后，订单会实时出现在「新下单」；此处仍可粘贴旧的订单码入账';
    }
    const tip=document.querySelector('#guestView .gtip');
    if(tip&&tip.textContent.indexOf('订单码')>=0){
      tip.innerHTML='这是本组设计的菜单。顾客扫「点单二维码」后可直接下单，订单会实时进入本组「后厨 KDS」，<b>无需复制粘贴订单码</b>。';
    }
  }

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

  /* ============ 教师只读预览 / 教学演示：只展示数据，不写入 ============ */
  if(previewId||demo)return previewMode(panel,demo);

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

  /* ===== 实时扫码点单：二维码指向本店服务端点单页，不再把整份菜单压进二维码 ===== */
  let qrPath='';
  try{
    const r=await fetch('/catering/api/qr-code',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    if(r.ok)qrPath=(await r.json()).path||'';
  }catch(e){}
  if(qrPath){
    shareInfo=function(){return{url:location.origin+qrPath,lv:0,name:'实时点单',raw:0};};
    const bossRender=renderBoss;
    renderBoss=function(){
      bossRender();
      if(subView==='code'){
        const host=document.getElementById('bossView');
        if(host&&!host.querySelector('.realtime-note')){
          const note=document.createElement('div');
          note.className='qrnote realtime-note';
          note.innerHTML='<b>实时点单已开启：</b>顾客扫码后订单会直接进入本店「后厨 KDS」，无需再复制粘贴订单码。此码长期有效，闭店时自动暂停。';
          host.insertBefore(note,host.firstChild);
        }
      }
    };
  }

  /* 让教师端看到学生此刻所在页面 */
  function beat(){
    if(document.hidden)return;
    const current=view==='g'?'guest':subView;
    fetch('/catering/api/presence',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({page:SECTION_LABEL[current]||'业务页面',section:current})}).catch(function(){});
  }

  /* 每 4 秒同步服务端新扫码订单；保存中、有未保存改动、弹层打开或页面隐藏时跳过 */
  let pulling=false;
  async function pull(){
    if(document.hidden||sending||batch||dirty||pulling)return;
    if(document.querySelector('.mask.show'))return;
    pulling=true;
    try{
      const r=await fetch('/catering/api/qr-orders',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(8000)});
      if(!r.ok)return;
      const d=await r.json();
      const known=new Set((S.orders||[]).map(o=>o.no));
      const incoming=(Array.isArray(d.orders)?d.orders:[]).filter(o=>o&&o.no&&!known.has(o.no));
      if(!incoming.length)return;
      for(const o of incoming){
        S.orders.push(o);
        if(!baseline.orders.some(x=>x.no===o.no))baseline.orders.push(o);
      }
      if(Number.isSafeInteger(d.seq)&&d.seq>Number(S.seq||0))S.seq=d.seq;
      if(Number.isSafeInteger(d.version)&&d.version>version)version=d.version;
      render();
      toast('收到新扫码订单：'+incoming.map(o=>o.table+' · '+o.no).join('，'));
    }catch(e){
    }finally{
      pulling=false;
    }
  }

  const mode=params.get('section')||'menu';view=mode==='guest'?'g':'b';subView=mode==='guest'?'menu':mode;
  showApp();switchView(view);status.textContent='已加载服务器存档';
  beat();setInterval(beat,30000);
  document.addEventListener('visibilitychange',function(){if(!document.hidden)beat();});
  setInterval(pull,4000);
  document.getElementById('appFooter').textContent='苏州旅游职业学院 · 原项目业务模块 · 本页面仅用于教学，所有收款均为模拟';
  ready=true;
  if(!original)save();
  window.addEventListener('beforeunload',e=>{if(dirty||batch||sending){e.preventDefault();e.returnValue='尚有操作未保存';}});

  /* ============ 教师只读预览 / 教学演示 ============ */
  async function previewMode(panel,demo){
    panel.style.display='none';
    let info;
    try{
      if(demo){
        const r=await fetch('/catering/api/teaching-demo',{signal:AbortSignal.timeout(15000)});
        info=await r.json().catch(()=>({}));
        if(!r.ok)throw Error(info.error||'仅教师可打开教学演示');
      }else{
        const r=await fetch('/catering/api/student-view',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:previewId})});
        info=await r.json().catch(()=>({}));
        if(!r.ok)throw Error(info.error||'仅教师可查看学生页面');
      }
    }catch(err){
      document.body.innerHTML='<div style="max-width:640px;margin:12vh auto;padding:26px;font:14px/1.9 system-ui;color:#243a36">'
        +'<h2 style="font-size:20px;margin:0 0 14px">'+(demo?'无法打开教学演示':'无法预览学生页面')+'</h2><p>'+esc(err.message)+'</p>'
        +'<p style="color:#78877e;margin:14px 0 0">'+(demo?'请从教师端「教学演示」进入。':'请从教师端「学生数据面板」的「查看页面」进入。')+'</p></div>';
      return;
    }
    const state=info.state||{},src=state.original;
    if(!src||!Array.isArray(src.menu)){
      document.body.innerHTML='<div style="max-width:640px;margin:12vh auto;padding:26px;font:14px/1.9 system-ui;color:#243a36">'
        +'<h2 style="font-size:20px;margin:0 0 14px">'+(demo?'演示数据暂不可用':'该学生尚未进入业务页面')+'</h2>'
        +'<p style="color:#78877e">'+(demo?'请稍后刷新重试。':'学生首次打开餐饮实训页后，教师即可在此查看其菜单、订单与操作轨迹。')+'</p></div>';
      return;
    }
    ACC=demo?'demo':info.user.id;ACC_NAME=demo?'教学演示·示范店':info.user.name+'的餐厅';isGuest=false;
    S=src;
    if(S.tables&&S.tables.length)TABLES=S.tables.slice();else S.tables=TABLES.slice();
    if(!S.voucher||typeof S.voucher!=='object')S.voucher=defaultState().voucher;
    if(!S.cats||!S.cats.length){S.cats=[];S.menu.forEach(d=>{if(S.cats.indexOf(d.cat)<0)S.cats.push(d.cat);});if(!S.cats.length)S.cats=['热菜'];}
    OPEN_STATE=S.open!==false;
    setOpen=function(){toast('只读模式，不会修改任何数据');};
    save=function(){toast('只读模式，不会修改任何数据');return false;};
    logout=function(){toast(demo?'教学演示只读：请点击底部「返回教师端」':'只读预览：请点击底部「返回教师端」');};
    const openBtn=document.getElementById('openBtn');if(openBtn)openBtn.style.display='none';
    const whoLink=document.querySelector('#appHeader .minilink');if(whoLink)whoLink.style.display='none';

    const qrPath=demo?'':(info.qrPath||'');
    if(qrPath){
      shareInfo=function(){return{url:location.origin+qrPath,lv:0,name:'实时点单',raw:0};};
      const bossRender=renderBoss;
      renderBoss=function(){
        bossRender();
        if(subView==='code'){
          const host=document.getElementById('bossView');
          if(host&&!host.querySelector('.realtime-note')){
            const note=document.createElement('div');
            note.className='qrnote realtime-note';
            note.innerHTML='<b>学生当前使用的实时点单码：</b>顾客扫码后订单直达该生「后厨 KDS」；教师预览只展示，不会写入学生数据。';
            host.insertBefore(note,host.firstChild);
          }
        }
      };
    }

    const section=params.get('section')||(info.presence&&info.presence.section)||'kds';
    view=section==='guest'?'g':'b';
    subView=section==='guest'?'menu':(SECTION_LABEL[section]?section:'kds');
    showApp();
    switchView(view);
    document.body.classList.add('teacher-preview');
    if(demo)document.body.classList.add('teaching-demo');

    const style=document.createElement('style');
    style.textContent='.teacher-preview-bar{position:fixed;left:0;right:0;bottom:0;z-index:1200;background:#15372d;color:#f4f1e4;display:flex;gap:14px;align-items:center;flex-wrap:wrap;padding:10px 16px;box-shadow:0 -6px 24px #0002;font:13px/1.6 Microsoft YaHei,system-ui,sans-serif}'
      +'.teacher-preview-bar b{color:#fff}.teacher-preview-bar .meta{color:#bcd3c3}.teacher-preview-bar select{border-radius:6px;padding:4px 8px;border:0;font:inherit}'
      +'.teacher-preview-bar button{background:#f0d9a4;color:#173f35;border-radius:6px;padding:5px 12px;font:inherit}'
      +'.teacher-preview-bar a{color:#f0d9a4;text-decoration:none}'
      +'body.teacher-preview{padding-bottom:60px}'
      +'body.teacher-preview #appMain button,body.teacher-preview #appMain input,body.teacher-preview #appMain textarea,body.teacher-preview #appMain select,body.teacher-preview #appMain .opt,body.teacher-preview #appMain .addbtn,body.teacher-preview #appMain .paygo{opacity:.5;cursor:not-allowed}'
      +'body.teacher-preview #appMain .subtab,body.teacher-preview #appMain .cat,body.teacher-preview #appMain .tchip{cursor:pointer}';
    document.head.appendChild(style);

    const sections=[['kds','后厨 KDS'],['menu','菜单管理'],['stat','营业统计'],['tables','桌号管理'],['check','菜单体检'],['insight','数据决策'],['code','点单二维码'],['guest','顾客点餐端']];
    const picked=sections.find(([k])=>k===(view==='g'?'guest':subView))||sections[0];
    const bar=document.createElement('div');
    bar.className='teacher-preview-bar';
    bar.innerHTML='<b>'+(demo?'教学演示 · 完整经营数据包':'只读预览 · '+esc(info.user.name)+'（'+esc(info.user.id)+'）')+'</b>'
      +'<span class="meta">'+(demo?'30 笔订单 / 14 道菜 / 7 种支付方式，演示数据只读':'学生当前页面：'+esc((info.presence&&info.presence.page)||'未知'))+'</span>'
      +'<label>切换页面 <select id="previewSection">'+sections.map(([k,label])=>'<option value="'+k+'"'+(k===picked[0]?' selected':'')+'>'+label+'</option>').join('')+'</select></label>'
      +'<button id="previewRefresh">'+(demo?'重置演示数据':'刷新学生数据')+'</button>'
      +'<a href="/catering/teacher">返回教师端</a>';
    document.body.appendChild(bar);
    document.getElementById('previewRefresh').onclick=function(){location.reload()};
    document.getElementById('previewSection').onchange=function(e){
      const key=e.target.value;
      if(key==='guest'){subView='menu';view='g';switchView('g');return;}
      subView=key;view='b';switchView('b');
    };

    /* 只读：拦截业务区内的写入控件，但保留切换页签、分类和桌号 */
    document.addEventListener('click',function(e){
      if(!e.target.closest('#appMain'))return;
      const blocked=e.target.closest('button,input,textarea,select,.opt,.addbtn,.paygo');
      if(!blocked)return;
      e.preventDefault();e.stopPropagation();
      toast(demo?'教学演示为只读，不会写入任何学生数据':'教师预览为只读，学生数据不会被修改');
    },true);
    document.addEventListener('submit',function(e){if(e.target.closest('#appMain')){e.preventDefault();e.stopPropagation();}},true);

    document.getElementById('appFooter').textContent=demo?'教学演示 · 独立示例经营数据，只读展示，不写入任何学生账号':'教师只读预览 · 展示学生已保存的菜单、订单与操作页面，不会写入学生数据';
  }
})();
