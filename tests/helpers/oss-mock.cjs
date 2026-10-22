'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const { once } = require('node:events');
async function createMock() {
  const objects = new Map(), stats = { creates: 0, gets: 0, lists: 0 };
  const fault = { failPuts: false, lostPutResponse: false, failGets: false, delayGets: 0, versioning: '', acl: 'private', pageSize: 1000, throttle: 0 };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'), key = decodeURIComponent(url.pathname.slice(1));
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const send = (status, body) => { res.writeHead(status); res.end(body); };
    const error = (status, code) => send(status, `<Error><Code>${code}</Code></Error>`);
    if (!req.headers.authorization?.startsWith('OSS4-HMAC-SHA256 Credential=mock-key/')) return error(403, 'SignatureDoesNotMatch');
    if (req.method === 'GET' && fault.delayGets) await new Promise(resolve => setTimeout(resolve, fault.delayGets));
    if (fault.throttle > 0) { fault.throttle--; return error(503, 'SlowDown'); }
    if (req.method === 'GET' && !key) {
      if (url.searchParams.has('versioning')) return send(200, `<VersioningConfiguration>${fault.versioning ? `<Status>${fault.versioning}</Status>` : ''}</VersioningConfiguration>`);
      if (url.searchParams.has('acl')) return send(200, `<AccessControlPolicy><AccessControlList><Grant>${fault.acl}</Grant></AccessControlList></AccessControlPolicy>`);
      stats.lists++;
      const prefix = url.searchParams.get('prefix'), token = url.searchParams.get('continuation-token') || '';
      const keys = [...objects.keys()].filter(k => k.startsWith(prefix) && k > token).sort();
      const page = keys.slice(0, fault.pageSize), truncated = keys.length > page.length;
      return send(200, `<ListBucketResult><IsTruncated>${truncated}</IsTruncated>${page.map(k => `<Contents><Key>${encodeURIComponent(k)}</Key></Contents>`).join('')}${truncated ? `<NextContinuationToken>${page.at(-1)}</NextContinuationToken>` : ''}</ListBucketResult>`);
    }
    if (req.method === 'GET') {
      stats.gets++;
      if (fault.failGets) return error(503, 'Unavailable');
      return objects.has(key) ? send(200, objects.get(key)) : error(404, 'NoSuchKey');
    }
    if (req.method === 'PUT') {
      if (fault.failPuts) return error(503, 'Unavailable');
      if (req.headers['x-oss-forbid-overwrite'] !== 'true') return error(400, 'MissingForbidOverwrite');
      if (req.headers['content-md5'] !== crypto.createHash('md5').update(body).digest('base64')) return error(400, 'InvalidDigest');
      if (objects.has(key)) return error(409, 'FileAlreadyExists');
      objects.set(key, body); stats.creates++;
      if (fault.lostPutResponse) { fault.lostPutResponse = false; return req.socket.destroy(); }
      return send(200, '');
    }
    return error(405, 'MethodNotAllowed');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { objects, stats, fault, env: {
    NODE_ENV: 'test', STORAGE_BACKEND: 'oss', OSS_BUCKET: 'forcc', OSS_REGION: 'cn-shanghai',
    OSS_ENDPOINT: `http://127.0.0.1:${server.address().port}`, OSS_SINGLE_WRITER: '1', OSS_STORAGE_KEY: 'ab'.repeat(32),
    ALIBABA_CLOUD_ACCESS_KEY_ID: 'mock-key', ALIBABA_CLOUD_ACCESS_KEY_SECRET: 'mock-secret'
  }, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
module.exports = { createMock };
