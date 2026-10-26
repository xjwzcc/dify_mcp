'use strict';
// Small REST client: the deployment ZIP deliberately has no npm runtime dependencies.
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const fs = require('node:fs');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => crypto.createHmac('sha256', key).update(value).digest();
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const encodePath = value => value.split('/').map(encode).join('/');
const xmlValue = (xml, tag) => {
  const value = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1];
  return value?.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[name]);
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function signV4({ method, bucket, key = '', query = {}, headers, region, accessKeyId, accessKeySecret, additional = [] }) {
  const canonicalQuery = Object.entries(query).map(([k, v]) => [encode(k), encode(v)]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => v === '' ? k : `${k}=${v}`).join('&');
  const extra = [...additional].sort().join(';');
  const canonicalHeaders = Object.keys(headers).filter(k => k.startsWith('x-oss-') || ['content-type', 'content-md5', ...additional].includes(k))
    .sort().map(k => `${k}:${String(headers[k]).trim()}\n`).join('');
  const canonical = [method, encodePath(`/${bucket}/${key}`), canonicalQuery, canonicalHeaders, extra, 'UNSIGNED-PAYLOAD'].join('\n');
  const date = headers['x-oss-date'].slice(0, 8), scope = `${date}/${region}/oss/aliyun_v4_request`;
  const signingKey = hmac(hmac(hmac(hmac('aliyun_v4' + accessKeySecret, date), region), 'oss'), 'aliyun_v4_request');
  const signature = hmac(signingKey, ['OSS4-HMAC-SHA256', headers['x-oss-date'], scope, sha256(canonical)].join('\n')).toString('hex');
  return { canonical, canonicalQuery, authorization: `OSS4-HMAC-SHA256 Credential=${accessKeyId}/${scope},${extra ? `AdditionalHeaders=${extra},` : ''}Signature=${signature}` };
}

class OssClient {
  constructor(env = process.env) {
    this.env = env;
    this.bucket = env.OSS_BUCKET;
    this.region = env.OSS_REGION;
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(this.bucket || '') || !/^[a-z]+-[a-z0-9-]+$/.test(this.region || ''))
      throw Error('OSS_BUCKET and OSS_REGION are required');
    const endpoint = env.OSS_ENDPOINT || `https://oss-${this.region}.aliyuncs.com`;
    const url = new URL(endpoint);
    const mock = env.NODE_ENV === 'test' && url.protocol === 'http:' && url.hostname === '127.0.0.1';
    if (!mock && (url.protocol !== 'https:' || url.port || ![`oss-${this.region}.aliyuncs.com`, `oss-${this.region}-internal.aliyuncs.com`].includes(url.hostname)))
      throw Error('OSS_ENDPOINT must be an official HTTPS endpoint matching OSS_REGION');
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('Invalid OSS_ENDPOINT');
    if (!mock && url.hostname.includes('-internal.') && env.FC_REGION && env.FC_REGION !== this.region)
      throw Error('Cross-region FC cannot use the OSS internal endpoint');
    this.base = mock ? url.origin : `https://${this.bucket}.${url.hostname}`;
    this.timeout = env.NODE_ENV === 'test' ? 1000 : 15000;
  }
  credentials() {
    // An externally refreshed file may be used for long-lived STS sessions. Never log its contents.
    if (this.env.OSS_CREDENTIALS_FILE) {
      const value = JSON.parse(fs.readFileSync(this.env.OSS_CREDENTIALS_FILE, 'utf8'));
      if (value.Expiration && Date.parse(value.Expiration) <= Date.now() + 30000) throw Error('OSS credentials expire soon; refresh credentials before retrying');
      if (!value.AccessKeyId || !value.AccessKeySecret) throw Error('Invalid OSS credential file');
      return { accessKeyId: value.AccessKeyId, accessKeySecret: value.AccessKeySecret, token: value.SecurityToken };
    }
    const accessKeyId = this.env.ALIBABA_CLOUD_ACCESS_KEY_ID, accessKeySecret = this.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET;
    if (!accessKeyId || !accessKeySecret) throw Error('Configure FC execution-role credentials or ALIBABA_CLOUD_ACCESS_KEY_ID/SECRET');
    return { accessKeyId, accessKeySecret, token: this.env.ALIBABA_CLOUD_SECURITY_TOKEN };
  }
  async request(method, key = '', { query = {}, body, headers = {}, missing = false, maxBytes = 140 * 1024 * 1024 } = {}) {
    // Retry only reads. An ambiguous PUT is reconciled by its immutable key and exact bytes.
    for (let attempt = 0; attempt < (method === 'GET' ? 3 : 1); attempt++) {
      const credentials = this.credentials();
      const signedHeaders = { ...headers, 'x-oss-date': new Date().toISOString().replace(/[-:]|\.\d{3}/g, ''), 'x-oss-content-sha256': 'UNSIGNED-PAYLOAD' };
      if (credentials.token) signedHeaders['x-oss-security-token'] = credentials.token;
      if (body !== undefined) {
        signedHeaders['content-type'] = 'application/octet-stream';
        signedHeaders['content-md5'] = crypto.createHash('md5').update(body).digest('base64');
      }
      const signed = signV4({ method, bucket: this.bucket, key, query, headers: signedHeaders, region: this.region, ...credentials });
      let response;
      try {
        response = await fetch(`${this.base}/${encodePath(key)}${signed.canonicalQuery ? '?' + signed.canonicalQuery : ''}`, {
          method, headers: { ...signedHeaders, Authorization: signed.authorization }, body,
          redirect: 'error', signal: AbortSignal.timeout(this.timeout)
        });
        const chunks = []; let length = 0;
        for await (const chunk of response.body) {
          length += chunk.length;
          if (length > maxBytes) throw Error('OSS response exceeds limit');
          chunks.push(chunk);
        }
        const bytes = Buffer.concat(chunks);
        if (response.ok) return bytes;
        const code = xmlValue(bytes.toString(), 'Code');
        if (missing && response.status === 404 && code === 'NoSuchKey') return null;
        if (method === 'GET' && (response.status === 429 || response.status >= 500) && attempt < 2) {
          await sleep(100 * 2 ** attempt); continue;
        }
        // Do not include OSS error bodies: they can contain signing material or object data.
        throw Object.assign(Error(`OSS ${method} failed (HTTP ${response.status})`), { status: response.status });
      } catch (error) {
        if (!response && method === 'GET' && attempt < 2) { await sleep(100 * 2 ** attempt); continue; }
        if (error.status) throw error;
        throw Error(`OSS ${method} transport failed or response invalid; outcome may be unknown`);
      }
    }
  }
  async checkBucket() {
    const version = (await this.request('GET', '', { query: { versioning: '' }, maxBytes: 65536 })).toString();
    // OSS ignores forbid-overwrite even when versioning is Suspended.
    if (!version.includes('VersioningConfiguration') || xmlValue(version, 'Status'))
      throw Error('OSS journal requires a bucket that has never enabled versioning');
    const acl = (await this.request('GET', '', { query: { acl: '' }, maxBytes: 65536 })).toString();
    if (xmlValue(acl, 'Grant') !== 'private') throw Error('OSS journal requires a private bucket');
  }
  async list(prefix) {
    const keys = []; let token = ''; const seen = new Set();
    do {
      const query = { 'list-type': '2', 'encoding-type': 'url', 'max-keys': '1000', prefix };
      if (token) query['continuation-token'] = token;
      const xml = (await this.request('GET', '', { query, maxBytes: 2 * 1024 * 1024 })).toString();
      if (!xml.includes('<ListBucketResult') || !['true', 'false'].includes(xmlValue(xml, 'IsTruncated')))
        throw Error('Invalid OSS listing');
      for (const match of xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)) keys.push(decodeURIComponent(xmlValue(match[0], 'Key')));
      if (keys.length > 1000000) throw Error('OSS journal listing limit exceeded; perform an offline migration');
      if (xmlValue(xml, 'IsTruncated') === 'false') break;
      token = xmlValue(xml, 'NextContinuationToken');
      if (!token || seen.has(token)) throw Error('Invalid OSS pagination');
      seen.add(token);
    } while (true);
    return keys;
  }
  async create(key, body) {
    try {
      await this.request('PUT', key, { body, headers: { 'x-oss-forbid-overwrite': 'true', 'x-oss-storage-class': 'Standard' } });
    } catch (error) {
      if (error.status === 409 || error.status === 412) throw Error('Another OSS writer already committed this sequence; restart and recover');
      // The response may have been lost after the server accepted the complete object.
      const actual = await this.request('GET', key, { missing: true });
      if (!actual?.equals(body)) throw Error('OSS commit could not be confirmed; restart and recover before accepting further requests');
    }
  }
}

class OssJournal {
  constructor(namespace, env = process.env) {
    if (!['catering', 'hotel', 'accounts', 'teacher-agent'].includes(namespace)) throw Error('Invalid OSS namespace');
    if (env.OSS_SINGLE_WRITER !== '1') throw Error('OSS requires OSS_SINGLE_WRITER=1 and one active deployment');
    if (!/^[a-fA-F0-9]{64}$/.test(env.OSS_STORAGE_KEY || '')) throw Error('OSS_STORAGE_KEY must be a persistent 32-byte hex encryption key');
    const prefix = env.OSS_PREFIX || 'teaching/v1';
    if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(prefix)) throw Error('Invalid OSS_PREFIX');
    this.client = new OssClient(env);
    this.namespace = namespace;
    this.prefix = `${prefix}/${namespace}/commits/`;
    this.key = Buffer.from(env.OSS_STORAGE_KEY, 'hex');
    this.head = { id: null, seq: 0 };
    this.checkpointEvery = 25;
    this.maxBytes = Number(env.OSS_MAX_STATE_BYTES || 128 * 1024 * 1024);
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1024 || this.maxBytes > 128 * 1024 * 1024) throw Error('Invalid OSS_MAX_STATE_BYTES');
  }
  objectKey(seq) { return this.prefix + String(seq).padStart(16, '0') + '.bin'; }
  encode(payload) {
    const raw = Buffer.from(JSON.stringify(payload));
    if (raw.length > this.maxBytes) throw Error('OSS state payload limit exceeded');
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(this.prefix));
    const encrypted = Buffer.concat([cipher.update(zlib.gzipSync(raw)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  }
  decode(bytes, seq) {
    if (bytes.length < 29 || bytes.length > this.maxBytes + 1024 * 1024) throw Error('Invalid OSS commit size');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(this.prefix)); decipher.setAuthTag(bytes.subarray(12, 28));
    const compressed = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
    const payload = JSON.parse(zlib.gunzipSync(compressed, { maxOutputLength: this.maxBytes }).toString());
    if (payload.version !== 1 || payload.namespace !== this.namespace || payload.seq !== seq ||
        !/^[0-9a-f-]{36}$/.test(payload.commit || '') || !['snapshot', 'changeset'].includes(payload.kind) ||
        (payload.kind === 'snapshot' ? !Array.isArray(payload.data) : typeof payload.data !== 'string')) throw Error('Invalid OSS commit');
    return payload;
  }
  async restore() {
    await this.client.checkBucket();
    const keys = (await this.client.list(this.prefix)).sort();
    if (!keys.length) {
      // A separate, additive account namespace has no legacy classroom data to import.
      if (['accounts', 'teacher-agent'].includes(this.namespace)) { await this.initialize([]); return this.restore(); }
      throw Error('OSS namespace is not initialized; use scripts/init-oss.cjs or migrate existing data');
    }
    // Preserve the entire immutable history. No lifecycle deletion on this prefix.
    keys.forEach((key, i) => { if (key !== this.objectKey(i + 1)) throw Error('OSS commit sequence has a gap or unexpected object'); });
    const commits = []; let child;
    for (let seq = keys.length; seq > 0 && commits.length <= this.checkpointEvery; seq--) {
      const payload = this.decode(await this.client.request('GET', this.objectKey(seq)), seq);
      if (child && child.parent !== payload.commit) throw Error('OSS recovery chain mismatch');
      commits.push(payload); child = payload;
      if (payload.kind === 'snapshot') break;
    }
    if (commits.at(-1)?.kind !== 'snapshot') throw Error('OSS recovery snapshot missing');
    this.head = { id: commits[0].commit, seq: commits[0].seq };
    return commits.reverse();
  }
  async initialize(tables = []) {
    await this.client.checkBucket();
    if ((await this.client.list(this.prefix)).length) throw Error('OSS namespace already contains data; use a new OSS_PREFIX');
    await this.append('snapshot', tables);
  }
  async append(kind, data) {
    // Recheck configuration before writes; versioning would disable atomic create-only semantics.
    await this.client.checkBucket();
    const seq = this.head.seq + 1, commit = crypto.randomUUID();
    const bytes = this.encode({ version: 1, namespace: this.namespace, seq, commit, parent: this.head.id, kind, data });
    await this.client.create(this.objectKey(seq), bytes);
    this.head = { id: commit, seq };
  }
}
module.exports = { OssClient, OssJournal, signV4, sha256 };
