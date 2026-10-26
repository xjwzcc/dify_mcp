import {request,stream} from './api.js';
import {renderMarkdown} from './markdown.js';
import {terminal,labels,storageKey,loadState,saveState,acceptEvent,draftKey,pageLabels} from './state.js';

class TeacherChat extends HTMLElement {
  constructor(){super();this.attachShadow({mode:'open'});this.drafts=new Map();this.dirtyDrafts=new Set();this.renderTimer=null;this.attachments=[];this.context={};this.generation=0;}
  $(id){return this.shadowRoot.getElementById(id);}
  async initialize(course,teacher){
    this.course=course;this.teacher=teacher;this.base=`/${course}/api/chat`;this.key=storageKey(course,teacher.id);this.saved=loadState(this.key);this.sid=this.saved.sid||null;this.createId=this.saved.createId||null;
    this.shadowRoot.innerHTML=`<link rel="stylesheet" href="/${course}/teacher-chat/chat.css">
      <button class="launcher" id="launcher" aria-expanded="false">✦ 教学助手</button>
      <section class="panel" id="panel" aria-label="教学助手" hidden>
        <div class="head"><div><div class="title">教学助手</div><div class="subtitle" id="subtitle"></div></div><div class="head-actions"><button id="expand" aria-label="展开教学助手" aria-expanded="false">展开</button><button class="close" id="close" aria-label="关闭教学助手">×</button></div></div>
        <div class="toolbar"><select id="sessions" aria-label="历史会话"><option value="">选择历史会话</option></select><button id="more" hidden>更多</button><button id="new">新对话</button></div>
        <div class="context" id="context" hidden><span id="contextText"></span><button id="clearContext">清除范围</button></div>
        <div class="messages" id="messages" aria-label="对话记录"><div class="empty" id="empty"><h3>从课堂数据出发</h3><p>查询进度、分析成果，或一起准备下一堂课。</p><div class="suggestions"><button data-prompt="请总结当前课程的学生进度和待批阅情况。">总结课堂进度</button><button data-prompt="请列出已发布工单的未提交学生，并给出辅导建议。">查看未提交情况</button><button data-prompt="请结合本课程现有工单，设计一份新的实训任务草稿。">设计实训任务</button></div></div></div>
        <div class="status" id="status" role="status" aria-live="polite">回答将结合当前课程的实际记录</div><div class="errorbox" id="error" role="alert" hidden></div>
        <div class="composer"><div class="attachments" id="attachments"></div><textarea id="prompt" aria-label="发送给教学助手的消息" placeholder="例如：哪些学生还没提交工单？" maxlength="16000" rows="3"></textarea><div class="actions"><button id="attach">附加文件</button><input type="file" id="files" accept=".txt,.csv,text/plain,text/csv" multiple hidden><span class="spacer"></span><button id="retry" hidden>重试发送</button><button id="resume" hidden>继续执行</button><button id="cancel" hidden>停止</button><button id="send" class="send">发送</button></div><p class="foot">教学分析与草稿建议 · 不会自动发布任务或修改成绩</p></div>
      </section>`;
    this.$('subtitle').textContent=(course==='hotel'?'酒店人力资源':'餐饮实训')+' · '+teacher.name;
    this.$('launcher').onclick=()=>this.open();this.$('close').onclick=()=>this.close();
    this.$('expand').onclick=()=>{const wide=this.$('panel').classList.toggle('wide');this.$('expand').textContent=wide?'收起':'展开';this.$('expand').setAttribute('aria-expanded',String(wide));this.$('expand').setAttribute('aria-label',wide?'收起教学助手':'展开教学助手');};
    this.$('new').onclick=()=>this.newConversation();this.$('sessions').onchange=()=>this.select(this.$('sessions').value);
    this.$('more').onclick=()=>this.listSessions(true);this.$('send').onclick=()=>this.send();this.$('retry').onclick=()=>this.send(true);
    this.$('cancel').onclick=()=>this.cancel();this.$('resume').onclick=()=>this.resume();this.$('clearContext').onclick=()=>this.setContext({});
    this.$('attach').onclick=()=>this.$('files').click();this.$('files').onchange=()=>this.upload();
    this.$('prompt').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();this.send();}};
    this.shadowRoot.addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();this.close();}});
    this.shadowRoot.querySelectorAll('[data-prompt]').forEach(b=>b.onclick=()=>{this.$('prompt').value=b.dataset.prompt;this.$('prompt').focus();});
    if(this.saved.pending){this.pending=this.saved.pending;this.$('prompt').value=this.pending.message;this.$('retry').hidden=false;}
  }
  persist(){saveState(this.key,{sid:this.sid,createId:this.createId||null,pending:this.pending||null});}
  setContext(value){this.context=value||{};if(!this.$('context'))return;const text=Object.entries(this.context).filter(([,v])=>v).map(([k,v])=>({page:'页面',class_id:'班级',student_id:'学生',workorder_id:'工单'}[k]+': '+(k==='page'?(pageLabels[v]||v):v))).join(' · ');this.$('contextText').textContent=text;this.$('context').hidden=!text;}
  note(text){this.$('status').textContent=text;}
  error(error){this.$('error').textContent=error.message||String(error);this.$('error').hidden=false;if(error.status===401||error.status===403){this.run?.abort();this.setBusy(false);}}
  setBusy(value){this.busy=value;for(const id of ['send','attach','new','sessions'])this.$(id).disabled=value;this.$('cancel').hidden=!value||!this.eid;this.$('retry').disabled=value;}
  async open(){this.$('panel').hidden=false;this.$('launcher').hidden=true;this.$('launcher').setAttribute('aria-expanded','true');this.$('prompt').focus();if(!this.loaded){try{const caps=await request(this.base,'/capabilities');if(!caps.configured){this.note('教学助手正在配置中');this.error(new Error('Agent 服务尚未连接，配置完成后即可对话。'));return;}await this.listSessions();if(this.sid)await this.select(this.sid);this.loaded=true;}catch(e){this.error(e);}}}
  close(){this.$('panel').hidden=true;this.$('launcher').hidden=false;this.$('launcher').setAttribute('aria-expanded','false');this.$('launcher').focus();}
  async listSessions(more=false){try{const data=await request(this.base,'/sessions?limit=20'+(more&&this.listCursor?'&cursor='+encodeURIComponent(this.listCursor):''));if(!more)this.$('sessions').replaceChildren(new Option('选择历史会话',''));for(const s of data.items){const option=new Option(s.title||'新对话',s.id);this.$('sessions').append(option);}this.listCursor=data.next_cursor;this.$('more').hidden=!this.listCursor;if(this.sid)this.$('sessions').value=this.sid;}catch(e){this.error(e);}}
  clearDraftRender(){clearTimeout(this.renderTimer);this.renderTimer=null;this.dirtyDrafts.clear();}
  clearMessages(){this.clearDraftRender();this.$('messages').replaceChildren();this.drafts.clear();this.artifactIds=new Set();this.$('resume').hidden=true;}
  message(text,kind='assistant',meta=''){
    this.$('empty')?.remove();const nearBottom=this.$('messages').scrollHeight-this.$('messages').scrollTop-this.$('messages').clientHeight<100;
    const el=document.createElement('div');el.className='message '+kind;const content=document.createElement('div');content.markdownSource=text;
    if(kind==='assistant'||kind==='draft')renderMarkdown(content,text);else content.textContent=text;el.append(content);
    if(meta){const info=document.createElement('span');info.className='meta';info.textContent=meta;el.append(info);}this.$('messages').append(el);
    if(nearBottom||kind==='user')this.$('messages').scrollTop=this.$('messages').scrollHeight;return content;
  }
  appendDelta(content,text){
    content.markdownSource+=text;this.dirtyDrafts.add(content);
    if(this.renderTimer!==null)return;
    this.renderTimer=setTimeout(()=>{this.renderTimer=null;const box=this.$('messages');const nearBottom=box.scrollHeight-box.scrollTop-box.clientHeight<100;
      for(const node of this.dirtyDrafts)if(node.isConnected)renderMarkdown(node,node.markdownSource);
      this.dirtyDrafts.clear();if(nearBottom)box.scrollTop=box.scrollHeight;
    },80);
  }
  async newConversation(){this.run?.abort();this.generation++;this.sid=null;this.eid=null;this.createId=null;this.pending=null;this.attachments=[];this.clearMessages();this.$('attachments').textContent='';this.$('prompt').value='';this.$('retry').hidden=true;this.setBusy(false);this.persist();this.note('新对话 · 输入你的教学问题');this.$('sessions').value='';}
  async ensureSession(){if(this.sid)return;this.createId ||= crypto.randomUUID();this.persist();const data=await request(this.base,'/sessions',{method:'POST',body:{request_id:this.createId}});this.sid=data.session_id;this.createId=null;this.persist();await this.listSessions();}
  async select(sid){if(!sid)return;this.run?.abort();const generation=++this.generation;if(this.sid!==sid){this.pending=null;this.$('retry').hidden=true;}this.sid=sid;this.eid=null;this.persist();this.clearMessages();this.setBusy(false);this.attachments=[];this.$('attachments').textContent='';
    try{const data=await request(this.base,`/sessions/${sid}/history?limit=50`);if(generation!==this.generation)return;this.historyCursor=data.next_cursor;this.renderHistory(data.items);this.showOlder();
      const active=data.items.findLast(r=>!terminal.has(r.state));const waiting=data.items.findLast(r=>r.state==='WAITING_INPUT');
      if(active){this.eid=active.execution_id;this.follow(this.eid);}else if(waiting){this.eid=waiting.execution_id;this.$('resume').hidden=false;this.note(labels.WAITING_INPUT);}else this.note('历史记录已恢复');
    }catch(e){if(generation===this.generation)this.error(e);}}
  renderHistory(items){for(const row of items){this.message(row.message,'user');if(row.result)this.message(row.result,'assistant','已保存');else this.message(labels[row.state]||row.state,'error',row.error||'');for(const a of row.artifacts||[])this.artifact(a);for(const e of row.evidence||[])this.evidence(e);}}
  showOlder(){this.$('older')?.remove();if(!this.historyCursor)return;const b=document.createElement('button');b.id='older';b.className='older';b.textContent='加载更早记录';b.onclick=async()=>{const sid=this.sid;b.disabled=true;try{const data=await request(this.base,`/sessions/${sid}/history?limit=50&cursor=${encodeURIComponent(this.historyCursor)}`);if(this.sid!==sid)return;const old=Array.from(this.$('messages').childNodes).filter(n=>n!==b);this.$('messages').replaceChildren();this.renderHistory(data.items);this.$('messages').append(...old);this.historyCursor=data.next_cursor;this.showOlder();}catch(e){this.error(e);b.disabled=false;}};this.$('messages').prepend(b);}
  async send(retry=false){if(this.busy)return;const message=this.$('prompt').value.trim();if(!retry&&!message)return;this.eid=null;this.$('error').hidden=true;this.setBusy(true);
    try{const body=retry&&this.pending?this.pending:{request_id:crypto.randomUUID(),message,attachment_ids:this.attachments.map(a=>a.artifact_id),page_context:{...this.context}};this.pending=body;this.persist();await this.ensureSession();
      const data=await request(this.base,`/sessions/${this.sid}/messages`,{method:'POST',body});this.pending=null;this.persist();this.$('retry').hidden=true;this.$('prompt').value='';this.attachments=[];this.$('attachments').textContent='';this.$('files').value='';this.message(body.message,'user');this.eid=data.execution_id;this.follow(this.eid);this.listSessions();
    }catch(e){this.error(e);this.setBusy(false);this.$('retry').hidden=!this.pending;}}
  async upload(){if(this.busy)return;this.setBusy(true);try{await this.ensureSession();for(const file of this.$('files').files){if(!/\.(txt|csv)$/i.test(file.name)||file.size>4_000_000)throw Error('请选择不超过 4 MB 的 TXT 或 CSV 文件');if(this.attachments.length>=20)throw Error('每条消息最多附加 20 个文件');const a=await request(this.base,`/sessions/${this.sid}/attachments?name=${encodeURIComponent(file.name)}`,{method:'POST',body:file});this.attachments.push(a);}this.$('attachments').textContent=this.attachments.map(a=>a.name).join('、');}catch(e){this.error(e);}finally{this.setBusy(false);this.$('files').value='';}}
  async cancel(){if(!this.eid)return;try{await request(this.base,`/executions/${this.eid}/cancel`,{method:'POST',body:{}});this.note('正在停止并清理执行环境…');}catch(e){this.error(e);}}
  async resume(){try{await request(this.base,`/executions/${this.eid}/resume`,{method:'POST',body:{}});this.$('resume').hidden=true;this.follow(this.eid);}catch(e){this.error(e);}}
  evidence(item){const line=document.createElement('div');line.className='source';line.textContent=`数据依据：${item.tool} · ${item.retrieved_at||''} · ${item.id}`;this.$('messages').append(line);}
  artifact(a){this.artifactIds ||= new Set();const id=a.artifact_id||a.id;if(this.artifactIds.has(id))return;this.artifactIds.add(id);const b=document.createElement('button');b.className='artifact';b.textContent='下载 '+a.name;b.onclick=async()=>{try{const r=await fetch(this.base+`/artifacts/${id}/download`,{credentials:'same-origin'});if(!r.ok)throw Error('文件下载失败，请确认登录状态');const url=URL.createObjectURL(await r.blob()),link=document.createElement('a');link.href=url;link.download=a.name.split('/').pop();link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}catch(e){this.error(e);}};this.$('messages').append(b);}
  event(event){const p=event.payload||{};if(event.type==='assistant.delta'){const key=draftKey(event);if(!this.drafts.has(key))this.drafts.set(key,this.message('','draft','生成中'));this.appendDelta(this.drafts.get(key),p.text||'');}
    else if(event.type==='turn.completed'){this.clearDraftRender();for(const el of this.drafts.values())el.parentElement.remove();this.drafts.clear();this.message(p.answer,'assistant','已保存');this.note('回答已完成并保存');this.completed=true;}
    else if(event.type==='artifact.created')this.artifact(p);
    else if(event.type==='tool.evidence')this.evidence(p);
    else if(event.type==='turn.retrying'){for(const el of this.drafts.values())el.parentElement.classList.add('interrupted');this.note('执行中断，正在恢复…');}
    else if(event.type==='attempt.started')this.note('正在处理 · 第 '+p.attempt+' 次尝试');
    else if(event.type==='tool.started')this.note('正在查询或处理教学资料…');
    else if(event.type==='turn.queued')this.note('已接收，排队中…');
    else if(['turn.waiting','turn.failed','turn.cancelled'].includes(event.type)){this.note(event.type==='turn.cancelled'?'已停止':event.type==='turn.waiting'?'需要处理后继续':'执行未完成');if(p.reason)this.error(new Error('执行状态：'+p.reason));}
  }
  async follow(eid){this.run?.abort();const controller=new AbortController();this.run=controller;this.setBusy(true);this.completed=false;let cursor=0,failures=0;
    while(!controller.signal.aborted){try{await stream(this.base,eid,cursor,event=>{if(!controller.signal.aborted&&acceptEvent(event,cursor)){cursor=event.seq;this.event(event);}},controller.signal);
        const state=await request(this.base,`/executions/${eid}`,{signal:controller.signal});if(terminal.has(state.state)){if(state.state==='COMMITTED'&&!this.completed){for(const el of this.drafts.values())el.parentElement.remove();this.drafts.clear();this.message(state.result,'assistant','已保存');}this.note(labels[state.state]||state.state);this.$('resume').hidden=state.state!=='WAITING_INPUT';break;}failures=0;
      }catch(e){if(controller.signal.aborted)break;if(e.status===401||e.status===403||++failures>=5){this.error(e);this.note('连接已暂停，重新打开历史会话可继续恢复');break;}this.note('连接恢复中…');}
      await new Promise(resolve=>{const t=setTimeout(resolve,Math.min(1000*2**failures,8000));controller.signal.addEventListener('abort',()=>{clearTimeout(t);resolve();},{once:true});});}
    if(this.run===controller)this.setBusy(false);
  }
  disconnectedCallback(){this.run?.abort();this.clearDraftRender();}
}
customElements.define('teacher-agent-chat',TeacherChat);
let widget=null,identityVersion=0,lastContext={};
const course=location.pathname.startsWith('/hotel/')?'hotel':'catering';
async function sync(detail){const version=++identityVersion;if(detail===null){if(widget){try{sessionStorage.removeItem(widget.key);}catch{}widget.remove();widget=null;}return;}
  lastContext=detail?.context||lastContext;
  if(widget&&detail?.teacher?.id===widget.teacher.id){widget.setContext(lastContext);return;}
  try{const data=await request(`/${course}/api/chat`,'/capabilities');if(version!==identityVersion)return;if(!data.enabled){widget?.remove();widget=null;return;}
    if(widget?.teacher.id!==data.teacher.id){widget?.remove();widget=document.createElement('teacher-agent-chat');document.body.append(widget);await widget.initialize(course,data.teacher);}widget.setContext(lastContext);
  }catch(e){if(e.status===401||e.status===403){widget?.remove();widget=null;}}}
window.addEventListener('teacher-chat-identity',event=>sync(event.detail));
sync();
