'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { snapshot } = require('../storage/database.cjs');
const { OssJournal } = require('../storage/oss.cjs');

async function initOss({ source, empty = false }, env = process.env) {
  if (env.STORAGE_BACKEND !== 'oss' || Boolean(source) === empty) throw Error('Select STORAGE_BACKEND=oss and exactly one of --empty / --from-dir');
  for (const key of ['TEACHER_PASSWORD', 'CATERING_CLASS_CODE', 'HOTEL_CLASS_CODE'])
    if (!env[key] || env[key].length < 8) throw Error('Missing stable configuration: ' + key);
  if (source) {
    const config = JSON.parse(fs.readFileSync(path.join(source, 'bootstrap.json'), 'utf8'));
    if (config.teacherPassword !== env.TEACHER_PASSWORD || config.cateringCode !== env.CATERING_CLASS_CODE || config.hotelCode !== env.HOTEL_CLASS_CODE)
      throw Error('Initialization variables must match the source bootstrap.json');
  }
  const plans = [];
  // Validate BOTH source databases and BOTH destinations before making the first write.
  for (const [namespace, filename] of [['catering', 'emenu.sqlite'], ['hotel', 'hotel.sqlite']]) {
    let tables = [];
    if (source) {
      const db = new DatabaseSync(path.join(source, namespace, filename), { readOnly: true });
      try {
        if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw Error('Source database integrity check failed');
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").get() ||
            !db.prepare("SELECT id FROM users WHERE id='teacher'").get()) throw Error('Source classroom is not initialized');
        // The current serializer stores tables only. Refuse to silently lose custom schema objects.
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('view','trigger','index') AND sql IS NOT NULL").get())
          throw Error('Source has custom indexes/views/triggers; explicit migration required');
        tables = snapshot(db);
      } finally { db.close(); }
    }
    const journal = new OssJournal(namespace, env);
    await journal.client.checkBucket();
    const keys = await journal.client.list(journal.prefix);
    if (keys.length) {
      // Resume only an exact, never-started initialization after an interrupted two-app import.
      const commits = await journal.restore();
      if (keys.length !== 1 || commits[0].kind !== 'snapshot' || JSON.stringify(commits[0].data) !== JSON.stringify(tables))
        throw Error('Destination contains different or active data; use a new OSS_PREFIX');
    }
    plans.push({ journal, tables, exists: keys.length > 0 });
  }
  for (const { journal, tables, exists } of plans) if (!exists) await journal.initialize(tables);
  // Read back/decrypt both roots before reporting completion.
  for (const { journal, tables } of plans) {
    const commits = await journal.restore();
    if (commits.length !== 1 || JSON.stringify(commits[0].data) !== JSON.stringify(tables)) throw Error('OSS initialization verification failed');
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const valid = args[0] === '--stopped-writer' && ((args.length === 2 && args[1] === '--empty') || (args.length === 3 && args[1] === '--from-dir'));
  if (!valid) {
    console.error('Stop every writer first. Usage: node --env-file=.env scripts/init-oss.cjs --stopped-writer (--empty | --from-dir <directory>)');
    process.exitCode = 1;
  } else initOss({ empty: args[1] === '--empty', source: args[2] }).then(() => console.log('Both OSS namespaces initialized and verified.'))
    .catch(error => { console.error('OSS initialization incomplete: ' + error.message); process.exitCode = 1; });
}
module.exports = { initOss };
