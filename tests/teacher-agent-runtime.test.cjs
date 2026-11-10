'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const {spawn} = require('node:child_process'), {once} = require('node:events');
const {configureAgent} = require('../agent/runtime-config.cjs');
const {createMock} = require('./helpers/oss-mock.cjs');

test('external controller requires fixed keys and does not need the model credential in the web service', () => {
  const env = {TEACHER_AGENT_MODE:'ecs-external', ENABLE_TEACHER_CHAT:'1', OSS_SINGLE_WRITER:'1'};
  assert.throws(() => configureAgent(env), /AGENT_SIGNING_KEY/);
  for (const key of ['AGENT_SIGNING_KEY','AGENT_TOOL_VERIFY_KEY','AGENT_PERSISTENCE_KEY']) env[key] = key.repeat(3);
  const before = {...env};
  assert.deepEqual(configureAgent(env), {enabled:true, external:true});
  for (const key of Object.keys(before)) assert.equal(env[key], before[key]);
  assert.equal(env.AGENT_BASE_URL, 'http://127.0.0.1:9181');
  assert.deepEqual(configureAgent({TEACHER_AGENT_MODE:'ecs-external',ENABLE_TEACHER_CHAT:'0'}), {enabled:false,external:false});
  assert.throws(() => configureAgent({TEACHER_AGENT_MODE:'fc-internal',ENABLE_TEACHER_CHAT:'1',OSS_SINGLE_WRITER:'1'}), /DEEPSEEK/);
});

test('external controller can start after the website and health follows controller restarts', {timeout:20000}, async t => {
  const mock = await createMock();
  t.after(() => mock.close());
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-external-'));
  const child = spawn(process.execPath, ['server.cjs'], {cwd:path.resolve(__dirname,'..'), env:{...process.env,...mock.env,
    STORAGE_BACKEND:'nas',DATA_DIR:data,HOST:'127.0.0.1',PORT:'19580',CATERING_PORT:'19581',HOTEL_PORT:'19582',ACCOUNTS_PORT:'19584',
    ACCOUNTS_ADMIN_SOCKET:path.join(data,'admin.sock'),ENABLE_MCP:'0',TEACHER_AGENT_MODE:'ecs-external',ENABLE_TEACHER_CHAT:'1',
    AGENT_SIGNING_KEY:'s'.repeat(64),AGENT_TOOL_VERIFY_KEY:'t'.repeat(64),AGENT_PERSISTENCE_KEY:'p'.repeat(64),
    AGENT_PERSISTENCE_PORT:'19585',PYTHON:'/must-not-spawn-python'},stdio:['ignore','pipe','pipe']});
  let output = '';
  child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
  let upstream;
  t.after(async () => {
    if (child.exitCode === null) { const stopped = once(child,'exit'); child.kill(); await stopped; }
    if (upstream) { upstream.closeAllConnections(); await new Promise(r => upstream.close(r)); }
    fs.rmSync(data,{recursive:true,force:true});
  });
  const health = () => fetch('http://127.0.0.1:19580/healthz').then(r => r.json());
  let first;
  for (let i=0;i<80;i++) {
    if (child.exitCode !== null) throw Error(output);
    try { first = await health(); break; } catch {}
    await new Promise(r => setTimeout(r,100));
  }
  assert.equal(first?.ok,true,output); assert.equal(first.agent,false);
  assert.doesNotMatch(output,/must-not-spawn-python/);
  const denied = await fetch('http://127.0.0.1:19585/database');
  assert.equal(denied.status,403);
  upstream = http.createServer((req,res) => { res.writeHead(req.url === '/health' ? 200 : 404); res.end('{}'); });
  upstream.listen(9181,'127.0.0.1'); await once(upstream,'listening');
  assert.equal((await health()).agent,true);
  upstream.closeAllConnections(); await new Promise(r => upstream.close(r)); upstream = null;
  assert.equal((await health()).agent,false);
});
