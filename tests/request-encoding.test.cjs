'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function splitLogin(port, data, offset) {
  const bytes = Buffer.from(JSON.stringify(data));
  const cut = bytes.indexOf(Buffer.from('🧪')) + offset;
  assert(cut > 0);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/api/login', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, cookie: res.headers['set-cookie']?.[0].split(';')[0],
        body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(Error('Request timed out')));
    req.write(bytes.subarray(0, cut));
    setTimeout(() => req.end(bytes.subarray(cut)), 25);
  });
}

for (const [namespace, port] of [['catering', 19981], ['hotel', 19982]]) {
  test(namespace + ' preserves UTF-8 characters split across HTTP chunks', { timeout: 15000 }, async t => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'teaching-utf8-'));
    const child = spawn(process.execPath, ['apps/' + namespace + '/server.cjs'], {
      cwd: path.resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, STORAGE_BACKEND: 'nas', DATA_DIR: data, PORT: String(port), HOST: '127.0.0.1',
        NODE_ENV: 'test', SECURE_COOKIE: '0', TEACHER_PASSWORD: 'EncodingTeacher2026!', CLASS_CODE: 'ENCODINGTEST' }
    });
    let output = '';
    child.stdout.on('data', chunk => output += chunk);
    child.stderr.on('data', chunk => output += chunk);
    t.after(async () => {
      if (child.exitCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
      fs.rmSync(data, { recursive: true, force: true });
    });
    let ready = false;
    for (let i = 0; i < 60; i++) {
      if (child.exitCode !== null) throw Error(output);
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) { ready = true; break; } } catch {}
      await pause(50);
    }
    assert(ready, output);
    // Split at each internal byte boundary of a four-byte UTF-8 character.
    for (const offset of [1, 2, 3]) {
      const name = '中文🧪分块验证' + offset;
      const result = await splitLogin(port, { id: 'UTF8_' + offset, name, password: 'student123', classCode: 'ENCODINGTEST' }, offset);
      assert.equal(result.status, 200);
      const route = namespace === 'catering' ? '/api/snapshot' : '/api/session';
      const response = await fetch(`http://127.0.0.1:${port}${route}`, { headers: { Cookie: result.cookie } });
      assert.equal(response.status, 200);
      const saved = await response.json();
      assert.equal(namespace === 'catering' ? saved.user.name : saved.student.name, name);
    }
  });
}
