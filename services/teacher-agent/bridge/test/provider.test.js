import test from 'node:test';
import assert from 'node:assert/strict';
import {provider} from '../provider.js';
import {scopeToken, authenticateScope, ownedResponse,responseKey} from '../isolation.js';
import {portableNativeInput} from '../native-history.js';

test('DeepSeek keeps tool pairing and plaintext reasoning; rejects opaque history',()=>{
  const input=[{type:'reasoning',content:[{type:'reasoning_text',text:'internal'}]},
    {type:'function_call',call_id:'c1',name:'time',arguments:'{}'},
    {type:'function_call_output',call_id:'c1',output:'ok'},
    {type:'custom_tool_call',name:'apply_patch',call_id:'c2',input:'patch'},
    {type:'custom_tool_call_output',call_id:'c2',output:'ok'}];
  const result=provider.body({input,previous_response_id:'old',reasoning:{effort:'medium',summary:'detailed'},
    tools:[{type:'custom',name:'apply_patch'}]});
  assert.deepEqual(result.input,input);
  assert.equal(result.previous_response_id,undefined);
  assert.deepEqual(result.reasoning,{effort:'high'});
  assert.throws(()=>provider.body({input:[{type:'reasoning',encrypted_content:'opaque'}]}),/OPAQUE/);
  assert.throws(()=>provider.body({input:[{type:'item_reference',id:'remote'}]}),/OPAQUE/);
  assert.throws(()=>provider.body({tools:[{type:'web_search'}]}),/UNSUPPORTED_TOOL/);
});

test('signed scope cannot be replayed in another scope',()=>{
  const a='a'.repeat(32),b='b'.repeat(32),secret='test-secret';
  const headers={'x-exp-conversation-id':a,authorization:'Bearer '+scopeToken(secret,a)};
  assert.equal(authenticateScope(headers,secret),a);
  assert.throws(()=>authenticateScope({...headers,'x-exp-conversation-id':b},secret));
  const store=new Map([[responseKey(a,'r'),{conversationKey:a,createdAt:Date.now(),response:{}}]]);
  assert.throws(()=>ownedResponse(store,b,'r',60000));
  assert.ok(ownedResponse(store,a,'r',60000));
});

test('DeepSeek replays complete plaintext reasoning when an opaque companion is present',()=>{
  const reasoning={type:'reasoning',summary:[],content:[{type:'reasoning_text',text:'Preserve the tool reasoning.'}],encrypted_content:'provider-companion'};
  const tool={type:'function_call',call_id:'c1',name:'exec_command',arguments:'{}'};
  const output={type:'function_call_output',call_id:'c1',output:'5050'};
  const adapted=provider.body({input:[reasoning,tool,output]}).input;
  assert.deepEqual(adapted,[{type:'reasoning',content:reasoning.content},tool,output]);
  assert.equal(reasoning.encrypted_content,'provider-companion');
  assert.throws(()=>provider.body({input:[{...reasoning,content:[]}]}),/OPAQUE/);
  assert.throws(()=>provider.body({input:[{...reasoning,content:[{type:'reasoning_text',text:''}]}]}),/OPAQUE/);
});

test('native history strips resource ids and retains tool call ids',()=>{
  assert.deepEqual(portableNativeInput([{id:'remote',type:'function_call',call_id:'c',name:'clock'}]),
    [{type:'function_call',call_id:'c',name:'clock'}]);
});
