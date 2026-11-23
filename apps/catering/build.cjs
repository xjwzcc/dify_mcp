const fs=require('node:fs'),path=require('node:path');const root=__dirname;
let source=fs.readFileSync(path.join(root,'原项目源文件.html'),'utf8');
const seed=source.slice(source.indexOf('function defaultState(){'),source.indexOf('\nfunction load(){'));
const tables=(source.match(/^var DEFAULT_TABLES = .*$/m)||[''])[0];
fs.writeFileSync(path.join(root,'native-seed.cjs'),tables+'\n'+seed+'\nmodule.exports=defaultState;');
source=source.replace("var SHARE_HOST = 'https://emenu-ordering-sim-v2.app.workbuddy.host/';","var SHARE_HOST = location.origin + '/catering/';");
source=source.replace("var SHARE_BASE = SHARE_HOST + '?sharecode=R66XD75JYP';   /* 访问需带 sharecode，二维码与订单码自动携带 */","var SHARE_BASE = SHARE_HOST + 'customer.html?s=1';   /* 教学版：顾客端由本服务提供 */");
source=source.replace(/^initApp\(\);$/m,'/* 启动由教学适配层管理 */');
// 加载课堂会话期间隐藏旧登录入口，避免误进本地实训。
source=source.replace('<div class="loginwrap" id="loginWrap">','<div class="loginwrap" id="loginWrap" style="display:none">');
source=source.replace('var S = load();',"var localBusiness = location.pathname.endsWith('/customer.html');\nvar S = localBusiness ? load() : defaultState();");
source=source.replace('if(ev.key===lsKey()){ S=load(); render(); }','if(localBusiness && ev.key===lsKey()){ S=load(); render(); }');
// 菜品编辑替换整个对象，回滚只需要原数组的浅拷贝。
source=source.replace('var backupMenu=JSON.stringify(S.menu), backupCats=JSON.stringify(S.cats||[]);','var backupMenu=S.menu.slice(), backupCats=(S.cats||[]).slice();');
source=source.replace('S.menu=JSON.parse(backupMenu); S.cats=JSON.parse(backupCats);','S.menu=backupMenu; S.cats=backupCats;');
// 课堂不同设备从同一个 S.seq 开始，下单及新增菜品使用独立编号。
source=source.replace('function submitOrder(){',`function newBusinessId(){
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), n=>n.toString(16).padStart(2,'0')).join('');
}
function submitOrder(){`);
source=source.replace("curTable+'-'+String(S.seq).slice(-3)","curTable+'-'+newBusinessId()");
source=source.replace("'d'+Date.now().toString().slice(-8)","'d'+newBusinessId()");
// 全量操作必须校验页面加载的版本，避免误覆盖其他同学的记录。
source=source.replace('S.menu=[]; save(); render();','S.menu=[]; save(true); render();');
source=source.replaceAll('save(); openCatDlg(); render();','save(true); openCatDlg(); render();');
source=source.replace('</body>','<script src="/catering/native-bridge.js"></script></body>');
fs.writeFileSync(path.join(root,'public','original.html'),source);
