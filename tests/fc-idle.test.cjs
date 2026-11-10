'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {spawn}=require('node:child_process'),{once}=require('node:events');
const root=path.resolve(__dirname,'..');

test('idle reads stop when hidden or inactive, resume once, and never overlap',async()=>{
  let now=100000,id=0,calls=0,release;
  const timers=new Map(),win=new EventTarget(),doc=new EventTarget();doc.hidden=false;
  const context=vm.createContext({window:win,document:doc,Date:{now:()=>now},
    setTimeout:(fn,delay)=>{timers.set(++id,{at:now+delay,fn});return id;},clearTimeout:id=>timers.delete(id)});
  vm.runInContext(fs.readFileSync(path.join(root,'shared/teacher-chat/idle-sync.js'),'utf8'),context);
  async function tick(ms){
    const end=now+ms;
    for(;;){const next=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;
      now=next[1].at;timers.delete(next[0]);next[1].fn();await Promise.resolve();await Promise.resolve();}
    now=end;
  }
  const remove=win.TeachingIdleSync.add(async()=>{calls++;},15000);
  await tick(15000);assert.equal(calls,1);
  doc.hidden=true;doc.dispatchEvent(new Event('visibilitychange'));
  await tick(120000);assert.equal(calls,1);assert.equal(timers.size,0);
  doc.hidden=false;doc.dispatchEvent(new Event('visibilitychange'));await tick(0);assert.equal(calls,2);
  await tick(60000);const idleCalls=calls;assert.equal(win.TeachingIdleSync.active(),false);
  await tick(120000);assert.equal(calls,idleCalls);assert.equal(timers.size,0);
  win.dispatchEvent(new Event('pointerdown'));await tick(0);assert.equal(calls,idleCalls+1);
  remove();
  const removeSlow=win.TeachingIdleSync.add(()=>{calls++;return new Promise(r=>{release=r;});},1000);
  await tick(1000);const slowCalls=calls;await tick(10000);assert.equal(calls,slowCalls);
  win.dispatchEvent(new Event('pagehide'));release();await Promise.resolve();await tick(10000);
  assert.equal(calls,slowCalls);assert.equal(timers.size,0);
  win.dispatchEvent(new Event('pageshow'));await tick(0);assert.equal(calls,slowCalls+1);
  removeSlow();release();await Promise.resolve();
});

test('disabled teacher assistant starts without sandbox or model credentials; idle assets are served', {timeout:20000},async t=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'fc-idle-'));
  let output='';
  const child=spawn(process.execPath,['server.cjs'],{cwd:root,stdio:['ignore','pipe','pipe'],env:{...process.env,
    NODE_ENV:'test',STORAGE_BACKEND:'nas',DATA_DIR:data,HOST:'127.0.0.1',PORT:'19860',
    CATERING_PORT:'19861',HOTEL_PORT:'19862',ACCOUNTS_PORT:'19864',
    ACCOUNTS_ADMIN_SOCKET:path.join(data,'admin.sock'),ENABLE_MCP:'0',TEACHER_AGENT_MODE:'fc-internal',
    ENABLE_TEACHER_CHAT:'0',DEEPSEEK_API_KEY:'',AGENT_BASE_URL:'',
    TEACHER_PASSWORD:'IdleTestTeacher123',CATERING_CLASS_CODE:'TESTMENU',HOTEL_CLASS_CODE:'TESTHOTEL'}});
  child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  t.after(async()=>{if(child.exitCode===null){const done=once(child,'exit');child.kill();await done;}fs.rmSync(data,{recursive:true,force:true});});
  const base='http://127.0.0.1:19860';
  let health;
  for(let i=0;i<100;i++){
    if(child.exitCode!==null)throw Error(output);
    try{const r=await fetch(base+'/healthz');if(r.ok){health=await r.json();break;}}catch{}
    await new Promise(r=>setTimeout(r,100));
  }
  assert.ok(health,output);assert.equal('agent' in health,false);
  assert.equal((await fetch(base+'/sse')).status,404);
  for(const course of ['hotel','catering']){
    const page=await (await fetch(base+'/'+course+'/')).text();
    assert.ok(page.indexOf('teacher-chat/idle-sync.js')<page.indexOf('/'+course+'/app.js'));
    const r=await fetch(base+'/'+course+'/teacher-chat/idle-sync.js');assert.equal(r.status,200);
    assert.match(await r.text(),/TeachingIdleSync/);
  }
});

test('hotel background refresh preserves edits made while the snapshot is in flight',async()=>{
  let resolveRead;
  const win=new EventTarget();win.TeachingIdleSync={active:()=>true,add:()=>()=>{}};
  const doc=new EventTarget(),draft={note:'saved'};
  const globals={window:win,document:doc,session:{id:'student',teacher:false},db:{assignments:[]},
    state:()=>draft,$:()=>({open:false}),localStorage:{setItem(){},removeItem(){}},
    setTimeout,clearTimeout,AbortSignal,
    fetch:()=>new Promise(resolve=>{resolveRead=()=>resolve({ok:true,json:async()=>({session:{id:'student'},assignments:['new'],student:{version:2,state:{note:'server'}}})});})};
  for(const name of ['render','modal','exportReport','tasks','save','log','renderLogin','submitTask','ranking','teacher','viewStudent','assignTask','init'])globals[name]=()=>{};
  const context=vm.createContext(globals);
  vm.runInContext(fs.readFileSync(path.join(root,'apps/hotel/public/online.js'),'utf8'),context);
  vm.runInContext('net.ack=JSON.stringify(state());net.version=1;',context);
  const pending=vm.runInContext('refreshOnline()',context);
  await Promise.resolve();await Promise.resolve();
  assert.equal(typeof resolveRead,'function');
  draft.note='unsaved edit';resolveRead();await pending;
  assert.equal(draft.note,'unsaved edit');
  assert.equal(vm.runInContext('net.version',context),1);
  assert.deepEqual(globals.db.assignments,[]);
});
