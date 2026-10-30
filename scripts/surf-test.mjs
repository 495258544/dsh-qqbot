// 自主冲浪可行性实测脚本（本机已验证跑通）
// 用法: node scripts/surf-test.mjs "查询词"
import { execFileSync } from 'node:child_process';

const EGO = '/root/.dsh/profiles/web/node_modules/dsh-ego-browser/runtime/ego-linux/bin/ego-browser.mjs';
const WRAPPER = '/root/.dsh/profiles/web/node_modules/dsh-ego-browser/bin/ego-chrome-wrapper.sh';

const topic = process.argv[2] || '2026年10月新番';

const script = `
await taskSpaces.useOrCreate('surf')
const q = ${JSON.stringify(topic)}
await page.goto('https://cn.bing.com/search?q=' + encodeURIComponent(q).replace(/%20/g,'+'), {wait:true})
await page.waitForTimeout(500)
const rows = await page.evaluate(\`(()=>{const o=[];document.querySelectorAll('li.b_algo').forEach(li=>{const h=li.querySelector('h2');const a=(h&&(h.closest('a')||h.parentElement.querySelector('a')));const p=li.querySelector('.b_caption p, p.b_lineclamp3');if(h&&a)o.push({title:h.textContent.trim(),url:a.href,snip:p?p.textContent.trim().slice(0,80):''})});return o.slice(0,3)})()\`)
console.log(JSON.stringify(rows))
`;

const out = execFileSync('node', [EGO], {
  input: script,
  env: { ...process.env, EGO_LINUX_HEADLESS: '1', EGO_LINUX_CHROME: WRAPPER },
  encoding: 'utf8',
  timeout: 120000,
});
console.log(out);
