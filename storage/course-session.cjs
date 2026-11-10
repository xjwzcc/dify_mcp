'use strict';
const crypto = require('node:crypto');
const teacherPrefix = 't2_';
const enabled = () => process.env.UNIFIED_ACCOUNTS === '1';
module.exports = {
  create(role) { return (enabled() && role === 'teacher' ? teacherPrefix : '') + crypto.randomBytes(32).toString('hex'); },
  hotelKey(raw, unified = enabled()) { return (unified && raw.startsWith(teacherPrefix) ? teacherPrefix : '') + crypto.createHash('sha256').update(raw).digest('hex'); },
  allowed(user, storedToken, unified = enabled()) { return !unified || user?.role !== 'teacher' || String(storedToken).startsWith(teacherPrefix); },
  reference(storedToken) { return storedToken.startsWith(teacherPrefix) ? storedToken.slice(teacherPrefix.length) : storedToken; }
};
