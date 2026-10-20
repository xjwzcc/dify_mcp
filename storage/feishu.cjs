'use strict';
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const text = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(v => v.text || '').join('') : '';

class FeishuClient {
  constructor(env = process.env) {
    this.env = env;
    this.base = env.FEISHU_API_BASE || 'https://open.feishu.cn/open-apis';
    const url = new URL(this.base);
    if (this.base !== 'https://open.feishu.cn/open-apis' &&
        !(env.NODE_ENV === 'test' && url.protocol === 'http:' && url.hostname === '127.0.0.1')) {
      throw Error('Only the official Feishu API is allowed (loopback mock is test-only)');
    }
    for (const key of ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_APP_TOKEN'])
      if (!env[key]) throw Error('Missing configuration: ' + key);
    this.token = null;
    this.expires = 0;
    this.nextWrite = 0;
  }
  async authenticate() {
    if (this.token && Date.now() < this.expires) return;
    const response = await fetch(this.base + '/auth/v3/tenant_access_token/internal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.env.FEISHU_APP_ID, app_secret: this.env.FEISHU_APP_SECRET }),
      signal: AbortSignal.timeout(10000), redirect: 'error'
    });
    const body = await response.json();
    if (!response.ok || body.code !== 0 || !body.tenant_access_token) throw Error('Feishu authentication failed');
    this.token = body.tenant_access_token;
    this.expires = Date.now() + Math.max(1, Number(body.expire || 7200) - 120) * 1000;
  }
  async request(method, route, data, { retry = method === 'GET' } = {}) {
    for (let attempt = 0; attempt < 4; attempt++) {
      await this.authenticate();
      if (method !== 'GET') {
        await sleep(Math.max(0, this.nextWrite - Date.now()));
        this.nextWrite = Date.now() + (this.env.NODE_ENV === 'test' ? 0 : 250);
      }
      let response, body;
      try {
        response = await fetch(this.base + route, {
          method, headers: { Authorization: 'Bearer ' + this.token, 'Content-Type': 'application/json' },
          body: data ? JSON.stringify(data) : undefined, signal: AbortSignal.timeout(10000), redirect: 'error'
        });
        body = await response.json();
      } catch {
        if (retry && attempt < 3) { await sleep(250 * 2 ** attempt); continue; }
        throw Error('Feishu request outcome unknown');
      }
      if (response.ok && body.code === 0) return body.data;
      if ([99991663, 99991664, 99991668].includes(body.code) && attempt < 3) {
        this.token = null; continue;
      }
      // Explicit throttling/write-conflict responses did not commit; retry serially.
      if ((response.status === 429 || [1254290, 1254291].includes(body.code)) && attempt < 3) {
        const seconds = Number(response.headers.get('retry-after'));
        await sleep(Math.min(5000, seconds > 0 ? seconds * 1000 : 250 * 2 ** attempt)); continue;
      }
      if (retry && response.status >= 500 && attempt < 3) { await sleep(250 * 2 ** attempt); continue; }
      throw Error(`Feishu API failed (HTTP ${response.status}, code ${Number(body.code) || 'unknown'})`);
    }
    throw Error('Feishu request retries exhausted');
  }
  tablePath(tableId) {
    return `/bitable/v1/apps/${encodeURIComponent(this.env.FEISHU_APP_TOKEN)}/tables/${encodeURIComponent(tableId)}`;
  }
  async record(tableId, recordId) {
    const result = await this.request('GET', this.tablePath(tableId) + '/records/' + encodeURIComponent(recordId));
    if (!result?.record?.fields) throw Error('Feishu record missing');
    return result.record;
  }
  async create(tableId, fields) {
    const result = await this.request('POST', this.tablePath(tableId) + '/records', { fields });
    if (!result?.record?.record_id) throw Error('Feishu create outcome unknown');
    return result.record.record_id;
  }
}

// One dedicated table and pre-created head record per application.
// This is a single-writer pilot journal, NOT a distributed lock or a database CAS.
class FeishuJournal {
  constructor(namespace, env = process.env) {
    if (env.FEISHU_SINGLE_WRITER !== '1') throw Error('Feishu pilot requires FEISHU_SINGLE_WRITER=1 and one active deployment');
    if (!/^[a-fA-F0-9]{64}$/.test(env.FEISHU_STORAGE_KEY || '')) throw Error('FEISHU_STORAGE_KEY must be a persistent 32-byte hex encryption key');
    this.client = new FeishuClient(env);
    this.namespace = namespace;
    this.table = env[`FEISHU_${namespace.toUpperCase()}_TABLE_ID`];
    this.headId = env[`FEISHU_${namespace.toUpperCase()}_HEAD_ID`];
    if (!this.table || !this.headId) throw Error('Missing Feishu table/head IDs for ' + namespace);
    this.key = Buffer.from(env.FEISHU_STORAGE_KEY, 'hex');
    this.head = null;
    this.maxBytes = Number(env.FEISHU_MAX_STATE_BYTES || 128 * 1024 * 1024);
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1024 || this.maxBytes > 128 * 1024 * 1024)
      throw Error('FEISHU_MAX_STATE_BYTES must be between 1024 and 134217728');
    this.checkpointEvery = 25;
  }
  async readHead() {
    const record = await this.client.record(this.table, this.headId);
    if (text(record.fields.key) !== '@head:' + this.namespace) throw Error('Wrong Feishu head record');
    const head = JSON.parse(text(record.fields.payload));
    if (head.version !== 1 || head.namespace !== this.namespace || !Number.isSafeInteger(head.seq) ||
        head.seq < 0 || (head.seq === 0 ? head.id !== null : typeof head.id !== 'string')) throw Error('Invalid Feishu head');
    return head;
  }
  encode(value) {
    const raw = Buffer.from(JSON.stringify(value));
    if (raw.length > this.maxBytes) throw Error('Pilot storage payload limit exceeded');
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(this.namespace));
    const encrypted = Buffer.concat([cipher.update(zlib.gzipSync(raw)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }
  decode(value) {
    const bytes = Buffer.from(value, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(this.namespace));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const compressed = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
    return JSON.parse(zlib.gunzipSync(compressed, { maxOutputLength: this.maxBytes }).toString());
  }
  async restore() {
    this.head = await this.readHead();
    if (!this.head.id) return [];
    const commits = [], seen = new Set();
    let id = this.head.id, expected = this.head.seq;
    while (id) {
      if (seen.has(id) || commits.length > this.checkpointEvery) throw Error('Invalid or excessive recovery chain');
      seen.add(id);
      const record = await this.client.record(this.table, id);
      const manifest = JSON.parse(text(record.fields.payload));
      if (manifest.version !== 1 || manifest.namespace !== this.namespace || manifest.seq !== expected ||
          !Array.isArray(manifest.chunks) || !manifest.chunks.length || manifest.chunks.length > 10000) throw Error('Invalid storage manifest');
      let encoded = '';
      for (let i = 0; i < manifest.chunks.length; i++) {
        const chunk = await this.client.record(this.table, manifest.chunks[i]);
        if (text(chunk.fields.key) !== `${manifest.commit}:${i}`) throw Error('Storage chunk mismatch');
        encoded += text(chunk.fields.payload);
        if (encoded.length > this.maxBytes * 2) throw Error('Recovery payload limit exceeded');
      }
      if (digest(encoded) !== manifest.sha256) throw Error('Storage checksum mismatch');
      const payload = this.decode(encoded);
      if (payload.seq !== manifest.seq || payload.parent !== manifest.parent || payload.namespace !== this.namespace ||
          payload.commit !== manifest.commit || !['snapshot', 'changeset'].includes(payload.kind)) throw Error('Storage commit mismatch');
      commits.push(payload);
      if (payload.kind === 'snapshot') {
        if (payload.parent !== null) throw Error('Snapshot must be a recovery root');
        break;
      }
      id = payload.parent; expected--;
    }
    if (commits.at(-1)?.kind !== 'snapshot') throw Error('Recovery snapshot missing');
    return commits.reverse();
  }
  async append(kind, data) {
    const current = await this.readHead();
    if (JSON.stringify(current) !== JSON.stringify(this.head)) throw Error('Another writer changed the Feishu head; stop the other deployment');
    const commit = crypto.randomUUID(), seq = this.head.seq + 1;
    const payload = { version: 1, namespace: this.namespace, seq, commit,
      parent: kind === 'snapshot' ? null : this.head.id, kind, data };
    const encoded = this.encode(payload), chunks = [];
    // Small text fields avoid storing large images/entire states in a single cell.
    for (let i = 0; i < encoded.length; i += 24000) {
      chunks.push(await this.client.create(this.table, { key: `${commit}:${chunks.length}`, payload: encoded.slice(i, i + 24000) }));
    }
    const manifest = { version: 1, namespace: this.namespace, seq, commit, parent: payload.parent, chunks, sha256: digest(encoded) };
    const id = await this.client.create(this.table, { key: commit, payload: JSON.stringify(manifest) });
    const next = { version: 1, namespace: this.namespace, seq, id };
    // All immutable chunks are durable before publishing the single head pointer.
    // A timed-out PUT is reconciled by reading the same known head, never by inventing another commit.
    try {
      await this.client.request('PUT', this.client.tablePath(this.table) + '/records/' + encodeURIComponent(this.headId),
        { fields: { payload: JSON.stringify(next) } });
    } catch { /* verify below even when the response was lost */ }
    let verified = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      try { if (JSON.stringify(await this.readHead()) === JSON.stringify(next)) { verified = true; break; } } catch {}
      await sleep(250 * 2 ** attempt);
    }
    if (!verified) throw Error('Feishu commit could not be confirmed; restart and recover before accepting further requests');
    this.head = next;
  }
}
module.exports = { FeishuClient, FeishuJournal };
