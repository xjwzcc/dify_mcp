'use strict';
const fs = require('node:fs'), path = require('node:path');
const { once } = require('node:events');
const { assertion, verify, selectedCookie, fail } = require('./identity.cjs');
const ids = '[a-f0-9]{32}';
const routes = [
  ['GET', /^\/capabilities$/], ['GET', /^\/sessions$/], ['POST', /^\/sessions$/],
  ['GET', new RegExp(`^/sessions/${ids}/history$`)], ['POST', new RegExp(`^/sessions/${ids}/messages$`)],
  ['POST', new RegExp(`^/sessions/${ids}/attachments$`)], ['GET', new RegExp(`^/executions/${ids}$`)],
  ['GET', new RegExp(`^/executions/${ids}/events$`)], ['POST', new RegExp(`^/executions/${ids}/(cancel|resume)$`)],
  ['GET', new RegExp(`^/artifacts/${ids}/download$`)]
];
async function readBody(req, limit) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) fail(413,'INPUT_TOO_LARGE','输入超过大小限制'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
function json(res, status, data) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(JSON.stringify(data));
}
module.exports = function createChatGateway({ services, bridgeSecret, env = process.env }) {
  const enabled = env.ENABLE_TEACHER_CHAT === '1';
  const ports = Object.fromEntries(services.filter(s => ['hotel','catering'].includes(s.name)).map(s => [s.name,s.port]));
  let target;
  if (env.AGENT_BASE_URL) {
    target = new URL(env.AGENT_BASE_URL);
    if ((target.protocol !== 'https:' && !(target.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(target.hostname))) ||
        target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw Error('AGENT_BASE_URL must be an HTTPS origin (localhost HTTP allowed)');
  }
  const configured = Boolean(target && env.AGENT_SIGNING_KEY?.length >= 32 && env.AGENT_TOOL_VERIFY_KEY?.length >= 32 && env.TEACHING_DEPLOYMENT_ID);
  const allowlist = env.CHAT_TEACHER_ALLOWLIST ? new Set(env.CHAT_TEACHER_ALLOWLIST.split(',').map(s => s.trim()).filter(Boolean)) : null;
  const rates = new Map();
  function allowed(who) { return !allowlist || allowlist.has(who.course + ':' + who.teacher_id); }
  async function courseCall(course, payload, cookie = '') {
    if (!ports[course]) fail(404,'COURSE_NOT_FOUND','课程不存在');
    const response = await fetch(`http://127.0.0.1:${ports[course]}/${course}/api/agent-bridge`, {
      method:'POST',headers:{'Content-Type':'application/json','X-Agent-Bridge':bridgeSecret,...(cookie?{Cookie:cookie}:{})},
      body:JSON.stringify(payload),signal:AbortSignal.timeout(4000),redirect:'error'
    });
    const data = await response.json();
    if (!response.ok) fail(response.status, response.status === 401 ? 'LOGIN_EXPIRED' : 'COURSE_REQUEST_FAILED', typeof data.error === 'string' ? data.error : '教学数据查询失败');
    return data;
  }
  function rate(who) {
    const key = who.course + ':' + who.teacher_id, now = Date.now();
    if (rates.size > 1000) for (const [id,r] of rates) if (now-r.at > 60000) rates.delete(id);
    let r = rates.get(key); if (!r || now-r.at > 60000) r = {at:now,count:0};
    rates.set(key,r); if (++r.count > 30) fail(429,'RATE_LIMIT','发送过于频繁，请稍后重试');
  }
  async function handler(req, res, url) {
    const asset = /^\/(catering|hotel)\/teacher-chat\/(chat\.js|api\.js|state\.js|markdown\.js|vendor\/(?:marked|purify)\.js|chat\.css)$/.exec(url.pathname);
    if (asset) {
      if (!['GET','HEAD'].includes(req.method)) { json(res,405,{error:{code:'METHOD_NOT_ALLOWED',message:'仅支持读取'}}); return true; }
      res.writeHead(200,{'Content-Type':asset[2].endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});
      res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(path.join(__dirname,'../shared/teacher-chat',asset[2]))); return true;
    }
    if (/^\/(hotel|catering)\/api\/agent-bridge(?:\/|$)/.test(url.pathname)) { json(res,404,{error:'接口不存在'}); return true; }
    const match = /^\/(hotel|catering)\/api\/chat(\/.*)?$/.exec(url.pathname);
    const internal = url.pathname === '/internal/teacher-agent/tools';
    if (!match && !internal) return false;
    let controller, authTimer;
    try {
      if (internal) {
        if (req.method !== 'POST' || !configured) fail(404,'NOT_FOUND','接口不存在');
        const raw = await readBody(req,128*1024);
        const claims = verify(req.headers['x-agent-tool-assertion'], env.AGENT_TOOL_VERIFY_KEY, {
          audience:'teaching-tools',method:'POST',path:url.pathname+url.search,body:raw });
        if (claims.iss !== 'teacher-agent' || claims.deployment_id !== env.TEACHING_DEPLOYMENT_ID) fail(403,'INVALID_SIGNATURE','服务作用域不匹配');
        let input; try { input=JSON.parse(raw); } catch { fail(400,'INVALID_JSON','无效 JSON'); }
        if (!input || !['hotel','catering'].includes(input.course) || !['authorize','tool'].includes(input.action)) fail(400,'INVALID_TOOL_REQUEST','教学工具请求无效');
        const result = await courseCall(input.course, {action:input.action,teacher_id:input.teacher_id,login_ref:input.login_ref,tool:input.tool,arguments:input.arguments});
        if (!allowed({course:input.course,teacher_id:input.teacher_id})) fail(403,'TEACHER_NOT_ENABLED','此教师暂未开放教学助手');
        json(res,200,result); return true;
      }
      const course=match[1], suffix=match[2] || '/';
      if (!routes.some(([method,re])=>method===req.method && re.test(suffix))) fail(404,'NOT_FOUND','接口不存在');
      if ((req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) || req.headers['sec-fetch-site']==='cross-site') fail(403,'CROSS_ORIGIN','拒绝跨站请求');
      const cookie=selectedCookie(req.headers,course);
      const who=await courseCall(course,{action:'identity'},cookie);
      if (suffix==='/capabilities') {
        let ready=configured;
        if(ready && env.TEACHER_AGENT_MODE==='fc-internal') {
          try { ready=(await fetch(new URL('/health',target),{signal:AbortSignal.timeout(1500)})).ok; } catch { ready=false; }
        }
        json(res,200,{enabled:enabled && allowed(who),configured:ready,teacher:{id:who.teacher_id,name:who.name},course,
          max_file_bytes:4_000_000,attachment_types:['.txt','.csv'],read_only:true}); return true;
      }
      if (!allowed(who)) fail(403,'TEACHER_NOT_ENABLED','此教师暂未开放教学助手');
      // Existing runs remain readable and cancellable when the feature is turned off.
      if (!enabled && (suffix==='/sessions' || /\/(messages|attachments|resume)$/.test(suffix))) fail(503,'CHAT_DISABLED','教学助手暂未开放');
      if (!configured) fail(503,'AGENT_NOT_CONFIGURED','教学助手服务尚未配置，请联系管理员');
      let body=req.method==='POST'?await readBody(req,suffix.endsWith('/attachments')?4_000_000:128*1024):Buffer.alloc(0);
      if (suffix.endsWith('/attachments')) {
        const name=url.searchParams.get('name') || '';
        if (!/\.(txt|csv)$/i.test(name) || name.length>150 || /[/\\\x00-\x1f]/.test(name)) fail(400,'INVALID_FILE','仅支持文件名有效的 TXT 或 CSV 文件');
      } else if (req.method==='POST') {
        let input; try { input=JSON.parse(body.length?body:'{}'); } catch { fail(400,'INVALID_JSON','无效 JSON'); }
        if (!input || Array.isArray(input) || typeof input!=='object') fail(400,'INVALID_JSON','请求必须是对象');
        if (suffix.endsWith('/messages')) {
          rate(who);
          if (Object.keys(input).some(k=>!['request_id','message','attachment_ids','page_context'].includes(k))) fail(400,'INVALID_FIELD','消息含未知字段');
          if (typeof input.message!=='string' || !input.message.trim() || Buffer.byteLength(input.message)>100000 || typeof input.request_id!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.request_id)) fail(400,'INVALID_MESSAGE','消息或请求编号无效');
          const checked=await courseCall(course,{action:'context',page_context:input.page_context || {}},cookie);
          input.page_context=checked.context;
        } else if (suffix==='/sessions') {
          if (Object.keys(input).some(k=>!['request_id','title'].includes(k)) || typeof input.request_id!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.request_id)) fail(400,'INVALID_REQUEST','会话请求编号无效');
        } else if (Object.keys(input).length) fail(400,'INVALID_REQUEST','此操作不接受额外参数');
        body=Buffer.from(JSON.stringify(input));
      }
      const stream=suffix.endsWith('/events'), upstreamPath='/api/chat'+suffix+url.search;
      controller=new AbortController();
      const disconnected=()=>controller.abort(); res.once('close',disconnected);
      if (stream) {
        let checking=false;
        authTimer=setInterval(async()=>{if(checking)return;checking=true;try{const current=await courseCall(course,{action:'identity'},cookie);if(current.teacher_id!==who.teacher_id)controller.abort();}catch{controller.abort();}finally{checking=false;}},15000);
        authTimer.unref();
      }
      const headers={'X-Teacher-Assertion':assertion(who,req.method,upstreamPath,body,env),Accept:stream?'text/event-stream':'application/json'};
      if (req.method==='POST') headers['Content-Type']=suffix.endsWith('/attachments')?'application/octet-stream':'application/json';
      const response=await fetch(new URL(upstreamPath,target),{method:req.method,headers,body:req.method==='POST'?body:undefined,
        signal:AbortSignal.any([controller.signal,AbortSignal.timeout(stream?(env.TEACHER_AGENT_MODE==='fc-internal'?300000:60000):45000)]),redirect:'error'});
      const out={'Content-Type':response.headers.get('content-type') || 'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
      if (response.headers.get('content-disposition')) out['Content-Disposition']=response.headers.get('content-disposition');
      if (stream) out['X-Accel-Buffering']='no';
      if (out['Content-Type'].includes('application/json')) {
        const data=await response.json();
        if (data.events_url?.startsWith('/api/chat/')) data.events_url='/'+course+data.events_url;
        json(res,response.status,data);
      } else {
        res.writeHead(response.status,out);
        for await (const chunk of response.body) {
          if (res.destroyed) break;
          if (!res.write(chunk)) await once(res,'drain',{signal:controller.signal});
        }
        res.end();
      }
      res.removeListener('close',disconnected);
    } catch(error) {
      if (res.headersSent) res.end();
      else json(res,error.status || 503,{error:{code:error.code || 'AGENT_UNAVAILABLE',message:error.status?error.message:'教学助手暂时无法连接，请稍后重试',retryable:!error.status || error.status>=500}});
    } finally { if(authTimer)clearInterval(authTimer); controller?.abort(); }
    return true;
  }
  return handler;
};
