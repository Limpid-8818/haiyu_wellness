// G18 核验：修改前后 CSS 语料 (选择器, 属性, 值) 多重集差异
// 用法: node scripts/css-multiset-diff.mjs <oldRev> <newRev>
// 输出的每一行差异都应是本次改动刻意为之的（剪裁的死声明）；除此之外必须为零。
import { execSync } from 'node:child_process';

const [, , oldRev, newRev] = process.argv;
const FILES = ['base.css', 'overrides.css', 'agent.css', 'assistant.css', 'layout.css', 'age-friendly.css',
  'health-review.css', 'project-admin.css', 'booking.css', 'meals.css', 'health-workspace.css',
  'wellness-review.css', 'checkin-feedback.css', 'daily-brief.css', 'operations.css', 'health-metrics.css',
  'mood.css', 'release.css', 'index.css'];
const DIR = 'src/styles';
const GIT_DIR = '项目源码/web/src/styles';

const norm = s => s.trim().replace(/\s*([>+~])\s*/g, '$1').replace(/\s+/g, ' ');

function corpus(rev) {
  const multiset = new Map(); // key → count
  for (const f of FILES) {
    let css;
    if (rev === 'WORKTREE') css = execSync(`cat ${DIR}/${f}`, { shell: 'bash', encoding: 'utf8', maxBuffer: 1024 * 1024 });
    else css = execSync(`git show ${rev}:${GIT_DIR}/${f}`, { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    css = css.replace(/\/\*[\s\S]*?\*\//g, '');
    let depth = 0, buf = '', sel = '', media = '', inKeyframes = false;
    for (let i = 0; i < css.length; i++) {
      const c = css[i];
      if (c === '{') {
        if (depth === 0) {
          sel = buf.trim(); buf = '';
          if (sel.startsWith('@keyframes') || sel.startsWith('@font-face')) inKeyframes = true;
          else if (sel.startsWith('@media') || sel.startsWith('@container') || sel.startsWith('@supports')) { media = sel; sel = ''; }
        }
        depth++;
      } else if (c === '}') {
        depth--;
        if (depth === 0) {
          if (!inKeyframes && sel && !sel.startsWith('@')) {
            for (const d of buf.split(';')) {
              const idx = d.indexOf(':');
              if (idx > 0) {
                const prop = d.slice(0, idx).trim().toLowerCase();
                let val = d.slice(idx + 1).trim();
                const imp = /!\s*important/i.test(val);
                val = val.replace(/!\s*important/ig, '').trim();
                for (const s of sel.split(',')) {
                  const key = `${media}‖${norm(s)}‖${prop}‖${val}‖${imp}`;
                  multiset.set(key, (multiset.get(key) || 0) + 1);
                }
              }
            }
          }
          buf = ''; sel = ''; media = ''; inKeyframes = false;
        }
      } else buf += c;
      if (depth === 0 && c === ';' && !sel.startsWith('@keyframes')) buf = '';
    }
  }
  return multiset;
}

const before = corpus(oldRev);
const after = corpus(newRev);
const removed = [], added = [];
for (const [k, n] of before) {
  const m = after.get(k) || 0;
  if (m < n) for (let i = 0; i < n - m; i++) removed.push(k);
}
for (const [k, n] of after) {
  const m = before.get(k) || 0;
  if (m < n) for (let i = 0; i < n - m; i++) added.push(k);
}
console.log(`before declarations: ${[...before.values()].reduce((a, b) => a + b, 0)}`);
console.log(`after  declarations: ${[...after.values()].reduce((a, b) => a + b, 0)}`);
console.log(`\n=== REMOVED (${removed.length}) ===`);
removed.forEach(k => console.log('  - ' + k.replaceAll('‖', ' | ')));
console.log(`\n=== ADDED (${added.length}) ===`);
added.forEach(k => console.log('  + ' + k.replaceAll('‖', ' | ')));
