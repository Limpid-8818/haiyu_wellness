// G18 精确层叠冲突分析：分组选择器展开、@media/@container 上下文、!important 语义
// 用法: node scripts/css-conflict-check.mjs <moved.css...> --eager <staying-eager.css...>
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const styleDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../src/styles');
const args = process.argv.slice(2);
const eagerIdx = args.indexOf('--eager');
const movedFiles = args.slice(0, eagerIdx);
const eagerFiles = args.slice(eagerIdx + 1);

// 选择器规范化：折叠空白并去掉组合符（> + ~）两侧空格，避免 `.a > b` 与 `.a>b` 漏配
const norm = s => s.trim().replace(/\s*([>+~])\s*/g, '$1').replace(/\s+/g, ' ');

// 解析：返回 [{media, selectors:[...], decls:[[prop, value, important]]}]
function parse(file) {
  const css = fs.readFileSync(path.join(styleDir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  let depth = 0, buf = '', sel = '', media = '', inKeyframes = false;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '{') {
      if (depth === 0) {
        sel = buf.trim(); buf = '';
        if (sel.startsWith('@keyframes') || sel.startsWith('@font-face')) { inKeyframes = true; }
        else if (sel.startsWith('@media') || sel.startsWith('@container') || sel.startsWith('@supports')) { media = sel; sel = ''; }
      }
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        if (!inKeyframes && sel && !sel.startsWith('@')) {
          const decls = [];
          for (const d of buf.split(';')) {
            const idx = d.indexOf(':');
            if (idx > 0) {
              const prop = d.slice(0, idx).trim().toLowerCase();
              let val = d.slice(idx + 1).trim();
              const imp = /!\s*important/i.test(val);
              val = val.replace(/!\s*important/ig, '').trim();
              decls.push([prop, val, imp]);
            }
          }
          if (decls.length) for (const s of sel.split(',')) rules.push({ media, sel: norm(s), decls });
        }
        buf = ''; sel = ''; media = ''; inKeyframes = false;
      }
    } else buf += c;
    if (depth === 0 && c === ';') { if (sel.startsWith('@keyframes')) buf += c; else buf = ''; }
  }
  return rules;
}

const parseRuleSet = files => {
  const map = new Map(); // key: media + '‖' + sel → [{file, decls}]
  for (const f of files) for (const r of parse(f)) {
    const key = (r.media || '') + '‖' + r.sel;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ file: f, decls: r.decls });
  }
  return map;
};

const moved = parseRuleSet(movedFiles);
const eager = parseRuleSet(eagerFiles);

// 找 moved 与 eager 的冲突：同 media + 同选择器，且存在同属性（考虑 !important：双方都 important 或双方都非 important 才构成顺序敏感）
let conflicts = 0;
for (const [key, mDefs] of moved) {
  const eDefs = eager.get(key);
  if (!eDefs) continue;
  for (const m of mDefs) for (const e of eDefs) {
    for (const [p, v, imp] of m.decls) {
      const eDecl = e.decls.find(([ep]) => ep === p);
      if (!eDecl) continue;
      const ev = eDecl[1], eImp = eDecl[2];
      if (imp !== eImp) continue; // important 数量不同则顺序无关
      if (v === ev) continue;     // 同值无影响
      conflicts++;
      const winner = imp ? '(!important) ' : '';
      console.log(`CONFLICT ${key}`);
      console.log(`   moved  ${m.file}: ${p}: ${v} ${winner}`);
      console.log(`   eager  ${e.file}: ${p}: ${ev} ${winner}   ← 今天生效（eager 在后）`);
    }
  }
}
console.log(`\nmoved=${movedFiles.join(',')} vs eager(${eagerFiles.length} files): ${conflicts} order-sensitive conflicts`);
// 另查 moved 内部互相之间
for (let i = 0; i < movedFiles.length; i++) for (let j = i + 1; j < movedFiles.length; j++) {
  const a = parseRuleSet([movedFiles[i]]), b = parseRuleSet([movedFiles[j]]);
  let n = 0;
  for (const [key, defs] of a) if (b.has(key)) {
    for (const d1 of defs) for (const d2 of b.get(key)) {
      for (const [p, v, imp] of d1.decls) {
        const e = d2.decls.find(([p2]) => p2 === p);
        if (e && e[2] === imp && e[1] !== v) { n++; console.log(`MUTUAL ${movedFiles[i]} ↔ ${movedFiles[j]} ${key}: ${p}: ${v} vs ${e[1]}`); }
      }
    }
  }
  console.log(`mutual ${movedFiles[i]}↔${movedFiles[j]}: ${n}`);
}
