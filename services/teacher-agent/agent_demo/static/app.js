const $ = id => document.getElementById(id);
let execution = null, cursor = 0, attachmentIds = [], busy = false;
const drafts = new Map();
function note(text) { $('status').textContent = text; }
function error(e) { $('error').textContent = e.message || String(e); }
async function api(path, opts = {}) {
  const response = await fetch(path, {...opts, headers: {'Authorization': 'Bearer ' + $('key').value,
    ...(opts.body && typeof opts.body === 'string' ? {'Content-Type': 'application/json'} : {}), ...opts.headers}});
  if (!response.ok) { const text = await response.text(); throw Error(text.slice(0, 300)); }
  return response;
}
function message(text, type) {
  document.querySelector('.empty')?.remove();
  const div = document.createElement('div'); div.className = 'message ' + type;
  div.textContent = text; $('messages').append(div); div.scrollIntoView({block:'end', behavior:'smooth'}); return div;
}
function setBusy(value) { busy=value; $('send').disabled=value; $('cancel').disabled=!value; $('new').disabled=value; $('load').disabled=value; for (const id of ['key','session','file']) $(id).disabled=value; }
$('new').onclick = async () => { try {
  const body = await (await api('/api/chat/sessions', {method:'POST'})).json();
  $('session').value=body.session_id; attachmentIds=[]; $('attachments').textContent=''; $('file').value=''; drafts.clear(); $('messages').textContent=''; note('新会话已建立');
} catch(e) {error(e);} };
$('load').onclick = async () => { try {
  const rows=await (await api('/api/chat/sessions/'+$('session').value+'/history')).json();
  $('messages').textContent=''; attachmentIds=[]; $('attachments').textContent=''; drafts.clear();
  for(const row of rows) {message(row.message,'user'); if(row.result)message(row.result,'assistant');}
  const running=rows.find(r=>!['COMMITTED','FAILED','CANCELLED','WAITING_INPUT','WAITING_DEPENDENCY'].includes(r.state));
  if(running){execution=running.execution_id;cursor=0;setBusy(true);await follow();}
  else note('历史已载入');
} catch(e){error(e);} };
$('file').onchange = async () => { $('send').disabled=true; try {
  if(!$('session').value)throw Error('请先新建会话');
  for(const file of $('file').files) {
    const result=await (await api('/api/chat/sessions/'+$('session').value+'/attachments?name='+encodeURIComponent(file.name),
      {method:'POST',body:file})).json();
    attachmentIds.push(result.artifact_id);
  }
  $('attachments').textContent='已附加 '+attachmentIds.length+' 个文件';
} catch(e){error(e);} finally { $('send').disabled=busy; } };
$('composer').onsubmit = async event => {
  event.preventDefault(); if(busy)return; setBusy(true); $('error').textContent='';
  try {
    if(!$('session').value)throw Error('请先新建会话');
    const text=$('prompt').value;
    const result=await (await api('/api/chat/sessions/'+$('session').value+'/messages', {method:'POST',
      body:JSON.stringify({request_id:crypto.randomUUID(),message:text,attachment_ids:attachmentIds,
        skill_refs:$('skill').checked?['data-analysis']:[]})})).json();
    message(text,'user'); $('prompt').value=''; attachmentIds=[]; $('attachments').textContent=''; $('file').value='';
    execution=result.execution_id;cursor=0; drafts.clear();setBusy(true);await follow();
  }catch(e){error(e);setBusy(false);}
};
$('cancel').onclick=async()=>{try{await api('/api/chat/executions/'+execution+'/cancel',{method:'POST'});note('正在停止执行…');}catch(e){error(e);}};
function handle(event) {
  const p=event.payload;
  if(event.type==='assistant.delta'){
    const key=event.attempt_id+':'+p.request_id+':'+p.item;
    if(!drafts.has(key))drafts.set(key,message('','draft'));
    drafts.get(key).textContent+=p.text;
  }else if(event.type==='turn.completed'){
    for(const div of drafts.values())div.remove();
    drafts.clear(); message(p.answer,'assistant');note('已完成并保存');
  }else if(event.type==='artifact.created'){
    const button=document.createElement('button');button.className='artifact secondary';button.textContent='下载 '+p.name;
    button.onclick=async()=>{try{const blob=await(await api('/api/chat/artifacts/'+p.artifact_id+'/download')).blob();
      const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=p.name.split('/').pop();a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(e){error(e);}};$('messages').append(button);
  }else if(event.type==='attempt.started')note('正在执行 · 第 '+p.attempt+' 次尝试');
  else if(event.type==='tool.started')note('正在执行工具 · '+p.kind);
  else if(event.type==='turn.retrying'){note('正在恢复执行');for(const d of drafts.values())d.dataset.failed='true';}
  else if(event.type==='turn.failed'||event.type==='turn.waiting'){note('执行未完成：'+p.reason);}
  else if(event.type==='turn.cancelled')note('已取消');
}
async function follow(){
  let failures=0;
  while(busy){
    try{
      const response=await api('/api/chat/executions/'+execution+'/events?after='+cursor);
      const reader=response.body.getReader(), decoder=new TextDecoder();let buffer='';
      while(true){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});
        while(buffer.includes('\n\n')){const end=buffer.indexOf('\n\n'),block=buffer.slice(0,end);buffer=buffer.slice(end+2);
          const line=block.split('\n').find(l=>l.startsWith('data: '));if(!line)continue;
          const ev=JSON.parse(line.slice(6));if(ev.seq<=cursor)continue;cursor=ev.seq;handle(ev);}
      }
      const status=await(await api('/api/chat/executions/'+execution)).json();
      if(['COMMITTED','FAILED','CANCELLED','WAITING_INPUT','WAITING_DEPENDENCY'].includes(status.state)){setBusy(false);return;}
      failures=0;
    }catch(e){if(++failures>=8){error(Error('连接中断，可用会话 ID 重新载入。'));setBusy(false);return;}note('连接恢复中…');}
    await new Promise(r=>setTimeout(r,1000));
  }
}
