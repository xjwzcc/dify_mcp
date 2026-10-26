'use strict';
const {test}=require('node:test'), assert=require('node:assert/strict');
const {createMock}=require('./helpers/oss-mock.cjs');
const {startPersistence}=require('../agent/persistence.cjs');
test('agent persistence authenticates, encrypts and recovers independently of classrooms',async t=>{
  const mock=await createMock();t.after(()=>mock.close());
  const env={...mock.env,AGENT_PERSISTENCE_KEY:'p'.repeat(32),AGENT_PERSISTENCE_PORT:'19882'};
  let server=await startPersistence(env);
  t.after(()=>{server.closeAllConnections();server.close();});
  const request=(route,method='GET',body,key=env.AGENT_PERSISTENCE_KEY)=>fetch('http://127.0.0.1:19882'+route,{method,body,headers:{Authorization:'Bearer '+key}});
  assert.equal((await request('/database','GET',undefined,'bad')).status,403);
  const database=Buffer.from('sqlite snapshot with teacher history');
  assert.equal((await request('/database','PUT',database)).status,204);
  const route='/blobs/'+'a'.repeat(32), attachment=Buffer.from('private teacher attachment');
  assert.equal((await request(route,'PUT',attachment)).status,204);
  assert.deepEqual(Buffer.from(await (await request(route)).arrayBuffer()),attachment);
  for(const [key,value] of mock.objects){
    assert.ok(key.includes('/teacher-agent/'));
    assert.equal(value.includes('private teacher attachment'),false);
    assert.equal(value.includes('teacher history'),false);
  }
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  server=await startPersistence(env);
  assert.deepEqual(Buffer.from(await (await request('/database')).arrayBuffer()),database);
  assert.deepEqual(Buffer.from(await (await request(route)).arrayBuffer()),attachment);
});
