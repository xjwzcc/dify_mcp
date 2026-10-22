'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const port = Number(process.env.PORT || 9000);
const backend = process.env.STORAGE_BACKEND || 'nas';
if (!['nas', 'feishu', 'oss'].includes(backend)) throw Error('Invalid STORAGE_BACKEND');
const remoteStorage = backend !== 'nas';
const dataDir = path.resolve(process.env.DATA_DIR || (remoteStorage ? '/tmp/teaching-cache' : path.join(__dirname, 'data')));
const production = process.env.NODE_ENV === 'production';
if (backend === 'nas' && production && (!process.env.DATA_DIR || dataDir.startsWith('/tmp/') || dataDir.startsWith('/code/'))) {
  throw new Error('Production requires DATA_DIR on persistent storage, e.g. /mnt/teaching/data');
}
if (backend === 'nas' && production && process.env.REQUIRE_NAS === '1') {
  // Refuse to silently create a local directory when an FC NAS mount is missing.
  const mount = process.env.NAS_MOUNT || '/mnt/teaching';
  if (!fs.existsSync(mount) || Number(fs.statfsSync(mount).type) !== 0x6969) {
    throw new Error('Expected NFS mount is unavailable: ' + mount);
  }
}
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const configFile = path.join(dataDir, 'bootstrap.json');
if (remoteStorage) {
  for (const key of ['TEACHER_PASSWORD', 'CATERING_CLASS_CODE', 'HOTEL_CLASS_CODE'])
    if (!process.env[key] || process.env[key].length < 8) throw Error(key + ' must be set to a stable value of at least 8 characters');
  if (backend === 'feishu' && process.env.FEISHU_CATERING_TABLE_ID === process.env.FEISHU_HOTEL_TABLE_ID)
    throw Error('The two applications require separate Feishu tables');
} else if (!fs.existsSync(configFile)) {
  fs.writeFileSync(configFile, JSON.stringify({
    teacherPassword: process.env.TEACHER_PASSWORD || crypto.randomBytes(18).toString('base64url'),
    cateringCode: process.env.CATERING_CLASS_CODE || crypto.randomBytes(6).toString('base64url'),
    hotelCode: process.env.HOTEL_CLASS_CODE || crypto.randomBytes(6).toString('base64url')
  }, null, 2), { flag: 'wx', mode: 0o600 });
}
const config = remoteStorage ? {
  teacherPassword: process.env.TEACHER_PASSWORD,
  cateringCode: process.env.CATERING_CLASS_CODE,
  hotelCode: process.env.HOTEL_CLASS_CODE
} : JSON.parse(fs.readFileSync(configFile, 'utf8'));
const accountEnabled = backend !== 'feishu';
const bridgeSecret = crypto.randomBytes(32).toString('hex');
const services = [
  { name: 'catering', port: Number(process.env.CATERING_PORT || 9101), code: config.cateringCode },
  { name: 'hotel', port: Number(process.env.HOTEL_PORT || 9102), code: config.hotelCode }
];
if (accountEnabled) services.push({ name: 'accounts', port: Number(process.env.ACCOUNTS_PORT || 9104) });
const children = [];
let stopping = false;
function start(command, args, env) {
  const child = spawn(command, args, { cwd: __dirname, env: { ...process.env, ...env }, stdio: 'inherit' });
  children.push(child);
  child.on('error', error => { console.error(error.message); shutdown(1); });
  child.on('exit', () => { if (!stopping) shutdown(1); });
}
for (const service of services) {
  start(process.execPath, [path.join(__dirname, 'apps', service.name, 'server.cjs')], {
    PORT: String(service.port), HOST: '127.0.0.1',
    DATA_DIR: path.join(dataDir, service.name),
    TEACHER_PASSWORD: config.teacherPassword, CLASS_CODE: service.code || '',
    ACCOUNT_BRIDGE_SECRET: bridgeSecret, CATERING_PORT: String(services[0].port), HOTEL_PORT: String(services[1].port),
    SECURE_COOKIE: production ? '1' : (process.env.SECURE_COOKIE || '0')
  });
}
const mcpPort = Number(process.env.MCP_PORT || 9103);
if (process.env.ENABLE_MCP === '1') {
  start(process.env.PYTHON || 'python3', ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', String(mcpPort)], {});
}
const rates = new Map();
const cleanup = setInterval(() => {
  for (const [key, value] of rates) if (Date.now() - value.start > 60000) rates.delete(key);
}, 60000);
cleanup.unref();
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
function proxy(req, res, targetPort, targetPath) {
  const headers = { ...req.headers };
  // Keep the original Host so the applications' same-origin checks remain effective.
  delete headers['x-forwarded-host'];
  delete headers['x-forwarded-proto'];
  const upstream = http.request({ hostname: '127.0.0.1', port: targetPort, method: req.method, path: targetPath, headers }, response => {
    res.writeHead(response.statusCode, response.headers);
    response.pipe(res); // SSE and database backups must remain streaming.
  });
  upstream.on('error', () => {
    if (!res.headersSent) json(res, 503, { error: '服务正在启动，请稍后重试' });
    else res.end();
  });
  req.on('aborted', () => upstream.destroy());
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}
async function serviceHealth() {
  const targets = services.map(service => `http://127.0.0.1:${service.port}/api/health`);
  if (process.env.ENABLE_MCP === '1') targets.push(`http://127.0.0.1:${mcpPort}/`);
  return Promise.all(targets.map(async target => {
    try {
      const response = await fetch(target, { signal: AbortSignal.timeout(2000) });
      await response.body?.cancel();
      return response.ok;
    } catch { return false; }
  }));
}
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch { return json(res, 400, { error: '无效地址' }); }
  if (url.pathname === '/healthz') {
    const checks = await serviceHealth();
    return json(res, checks.every(Boolean) ? 200 : 503, { ok: checks.every(Boolean), storage: backend, services: checks });
  }
  if (url.pathname === '/' && ['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(path.join(__dirname, 'portal/index.html')));
  }
  for (const service of services) {
    const prefix = '/' + service.name;
    if (url.pathname === prefix) {
      res.writeHead(308, { Location: prefix + '/' + url.search }); return res.end();
    }
    if (!url.pathname.startsWith(prefix + '/')) continue;
    if (url.pathname === prefix + '/api/account-bridge') return json(res, 404, { error: '接口不存在' });
    if (url.pathname === prefix + '/api/login') {
      // Only trust FC's injected client address in the FC deployment.
      const ip = process.env.FC_INSTANCE_ID ? req.headers['x-fc-client-ip'] || req.socket.remoteAddress : req.socket.remoteAddress;
      const key = service.name + ':' + ip;
      let rate = rates.get(key);
      if (!rate || Date.now() - rate.start > 60000) rate = { start: Date.now(), count: 0 };
      rates.set(key, rate);
      if (++rate.count > 40) return json(res, 429, { error: '登录尝试过于频繁，请稍后重试' });
    }
    return proxy(req, res, service.port, url.pathname + url.search);
  }
  if (process.env.ENABLE_MCP === '1') {
    if (url.pathname === '/mcp' || url.pathname === '/mcp/') return proxy(req, res, mcpPort, '/');
    if (url.pathname === '/sse' || url.pathname === '/messages') return proxy(req, res, mcpPort, req.url);
  }
  json(res, 404, { error: '页面不存在' });
});
server.on('error', error => { console.error(error.message); shutdown(1); });
// FC considers the runtime initialized once this port listens. Keep initialization
// active until remote recovery and every child service are ready.
(async () => {
  const deadline = Date.now() + 90000;
  while (!stopping) {
    const checks = await serviceHealth();
    if (stopping) return;
    if (checks.every(Boolean)) {
      server.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`Teaching portal ready: http://localhost:${port}`));
      return;
    }
    if (Date.now() >= deadline) throw Error('Child services did not become ready during startup');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
})().catch(error => { console.error(error.message); shutdown(1); });
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  server.close();
  for (const child of children) child.kill('SIGTERM');
  const timer = setTimeout(() => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    process.exit(code);
  }, 4000);
  Promise.all(children.map(child => child.exitCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve))))
    .then(() => { clearTimeout(timer); process.exit(code); });
}
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
