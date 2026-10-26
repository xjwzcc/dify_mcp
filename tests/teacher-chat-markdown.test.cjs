const {test}=require('node:test'),assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
async function render(source){const dom=new JSDOM('<div id="answer"></div>');const target=dom.window.document.getElementById('answer');const {renderMarkdown}=await import('../shared/teacher-chat/markdown.js');renderMarkdown(target,source);return {target,dom,renderMarkdown};}
test('Chinese headings, nested lists, tables, quotes and code render as semantic elements',async()=>{
 const {target}=await render('## 备课计划\n\n**教学目标**与`sum`。\n\n1. 准备资料\n   - 阅读工单\n2. 设计任务\n\n| 阶段 | 内容 |\n| --- | --- |\n| 课前 | 阅读 |\n\n> 教师审核\n\n```python\nprint("<tag>")\n```');
 assert.equal(target.querySelector('h2').textContent,'备课计划');assert.equal(target.querySelector('strong').textContent,'教学目标');
 assert.equal(target.querySelectorAll('ol > li').length,2);assert.ok(target.querySelector('ol ul li'));
 assert.equal(target.querySelector('table tbody td').textContent,'课前');assert.ok(target.querySelector('.table-scroll'));
 assert.equal(target.querySelector('pre code').textContent,'print("<tag>")\n');assert.equal(target.querySelector('button').textContent,'复制代码');
});
test('Untrusted Markdown cannot create scripts, images, forms or executable links',async()=>{
 const {target}=await render('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<svg onload=alert(1)>\n\n![追踪](https://evil.test/pixel)\n\n[危险](javascript:alert%281%29) [编码](jav&#x61;script:alert%281%29) [数据](data:text/html,test) [本地](/hotel/api/logout) [正常](https://example.com)');
 assert.equal(target.querySelector('script,img,svg,iframe,form,input,style'),null);
 for(const a of target.querySelectorAll('a[href]')){assert.match(a.href,/^https:\/\/example.com/);assert.equal(a.rel,'noopener noreferrer');}
 assert.equal(target.querySelectorAll('[onerror],[onload]').length,0);
});
test('Streaming incomplete fences and completed history produce the same final structure',async()=>{
 const {target,renderMarkdown}=await render('### 分析\n\n**重');
 renderMarkdown(target,'### 分析\n\n**重点**\n\n```python\nprint(1)');
 assert.equal(target.querySelector('pre code').textContent,'print(1)\n');
 const source='### 分析\n\n**重点**\n\n```python\nprint(1)\n```';
 renderMarkdown(target,source);const fresh=await render(source);
 assert.equal(target.innerHTML,fresh.target.innerHTML);
});
