import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import postcss from 'postcss';
const baseline = 'd62608266aa7ee118ab43c30ced5847c204fb100';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 2097152 });
const files = git('diff', '--name-only').trim().split('\n').filter(file => file.endsWith('.css') && !file.endsWith('/index.css'));
const modifications = [];
for (const file of files) {
  const before = postcss.parse(git('show', `${baseline}:${file}`));
  const after = postcss.parse(fs.readFileSync(path.resolve('..', file), 'utf8'));
  const declarations = tree => { const result = []; tree.walkDecls(d => result.push(d)); return result; };
  const oldDecls = declarations(before), newDecls = declarations(after);
  assert.equal(oldDecls.length, newDecls.length);
  const counts = {};
  for (let index = 0; index < oldDecls.length; index++) {
    const old = oldDecls[index], next = newDecls[index];
    assert.equal(old.prop, next.prop); assert.equal(old.parent.selector, next.parent.selector); assert.equal(old.important, next.important);
    if (old.value === next.value) continue;
    assert.ok(['font-size', 'color'].includes(next.prop) || (file.endsWith('/assistant.css') && next.prop === 'background'), `${file}: unexpected property change ${next.prop}`);
    counts[next.prop] = (counts[next.prop] || 0) + 1;
  }
  modifications.push({ file, counts });
}
const beforeImports = [...git('show', `${baseline}:项目源码/web/src/styles/index.css`).matchAll(/@import\s+'([^']+)'/g)].map(m => m[1]);
const imports = [...fs.readFileSync('web/src/styles/index.css', 'utf8').matchAll(/@import\s+'([^']+)'/g)].map(m => m[1]);
assert.deepEqual(imports, [...beforeImports, './readability.css']);
const shared = fs.readFileSync('web/src/styles/readability.css', 'utf8');
assert.ok(!shared.includes('!important') && !/\b(?:zoom|transform)\s*:/.test(shared));
const result = { status: 'PASS', baseline, modifications, existingImportOrderUnchanged: true,
  cssMultisetChangesIntentional: true, newImportantDeclarations: 0, newPageScaling: false };
fs.writeFileSync(path.join(process.env.G28_AUDIT_ROOT, process.env.G28_ATTEMPT + '-css.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
console.log(JSON.stringify(result));
