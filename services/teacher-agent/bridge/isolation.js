import crypto from 'node:crypto';

export function scopeToken(secret, scope, sessionId = null, legacyHashes = '', configDigest = null) {
  const binding = configDigest ? `expserver-codex:v3:${scope}:${sessionId}:${configDigest}`
    : sessionId ? `expserver-codex:v2:${scope}:${sessionId}:${legacyHashes}` : `expserver-codex:${scope}`;
  return crypto.createHmac('sha256', secret).update(binding).digest('hex');
}

export function authenticateScope(headers, secret) {
  const scope = headers['x-exp-conversation-id'];
  const token = /^Bearer ([a-f0-9]{64})$/.exec(headers.authorization || '')?.[1];
  const sessionId = headers['x-exp-modelhub-session-id'];
  const hashes = headers['x-exp-legacy-reasoning'] || '';
  const configDigest = headers['x-exp-modelhub-config-digest'];
  if (!secret || typeof scope !== 'string' || !/^[a-f0-9]{32}$/.test(scope) || !token) {
    throw Object.assign(new Error('Invalid conversation credential'), {statusCode: 401});
  }
  if (configDigest !== undefined && (!sessionId || hashes || typeof configDigest !== 'string' || !/^[a-f0-9]{64}$/.test(configDigest))) {
    throw Object.assign(new Error('Invalid configuration binding'), {statusCode: 401});
  }
  if ((sessionId !== undefined && (typeof sessionId !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(sessionId))) ||
      typeof hashes !== 'string' || (hashes && (!sessionId || !/^[a-f0-9]{64}(,[a-f0-9]{64}){0,127}$/.test(hashes)))) {
    throw Object.assign(new Error('Invalid session binding'), {statusCode: 401});
  }
  if (!crypto.timingSafeEqual(Buffer.from(token), Buffer.from(scopeToken(secret, scope, sessionId, hashes, configDigest)))) {
    throw Object.assign(new Error('Invalid conversation credential'), {statusCode: 401});
  }
  return scope;
}

export function modelConfigDigest(env, model) {
  // Sort explicitly to match Python's canonical JSON serializer across runtimes.
  const value = {endpoint: (env.MODELHUB_BASE || 'https://api.deepseek.com').replace(/\/+$/, ''),
    model, product: env.MODELHUB_PRODUCT || '', provider_namespace: env.MODELHUB_PROVIDER_NAMESPACE || 'default',
    protocol: 'responses-v1'};
  return crypto.createHash('sha256').update(JSON.stringify(value, Object.keys(value).sort())).digest('hex');
}

export function responseKey(scope, id) {
  return JSON.stringify([scope, id]);
}

export function ownedResponse(store, scope, id, ttlMs) {
  const key = responseKey(scope, id);
  const entry = store.get(key);
  if (!entry || entry.conversationKey !== scope || Date.now() - entry.createdAt >= ttlMs) {
    if (entry) store.delete(key);
    throw Object.assign(new Error('Response unavailable in this conversation'), {statusCode: 404});
  }
  return entry;
}
