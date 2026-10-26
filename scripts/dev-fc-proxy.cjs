'use strict';
// Local static pages, cloud APIs. This process never opens SQLite or writes OSS.
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const DEFAULT_FC = 'https://cc-dify-mcp-wvsdgstfwa.cn-hangzhou.fcapp.run';
const files = {
  '/': 'portal/index.html',
  ...Object.fromEntries(['catering','hotel'].flatMap(c=>['chat.js','api.js','state.js','markdown.js','vendor/marked.js','vendor/purify.js','chat.css'].map(f=>['/'+c+'/teacher-chat/'+f,'shared/teacher-chat/'+f]))),
  '/accounts/': 'apps/accounts/public/index.html',
  '/accounts/app.js': 'apps/accounts/public/app.js',
  '/accounts/style.css': 'apps/accounts/public/style.css',
  ...Object.fromEntries(['teacher', 'student', ''].map(p => ['/catering/' + p, 'apps/catering/public/index.html'])),
  ...Object.fromEntries(['app.js', 'style.css', 'native-bridge.js'].map(p => ['/catering/' + p, 'apps/catering/public/' + p])),
  '/catering/customer.html': 'apps/catering/public/original.html',
  '/catering/original.html': 'apps/catering/public/original.html',
  ...Object.fromEntries(['teacher', 'student', 'index.html', ''].map(p => ['/hotel/' + p, 'apps/hotel/public/index.html'])),
  ...Object.fromEntries(['app.js', 'online.js', 'teaching.js', 'classroom.js', 'mobile.js', 'mobile.css'].map(p => ['/hotel/' + p, 'apps/hotel/public/' + p]))
};
function reply(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: message }));
}
function createProxy(upstream = DEFAULT_FC) {
  const target = new URL(upstream);
  const loopbackTest = target.protocol === 'http:' && target.hostname === '127.0.0.1';
  if ((!loopbackTest && target.protocol !== 'https:') || target.username || target.password || target.pathname !== '/' || target.search || target.hash)
    throw Error('FC_BASE_URL must be an HTTPS origin (loopback HTTP is allowed for tests)');
  const transport = target.protocol === 'https:' ? https : http;
  function forward(req, res, { authOnly = false } = {}) {
    const headers = { ...req.headers, host: target.host };
    for (const key of Object.keys(headers)) {
      if (key.startsWith('x-forwarded-') || key.startsWith('x-fc-') || ['connection', 'proxy-authorization', 'proxy-connection'].includes(key)) delete headers[key];
    }
    // The browser's local Origin is validated before reaching here. Translate it
    // so the existing cloud same-origin check continues to protect direct access.
    if (headers.origin) headers.origin = target.origin;
    if (headers.referer) headers.referer = target.origin + '/';
    if (authOnly) { delete headers['content-length']; delete headers['transfer-encoding']; }
    const request = transport.request({ hostname: target.hostname, port: target.port || undefined,
      method: authOnly ? 'GET' : req.method, path: authOnly ? '/catering/api/snapshot' : req.url, headers }, response => {
      if (authOnly) {
        response.resume();
        if (response.statusCode === 200) return serve(req, res, files['/catering/original.html']);
        return reply(res, response.statusCode === 401 ? 401 : 502, '请先登录 FC 学生账号');
      }
      const out = { ...response.headers, 'cache-control': 'no-store' };
      delete out.connection;
      delete out['strict-transport-security'];
      // Preserve authentication and scope, but adapt HTTPS cookies to this
      // loopback-only HTTP development server. Never use this proxy publicly.
      if (out['set-cookie']) out['set-cookie'] = out['set-cookie'].map(cookie => cookie.replace(/;\s*Secure(?=;|$)/gi, '').replace(/;\s*Domain=[^;]+/gi, ''));
      res.writeHead(response.statusCode, out);
      response.pipe(res);
    });
    request.setTimeout(60000, () => request.destroy(Error('FC timeout')));
    request.on('error', () => { if (!res.headersSent) reply(res, 502, 'FC 暂时无法连接，请保留页面后重试'); else res.destroy(); });
    req.on('aborted', () => request.destroy());
    res.on('close', () => request.destroy());
    if (authOnly) request.end(); else req.pipe(request);
  }
  function serve(req, res, relative) {
    const type = relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : 'text/html';
    res.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(path.join(root, relative));
    stream.on('error', () => res.destroy()); stream.pipe(res);
  }
  return http.createServer((req, res) => {
    const port = req.socket.localPort;
    if (![ `localhost:${port}`, `127.0.0.1:${port}` ].includes(req.headers.host)) return reply(res, 403, '仅允许本机访问');
    const localOrigin = 'http://' + req.headers.host;
    let pathname;
    try { pathname = new URL(req.url, localOrigin).pathname; } catch { return reply(res, 400, '无效地址'); }
    const api = /^\/(catering|hotel|accounts)\/api\//.test(pathname) || pathname === '/healthz';
    const protectedRequest = api || pathname === '/catering/original.html' || !['GET', 'HEAD'].includes(req.method);
    if ((req.headers.origin && req.headers.origin !== localOrigin) || (protectedRequest && req.headers['sec-fetch-site'] === 'cross-site'))
      return reply(res, 403, '拒绝跨站请求');
    if (pathname.endsWith('/api/account-bridge') || /\/api\/agent-bridge(?:\/|$)/.test(pathname)) return reply(res, 404, '接口不存在');
    if (api) return forward(req, res);
    if (!['GET', 'HEAD'].includes(req.method)) return reply(res, 405, '静态页面仅支持读取');
    if (['/catering', '/hotel', '/accounts'].includes(pathname)) { res.writeHead(308, { Location: pathname + '/' }); return res.end(); }
    if (!files[pathname]) return reply(res, 404, '页面不存在');
    if (pathname === '/catering/original.html') return forward(req, res, { authOnly: true });
    serve(req, res, files[pathname]);
  });
}
if (require.main === module) {
  const port = Number(process.env.LOCAL_PORT || 19081);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid LOCAL_PORT');
  const upstream = process.env.FC_BASE_URL || DEFAULT_FC;
  const server = createProxy(upstream);
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Local pages: http://127.0.0.1:${port}`);
    console.log(`Cloud APIs: ${upstream}`);
    console.log('LIVE DATA: saves go to FC and production OSS. Use a test account.');
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.closeAllConnections(); server.close(); });
}
module.exports = { createProxy };
