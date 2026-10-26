import {Marked} from './vendor/marked.js';
import createDOMPurify from './vendor/purify.js';

const escape = text => String(text).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const markdown = new Marked({gfm:true, breaks:true, renderer:{
  html: token => escape(token.text),
  image: token => escape(token.text || '图片')
}});
const purifiers = new WeakMap();
export function renderMarkdown(target, text) {
  const document = target.ownerDocument, window = document.defaultView;
  if (!purifiers.has(window)) purifiers.set(window, createDOMPurify(window));
  const fragment = purifiers.get(window).sanitize(markdown.parse(String(text)), {
    ALLOWED_TAGS:['p','br','strong','em','s','del','blockquote','pre','code','ul','ol','li','h1','h2','h3','h4','h5','h6','table','thead','tbody','tr','th','td','hr','a'],
    ALLOWED_ATTR:['href','title','start'], ALLOW_DATA_ATTR:false, ALLOW_ARIA_ATTR:false, RETURN_DOM_FRAGMENT:true
  });
  for (const link of fragment.querySelectorAll('a')) {
    try {
      const url = new URL(link.getAttribute('href'));
      if (!['https:','http:','mailto:'].includes(url.protocol)) throw Error('Unsupported link');
      link.target = '_blank'; link.rel = 'noopener noreferrer';
    } catch { link.removeAttribute('href'); }
  }
  for (const table of fragment.querySelectorAll('table')) {
    const wrap = document.createElement('div'); wrap.className='table-scroll'; wrap.tabIndex=0;
    wrap.setAttribute('role','region'); wrap.setAttribute('aria-label','表格，可横向滚动');
    table.replaceWith(wrap); wrap.append(table);
  }
  for (const pre of fragment.querySelectorAll('pre')) {
    const wrap=document.createElement('div'); wrap.className='code-block';
    const copy=document.createElement('button'); copy.className='copy-code'; copy.type='button'; copy.textContent='复制代码';
    copy.onclick=async()=>{try{await window.navigator.clipboard.writeText(pre.textContent);copy.textContent='已复制';}catch{copy.textContent='请选中代码复制';}};
    pre.replaceWith(wrap); wrap.append(copy,pre);
  }
  target.classList.add('markdown'); target.replaceChildren(fragment);
}
