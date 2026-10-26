'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {spawn}=require('node:child_process'),{once}=require('node:events');
const {verify,sign,sha256}=require('../agent/identity.cjs');
test('teacher gateway authenticates course sessions, signs requests and brokers read-only tools',{timeout:45000},async t=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'teacher-chat-test-')),received=[];
  const sid='a'.repeat(32),eid='b'.repeat(32),key='k'.repeat(32),toolKey='t'.repeat(32);
  const upstream=http.createServer(async(req,res)=>{
    const chunks=[];for await(const b of req)chunks.push(b);const body=Buffer.concat(chunks);
    try{
      const claims=verify(req.headers['x-teacher-assertion'],key,{audience:'teacher-agent',method:req.method,path:req.url,body});
      received.push({claims,body:body.length?JSON.parse(body):null,headers:req.headers});
      if(req.url.includes('/events')){res.writeHead(200,{'Content-Type':'text/event-stream'});return res.end('id: 1\ndata: {"seq":1,"type":"assistant.delta","payload":{"text":"测试"}}\n\n');}
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify(req.url.endsWith('/messages')?{execution_id:eid,events_url:`/api/chat/executions/${eid}/events`}:{session_id:sid}));
    }catch(e){res.writeHead(403);res.end('{}');}
  });
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const base='http://127.0.0.1:19680';let output='';
  const child=spawn(process.execPath,['server.cjs'],{cwd:path.resolve(__dirname,'..'),stdio:['ignore','pipe','pipe'],env:{...process.env,NODE_ENV:'test',STORAGE_BACKEND:'nas',DATA_DIR:data,
    PORT:'19680',CATERING_PORT:'19681',HOTEL_PORT:'19682',ACCOUNTS_PORT:'19684',HOST:'127.0.0.1',ENABLE_MCP:'0',
    TEACHER_PASSWORD:'TestTeacherPass123',CATERING_CLASS_CODE:'TESTMENU',HOTEL_CLASS_CODE:'TESTHOTEL',ENABLE_TEACHER_CHAT:'1',
    AGENT_BASE_URL:`http://127.0.0.1:${upstream.address().port}`,AGENT_SIGNING_KEY:key,AGENT_TOOL_VERIFY_KEY:toolKey,TEACHING_DEPLOYMENT_ID:'test'}});
  child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  t.after(async()=>{if(child.exitCode===null){const done=once(child,'exit');child.kill();await done;}upstream.closeAllConnections();upstream.close();fs.rmSync(data,{recursive:true,force:true});});
  for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(output);try{if((await fetch(base+'/healthz')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));if(i===99)throw Error(output);}
  async function call(route,{body,cookie,headers={}}={}){const r=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();return {status:r.status,body:r.headers.get('content-type')?.includes('json')?JSON.parse(text):text,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
  const teacher={},identities={};
  for(const course of ['hotel','catering']){
    teacher[course]=(await call(`/${course}/api/login`,{body:{role:'teacher',password:'TestTeacherPass123'}})).cookie;
    assert.ok(teacher[course]);
    const student=await call(`/${course}/api/login`,{body:{id:'S001',name:'样例学生',password:'Student123!',classCode:course==='hotel'?'TESTHOTEL':'TESTMENU'}});
    assert.equal(student.status,200,JSON.stringify(student.body));
    assert.equal((await call(`/${course}/api/chat/capabilities`)).status,401);
    assert.equal((await call(`/${course}/api/chat/capabilities`,{cookie:student.cookie})).status,403);
    const caps=await call(`/${course}/api/chat/capabilities`,{cookie:teacher[course]});assert.equal(caps.body.enabled,true);assert.equal(caps.body.configured,true);
    const sent=await call(`/${course}/api/chat/sessions/${sid}/messages`,{cookie:teacher[course],body:{request_id:'request1',message:'查进度',page_context:{page:course==='hotel'?'teacher':'总览'}}});
    assert.equal(sent.status,200,JSON.stringify(sent.body));assert.match(sent.body.events_url,new RegExp('^/'+course+'/api/chat/'));
    const last=received.at(-1);identities[course]=last.claims;assert.equal(last.claims.course,course);assert.equal(last.headers.cookie,undefined);
    assert.doesNotMatch(JSON.stringify(last),/TestTeacherPass123|emenu_source_session=|hotel_session=/);
    assert.equal((await call(`/${course}/api/chat/sessions/${sid}/messages`,{cookie:teacher[course],body:{request_id:'bad',message:'x',capability_profile:'admin'}})).status,400);
    assert.equal((await call(`/${course}/api/chat/sessions`,{cookie:teacher[course],body:{request_id:'x'},headers:{Origin:'https://evil.test'}})).status,403);
    assert.equal((await call(`/${course}/api/agent-bridge`,{body:{action:'identity'},cookie:teacher[course]})).status,404);
    assert.match((await call(`/${course}/teacher-chat/chat.js`)).body,/customElements.define/);
    for(const file of ['markdown.js','vendor/marked.js','vendor/purify.js']){
      const asset=await call(`/${course}/teacher-chat/${file}`);assert.equal(asset.status,200);assert.ok(asset.body.length>100);
    }
    assert.match((await call(`/${course}/api/chat/executions/${eid}/events`,{cookie:teacher[course]})).body,/assistant.delta/);
    assert.equal((await call(`/${course}/api/chat/sessions/${sid}/close`,{cookie:teacher[course],body:{}})).status,200);
    assert.equal((await call(`/${course}/api/chat/sessions/${sid}/close`,{body:{}})).status,401);
  }
  assert.equal((await call('/hotel/api/chat/capabilities',{cookie:teacher.catering})).status,401);
  async function tool(course,name,args={},action='tool'){
    const who=identities[course],body={course,teacher_id:who.sub,login_ref:who.login_ref,action,tool:name,arguments:args};
    const now=Math.floor(Date.now()/1000),raw=Buffer.from(JSON.stringify(body));
    const signature=sign({v:1,iss:'teacher-agent',aud:'teaching-tools',deployment_id:'test',iat:now,exp:now+30,method:'POST',path:'/internal/teacher-agent/tools',body_sha256:sha256(raw)},toolKey);
    return call('/internal/teacher-agent/tools',{body,headers:{'X-Agent-Tool-Assertion':signature}});
  }
  for(const course of ['hotel','catering']){
    const overview=await tool(course,'get_course_overview');assert.equal(overview.status,200,JSON.stringify(overview.body));assert.equal(overview.body.data.student_count,1);
    const progress=await tool(course,'list_students_progress',{limit:1});assert.equal(progress.body.data.items[0].id,'S001');
    const detail=await tool(course,'get_student_detail',{student_id:'S001'});assert.equal(detail.status,200,JSON.stringify(detail.body));
    assert.doesNotMatch(JSON.stringify(detail.body),/"hash"|"password"|"token"|"login_ref"/);
    assert.equal((await tool(course,'reset_password')).status,403);
    assert.equal((await tool(course,'get_student_detail',{student_id:'missing'})).status,404);
    await call(`/${course}/api/logout`,{cookie:teacher[course],body:{}});
    assert.equal((await tool(course,null,{},'authorize')).status,401);
    assert.equal((await call(`/${course}/api/chat/capabilities`,{cookie:teacher[course]})).status,401);
  }
});
