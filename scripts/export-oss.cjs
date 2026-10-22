'use strict';
const { exportRemote } = require('./export-feishu.cjs');
async function exportOss(destination, env = process.env) {
  if (env.STORAGE_BACKEND !== 'oss') throw Error('Export requires STORAGE_BACKEND=oss');
  return exportRemote(destination, env);
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--stopped-writer') {
    console.error('Stop every writer first. Usage: node --env-file=.env scripts/export-oss.cjs --stopped-writer <new-directory>');
    process.exitCode = 1;
  } else exportOss(args[1]).then(target => console.log('Export complete: ' + target))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { exportOss };
