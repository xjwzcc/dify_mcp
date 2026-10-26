'use strict';
// Rebuild pinned browser assets after `npm ci --ignore-scripts`.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const destination = path.join(root, 'shared/teacher-chat/vendor');
fs.mkdirSync(destination, {recursive: true});
const manifest = [];
for (const [name, source, output, license] of [
  ['marked', 'lib/marked.esm.js', 'marked.js', 'LICENSE'],
  ['dompurify', 'dist/purify.es.mjs', 'purify.js', 'LICENSE']
]) {
  const base = path.join(root, 'node_modules', name);
  const pkg = JSON.parse(fs.readFileSync(path.join(base, 'package.json')));
  const data = fs.readFileSync(path.join(base, source));
  fs.writeFileSync(path.join(destination, output), data);
  fs.copyFileSync(path.join(base, license), path.join(destination, name + '-LICENSE.txt'));
  manifest.push({name, version: pkg.version, source, output, sha256: crypto.createHash('sha256').update(data).digest('hex')});
}
fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(manifest.map(item => item.name + '@' + item.version).join(', '));
