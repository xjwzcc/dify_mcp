'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { backup } = require('node:sqlite');
const { openDatabase } = require('../storage/database.cjs');

async function exportRemote(destination, env = process.env) {
  if (!['feishu', 'oss'].includes(env.STORAGE_BACKEND)) throw Error('Export requires STORAGE_BACKEND=feishu or oss');
  for (const key of ['TEACHER_PASSWORD', 'CATERING_CLASS_CODE', 'HOTEL_CLASS_CODE'])
    if (!env[key]) throw Error('Missing configuration: ' + key);
  const target = path.resolve(destination);
  // Exclusive creation prevents accidentally replacing existing classroom data.
  fs.mkdirSync(target, { mode: 0o700 });
  const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
  try {
    for (const [namespace, filename, code] of [
      ['catering', 'emenu.sqlite', env.CATERING_CLASS_CODE],
      ['hotel', 'hotel.sqlite', env.HOTEL_CLASS_CODE]
    ]) {
      const dir = path.join(target, namespace);
      fs.mkdirSync(dir, { mode: 0o700 });
      const storage = await openDatabase(namespace, ':memory:', env);
      try {
        if (!storage.db.prepare("SELECT 1 FROM sqlite_master WHERE name='users'").get())
          throw Error('No initialized classroom found for ' + namespace);
        await backup(storage.db, path.join(dir, filename));
        fs.chmodSync(path.join(dir, filename), 0o600);
      } finally { storage.db.close(); }
      write(path.join(dir, namespace === 'catering' ? 'login.json' : 'config.json'),
        { teacherPassword: env.TEACHER_PASSWORD, classCode: code });
    }
    write(path.join(target, 'bootstrap.json'), {
      teacherPassword: env.TEACHER_PASSWORD, cateringCode: env.CATERING_CLASS_CODE, hotelCode: env.HOTEL_CLASS_CODE
    });
    fs.writeFileSync(path.join(target, 'EXPORT_COMPLETE'), 'Both databases exported. Keep this directory private.\n', { mode: 0o600, flag: 'wx' });
    return target;
  } catch (error) {
    // Keep partial results for inspection, but never label them as ready for deployment.
    throw Error('Export incomplete; do not deploy this directory: ' + error.message);
  }
}
async function exportFeishu(destination, env = process.env) {
  if (env.STORAGE_BACKEND !== 'feishu') throw Error('Export requires STORAGE_BACKEND=feishu');
  return exportRemote(destination, env);
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--stopped-writer') {
    console.error('Stop every writer first, then use: node --env-file=.env scripts/export-feishu.cjs --stopped-writer <new-directory>');
    process.exitCode = 1;
  } else exportFeishu(args[1]).then(target => console.log('Export complete: ' + target))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { exportFeishu, exportRemote };
