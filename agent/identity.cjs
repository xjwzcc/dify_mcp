'use strict';
const crypto = require('node:crypto');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = (status, code, message) => { throw Object.assign(Error(message), { status, code }); };
function equal(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function sign(claims, key) {
  if (typeof key !== 'string' || key.length < 32) fail(503, 'AGENT_NOT_CONFIGURED', '教学助手尚未配置');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return payload + '.' + crypto.createHmac('sha256', key).update(payload).digest('base64url');
}
function verify(value, key, { audience, method, path, body = Buffer.alloc(0), now = Date.now() / 1000 }) {
  const invalid = () => fail(403, 'INVALID_SIGNATURE', '服务身份校验失败');
  if (!key || key.length < 32 || typeof value !== 'string' || value.length > 8192) invalid();
  const parts = value.split('.');
  if (parts.length !== 2 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) invalid();
  const expected = crypto.createHmac('sha256', key).update(parts[0]).digest('base64url');
  if (!equal(parts[1], expected)) invalid();
  let claims; try { claims = JSON.parse(Buffer.from(parts[0], 'base64url')); } catch { invalid(); }
  if (!claims || claims.v !== 1 || claims.aud !== audience || claims.method !== method || claims.path !== path ||
      claims.body_sha256 !== sha256(body) || !Number.isFinite(claims.iat) || !Number.isFinite(claims.exp) ||
      claims.exp <= now || claims.iat > now + 5 || claims.exp - claims.iat > 60 || claims.exp <= claims.iat) invalid();
  return claims;
}
function assertion(identity, method, path, body, env = process.env) {
  const now = Math.floor(Date.now() / 1000);
  return sign({ v: 1, kid: 'teaching-to-agent-v1', iss: 'teaching-platform', aud: 'teacher-agent',
    deployment_id: env.TEACHING_DEPLOYMENT_ID || 'teaching', sub: identity.teacher_id, course: identity.course,
    role: 'teacher', login_ref: identity.login_ref, login_expires_at: identity.login_expires_at,
    iat: now, exp: now + 60, method, path, body_sha256: sha256(body) }, env.AGENT_SIGNING_KEY);
}
function selectedCookie(headers, course) {
  const name = course === 'hotel' ? 'hotel_session' : 'emenu_source_session';
  return String(headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(name + '=')) || '';
}
module.exports = { sha256, equal, sign, verify, assertion, selectedCookie, fail };
