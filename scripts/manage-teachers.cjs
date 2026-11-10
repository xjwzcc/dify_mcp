#!/usr/bin/env node
'use strict';
// Run inside the active FC instance. Never opens a second OSS writer.
const http = require('node:http');
const crypto = require('node:crypto');
async function manage(input, socketPath = process.env.ACCOUNTS_ADMIN_SOCKET || '/tmp/shixunlab-accounts-admin.sock') {
  return new Promise((resolve, reject) => {
    const req = http.request({socketPath, path:'/api/admin/teachers', method:'POST', headers:{'Content-Type':'application/json'}}, res => {
      let raw=''; res.setEncoding('utf8'); res.on('data', c => raw+=c);
      res.on('end', () => { try { const value=JSON.parse(raw); if(res.statusCode!==200) throw Error(value.error || '管理操作失败'); resolve(value); } catch(e) { reject(e); } });
    });
    req.on('error', reject); req.setTimeout(15000, () => req.destroy(Error('账号服务未响应'))); req.end(JSON.stringify(input));
  });
}
module.exports = {manage};
if (require.main === module) (async () => {
  const [action, username, name, ...extra] = process.argv.slice(2);
  if (!['list','create','approve'].includes(action) || extra.length || (action==='create' && (!username || !name)) || (action==='approve' && (!username || name)) || (action==='list' && username))
    throw Error('用法：node scripts/manage-teachers.cjs list | create 账号 "姓名" | approve 已核实的教师账号');
  const password = action==='create' ? crypto.randomBytes(18).toString('base64url') : undefined;
  const result = await manage({action,username,name,password});
  console.log(JSON.stringify(result,null,2));
  if(password) console.log('新教师密码（仅此次显示，请私下交付）：' + password);
})().catch(e => { console.error(e.message); process.exitCode=1; });
