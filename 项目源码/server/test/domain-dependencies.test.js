import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../src/', import.meta.url));
function filesAt(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory()
    ? filesAt(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []);
}
const files = new Map(filesAt(src).map(f => [path.relative(src, f), fs.readFileSync(f, 'utf8')]));
const graph = new Map([...files].map(([file, body]) => {
  const dynamic = [...body.matchAll(/\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g)];
  assert.equal(dynamic.length, [...body.matchAll(/\bimport\s*\(/g)].length, `${file}: computed import`);
  const literals = [...body.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'](\.[^"']+)["']/g)];
  return [file, [...new Set(literals.map(m => path.normalize(path.join(path.dirname(file), m[1]))))]];
}));

test('G46: static, re-export and literal dynamic dependency closures have no business cycle', t => {
  const done = new Set();
  function visit(node, chain = []) {
    assert.ok(!chain.includes(node), `cycle: ${[...chain, node].join(' -> ')}`);
    if (done.has(node)) return;
    assert.ok(graph.has(node), `missing package dependency ${node}`);
    for (const edge of graph.get(node)) visit(edge, [...chain, node]);
    done.add(node);
  }
  for (const root of ['wellness-followup.js', 'health-metrics.js', 'mood.js', 'operations.js', 'wellness-review.js']) visit(root);
  const reachable = done.size;
  for (const root of graph.keys()) visit(root);
  t.diagnostic(`${graph.size} modules; ${[...graph.values()].reduce((n, edges) => n + edges.length, 0)} edges; ${reachable} reachable from corrected roots; no cycles`);
  assert.doesNotMatch(files.get('wellness-followup.js'), /\bimport\s*\(/);
  assert.doesNotMatch(files.get('assistant-actions.js'), /\bimport\s*\(/);
  for (const file of ['health-metrics.js', 'mood.js']) {
    assert.ok(graph.get(file).includes('wellness-source-events.js'));
    assert.ok(!graph.get(file).includes('wellness-followup.js'));
  }
});

test('G46: production never imports historical stage facades; facades are static re-exports only', () => {
  for (const [file, edges] of graph) for (const edge of edges) {
    assert.doesNotMatch(edge, /stage2[1-6]-(?:schema|operations)\.js$/, file);
  }
  for (const [file, body] of files) if (/^stage2[1-6]-(schema|operations)\.js$/.test(file)) {
    const code = body.replace(/^\/\/.*$/gm, '').trim();
    assert.match(code, /^export (?:\{[^}]+\}|\*) from '\.\/[^']+';$/);
  }
});

test('G46: old schema paths preserve exact values and array identities at domain entries', async () => {
  const entries = [
    ['assessment-wellness-draft', 'AssessmentWellnessDraft'], ['wellness-review', 'WellnessReview'],
    ['assistant-action', 'AssistantAction'], ['wellness-followup', 'WellnessFollowup'],
    ['wellness-notification', 'WellnessNotification'], ['operations', 'Operations']
  ];
  for (const [index, [file, name]] of entries.entries()) {
    const old = await import(`../src/stage${index + 21}-schema.js`);
    const domain = await import(`../src/${file}-schema.js`);
    assert.equal(Object.keys(old).length, 2);
    for (const dialect of ['sqlite', 'mysql']) assert.strictEqual(old[`${dialect}Stage${index + 21}Schema`], domain[`${dialect}${name}Schema`]);
  }
});
