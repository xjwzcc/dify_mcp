'use strict';
/* 顾客扫码点单：直接读该学生店铺的实时菜单，下单后立刻出现在其「后厨 KDS」。 */
(function(){
  const token=(location.pathname.match(/\/catering\/qr\/([A-Za-z0-9_-]{16,64})/)||[])[1]||'';
  const API='/catering/api/qr/'+token;
  const app=document.getElementById('app'),sheetHost=document.getElementById('sheet');
  const MODS=['少油','少盐','免葱','免蒜','加急'];
  /* 顾客点单时先选支付方式，随订单一起送到后厨与收银台（真实结账仍以收银台为准） */
  const PAYS=[{k:'wx',n:'微信支付',e:'💬'},{k:'zfb',n:'支付宝',e:'🅰️'},{k:'cash',n:'现金',e:'💵'},{k:'credit',n:'信用卡',e:'💳'},{k:'debit',n:'储蓄卡',e:'🏦'},{k:'meituan',n:'美团团购',e:'🟡'},{k:'dianping',n:'大众点评',e:'🟠'}];
  const PAY_NAME=Object.fromEntries(PAYS.map(p=>[p.k,p.n]));
  const STATUS_TEXT={new:'已下单，等待接单',cooking:'后厨制作中',done:'已出餐，等待结账',paid:'已结账',missing:'订单已被店员重置'};
  const STATUS_PILL={new:'待接单',cooking:'制作中',done:'待结账',paid:'已结账',missing:'已失效'};
  const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money=n=>'¥'+Number(n||0).toFixed(2);
  const storeKey='catering-qr-'+token;
  let meta=null,cart=[],table='',guests=2,note='',cat='',pay='wx',view='menu',order=null,sheet=null,submitting=false,timer=0;

  if(!token){app.innerHTML='<div class="empty"><h2>二维码无效</h2><p>请重新扫描餐桌上的点单二维码。</p></div>';return;}

  function toast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove('show'),2600);}
  async function api(path,body){
    const r=await fetch(API+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});
    const j=await r.json().catch(()=>({}));
    if(!r.ok)throw Error(j.error||('请求失败（'+r.status+'）'));
    return j;
  }
  function persist(){try{localStorage.setItem(storeKey,JSON.stringify({table,guests,note,cat,pay,cart,order}))}catch(e){}}
  function restore(){
    try{
      const saved=JSON.parse(localStorage.getItem(storeKey)||'{}');
      if(saved.table)table=String(saved.table);
      if(Number.isInteger(saved.guests))guests=Math.min(30,Math.max(1,saved.guests));
      if(typeof saved.note==='string')note=saved.note.slice(0,200);
      if(typeof saved.cat==='string')cat=saved.cat;
      if(typeof saved.pay==='string'&&PAY_NAME[saved.pay])pay=saved.pay;
      if(Array.isArray(saved.cart))cart=saved.cart.filter(i=>i&&typeof i.id==='string'&&Number.isInteger(i.qty)&&i.qty>0).slice(0,20);
      if(saved.order&&saved.order.no)order=saved.order;
    }catch(e){}
  }
  const dishOf=id=>(meta&&meta.menu||[]).find(d=>String(d.id)===String(id))||null;
  const lineOf=item=>{const d=dishOf(item.id);if(!d)return null;const spec=item.spec||'';const price=spec&&d.specPrice&&d.specPrice[spec]!=null?Number(d.specPrice[spec]):Number(d.price)||0;return{d,spec,price,qty:item.qty};};
  const lines=()=>cart.map((item,idx)=>{const l=lineOf(item);return l?Object.assign(l,{idx}):null;}).filter(Boolean);
  const total=()=>lines().reduce((a,l)=>a+l.price*l.qty,0);
  const stepsOn=status=>[(['new','cooking','done','paid'].includes(status)),(['cooking','done','paid'].includes(status)),(['done','paid'].includes(status)),status==='paid'];

  function load(){
    restore();
    return api('').then(m=>{
      meta=m;
      if(!table||!m.tables.includes(table))table=m.tables[0]||'A01';
      if(!cat||!m.cats.includes(cat))cat=m.cats[0]||'';
      cart=cart.filter(i=>{const d=dishOf(i.id);return d&&!d.soldOut;});
      render();
    }).catch(err=>{
      app.innerHTML='<div class="empty"><h2>无法打开点单页</h2><p>'+esc(err.message)+'</p><p class="muted">请联系店员重新生成二维码。</p></div>';
    });
  }

  function render(){
    if(!meta)return;
    if(order&&view==='done')return renderDone();
    if(view==='cart')return renderCart();
    return renderMenu();
  }

  function header(){
    return '<header class="shop">'
      +'<div class="badge">'+(meta.open?'● 实时点单中':'○ 本店已暂停点单')+'</div>'
      +'<h1>'+esc(meta.restaurant)+'</h1>'
      +'<p class="sub">经营学生：'+esc(meta.student.name)+' · 教学模拟餐厅，不产生真实支付</p>'
      +'</header>';
  }

  function renderMenu(){
    const dishes=(meta.menu||[]).filter(d=>!cat||d.cat===cat);
    app.innerHTML=header()
      +'<section class="tables"><span>桌号</span><div class="chips">'+meta.tables.map(t=>'<button class="tchip'+(t===table?' on':'')+'" data-act="table" data-table="'+esc(t)+'">'+esc(t)+'</button>').join('')+'</div></section>'
      +(meta.open?'':'<div class="closed">本店暂停点单：可先浏览菜单，恢复后再下单。</div>')
      +'<section class="cats">'+meta.cats.map(c=>'<button class="cat'+(c===cat?' on':'')+'" data-act="cat" data-cat="'+esc(c)+'">'+esc(c)+'</button>').join('')+'</section>'
      +'<main class="list">'+(dishes.length?dishes.map(dishRow).join(''):'<div class="empty">该分类暂无菜品</div>')+'</main>'
      +cartBar();
    wire();
  }

  function dishRow(d){
    return '<article class="dish'+(d.soldOut?' off':'')+'">'
      +'<div class="emoji">'+esc(d.emoji||'🍽️')+'</div>'
      +'<div class="dmain"><h3>'+esc(d.name)+(d.specs.length?' <span class="tag">多规格</span>':'')+'</h3>'
      +'<p>'+esc(d.desc||'')+'</p>'
      +'<div class="price">'+money(d.price)+'<span class="unit">/'+esc(d.unit||'份')+'</span></div></div>'
      +'<button class="add" data-act="add" data-id="'+esc(d.id)+'"'+(d.soldOut||!meta.open?' disabled':'')+'>'+(d.soldOut?'沽清':'＋')+'</button>'
      +'</article>';
  }

  function cartBar(){
    const t=total(),n=cart.reduce((a,i)=>a+i.qty,0);
    return '<div class="cartbar"><div class="sum"><b>'+money(t)+'</b><span>'+n+' 份 · 桌 '+esc(table)+'</span></div>'
      +'<button data-act="cart"'+(!n?' disabled':'')+'>'+(n?'去下单':'请先选菜')+'</button></div>';
  }

  function renderCart(){
    const ls=lines();
    app.innerHTML=header()
      +'<main class="cartpage">'
      +'<h2>确认订单</h2>'
      +'<div class="tables"><span>桌号</span><div class="chips">'+meta.tables.map(t=>'<button class="tchip'+(t===table?' on':'')+'" data-act="table" data-table="'+esc(t)+'">'+esc(t)+'</button>').join('')+'</div></div>'
      +'<section class="pays"><span>支付方式</span><div class="chips">'+PAYS.map(p=>'<button class="pchip'+(p.k===pay?' on':'')+'" data-act="pay" data-pay="'+p.k+'">'+p.e+' '+p.n+'</button>').join('')+'</div>'
      +'<p class="muted">先选一种支付方式随订单送到后厨；实际结账仍由收银台确认。</p></section>'
      +'<ul class="lines">'+(ls.length?ls.map(l=>'<li><div><b>'+esc(l.d.name)+(l.spec?'（'+esc(l.spec)+'）':'')+'</b><span>'+money(l.price)+' × '+l.qty+'</span></div>'
        +'<div class="qty"><button data-act="minus" data-i="'+l.idx+'">−</button><span>'+l.qty+'</span><button data-act="plus" data-i="'+l.idx+'">＋</button></div></li>').join(''):'<li class="empty">购物车为空</li>')+'</ul>'
      +'<div class="form"><label>用餐人数<input id="guests" type="number" min="1" max="30" step="1" value="'+guests+'"></label>'
      +'<label>口味与过敏提示<textarea id="note" maxlength="200" placeholder="例如：少油、忌葱、宝宝椅">'+esc(note)+'</textarea></label></div>'
      +'<div class="total"><span>合计</span><b>'+money(total())+'</b></div>'
      +'<button class="wide" data-act="submit"'+(!ls.length||!meta.open?' disabled':'')+'>'+(meta.open?'确认下单 · 直达后厨':'本店暂停点单')+'</button>'
      +'<button class="ghost" data-act="back">返回菜单</button>'
      +'</main>';
    wire();
    document.getElementById('guests').oninput=e=>{guests=Math.min(30,Math.max(1,Number(e.target.value)||1));persist();};
    document.getElementById('note').oninput=e=>{note=e.target.value.slice(0,200);persist();};
  }

  function renderDone(){
    app.innerHTML=header()
      +'<main class="done">'
      +'<div class="tick">✓</div>'
      +'<h2>已发送到后厨</h2>'
      +'<div class="ono">'+esc(order.no)+'</div>'
      +'<p class="meta">桌 '+esc(order.table||table)+' · '+esc(order.timeHM||'')+' · '+esc(order.guests||guests)+' 人</p>'
      +'<p class="meta">支付方式：<b>'+esc(order.payName||PAY_NAME[order.payMethod]||'到店选择')+'</b>（到店结账时由店员确认）</p>'
      +'<div class="status" id="statusBox">'
      +'<span class="pill" id="statusPill">'+esc(STATUS_PILL[order.status]||'待接单')+'</span>'
      +'<p id="statusText">'+esc(STATUS_TEXT[order.status]||'')+'</p>'
      +'<div class="steps">'+['接单','制作','出餐','结账'].map((label,i)=>'<i class="'+(stepsOn(order.status)[i]?'on':'')+'">'+label+'</i>').join('')+'</div>'
      +'</div>'
      +'<ul class="lines plain">'+(order.items||[]).map(i=>'<li><div><b>'+esc(i.name)+'</b><span>'+money(i.price)+' × '+i.qty+'</span></div></li>').join('')+'</ul>'
      +'<button class="wide" data-act="again">继续加菜</button>'
      +'<p class="muted">订单状态每 4 秒自动刷新，无需刷新页面。</p>'
      +'</main>';
    wire();
    poll();
  }

  function wire(){
    app.querySelectorAll('[data-act]').forEach(b=>b.onclick=()=>act(b.dataset.act,b));
  }

  function act(a,b){
    if(a==='table'){table=b.dataset.table;persist();render();return;}
    if(a==='pay'){pay=b.dataset.pay;persist();render();return;}
    if(a==='cat'){cat=b.dataset.cat;persist();render();return;}
    if(a==='add'){pickDish(b.dataset.id);return;}
    if(a==='cart'){view='cart';render();return;}
    if(a==='back'){view='menu';render();return;}
    if(a==='minus'){const i=Number(b.dataset.i);const item=cart[i];if(item){item.qty-=1;if(item.qty<1)cart.splice(i,1);}persist();render();return;}
    if(a==='plus'){const i=Number(b.dataset.i);const item=cart[i];if(item){const d=dishOf(item.id);if(!d){toast('菜品已下架');return;}item.qty=Math.min(20,item.qty+1);}persist();render();return;}
    if(a==='submit'){submit();return;}
    if(a==='again'){order=null;view='menu';persist();render();return;}
  }

  /* 有规格的菜品先选规格 */
  function pickDish(id){
    const d=dishOf(id);
    if(!d)return;
    if(!meta.open){toast('本店已暂停点单');return;}
    if(d.soldOut){toast('该菜品已沽清');return;}
    if(!d.specs.length){addToCart(d,'',[]);return;}
    openSheet(d);
  }

  function openSheet(d){
    let spec=d.specs[0],qty=1,mods=[];
    sheetHost.innerHTML='<div class="mask"></div><div class="sheetbox">'
      +'<h3>'+esc(d.name)+'</h3><p class="muted">'+esc(d.desc||'')+'</p>'
      +'<div class="form"><label>规格<select id="pickSpec">'+d.specs.map(s=>'<option value="'+esc(s)+'">'+esc(s)+'</option>').join('')+'</select></label></div>'
      +'<div class="mods" id="mods">'+MODS.map(m=>'<button class="mod" data-mod="'+esc(m)+'">'+esc(m)+'</button>').join('')+'</div>'
      +'<div class="qty big"><button data-step="-1">−</button><span id="pickQty">1</span><button data-step="1">＋</button></div>'
      +'<button class="wide" id="sheetAdd">加入订单 · '+money(priceOf(d,spec))+'</button>'
      +'</div>';
    sheetHost.classList.add('show');
    const close=()=>{sheetHost.classList.remove('show');sheetHost.innerHTML='';};
    sheetHost.querySelector('.mask').onclick=close;
    sheetHost.querySelector('#sheetAdd').onclick=()=>{addToCart(d,spec,mods);close();};
    sheetHost.querySelector('#pickSpec').onchange=e=>{spec=e.target.value;refreshPrice();};
    sheetHost.querySelectorAll('[data-step]').forEach(b=>b.onclick=()=>{qty=Math.min(20,Math.max(1,qty+Number(b.dataset.step)));sheetHost.querySelector('#pickQty').textContent=qty;});
    sheetHost.querySelectorAll('.mod').forEach(b=>b.onclick=()=>{
      const m=b.dataset.mod;
      if(mods.includes(m)){mods=mods.filter(x=>x!==m);b.classList.remove('on');}
      else if(mods.length<5){mods=mods.concat([m]);b.classList.add('on');}
    });
    function priceOf(dish,s){return s&&dish.specPrice&&dish.specPrice[s]!=null?Number(dish.specPrice[s]):Number(dish.price);}
    function refreshPrice(){sheetHost.querySelector('#sheetAdd').textContent='加入订单 · '+money(priceOf(d,spec));}
  }

  function addToCart(d,spec,mods){
    const price=spec&&d.specPrice&&d.specPrice[spec]!=null?Number(d.specPrice[spec]):Number(d.price);
    const hit=cart.find(i=>i.id===String(d.id)&&(i.spec||'')===spec&&(i.mods||[]).join('')===(mods||[]).join(''));
    if(hit){hit.qty=Math.min(20,hit.qty+1);}
    else cart.push({id:String(d.id),spec,mods:mods||[],qty:1,price});
    persist();render();toast('已加入：'+d.name+(spec?'（'+spec+'）':''));
  }

  async function submit(){
    if(submitting)return;
    if(!meta.open){toast('本店已暂停点单');return;}
    if(!table){toast('请选择桌号');return;}
    if(!cart.length){toast('请先选择菜品');return;}
    submitting=true;
    const btn=app.querySelector('[data-act="submit"]');
    if(btn){btn.disabled=true;btn.textContent='正在发送到后厨…';}
    try{
      const result=await api('/order',{table,guests,note,pay,items:cart.map(i=>({id:i.id,spec:i.spec,mods:i.mods,qty:i.qty}))});
      order={no:result.no,table:result.table,guests,timeHM:result.timeHM,status:'new',payMethod:pay,payName:PAY_NAME[pay]||pay,items:lines().map(l=>({name:l.d.name+(l.spec?'（'+l.spec+'）':''),price:l.price,qty:l.qty})),note};
      cart=[];view='done';persist();render();
    }catch(err){
      toast(err.message);
      if(btn){btn.disabled=false;btn.textContent='确认下单 · 直达后厨';}
    }finally{submitting=false;}
  }

  async function poll(){
    clearTimeout(timer);
    if(!order)return;
    try{
      const r=await api('/status',{no:order.no});
      order.status=r.status;
      const pill=document.getElementById('statusPill'),text=document.getElementById('statusText'),box=document.getElementById('statusBox');
      if(pill)pill.textContent=STATUS_PILL[r.status]||r.status;
      if(text)text.textContent=STATUS_TEXT[r.status]||'';
      if(box){
        const on=stepsOn(r.status);
        box.querySelectorAll('.steps i').forEach((el,i)=>el.classList.toggle('on',on[i]));
        if(r.status==='new'&&r.queue>1){text.textContent='已下单，前面还有 '+(r.queue-1)+' 单，请稍候';}
        box.classList.toggle('done',r.status==='paid');
      }
      if(order.status==='missing'){toast('订单已被店员重置，请重新下单');render();return;}
    }catch(e){}
    if(order&&order.status!=='paid'&&order.status!=='missing')timer=setTimeout(poll,4000);
  }

  /* 菜单每 20 秒刷新沽清与营业状态，不影响已选购物车 */
  setInterval(async()=>{
    if(!meta||document.hidden||sheetHost.classList.contains('show'))return;
    try{
      const latest=await api('');
      const wasOpen=meta.open;
      meta=latest;
      if(!meta.tables.includes(table))table=meta.tables[0]||'A01';
      if(!meta.cats.includes(cat))cat=meta.cats[0]||'';
      if(view==='menu')render();
      if(wasOpen&&!meta.open)toast('本店已暂停点单');
    }catch(e){}
  },20000);

  load();
})();
