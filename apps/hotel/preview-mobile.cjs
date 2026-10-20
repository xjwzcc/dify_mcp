// 手机布局验收工具：独立临时课堂 + 固定宽度 iframe，不写入正式课堂数据库。
const http=require('node:http'),{spawn}=require('node:child_process'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const data=fs.mkdtempSync(path.join(os.tmpdir(),'hotel-phone-'));
const child=spawn(process.execPath,[path.join(__dirname,'server.cjs')],{env:{...process.env,PORT:'18792',HOST:'127.0.0.1',DATA_DIR:data},stdio:['ignore','pipe','inherit']});
const proxy=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/preview'){
  const width=[320,375,390,430,760].includes(+url.searchParams.get('w'))?+url.searchParams.get('w'):390;
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(`<!doctype html><meta charset="utf-8"><title>手机布局验收</title><style>body{margin:0;background:#dce5e8;font:14px system-ui}header{text-align:center;padding:10px}a{margin:0 8px}iframe{display:block;width:${width}px;height:calc(100dvh - 44px);border:0;margin:0 auto;background:white;box-shadow:0 0 16px #0002}</style><header>独立测试课堂 · ${width}px 宽 · <a href="/preview?w=320">320</a><a href="/preview?w=390">390</a><a href="/preview?w=430">430</a></header><iframe title="学生手机实训预览" src="/?role=student"></iframe>`);return;
 }
 const p=http.request({hostname:'127.0.0.1',port:18792,path:req.url,method:req.method,headers:req.headers},r=>{const headers={...r.headers};delete headers['x-frame-options'];res.writeHead(r.statusCode,headers);r.pipe(res);});p.on('error',()=>{res.writeHead(502);res.end('Test classroom starting');});req.pipe(p);
});
child.stdout.on('data',d=>{if(d.toString().includes('ready'))proxy.listen(18791,'127.0.0.1',()=>console.log('Phone QA ready: http://localhost:18791/preview'));});
function stop(){proxy.close();child.kill();}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
