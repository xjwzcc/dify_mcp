'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {sign,verify,assertion,sha256,selectedCookie}=require('../agent/identity.cjs');
test('service assertions bind identity, bytes, route, method and expiry',()=>{
  const key='k'.repeat(32),body=Buffer.from('{"message":"中文"}'),path='/api/chat/sessions?a=1';
  const who={teacher_id:'teacher1',course:'hotel',login_ref:sha256('session'),login_expires_at:Date.now()/1000+300};
  const value=assertion(who,'POST',path,body,{AGENT_SIGNING_KEY:key,TEACHING_DEPLOYMENT_ID:'test'});
  const args={audience:'teacher-agent',method:'POST',path,body};
  assert.equal(verify(value,key,args).sub,'teacher1');
  for(const changed of [{body:Buffer.from('{}')},{method:'GET'},{path:'/api/chat/sessions?a=2'},{audience:'teaching-tools'},{now:Date.now()/1000+61}])assert.throws(()=>verify(value,key,{...args,...changed}));
  assert.throws(()=>verify(value.slice(0,-1)+'!',key,args));
  assert.throws(()=>verify(value,'wrong'.repeat(8),args));
  const c=verify(value,key,args);assert.throws(()=>verify(sign({...c,exp:c.iat+3600},key),key,args));
  assert.equal(selectedCookie({cookie:'hotel_session=H; emenu_source_session=C; secret=private'},'hotel'),'hotel_session=H');
});
