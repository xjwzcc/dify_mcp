'use strict';
// Trusted, loopback-only broker. The sandbox never receives this key or socket.
const http = require('node:http');
const crypto = require('node:crypto');
const { OssJournal } = require('../storage/oss.cjs');
const { equal } = require('./identity.cjs');

async function startPersistence(env = process.env) {
  const secret = env.AGENT_PERSISTENCE_KEY;
  if (!secret || secret.length < 32) throw Error('Agent persistence key required');
  const journal = new OssJournal('teacher-agent', env);
  journal.checkpointEvery = 1;
  let current = (await journal.restore()).at(-1).data[0]?.database || '';
  let poisoned = false, pending = Promise.resolve();
  const prefix = journal.prefix.replace('/commits/', '/blobs/');
  const key = crypto.createHash('sha256').update(journal.key).update(prefix).digest();
  function seal(data) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(prefix));
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  }
  function open(data) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0,12));
    decipher.setAAD(Buffer.from(prefix)); decipher.setAuthTag(data.subarray(12,28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]);
  }
  const server = http.createServer(async (req,res) => {
    try {
      if (!equal(req.headers.authorization || '', 'Bearer '+secret)) { res.writeHead(403).end(); return; }
      if (poisoned) throw Error('Recovery required');
      const route = req.url;
      if (req.method === 'GET' && route === '/database') return res.end(Buffer.from(current,'base64'));
      if (req.method === 'GET' && /^\/blobs\/[a-f0-9]{32}$/.test(route))
        return res.end(open(await journal.client.request('GET',prefix+route.slice(7))));
      if (req.method !== 'PUT' || !(route === '/database' || /^\/blobs\/[a-f0-9]{32}$/.test(route))) {
        res.writeHead(404).end(); return;
      }
      const chunks=[]; let size=0;
      for await (const chunk of req) {
        size += chunk.length; if (size > 32*1024*1024) throw Error('Persistence limit'); chunks.push(chunk);
      }
      const body=Buffer.concat(chunks);
      if (route === '/database') {
        const operation = pending.then(async () => {
          if (poisoned) throw Error('Recovery required');
          try { await journal.append('snapshot',[{database:body.toString('base64')}]); current=body.toString('base64'); }
          catch (error) { poisoned=true; throw error; }
        });
        pending=operation.catch(()=>{}); await operation;
      } else await journal.client.create(prefix+route.slice(7),seal(body));
      res.writeHead(204).end();
    } catch { res.writeHead(503).end('PERSISTENCE_UNAVAILABLE'); }
  });
  await new Promise((resolve,reject)=>{ server.once('error',reject); server.listen(Number(env.AGENT_PERSISTENCE_PORT || 9182),'127.0.0.1',resolve); });
  return server;
}
module.exports = {startPersistence};
