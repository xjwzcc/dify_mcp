'use strict';
const { isIP } = require('node:net');
function clientAddress(req, env = process.env) {
  const peer = req.socket.remoteAddress || 'unknown';
  if (env.FC_INSTANCE_ID) return String(req.headers['x-fc-client-ip'] || peer);
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer);
  const forwarded = req.headers['x-real-ip'];
  if (env.TRUST_LOCAL_PROXY === '1' && loopback && typeof forwarded === 'string' && isIP(forwarded)) return forwarded;
  return peer;
}
module.exports = { clientAddress };
