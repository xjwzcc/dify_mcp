export class ChatError extends Error {
  constructor(message, status, code) { super(message); this.status=status; this.code=code; }
}
export async function request(base, path, { method='GET', body, signal }={}) {
  const raw=body instanceof File || body instanceof Blob;
  const response=await fetch(base+path,{method,credentials:'same-origin',signal,
    headers:body!==undefined&&!raw?{'Content-Type':'application/json'}:{},body:body===undefined?undefined:raw?body:JSON.stringify(body)});
  if(!response.ok){let value;try{value=await response.json();}catch{}const code=value?.error?.code||(typeof value?.error==='string'?value.error:'');const messages={TEACHER_SESSION_LIMIT:'每门课程最多保留 5 个未结束会话，请先结束一个旧会话。',TEACHER_QUEUE_FULL:'已有 3 个请求在排队，请稍后再试。',SESSION_CLOSED:'此会话已结束，历史记录仍可查看。请新建对话继续。'};throw new ChatError(messages[code]||value?.error?.message||value?.error||'教学助手请求失败',response.status,code);}
  return response.json();
}
export async function* sseFrames(body) {
  const reader=body.getReader(),decoder=new TextDecoder();let buffer='';
  try {
    while(true){
      const {value,done}=await reader.read();buffer+=decoder.decode(value,{stream:!done});
      let match;
      while((match=/\r?\n\r?\n/.exec(buffer))){
        const frame=buffer.slice(0,match.index);buffer=buffer.slice(match.index+match[0].length);
        const data=frame.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).replace(/^ /,'')).join('\n');
        if(data)yield JSON.parse(data);
      }
      if(buffer.length>2_000_000)throw new Error('事件内容超过限制');
      if(done)break;
    }
  } finally { await reader.cancel().catch(()=>{});reader.releaseLock(); }
}
export async function stream(base,eid,after,onEvent,signal) {
  const response=await fetch(`${base}/executions/${eid}/events?after=${after}`,{credentials:'same-origin',signal,headers:{Accept:'text/event-stream'}});
  if(!response.ok)throw new ChatError('对话连接已中断',response.status);
  if(!response.headers.get('content-type')?.includes('text/event-stream'))throw new Error('服务器未返回事件流');
  for await(const event of sseFrames(response.body))onEvent(event);
}
