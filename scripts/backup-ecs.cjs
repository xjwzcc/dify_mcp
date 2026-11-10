'use strict';
// Immutable, encrypted, bounded-memory backups. Never copy a live SQLite main file.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { DatabaseSync, backup } = require('node:sqlite');
const { OssClient, sha256 } = require('../storage/oss.cjs');
const PART_BYTES = 4 * 1024 * 1024;
const DATABASES = ['accounts/accounts.sqlite', 'catering/emenu.sqlite', 'hotel/hotel.sqlite'];
const CONFIGS = ['bootstrap.json', 'catering/login.json', 'hotel/config.json'];
const FILES = [...DATABASES, ...CONFIGS];
const PREFIX = 'teaching/v1/ecs-backups';

function regularFile(root, name) {
  const file = path.join(root, name);
  if (!fs.lstatSync(file).isFile() || fs.realpathSync(file) !== path.resolve(file)) throw Error('Expected regular file: ' + name);
  return file;
}
function inspectDatabase(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const result = db.prepare('PRAGMA integrity_check').all();
    if (result.length !== 1 || result[0].integrity_check !== 'ok') throw Error('SQLite integrity check failed');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    if (!tables.length) throw Error('Refusing an empty database');
    const counts = {};
    for (const { name } of tables) counts[name] = db.prepare('SELECT count(*) AS n FROM "' + name.replaceAll('"', '""') + '"').get().n;
    return { bytes: fs.statSync(file).size, pageSize: db.prepare('PRAGMA page_size').get().page_size,
      maxPageCount: db.prepare('PRAGMA max_page_count').get().max_page_count, counts };
  } finally { db.close(); }
}
function validateSource(root) {
  root = fs.realpathSync(root);
  regularFile(root, 'EXPORT_COMPLETE');
  for (const name of FILES) regularFile(root, name);
  for (const name of CONFIGS) JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
  return root;
}
function settings(env) {
  const prefix = env.OSS_BACKUP_PREFIX || PREFIX;
  if (!/^teaching\/v1\/ecs-backups(?:\/[A-Za-z0-9_-]+)*$/.test(prefix)) throw Error('Use the dedicated teaching/v1/ecs-backups prefix');
  if (!/^[a-fA-F0-9]{64}$/.test(env.OSS_STORAGE_KEY || '')) throw Error('Persistent OSS_STORAGE_KEY required');
  return { prefix, key: Buffer.from(env.OSS_STORAGE_KEY, 'hex') };
}
function seal(raw, key, objectKey) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(objectKey));
  const encrypted = Buffer.concat([cipher.update(zlib.gzipSync(raw)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}
function unseal(bytes, key, objectKey) {
  if (bytes.length < 29 || bytes.length > PART_BYTES + 65536) throw Error('Invalid backup part size');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(objectKey)); decipher.setAuthTag(bytes.subarray(12, 28));
  return zlib.gunzipSync(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]), { maxOutputLength: PART_BYTES });
}

// ECS role credentials refresh without storing an expiring STS token in app.env.
class BackupClient extends OssClient {
  constructor(env) { super({ ...env }); this.expiration = 0; }
  async request(...args) {
    if (this.env.OSS_ECS_ROLE && this.expiration < Date.now() + 300000) {
      if (!/^[A-Za-z0-9_-]+$/.test(this.env.OSS_ECS_ROLE)) throw Error('Invalid ECS role name');
      const base = 'http://100.100.100.200/latest/';
      const tokenResponse = await fetch(base + 'api/token', { method: 'PUT', redirect: 'error',
        headers: { 'X-aliyun-ecs-metadata-token-ttl-seconds': '60' }, signal: AbortSignal.timeout(3000) });
      if (!tokenResponse.ok) throw Error('ECS metadata token unavailable');
      const response = await fetch(base + 'meta-data/ram/security-credentials/' + this.env.OSS_ECS_ROLE,
        { headers: { 'X-aliyun-ecs-metadata-token': await tokenResponse.text() }, redirect: 'error', signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw Error('ECS role credentials unavailable');
      const value = await response.json();
      const expiration = Date.parse(value.Expiration);
      if (value.Code !== 'Success' || !value.AccessKeyId || !value.AccessKeySecret || !value.SecurityToken ||
          !Number.isFinite(expiration) || expiration < Date.now() + 300000) throw Error('Invalid ECS role credentials');
      Object.assign(this.env, { ALIBABA_CLOUD_ACCESS_KEY_ID: value.AccessKeyId, ALIBABA_CLOUD_ACCESS_KEY_SECRET: value.AccessKeySecret,
        ALIBABA_CLOUD_SECURITY_TOKEN: value.SecurityToken });
      delete this.env.OSS_CREDENTIALS_FILE;
      this.expiration = expiration;
    }
    return super.request(...args);
  }
}
async function putVerified(client, objectKey, bytes) {
  await client.create(objectKey, bytes);
  const actual = await client.request('GET', objectKey, { maxBytes: PART_BYTES + 65536 });
  if (!actual.equals(bytes)) throw Error('OSS backup read-back mismatch');
}
function writeStatus(work, status) {
  const temp = path.join(work, 'status-' + crypto.randomUUID() + '.tmp');
  fs.writeFileSync(temp, JSON.stringify(status, null, 2), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, path.join(work, 'last-success.json'));
}
async function backupEcs(env = process.env) {
  const { prefix, key } = settings(env), client = new BackupClient(env);
  if (!env.DATA_DIR || !env.OSS_BACKUP_WORK_DIR) throw Error('DATA_DIR and OSS_BACKUP_WORK_DIR required');
  const source = validateSource(env.DATA_DIR), work = path.resolve(env.OSS_BACKUP_WORK_DIR);
  if (work === source || work.startsWith(source + path.sep)) throw Error('Backup work directory must be outside live data');
  fs.mkdirSync(work, { recursive: true, mode: 0o700 });
  await client.checkBucket();
  const available = fs.statfsSync(work), freeBytes = available.bavail * available.bsize;
  const sourceBytes = FILES.reduce((n, name) => n + fs.statSync(path.join(source, name)).size, 0);
  if (freeBytes < sourceBytes * 2 + 256 * 1024 * 1024) throw Error('Insufficient backup disk space');
  const stage = fs.mkdtempSync(path.join(work, 'snapshot-'));
  const run = prefix + '/' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID();
  const manifestKey = run + '/manifest.bin';
  const manifest = { version: 1, createdAt: new Date().toISOString(), consistency: 'per-database-online-snapshot', files: [] };
  try {
    for (const name of FILES) {
      const target = path.join(stage, name);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      if (DATABASES.includes(name)) {
        const db = new DatabaseSync(path.join(source, name), { readOnly: true });
        try { await backup(db, target); } finally { db.close(); }
      } else fs.copyFileSync(path.join(source, name), target, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(target, 0o600);
      const entry = { name, bytes: fs.statSync(target).size, parts: [] };
      if (DATABASES.includes(name)) entry.database = inspectDatabase(target);
      else JSON.parse(fs.readFileSync(target, 'utf8'));
      const digest = crypto.createHash('sha256');
      const fd = fs.openSync(target, 'r');
      try {
        const buffer = Buffer.alloc(PART_BYTES); let count;
        while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
          const raw = buffer.subarray(0, count), objectKey = run + '/' + name + '/' + entry.parts.length + '.bin';
          digest.update(raw);
          await putVerified(client, objectKey, seal(raw, key, objectKey));
          entry.parts.push({ key: objectKey, bytes: count, sha256: sha256(raw) });
        }
      } finally { fs.closeSync(fd); }
      entry.sha256 = digest.digest('hex'); manifest.files.push(entry);
    }
    // A backup is discoverable as complete only after every part passed read-back.
    manifest.completedAt = new Date().toISOString();
    const raw = Buffer.from(JSON.stringify(manifest));
    if (raw.length > PART_BYTES) throw Error('Backup manifest exceeds limit');
    await putVerified(client, manifestKey, seal(raw, key, manifestKey));
    const result = { manifestKey, completedAt: manifest.completedAt, sourceBytes,
      databases: manifest.files.filter(f => f.database).map(f => ({ name: f.name, ...f.database })), freeBytes };
    writeStatus(work, result);
    return result;
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}
async function restoreEcs(manifestKey, destination, env = process.env) {
  const { prefix, key } = settings(env), client = new BackupClient(env);
  if (!manifestKey.startsWith(prefix + '/') || !manifestKey.endsWith('/manifest.bin') || manifestKey.includes('..')) throw Error('Invalid backup manifest key');
  if (fs.existsSync(destination)) throw Error('Restore requires a new directory; never overwrite live data');
  const manifest = JSON.parse(unseal(await client.request('GET', manifestKey, { maxBytes: PART_BYTES + 65536 }), key, manifestKey));
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length !== FILES.length ||
      new Set(manifest.files.map(f => f.name)).size !== FILES.length || manifest.files.some(f => !FILES.includes(f.name))) throw Error('Invalid backup file inventory');
  const run = manifestKey.slice(0, -'manifest.bin'.length);
  fs.mkdirSync(destination, { mode: 0o700 });
  try {
    for (const file of manifest.files) {
      if (!Number.isSafeInteger(file.bytes) || file.bytes <= 0 || !Array.isArray(file.parts) || !file.parts.length) throw Error('Invalid backup file');
      const target = path.join(destination, file.name);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const digest = crypto.createHash('sha256'), fd = fs.openSync(target, 'wx', 0o600); let bytes = 0;
      try {
        for (const [i, part] of file.parts.entries()) {
          if (part.key !== run + file.name + '/' + i + '.bin') throw Error('Invalid part path');
          const raw = unseal(await client.request('GET', part.key, { maxBytes: PART_BYTES + 65536 }), key, part.key);
          if (raw.length !== part.bytes || sha256(raw) !== part.sha256) throw Error('Backup part checksum mismatch');
          digest.update(raw); bytes += raw.length;
          let offset = 0;
          while (offset < raw.length) offset += fs.writeSync(fd, raw, offset, raw.length - offset);
        }
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      if (bytes !== file.bytes || digest.digest('hex') !== file.sha256) throw Error('Backup file checksum mismatch');
      if (DATABASES.includes(file.name)) {
        const inspected = inspectDatabase(target);
        if (JSON.stringify(inspected.counts) !== JSON.stringify(file.database?.counts)) throw Error('Restored database row counts differ');
      } else JSON.parse(fs.readFileSync(target, 'utf8'));
    }
    fs.writeFileSync(path.join(destination, 'restore-manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(path.join(destination, 'EXPORT_COMPLETE'), 'Verified OSS backup restored.\n', { mode: 0o600, flag: 'wx' });
    return { manifestKey, destination, verified: true };
  } catch (error) {
    // Keep failed output for diagnosis, but never mark it startable.
    throw error;
  }
}
module.exports = { backupEcs, restoreEcs, validateSource, inspectDatabase, seal, unseal, DATABASES, CONFIGS, PART_BYTES, BackupClient };
if (require.main === module) {
  process.umask(0o077);
  const [command, ...args] = process.argv.slice(2);
  const run = async () => {
    if (command === 'backup' && !args.length) return backupEcs();
    if (command === 'restore' && args.length === 2) return restoreEcs(args[0], args[1]);
    if (command === 'check-data' && args.length === 1) {
      const root = validateSource(args[0]);
      return { databases: DATABASES.map(name => ({ name, ...inspectDatabase(path.join(root, name)) })) };
    }
    throw Error('Usage: backup-ecs.cjs backup | restore MANIFEST_KEY NEW_DIRECTORY | check-data DATA_DIR');
  };
  run().then(result => console.log(JSON.stringify(result))).catch(error => { console.error('ECS_BACKUP_FAILED:', error.message); process.exitCode = 1; });
}
