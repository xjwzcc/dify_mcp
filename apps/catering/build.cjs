const fs=require('node:fs'),path=require('node:path');const root=__dirname;
let source=fs.readFileSync(path.join(root,'原项目源文件.html'),'utf8');
const seed=source.slice(source.indexOf('function defaultState(){'),source.indexOf('\nfunction load(){'));
fs.writeFileSync(path.join(root,'native-seed.cjs'),seed+'\nmodule.exports=defaultState;');
source=source.replace("var SHARE_BASE = 'https://emenu-ordering-sim.app.workbuddy.host/';","var SHARE_BASE = location.origin + '/customer.html';");
source=source.replace(/^initApp\(\);$/m,'/* 启动由教学适配层管理 */');
source=source.replace('</body>','<script src="/native-bridge.js"></script></body>');
fs.writeFileSync(path.join(root,'public','original.html'),source);
