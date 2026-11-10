'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { backup } = require('node:sqlite');
const { openDatabase } = require('../storage/database.cjs');
async function exportEcs(destination, env = process.env) {
  if (env.STORAGE_BACKEND !== 'oss') throw Error('Requires OSS source');
  for (const key of ['TEACHER_PASSWORD', 'CATERING_CLASS_CODE', 'HOTEL_CLASS_CODE'])
    if (!env[key]) throw Error('Missing ' + key);
  fs.mkdirSync(destination, { mode: 0o700 });
  const manifest = { createdAt: new Date().toISOString(), databases: {} };
  for (const [namespace, filename, requiredTable] of [
    ['catering', 'emenu.sqlite', 'users'], ['hotel', 'hotel.sqlite', 'users'], ['accounts', 'accounts.sqlite', 'accounts']
  ]) {
    const dir = path.join(destination, namespace);
    fs.mkdirSync(dir, { mode: 0o700 });
    const storage = await openDatabase(namespace, ':memory:', env);
    try {
      if (!storage.db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(requiredTable)) throw Error('Missing initialized ' + namespace);
      if (storage.db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw Error('Integrity failure: ' + namespace);
      const file = path.join(dir, filename);
      await backup(storage.db, file);
      fs.chmodSync(file, 0o600);
      const counts = {};
      for (const {name} of storage.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
        if (!/^[a-z_]+$/.test(name)) throw Error('Unexpected table');
        counts[name] = storage.db.prepare('SELECT count(*) AS n FROM "' + name + '"').get().n;
      }
      manifest.databases[namespace] = { filename: namespace + '/' + filename, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), counts };
    } finally { storage.db.close(); }
  }
  const write = (file, value) => fs.writeFileSync(path.join(destination, file), JSON.stringify(value, null, 2), {mode:0o600,flag:'wx'});
  write('bootstrap.json', {teacherPassword:env.TEACHER_PASSWORD,cateringCode:env.CATERING_CLASS_CODE,hotelCode:env.HOTEL_CLASS_CODE});
  write('catering/login.json', {teacherPassword:env.TEACHER_PASSWORD,classCode:env.CATERING_CLASS_CODE});
  write('hotel/config.json', {teacherPassword:env.TEACHER_PASSWORD,classCode:env.HOTEL_CLASS_CODE});
  write('migration-manifest.json', manifest);
  fs.writeFileSync(path.join(destination, 'EXPORT_COMPLETE'), 'Three databases exported and checked.\n', {mode:0o600,flag:'wx'});
  return manifest;
}
module.exports = { exportEcs };
if (require.main === module) {
  const [flag, destination, ...extra] = process.argv.slice(2);
  if (flag !== '--stopped-writer' || !destination || extra.length) throw Error('Stop all writers; use --stopped-writer NEW_DIRECTORY');
  exportEcs(destination).then(m => console.log(JSON.stringify(m))).catch(e => {console.error(e.message);process.exitCode=1;});
}
