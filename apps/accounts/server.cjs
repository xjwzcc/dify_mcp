'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { openDatabase } = require('../../storage/database.cjs');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const hash = password => { const salt = crypto.randomBytes(16).toString('hex'); return salt + ':' + crypto.scryptSync(password, salt, 32).toString('hex'); };
const check = (password, stored) => { try { const [salt, value] = stored.split(':'); return crypto.timingSafeEqual(crypto.scryptSync(password, salt, 32), Buffer.from(value, 'hex')); } catch { return false; } };
const fail = (message, status = 400) => { throw Object.assign(Error(message), { status }); };
const secure = process.env.SECURE_COOKIE === '1' ? '; Secure' : '';
const cookie = token => `teaching_account=${token}; HttpOnly; SameSite=Strict; Path=/accounts/; Max-Age=28800${secure}`;
const clearCourses = ['emenu_source_session=; Path=/catering/; Max-Age=0; HttpOnly; SameSite=Strict', 'hotel_session=; Path=/hotel/; Max-Age=0; HttpOnly; SameSite=Strict'];
const ports = { catering: Number(process.env.CATERING_PORT || 9101), hotel: Number(process.env.HOTEL_PORT || 9102) };
async function bridge(course, data) {
  if (!Object.hasOwn(ports, course)) fail('请选择有效课程');
  let response;
  try { response = await fetch(`http://127.0.0.1:${ports[course]}/${course}/api/account-bridge`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Account-Bridge': process.env.ACCOUNT_BRIDGE_SECRET },
    body: JSON.stringify(data), signal: AbortSignal.timeout(45000)
  }); } catch { fail('课程服务暂不可用，请稍后重试；原有记录保留', 503); }
  const value = await response.json();
  if (!response.ok) fail(value.error || '课程操作失败', response.status);
  return value;
}
(async () => {
  const dir = process.env.DATA_DIR || path.join(__dirname, 'data'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const storage = await openDatabase('accounts', path.join(dir, 'accounts.sqlite'));
  const db = storage.db;
  db.exec(`CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL,password TEXT NOT NULL,provision TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,id TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS bindings(account_id TEXT NOT NULL,course TEXT NOT NULL,local_id TEXT NOT NULL,name TEXT NOT NULL,PRIMARY KEY(account_id,course),UNIQUE(course,local_id));
    CREATE TABLE IF NOT EXISTS invitations(hash TEXT PRIMARY KEY,creator TEXT NOT NULL,expires INTEGER NOT NULL,used_by TEXT);
    CREATE TABLE IF NOT EXISTS course_sessions(session_id TEXT NOT NULL,course TEXT NOT NULL,token TEXT NOT NULL,PRIMARY KEY(session_id,course));`);
  const publicAccount = u => ({ username: u.username, name: u.name, role: u.role });
  const bindings = id => db.prepare('SELECT course,local_id AS localId,name FROM bindings WHERE account_id=?').all(id);
  const reply = (res, status, value, cookies) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(cookies ? { 'Set-Cookie': cookies } : {}) }); res.end(JSON.stringify(value)); };
  function auth(req) {
    const raw = String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('teaching_account='))?.slice(17);
    return raw ? db.prepare('SELECT a.*,s.token AS session_id FROM accounts a JOIN sessions s ON s.id=a.id WHERE s.token=? AND s.expires>?').get(digest(raw), Date.now()) : null;
  }
  async function revokeCourses(sessionId) {
    for (const s of db.prepare('SELECT * FROM course_sessions WHERE session_id=?').all(sessionId)) await bridge(s.course, { action: 'revoke', token: s.token });
    db.prepare('DELETE FROM course_sessions WHERE session_id=?').run(sessionId);
  }
  async function login(req, res, account) {
    const current = auth(req);
    if (current) { await revokeCourses(current.session_id); db.prepare('DELETE FROM sessions WHERE token=?').run(current.session_id); }
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token), account.id, Date.now() + 8 * 3600000);
    reply(res, 200, { user: publicAccount(account), bindings: bindings(account.id) }, [cookie(token), ...clearCourses]);
  }
  // Bound global and per-address limits also apply to invitation/password verification.
  const rates = new Map();
  const handler = storage.wrap(async (req, res) => {
    try {
      res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'same-origin');
      const route = new URL(req.url, 'http://localhost').pathname.replace(/^\/accounts(?=\/|$)/, '') || '/';
      if (!route.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(req.method)) fail('请求方法无效', 405);
        const file = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' }[route];
        if (!file) fail('页面不存在', 404);
        res.writeHead(200, { 'Content-Type': (file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html') + '; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(path.join(__dirname, 'public', file)));
      }
      if (route === '/api/health' && req.method === 'GET') return reply(res, 200, { ok: true });
      if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)) fail('拒绝跨站请求', 403);
      const u = auth(req);
      if (route === '/api/session' && req.method === 'GET') {
        if (!u) fail('请先登录统一账号', 401);
        return reply(res, 200, { user: publicAccount(u), bindings: bindings(u.id) });
      }
      if (req.method !== 'POST') fail('请求方法无效', 405);
      const ip = process.env.FC_INSTANCE_ID ? String(req.headers['x-fc-client-ip'] || req.socket.remoteAddress) : req.socket.remoteAddress;
      for (const key of ['global', ip]) {
        const rate = rates.get(key) || { at: 0, n: 0 };
        if (Date.now() - rate.at > 60000) { rate.at = Date.now(); rate.n = 0; }
        if (++rate.n > (key === 'global' ? 200 : 40)) fail('尝试过于频繁，请稍后重试', 429);
        rates.set(key, rate);
      }
      if (rates.size > 1000) for (const [key, r] of rates) if (Date.now() - r.at > 60000) rates.delete(key);
      let raw = ''; req.setEncoding('utf8'); for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 8192) fail('请求过大', 413); }
      let b; try { b = JSON.parse(raw || '{}'); } catch { fail('请求格式错误'); }
      if (!b || typeof b !== 'object' || Array.isArray(b)) fail('请求格式错误');
      if (route === '/api/register') {
        const username = String(b.username || '').trim(), name = String(b.name || '').trim();
        if (!/^[A-Za-z0-9_-]{3,40}$/.test(username) || ['teacher', 'constructor', 'prototype', '__proto__'].includes(username) || /^t_[a-f0-9]{32}$/.test(username)) fail('账号须为3—40位字母、数字、下划线或连字符，不能使用保留账号');
        if (!name || name.length > 30 || !['student', 'teacher'].includes(b.role)) fail('请填写姓名并选择身份');
        if (typeof b.password !== 'string' || b.password.length < 8 || b.password.length > 128 || b.password !== b.confirmPassword) fail('密码至少8位，且两次输入一致');
        if (db.prepare('SELECT id FROM accounts WHERE username=?').get(username)) fail('该统一账号已注册，请直接登录', 409);
        const invitation = typeof b.invitation === 'string' ? digest(b.invitation.trim()) : '';
        if (b.role === 'teacher' && !db.prepare('SELECT hash FROM invitations WHERE hash=? AND expires>? AND used_by IS NULL').get(invitation, Date.now())) fail('教师邀请码无效、已使用或已过期', 403);
        // Revoke the old browser identity before creating a new account. This
        // keeps local SQLite and remote journal failure behaviour consistent.
        if (u) await revokeCourses(u.session_id);
        const id = crypto.randomUUID();
        db.exec('SAVEPOINT register_account');
        try {
          db.prepare('INSERT INTO accounts VALUES(?,?,?,?,?,?)').run(id, username, name, b.role, hash(b.password), crypto.randomBytes(32).toString('hex'));
          if (b.role === 'teacher') db.prepare('UPDATE invitations SET used_by=? WHERE hash=?').run(id, invitation);
          db.exec('RELEASE register_account');
        } catch (e) { db.exec('ROLLBACK TO register_account; RELEASE register_account'); throw e; }
        return login(req, res, db.prepare('SELECT * FROM accounts WHERE id=?').get(id));
      }
      if (route === '/api/login') {
        const account = db.prepare('SELECT * FROM accounts WHERE username=?').get(String(b.username || '').trim());
        if (typeof b.password !== 'string' || b.password.length > 128 || !check(b.password, account?.password || hash('unavailable')) || !account) fail('账号或密码错误', 401);
        return login(req, res, account);
      }
      if (route === '/api/invitations') {
        let creator;
        if (u?.role === 'teacher') creator = u.id;
        else if (!u && typeof b.legacyPassword === 'string') {
          await bridge('catering', { action: 'verify', id: 'teacher', role: 'teacher', password: b.legacyPassword }); creator = 'legacy:teacher';
        } else fail('仅教师可生成邀请码', 403);
        const invitation = crypto.randomBytes(24).toString('base64url'), expires = Date.now() + 7 * 86400000;
        db.prepare('INSERT INTO invitations VALUES(?,?,?,NULL)').run(digest(invitation), creator, expires);
        return reply(res, 200, { invitation, expires });
      }
      if (!u) fail('请先登录统一账号', 401);
      if (route === '/api/logout') {
        await revokeCourses(u.session_id); db.prepare('DELETE FROM sessions WHERE token=?').run(u.session_id);
        return reply(res, 200, { ok: true }, ['teaching_account=; Path=/accounts/; Max-Age=0; HttpOnly; SameSite=Strict', ...clearCourses]);
      }
      if (!Object.hasOwn(ports, b.course)) fail('请选择有效课程');
      if (route === '/api/bind') {
        if (u.role !== 'student') fail('教师使用独立教学身份，无需绑定共享教师账号', 403);
        if (bindings(u.id).some(r => r.course === b.course)) fail('此课程已绑定，不能覆盖已有绑定', 409);
        if (!['existing', 'enroll'].includes(b.mode)) fail('请选择绑定原账号或加入课程');
        const id = b.mode === 'existing' ? String(b.localId || '').trim() : u.username;
        if (db.prepare('SELECT 1 FROM bindings WHERE course=? AND local_id=?').get(b.course, id)) fail('此课程账号已绑定其他统一账号', 409);
        const local = await bridge(b.course, b.mode === 'existing' ? { action: 'verify', id, role: 'student', password: b.password } :
          { action: 'enroll', id, name: u.name, role: 'student', provision: u.provision, classCode: b.classCode, classId: b.classId });
        db.prepare('INSERT INTO bindings VALUES(?,?,?,?)').run(u.id, b.course, local.id, local.name);
        return reply(res, 200, { bindings: bindings(u.id) });
      }
      if (route === '/api/enter') {
        let binding = bindings(u.id).find(r => r.course === b.course);
        if (!binding && u.role === 'teacher') {
          const local = await bridge(b.course, { action: 'enroll', id: 't_' + u.id.replaceAll('-', ''), role: 'teacher', name: u.name, provision: u.provision });
          db.prepare('INSERT INTO bindings VALUES(?,?,?,?)').run(u.id, b.course, local.id, local.name); binding = { localId: local.id };
        }
        if (!binding) fail('请先绑定原账号或加入课程', 409);
        const previous = db.prepare('SELECT token FROM course_sessions WHERE session_id=? AND course=?').get(u.session_id, b.course);
        if (previous) await bridge(b.course, { action: 'revoke', token: previous.token });
        const result = await bridge(b.course, { action: 'session', id: binding.localId, role: u.role });
        db.prepare('INSERT OR REPLACE INTO course_sessions VALUES(?,?,?)').run(u.session_id, b.course, result.token);
        return reply(res, 200, { url: '/' + b.course + '/' + u.role }, [result.cookie]);
      }
      fail('接口不存在', 404);
    } catch (e) { reply(res, e.status || 400, { error: e.status ? e.message : '操作未完成，请重试或联系管理员' }); }
  });
  // SQLite requests also serialize across async bridge calls. Remote storage.wrap
  // already serializes and confirms OSS before releasing the response.
  let queue = Promise.resolve();
  const server = http.createServer(storage.remote ? handler : (req, res) => { queue = queue.then(() => handler(req, res)).catch(() => { if (!res.writableEnded) reply(res, 500, { error: '账号服务暂不可用' }); }); });
  await storage.ready();
  server.listen(Number(process.env.PORT || 9104), process.env.HOST || '127.0.0.1', () => console.log('Unified account service ready'));
  function stop() { server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(0), 3000).unref(); }
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
})().catch(e => { console.error('Account startup failed:', e.message); process.exit(1); });
