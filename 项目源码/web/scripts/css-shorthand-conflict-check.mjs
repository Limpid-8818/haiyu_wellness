// G18 补充分析：简写属性展开后的层叠冲突（shorthand vs longhand 交叉）
// 用法: node scripts/css-shorthand-conflict-check.mjs
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const styleDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../src/styles');
const norm = s => s.trim().replace(/\s*([>+~])\s*/g, '$1').replace(/\s+/g, ' ');

// 常用简写 → 受影响 longhand（用于交叉冲突判定）
const SHORTHAND = {
  'font': ['font-family', 'font-size', 'font-weight', 'font-style', 'font-variant', 'font-stretch', 'line-height'],
  'background': ['background-color', 'background-image', 'background-position', 'background-size', 'background-repeat', 'background-origin', 'background-clip', 'background-attachment'],
  'border': ['border-width', 'border-style', 'border-color', 'border-top-width', 'border-top-style', 'border-top-color', 'border-bottom-width', 'border-bottom-style', 'border-bottom-color', 'border-left-width', 'border-left-style', 'border-left-color', 'border-right-width', 'border-right-style', 'border-right-color'],
  'border-top': ['border-top-width', 'border-top-style', 'border-top-color'],
  'border-bottom': ['border-bottom-width', 'border-bottom-style', 'border-bottom-color'],
  'border-left': ['border-left-width', 'border-left-style', 'border-left-color'],
  'border-right': ['border-right-width', 'border-right-style', 'border-right-color'],
  'margin': ['margin-top', 'margin-bottom', 'margin-left', 'margin-right'],
  'padding': ['padding-top', 'padding-bottom', 'padding-left', 'padding-right'],
  'flex': ['flex-grow', 'flex-shrink', 'flex-basis'],
  'flex-flow': ['flex-direction', 'flex-wrap'],
  'overflow': ['overflow-x', 'overflow-y'],
  'place-items': ['align-items', 'justify-items'],
  'place-content': ['align-content', 'justify-content'],
  'place-self': ['align-self', 'justify-self'],
  'gap': ['row-gap', 'column-gap'],
  'inset': ['top', 'right', 'bottom', 'left'],
  'list-style': ['list-style-type', 'list-style-position', 'list-style-image'],
  'grid-area': ['grid-row-start', 'grid-row-end', 'grid-column-start', 'grid-column-end'],
  'grid-column': ['grid-column-start', 'grid-column-end'],
  'grid-row': ['grid-row-start', 'grid-row-end'],
};
const expand = p => SHORTHAND[p] || [p];

function parse(file) {
  const css = fs.readFileSync(path.join(styleDir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  let depth = 0, buf = '', sel = '', media = '', inKf = false;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '{') {
      if (depth === 0) {
        sel = buf.trim(); buf = '';
        if (sel.startsWith('@keyframes') || sel.startsWith('@font-face')) inKf = true;
        else if (/^@(media|container|supports)/.test(sel)) { media = sel; sel = ''; }
      }
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        if (!inKf && sel && !sel.startsWith('@')) {
          const decls = [];
          for (const d of buf.split(';')) {
            const idx = d.indexOf(':');
            if (idx > 0) decls.push([d.slice(0, idx).trim().toLowerCase(), d.slice(idx + 1).trim()]);
          }
          if (decls.length) for (const s of sel.split(',')) rules.push({ media, sel: norm(s), decls });
        }
        buf = ''; sel = ''; media = ''; inKf = false;
      }
    } else buf += c;
    if (depth === 0 && c === ';' && !sel.startsWith('@keyframes')) buf = '';
  }
  return rules;
}

// 原始 index.css 顺序（用于判定"今天谁生效"）：base, overrides, agent, assistant, layout,
// age-friendly, health-review, project-admin, booking, meals, health-workspace, wellness-review,
// checkin-feedback, daily-brief, operations, health-metrics, mood, release
const ORIGINAL_ORDER = ['base.css', 'overrides.css', 'agent.css', 'assistant.css', 'layout.css',
  'age-friendly.css', 'health-review.css', 'project-admin.css', 'booking.css', 'meals.css',
  'health-workspace.css', 'wellness-review.css', 'checkin-feedback.css', 'daily-brief.css',
  'operations.css', 'health-metrics.css', 'mood.css', 'release.css'];
const MOVED = new Set(['agent.css', 'assistant.css', 'operations.css']);

let order = 0;
const index = new Map(); // media‖sel → [{file, prop, order, important, lazy}]
for (const f of ORIGINAL_ORDER) {
  const isLazy = MOVED.has(f); // 拆分后这三个文件恒晚于全部 eager 文件加载
  for (const r of parse(f)) {
    for (const [prop, val] of r.decls) {
      const imp = /!\s*important/i.test(val);
      for (const ex of expand(prop)) {
        const key = r.media + '‖' + r.sel;
        if (!index.has(key)) index.set(key, []);
        index.get(key).push({ file: f, prop: ex, raw: prop, order: order++, lazy: isLazy, important: imp, val });
      }
    }
  }
}

let hits = 0;
for (const [key, decls] of index) {
  // 同一 (media, selector) 下，lazy 声明与 eager 声明影响同一 longhand
  for (let i = 0; i < decls.length; i++) for (let j = i + 1; j < decls.length; j++) {
    const a = decls[i], b = decls[j];
    if (a.lazy === b.lazy) continue;
    if (a.prop !== b.prop) continue;
    if (a.important !== b.important) continue;
    // 原顺序中靠后者今天生效；拆分后 lazy 恒靠后 → 若今天的赢家是 eager 则为翻转风险
    const winnerToday = a.order > b.order ? a : b;
    if (!winnerToday.lazy) {
      hits++;
      console.log(`FLIP-RISK ${key}`);
      console.log(`   lazy ${a.file} (${a.raw}: ${a.val})`);
      console.log(`   eager ${b.file} (${b.raw}: ${b.val})  ← 今天生效`);
    }
  }
}
console.log(`\nshorthand-expanded flip risks: ${hits}`);
