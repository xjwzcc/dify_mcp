'use strict';
const http = require('node:http');
const { once } = require('node:events');
async function createMock() {
  const tables = new Map(), stats = { requests: 0, auth: 0, creates: 0, heads: 0 };
  const fault = { throttle: 0, failChunks: false, lostHeadResponse: false, delayMs: 0 };
  for (const app of ['catering', 'hotel']) {
    tables.set('table_' + app, new Map([['head_' + app, { record_id: 'head_' + app,
      fields: { key: '@head:' + app, payload: JSON.stringify({ version: 1, namespace: app, seq: 0, id: null }) } }]]));
  }
  let sequence = 0;
  const server = http.createServer(async (req, res) => {
    let source = ''; for await (const chunk of req) source += chunk;
    const body = JSON.parse(source || '{}');
    const send = (data, code = 0, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code, data })); };
    stats.requests++;
    if (fault.delayMs) await new Promise(resolve => setTimeout(resolve, fault.delayMs));
    if (req.url.endsWith('/auth/v3/tenant_access_token/internal')) {
      stats.auth++; res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, tenant_access_token: 'mock-tenant', expire: 7200 }));
    }
    if (req.headers.authorization !== 'Bearer mock-tenant') return send({}, 99991663, 401);
    if (fault.throttle > 0) { fault.throttle--; return send({}, 1254290, 429); }
    const match = req.url.match(/\/tables\/([^/]+)\/records(?:\/([^/?]+))?$/);
    if (!match || !tables.has(match[1])) return send({}, 1254041, 404);
    const table = tables.get(match[1]), id = match[2];
    if (req.method === 'GET') {
      if (!table.has(id)) return send({}, 1254043, 404);
      return send({ record: table.get(id) });
    }
    if (req.method === 'POST') {
      if (fault.failChunks) return send({}, 1255001, 500);
      const record_id = 'rec_' + ++sequence;
      const record = { record_id, fields: body.fields }; table.set(record_id, record); stats.creates++;
      return send({ record });
    }
    if (req.method === 'PUT' && table.has(id)) {
      const record = table.get(id); record.fields = { ...record.fields, ...body.fields }; stats.heads++;
      if (fault.lostHeadResponse) { fault.lostHeadResponse = false; return req.socket.destroy(); }
      return send({ record });
    }
    return send({}, 1254043, 404);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { tables, stats, fault, env: {
    NODE_ENV: 'test', STORAGE_BACKEND: 'feishu', FEISHU_SINGLE_WRITER: '1',
    FEISHU_API_BASE: `http://127.0.0.1:${server.address().port}/open-apis`,
    FEISHU_APP_ID: 'mock-app', FEISHU_APP_SECRET: 'mock-secret', FEISHU_APP_TOKEN: 'mock-base',
    FEISHU_STORAGE_KEY: 'ab'.repeat(32), FEISHU_CATERING_TABLE_ID: 'table_catering', FEISHU_CATERING_HEAD_ID: 'head_catering',
    FEISHU_HOTEL_TABLE_ID: 'table_hotel', FEISHU_HOTEL_HEAD_ID: 'head_hotel'
  }, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
module.exports = { createMock };
