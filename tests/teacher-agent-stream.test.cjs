'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
test('SSE decodes split UTF8, CRLF, heartbeats and replay cursors',async()=>{
  const {sseFrames}=await import('../shared/teacher-chat/api.js');
  const {acceptEvent,draftKey,storageKey}=await import('../shared/teacher-chat/state.js');
  const bytes=new TextEncoder().encode(': heartbeat\r\n\r\nid: 1\r\ndata: {"seq":1,"payload":{"text":"老师好"}}\r\n\r\ndata: {"seq":2}\n\n');
  const body=new ReadableStream({start(c){for(const b of bytes)c.enqueue(new Uint8Array([b]));c.close();}});
  const found=[];for await(const e of sseFrames(body))found.push(e);
  assert.equal(found[0].payload.text,'老师好');assert.equal(found.length,2);
  assert.equal(acceptEvent(found[0],1),false);assert.equal(acceptEvent(found[1],1),true);
  assert.notEqual(draftKey({attempt_id:'a',payload:{item:1}}),draftKey({attempt_id:'b',payload:{item:1}}));
  assert.notEqual(storageKey('hotel','a'),storageKey('catering','a'));
});
