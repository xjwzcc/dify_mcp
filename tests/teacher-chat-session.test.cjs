const {test}=require('node:test'),assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
test('ending an active conversation closes it, preserves history and prevents resubmission',async t=>{
  const dom=new JSDOM('<body></body>',{url:'http://localhost/hotel/teacher'});
  const previous={};
  for(const name of ['window','document','HTMLElement','customElements','location','sessionStorage','Option','File','Blob']){
    previous[name]=global[name];global[name]=dom.window[name];
  }
  const oldFetch=global.fetch;let closed=false;const requests=[];
  global.fetch=async(url,options={})=>{
    requests.push({url,options});
    if(url.endsWith('/capabilities'))return {ok:false,status:401,json:async()=>({error:'anonymous'})};
    if(url.endsWith('/close')){assert.equal(options.method,'POST');closed=true;return {ok:true,json:async()=>({ok:true,closed:true})};}
    if(url.includes('/history'))return {ok:true,json:async()=>({items:[{execution_id:'e',message:'问题',result:'保存的回答',state:'COMMITTED'}],session:{closed},next_cursor:null})};
    return {ok:true,json:async()=>({items:[{id:'a'.repeat(32),title:'测试',closed}],next_cursor:null})};
  };
  t.after(()=>{global.fetch=oldFetch;for(const [key,value] of Object.entries(previous))global[key]=value;dom.window.close();});
  await import('../shared/teacher-chat/chat.js');
  const widget=document.createElement('teacher-agent-chat');document.body.append(widget);
  await widget.initialize('hotel',{id:'teacher',name:'教师'});
  widget.sid='a'.repeat(32);widget.eid='e';widget.run=new AbortController();widget.setBusy(true);
  assert.equal(widget.$('end').disabled,false);
  const running=widget.run;await widget.endConversation();
  assert.ok(running.signal.aborted);assert.ok(widget.sessionClosed);
  assert.equal(widget.$('send').disabled,true);assert.equal(widget.$('prompt').disabled,true);
  assert.equal(widget.$('end').disabled,true);assert.match(widget.$('messages').textContent,/保存的回答/);
  assert.match(widget.$('status').textContent,/会话已结束/);
  const count=requests.length;widget.$('prompt').value='不应提交';await widget.send();assert.equal(requests.length,count);
  await widget.newConversation();assert.equal(widget.sessionClosed,false);assert.equal(widget.$('send').disabled,false);
});
