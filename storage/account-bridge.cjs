'use strict';
const crypto = require('node:crypto');
// Only the sibling account service receives this per-boot secret. The gateway
// never exposes this route, including when called through the development proxy.
module.exports = function accountBridge(adapter) {
  const { get, check, create, session, revoke, enrollment } = adapter;
  return (req, b) => {
    const expected = process.env.ACCOUNT_BRIDGE_SECRET || '';
    const supplied = String(req.headers['x-account-bridge'] || '');
    if (!expected || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) ||
        supplied.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)))
      throw Object.assign(Error('接口不存在'), { status: 404 });
    const fail = (message, status = 400) => { throw Object.assign(Error(message), { status }); };
    if (b.action === 'revoke') { revoke(String(b.token || '')); return { ok: true }; }
    const id = String(b.id || '');
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) fail('账号格式无效');
    let user = get(id);
    if (b.action === 'verify') {
      if (typeof b.password !== 'string' || b.password.length > 128 || !user || user.role !== b.role || !check(b.password, user))
        fail('原账号或密码不正确', 401);
      return { id: user.id, name: user.name, role: user.role };
    }
    if (b.action === 'enroll') {
      if (!['student', 'teacher'].includes(b.role) || typeof b.name !== 'string' || !b.name.trim() || b.name.length > 30 || !/^[a-f0-9]{64}$/.test(b.provision || '')) fail('注册资料无效');
      // The stable random provisioning password makes a retry safe even if the
      // course committed but the account service lost its response.
      if (user) {
        if (user.role !== b.role || !check(b.provision, user)) fail('该学号已有档案，请选择绑定原账号', 409);
      } else {
        if (b.role === 'student') enrollment(b);
        else if (!/^t_[a-f0-9]{32}$/.test(id)) fail('教师账号格式无效');
        create(b); user = get(id);
      }
      return { id: user.id, name: user.name, role: user.role };
    }
    if (b.action === 'session') {
      if (!user || user.role !== b.role) fail('课程身份已失效', 409);
      return session(user);
    }
    fail('未知账号操作');
  };
};
