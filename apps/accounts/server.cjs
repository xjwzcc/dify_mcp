'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { openDatabase } = require('../../storage/database.cjs');
const { clientAddress } = require('../../storage/client-address.cjs');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const hash = password => { const salt = crypto.randomBytes(16).toString('hex'); return salt + ':' + crypto.scryptSync(password, salt, 32).toString('hex'); };
const check = (password, stored) => { try { const [salt, value] = stored.split(':'); return crypto.timingSafeEqual(crypto.scryptSync(password, salt, 32), Buffer.from(value, 'hex')); } catch { return false; } };
const fail = (message, status = 400) => { throw Object.assign(Error(message), { status }); };
const secure = process.env.SECURE_COOKIE === '1' ? '; Secure' : '';
const cookie = (token, role) => `teaching_${role}=${token}; HttpOnly; SameSite=Strict; Path=/${role}/; Max-Age=28800${secure}`;
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
  const isAdmin = u => u?.role === 'teacher' && u.username === 'teacher_admin' && approved(u.id);
  const publicAccount = u => ({ username: u.username, name: u.name, role: u.role, canManageTeachers: isAdmin(u) });
  const bindings = id => db.prepare('SELECT course,local_id AS localId,name FROM bindings WHERE account_id=?').all(id);
  const reply = (res, status, value, cookies) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(cookies ? { 'Set-Cookie': cookies } : {}) }); res.end(JSON.stringify(value)); };
  // Approval records use the retired invitation ledger, avoiding an offline OSS schema migration.
  const approved = id => Boolean(db.prepare("SELECT 1 FROM invitations WHERE hash=? AND creator='console-admin' AND used_by=?").get('teacher-approved:' + id, id));
  function auth(req) {
    const raw = String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(`teaching_${req.entryRole}=`))?.slice(`teaching_${req.entryRole}=`.length);
    const account = raw ? db.prepare('SELECT a.*,s.token AS session_id FROM accounts a JOIN sessions s ON s.id=a.id WHERE s.token=? AND s.expires>?').get(digest(raw), Date.now()) : null;
    return account && account.role === req.entryRole && (account.role === 'student' || approved(account.id)) ? account : null;
  }
  async function revokeCourses(sessionId) {
    for (const s of db.prepare('SELECT * FROM course_sessions WHERE session_id=?').all(sessionId)) await bridge(s.course, { action: 'revoke', token: s.token });
    db.prepare('DELETE FROM course_sessions WHERE session_id=?').run(sessionId);
  }
  const teacherList = () => ({ teachers: db.prepare("SELECT id,username,name,role FROM accounts WHERE role='teacher' ORDER BY username").all()
    .map(a => ({ ...publicAccount(a), approved: approved(a.id) })) });
  async function manageTeacher(b, web = false) {
    if (b.action === 'list') return teacherList();
    const username = String(b.username || '').trim();
    let account = db.prepare('SELECT * FROM accounts WHERE username=?').get(username);
    // The single administrator cannot be created, disabled or reset through this API.
    if (web && username.toLowerCase() === 'teacher_admin') fail('管理员账号受保护，不能在教师管理中修改', 403);
    if (web && (b.role !== undefined || b.canManageTeachers !== undefined)) fail('教师管理不能授予管理员权限', 403);
    let password;
    if (b.action === 'create') {
      const name = String(b.name || '').trim();
      if (!/^[A-Za-z0-9_-]{3,40}$/.test(username) || ['teacher','constructor','prototype','__proto__'].includes(username) || /^t_[a-f0-9]{32}$/.test(username) || !name || name.length > 30) fail('教师账号或姓名格式无效');
      if (account) fail('账号已存在，不能覆盖或将学生升级为教师', 409);
      password = web ? crypto.randomBytes(18).toString('base64url') : b.password;
      if (typeof password !== 'string' || password.length < 8 || password.length > 128) fail('密码须为8—128位');
      const id = crypto.randomUUID();
      db.prepare('INSERT INTO accounts VALUES(?,?,?,?,?,?)').run(id, username, name, 'teacher', hash(password), crypto.randomBytes(32).toString('hex'));
      account = db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
    } else if (!['approve','enable','disable','update','reset-password'].includes(b.action)) fail('未知管理操作');
    if (!account || account.role !== 'teacher') fail('只能管理已有教师账号，不能提升学生权限', 403);
    if (['disable','reset-password'].includes(b.action)) {
      // Revoke every browser and both course sessions before reporting success.
      // If a course is unavailable, leave the operation unsuccessful and retryable.
      // Course sessions can outlive an expired/deleted account session (hotel: 30 days).
      // Revoke by the teacher's bound course identity, including these orphaned sessions.
      for (const b of bindings(account.id)) await bridge(b.course, { action: 'revoke-teacher', id: b.localId });
      for (const s of db.prepare('SELECT token FROM sessions WHERE id=?').all(account.id)) db.prepare('DELETE FROM course_sessions WHERE session_id=?').run(s.token);
      db.prepare('DELETE FROM sessions WHERE id=?').run(account.id);
    }
    if (b.action === 'disable') db.prepare('DELETE FROM invitations WHERE hash=?').run('teacher-approved:' + account.id);
    if (['create','approve','enable'].includes(b.action)) db.prepare('INSERT OR REPLACE INTO invitations VALUES(?,?,?,?)').run('teacher-approved:' + account.id, 'console-admin', 0, account.id);
    if (b.action === 'update') {
      const name = String(b.name || '').trim();
      if (!name || name.length > 30) fail('姓名须为1—30个字符');
      db.prepare('UPDATE accounts SET name=? WHERE id=?').run(name, account.id); account.name = name;
    }
    if (b.action === 'reset-password') {
      password = crypto.randomBytes(18).toString('base64url');
      db.prepare('UPDATE accounts SET password=? WHERE id=?').run(hash(password), account.id);
    }
    return { user: publicAccount(account), approved: approved(account.id), ...(web && password ? { password } : {}) };
  }
  async function login(req, res, account) {
    const current = auth(req);
    if (current) { await revokeCourses(current.session_id); db.prepare('DELETE FROM sessions WHERE token=?').run(current.session_id); }
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token), account.id, Date.now() + 8 * 3600000);
    reply(res, 200, { user: publicAccount(account), bindings: bindings(account.id) }, [cookie(token, account.role), ...clearCourses]);
  }
  // Bound global and per-address limits also apply to registration/password verification.
  const rates = new Map();
  const handler = storage.wrap(async (req, res) => {
    try {
      res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'same-origin');
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const match = /^\/(student|teacher)(?=\/|$)/.exec(pathname);
      req.entryRole = match?.[1];
      const route = match ? pathname.slice(match[0].length) || '/' : pathname;
      if (req.consoleAdmin && pathname === '/api/admin/teachers') {
        if (req.method !== 'POST') fail('请求方法无效', 405);
        let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 8192) fail('请求过大', 413); }
        const b = JSON.parse(raw || '{}');
        return reply(res, 200, await manageTeacher(b));
      }
      if (pathname === '/api/health' && req.method === 'GET') return reply(res, 200, { ok: true });
      if (pathname === '/accounts/entry.js' && ['GET','HEAD'].includes(req.method)) {
        res.writeHead(200, {'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store'});
        return res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(path.join(__dirname,'public/entry.js')));
      }
      if (!match) fail('旧统一入口已停用，请使用学生端或教师端独立地址', 410);
      if (!route.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(req.method)) fail('请求方法无效', 405);
        const file = { '/': req.entryRole + '/index.html', '/app.js': req.entryRole + '/app.js', '/style.css': 'style.css',
          ...(req.entryRole === 'teacher' ? { '/admin/': 'teacher/admin/index.html', '/admin/app.js': 'teacher/admin/app.js', '/admin/style.css': 'teacher/admin/style.css' } : {}) }[route];
        if (!file) fail('页面不存在', 404);
        res.writeHead(200, { 'Content-Type': (file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html') + '; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(path.join(__dirname, 'public', file)));
      }
      if (route === '/api/health' && req.method === 'GET') return reply(res, 200, { ok: true });
      if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)) fail('拒绝跨站请求', 403);
      const u = auth(req);
      if (route === '/api/admin/teachers') {
        if (!u) fail('请先登录教师管理员账号', 401);
        if (req.entryRole !== 'teacher' || !isAdmin(u)) fail('仅 teacher_admin 可以管理教师账号', 403);
        if (req.method === 'GET') return reply(res, 200, teacherList());
      }
      if (route === '/api/session' && req.method === 'GET') {
        if (!u) fail('请先登录统一账号', 401);
        return reply(res, 200, { user: publicAccount(u), bindings: bindings(u.id) });
      }
      if (req.method !== 'POST') fail('请求方法无效', 405);
      const ip = clientAddress(req);
      // Classroom clients often share a NAT address. Course entry must not
      // consume the separate password-attempt budget for later logins.
      for (const key of ['global', (u ? 'authenticated:' : 'anonymous:') + ip]) {
        const rate = rates.get(key) || { at: 0, n: 0 };
        if (Date.now() - rate.at > 60000) { rate.at = Date.now(); rate.n = 0; }
        if (++rate.n > (key === 'global' || u ? 200 : 40)) fail('尝试过于频繁，请稍后重试', 429);
        rates.set(key, rate);
      }
      if (rates.size > 1000) for (const [key, r] of rates) if (Date.now() - r.at > 60000) rates.delete(key);
      let raw = ''; req.setEncoding('utf8'); for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 8192) fail('请求过大', 413); }
      let b; try { b = JSON.parse(raw || '{}'); } catch { fail('请求格式错误'); }
      if (!b || typeof b !== 'object' || Array.isArray(b)) fail('请求格式错误');
      if (route === '/api/admin/teachers') return reply(res, 200, await manageTeacher(b, true));
      if (route === '/api/register') {
        if (req.entryRole !== 'student' || (b.role !== undefined && b.role !== 'student')) fail('教师账号由管理员创建，禁止公开注册或修改身份', 403);
        const username = String(b.username || '').trim(), name = String(b.name || '').trim();
        if (!/^[A-Za-z0-9_-]{3,40}$/.test(username) || ['teacher', 'teacher_admin', 'constructor', 'prototype', '__proto__'].includes(username.toLowerCase()) || /^t_[a-f0-9]{32}$/.test(username)) fail('账号须为3—40位字母、数字、下划线或连字符，不能使用保留账号');
        if (!name || name.length > 30 || (b.role !== undefined && b.role !== 'student')) fail('请填写姓名并选择身份');
        if (typeof b.password !== 'string' || b.password.length < 8 || b.password.length > 128 || b.password !== b.confirmPassword) fail('密码至少8位，且两次输入一致');
        if (db.prepare('SELECT id FROM accounts WHERE username=?').get(username)) fail('该统一账号已注册，请直接登录', 409);
        // Revoke the old browser identity before creating a new account. This
        // keeps local SQLite and remote journal failure behaviour consistent.
        if (u) await revokeCourses(u.session_id);
        const id = crypto.randomUUID();
        db.exec('SAVEPOINT register_account');
        try {
          db.prepare('INSERT INTO accounts VALUES(?,?,?,?,?,?)').run(id, username, name, 'student', hash(b.password), crypto.randomBytes(32).toString('hex'));
          db.exec('RELEASE register_account');
        } catch (e) { db.exec('ROLLBACK TO register_account; RELEASE register_account'); throw e; }
        return login(req, res, db.prepare('SELECT * FROM accounts WHERE id=?').get(id));
      }
      if (route === '/api/login') {
        const account = db.prepare('SELECT * FROM accounts WHERE username=?').get(String(b.username || '').trim());
        if (typeof b.password !== 'string' || b.password.length > 128 || !check(b.password, account?.password || hash('unavailable')) || !account) fail('账号或密码错误', 401);
        if (account.role !== req.entryRole || (b.role !== undefined && b.role !== req.entryRole)) fail('账号身份与当前入口不符，请使用对应地址登录', 403);
        if (account.role === 'teacher' && !approved(account.id)) fail('教师账号尚未经管理员确认，请联系管理员', 403);
        return login(req, res, account);
      }
      if (route === '/api/invitations') {
        fail('邀请码已停用，教师账号由管理员创建', 410);
      }
      if (!u) fail('请先登录统一账号', 401);
      if (route === '/api/logout') {
        await revokeCourses(u.session_id); db.prepare('DELETE FROM sessions WHERE token=?').run(u.session_id);
        return reply(res, 200, { ok: true }, [`teaching_${req.entryRole}=; Path=/${req.entryRole}/; Max-Age=0; HttpOnly; SameSite=Strict${secure}`, ...clearCourses]);
      }
      if (!Object.hasOwn(ports, b.course)) fail('请选择有效课程');
      if (route === '/api/bind') {
        if (u.role !== 'student') fail('教师使用独立教学身份，无需绑定共享教师账号', 403);
        if (bindings(u.id).some(r => r.course === b.course)) fail('此课程已绑定，不能覆盖已有绑定', 409);
        if (!['existing', 'enroll'].includes(b.mode)) fail('请选择绑定原账号或加入课程');
        const id = b.mode === 'existing' ? String(b.localId || '').trim() : u.username;
        if (db.prepare('SELECT 1 FROM bindings WHERE course=? AND local_id=?').get(b.course, id)) fail('此课程账号已绑定其他统一账号', 409);
        const local = await bridge(b.course, b.mode === 'existing' ? { action: 'verify', id, role: 'student', password: b.password } :
          { action: 'enroll', id, name: u.name, role: 'student', provision: u.provision, classId: b.classId });
        db.prepare('INSERT INTO bindings VALUES(?,?,?,?)').run(u.id, b.course, local.id, local.name);
        return reply(res, 200, { bindings: bindings(u.id) });
      }
      if (route === '/api/enter') {
        let binding = bindings(u.id).find(r => r.course === b.course);
        if (!binding) {
          const id = u.role === 'teacher' ? 't_' + u.id.replaceAll('-', '') : u.username;
          if (db.prepare('SELECT 1 FROM bindings WHERE course=? AND local_id=?').get(b.course, id)) fail('此课程账号已关联其他账号，请使用原注册账号登录', 409);
          const local = await bridge(b.course, { action: 'enroll', id, role: u.role, name: u.name, provision: u.provision, classId: b.classId });
          db.prepare('INSERT INTO bindings VALUES(?,?,?,?)').run(u.id, b.course, local.id, local.name); binding = { localId: local.id };
        }
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
  const dispatch = storage.remote ? handler : (req, res) => { queue = queue.then(() => handler(req, res)).catch(() => { if (!res.writableEnded) reply(res, 500, { error: '账号服务暂不可用' }); }); };
  const server = http.createServer(dispatch);
  // Only OS users with access to this private Unix socket may manage teachers.
  const socketPath = process.env.ACCOUNTS_ADMIN_SOCKET || '/tmp/shixunlab-accounts-admin.sock';
  const adminServer = http.createServer((req, res) => { req.consoleAdmin = true; return dispatch(req, res); });
  await storage.ready();
  if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
  await new Promise((resolve, reject) => { adminServer.once('error', reject); adminServer.listen(socketPath, () => { fs.chmodSync(socketPath, 0o600); resolve(); }); });
  server.listen(Number(process.env.PORT || 9104), process.env.HOST || '127.0.0.1', () => console.log('Unified account service ready'));
  function stop() { adminServer.close(); server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(0), 3000).unref(); }
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
})().catch(e => { console.error('Account startup failed:', e.message); process.exit(1); });
