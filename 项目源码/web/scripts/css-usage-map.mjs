// G18 评估脚本：精确映射每个 CSS 文件的类名到使用它的组件文件（className token 级匹配）
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../src');
function walk(dir) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else if (/\.(jsx|js)$/.test(e.name)) out.push(p);
  }
  return out;
}
const srcFiles = walk(root).filter(f => !f.includes('styles'));
const tokensByFile = {};
const TOKEN_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
for (const f of srcFiles) {
  const text = fs.readFileSync(f, 'utf8');
  const tokens = new Set();
  for (const m of text.matchAll(/className=\{?["']([^"']+)["']/g)) {
    m[1].split(/\s+/).forEach(t => { if (TOKEN_RE.test(t)) tokens.add(t); });
  }
  // 模板字符串 className（含表达式）：切掉表达式后逐段取 token
  for (const m of text.matchAll(/className=\{`([^`]+)`\}/g)) {
    m[1].split(/[$ { } ? : ' " ! & | ( )]+/).forEach(t => { if (TOKEN_RE.test(t) && t.length > 2) tokens.add(t); });
  }
  tokensByFile[f] = tokens;
}
const styleDir = path.join(root, 'styles');
for (const css of fs.readdirSync(styleDir).filter(f => f.endsWith('.css') && f !== 'index.css')) {
  const cssText = fs.readFileSync(path.join(styleDir, css), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const classes = new Set();
  for (const m of cssText.matchAll(/\.(-?[a-zA-Z_][a-zA-Z0-9_-]*)/g)) classes.add(m[1]);
  const usage = [];
  for (const [f, toks] of Object.entries(tokensByFile)) {
    const hits = [...classes].filter(c => toks.has(c));
    if (hits.length >= 2) usage.push([path.relative(root, f), hits.length]);
  }
  usage.sort((a, b) => b[1] - a[1]);
  console.log('=== ' + css + ' ===');
  for (const [f, n] of usage.slice(0, 8)) console.log('   ' + String(n).padStart(3) + '  ' + f);
  if (usage.length > 8) console.log('   ... +' + (usage.length - 8) + ' more files');
}
