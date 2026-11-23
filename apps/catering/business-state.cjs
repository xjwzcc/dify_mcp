'use strict';

const { isDeepStrictEqual: equal } = require('node:util');
const defaultState = require('./native-seed.cjs');

function invalid(message='业务数据格式错误',status=400){
  throw Object.assign(Error(message),{status});
}

function normalize(original){
  const defaults=defaultState();
  const state={...defaults,...original};
  if(!state.tables?.length)state.tables=defaults.tables;
  if(!state.voucher||typeof state.voucher!=='object')state.voucher=defaults.voucher;
  return state;
}

function applyRecords(records,changes,key,label){
  if(!Array.isArray(changes))invalid();
  const result=records.slice(), seen=new Set();
  let added=0, changed=false;
  for(const entry of changes){
    if(!entry||typeof entry!=='object')invalid();
    const {id,before,after}=entry;
    if(typeof id!=='string'||!id||seen.has(id)||
      (before!==null&&before?.[key]!==id)||(after!==null&&after?.[key]!==id))invalid();
    seen.add(id);
    const index=result.findIndex(record=>record?.[key]===id);
    const current=index<0?null:result[index];
    if(index>=0&&index!==result.findLastIndex(record=>record?.[key]===id))
      invalid(label+'「'+id+'」存在重复编号，请重新进入业务页面',409);
    if(equal(current,after))continue;
    if(!equal(current,before))
      invalid(label+'「'+(current?.name||before?.name||id)+'」已被其他同学修改',409);
    if(index<0){result.push(after);added++;}
    else if(after===null)result.splice(index,1);
    else result[index]=after;
    changed=true;
  }
  return {records:result,added,changed};
}

function applyChanges(current,changes){
  if(!changes||typeof changes!=='object')invalid();
  const menu=applyRecords(current.menu,changes.menu,'id','菜品');
  const orders=applyRecords(current.orders,changes.orders,'no','订单');
  let changed=menu.changed||orders.changed;
  const original={...current,menu:menu.records,orders:orders.records,seq:current.seq+orders.added};
  for(const key of ['cats','tables']){
    const additions=changes[key];
    if(!Array.isArray(additions)||additions.some(value=>typeof value!=='string'||!value))invalid();
    const newValues=[...new Set(additions)].filter(value=>!current[key].includes(value));
    if(newValues.length){
      original[key]=[...current[key],...newValues];
      changed=true;
    }
  }
  for(const [key,label] of [['voucher','团购折扣'],['open','营业状态']]){
    const edit=changes[key];
    if(edit===undefined)continue;
    if(!edit||!Object.hasOwn(edit,'before')||!Object.hasOwn(edit,'after'))invalid();
    if(key==='open'&&typeof edit.after!=='boolean')invalid();
    if(key==='voucher'&&(!edit.after||!['meituan','dianping'].every(name=>Number.isFinite(edit.after[name])&&edit.after[name]>=0.3&&edit.after[name]<=1)))invalid();
    const value=key==='open'?current.open!==false:current[key];
    if(equal(value,edit.after))continue;
    if(!equal(value,edit.before))invalid(label+'已被其他同学修改',409);
    original[key]=edit.after;
    changed=true;
  }
  return {original,changed};
}

function businessState(previous,{version,changes,replacement}){
  const merged=version!==(previous.version||0);
  const current=normalize(previous.original);
  let original, changed;
  if(replacement!==undefined){
    if(!Array.isArray(replacement?.menu)||!Array.isArray(replacement.orders)||
      !Array.isArray(replacement.cats)||!Number.isInteger(replacement.seq))invalid();
    original=normalize(replacement);
    changed=!equal(original,current)||!previous.original;
    if(merged&&changed)invalid('存档已有其他修改，无法覆盖整份业务数据',409);
  }else{
    ({original,changed}=applyChanges(current,changes));
    changed ||= !previous.original;
  }
  if(!changed)return {state:previous,changed,merged};
  if(!Array.isArray(original.menu)||!Array.isArray(original.orders)||!Array.isArray(original.cats)||
    !Array.isArray(original.tables)||!Number.isInteger(original.seq)||original.menu.length>100||original.orders.length>500)
    invalid('业务数据格式错误，最多保存 100 道菜品和 500 笔订单');
  const menu=original.menu.map(d=>{
    if(!d?.name||!Number.isFinite(+d.price)||+d.price<=0)invalid('菜品价格必须大于 0');
    return {id:d.id,name:d.name,category:d.cat,price:+d.price,cost:0,stock:0,
      allergen:'原项目未设此字段',description:d.desc||'',on:!d.soldOut};
  });
  const orders=original.orders.map(o=>{
    const status=({new:'待接单',cooking:'制作中',done:'待结账',paid:'已结账'})[o?.status];
    if(!['new','cooking','done','paid'].includes(o?.status)||!Array.isArray(o.items)||
      o.items.some(i=>!i||!Number.isFinite(i.price)||i.price<0||!Number.isInteger(i.qty)||i.qty<1))
      invalid('订单数据无效');
    const time=new Date(o.ts);
    if(!Number.isFinite(time.getTime()))invalid('订单时间无效');
    const items=o.items.map(i=>({...i,cost:0})),total=items.reduce((sum,i)=>sum+i.price*i.qty,0);
    return {id:o.no,table:o.table,note:o.orderNote||'',items,total,payable:o.settle??total,
      status,time:time.toISOString(),method:o.payMethod||''};
  });
  const logs=[{time:new Date().toISOString(),action:'保存原版餐饮业务：菜品 '+menu.length+'，订单 '+orders.length},...(previous.logs||[])].slice(0,300);
  return {state:{...previous,version:(previous.version||0)+1,original,menu,orders,logs},changed,merged};
}

module.exports={businessState};
