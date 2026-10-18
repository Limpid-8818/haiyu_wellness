// No MySQL driver/server: execute the actual migration functions against a recording adapter.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const src = path.resolve('server/src');
const out = process.env.G46_AUDIT_ROOT;
const phase = process.argv[2];
assert.ok(out && /^(before|after)$/.test(phase));
const baseline = process.argv[3];
assert.ok(!baseline || (phase === 'before' && /^[a-f0-9]{40}$/.test(baseline)));
const originals = new Map();
function read(file) {
  if (!baseline) return fs.readFileSync(file, 'utf8');
  if (!originals.has(file)) originals.set(file, execFileSync('git', ['show',
    `${baseline}:项目源码/server/src/${path.relative(src, file)}`], { encoding: 'utf8', timeout: 5000, maxBuffer: 1048576 }));
  return originals.get(file);
}
const schemas = {};
for (let n = 21; n <= 26; n++) {
  const file = path.join(src, `stage${n}-schema.js`);
  if (baseline) {
    const module = new vm.SourceTextModule(read(file));
    await module.link(() => { throw new Error('original schema unexpectedly imports a dependency'); });
    await module.evaluate();
    schemas[n] = JSON.parse(JSON.stringify({ ...module.namespace }));
  } else schemas[n] = { ...await import(pathToFileURL(file)) };
}
const source = read(path.join(src, 'migrations.js'));
const metadata = [...source.matchAll(/version: (\d+), name: '([^']+)'/g)].map(m => [Number(m[1]), m[2]]);
assert.equal(metadata.length, 58);
assert.deepEqual(metadata.slice(0, 29), metadata.slice(29));
const sequences = {};
for (const driver of ['sqlite', 'mysql']) {
  for (const existing of [false, true]) {
    const calls = [];
    const db = {
      exec: async sql => { calls.push(['exec', sql]); },
      prepare: sql => Object.fromEntries(['get', 'all', 'run'].map(method => [method, async (...args) => {
        calls.push([method, sql, args]);
        if (method === 'run') return { changes: 1 };
        if (method === 'all') return [];
        if (sql === 'SELECT version FROM schema_migrations WHERE version=?') return undefined;
        if (sql.includes('sqlite_master')) return { sql: existing ? 'approved_after_revision' : 'old schema' };
        if (sql.includes('COUNT(*)')) return { n: existing ? 1 : 0 };
        return existing ? { name: 'existing', clause: 'approved_after_revision' } : undefined;
      }]))
    };
    const context = vm.createContext({ console, process: { env: {} } });
    const cache = new Map();
    function synthetic(key, values) {
      if (!cache.has(key)) cache.set(key, new vm.SyntheticModule(Object.keys(values), function () {
        for (const [name, value] of Object.entries(values)) this.setExport(name, value);
      }, { context, identifier: key }));
      return cache.get(key);
    }
    function module(file) {
      if (cache.has(file)) return cache.get(file);
      if (file.endsWith('/db-infrastructure.js')) return synthetic(file, { db, driver, transaction: async f => f() });
      if (file.endsWith('/db-values.js')) return synthetic(file, { now: () => '2000-01-01T00:00:00.000Z' });
      const m = new vm.SourceTextModule(read(file), { context, identifier: file });
      cache.set(file, m); return m;
    }
    const main = module(path.join(src, 'migrations.js'));
    await main.link((specifier, parent) => module(path.resolve(path.dirname(parent.identifier), specifier)));
    await main.evaluate();
    assert.equal((await main.namespace.migrate()).applied, 29);
    sequences[`${driver}-${existing ? 'existing' : 'missing'}`] = calls;
  }
}
const exports = {};
for (const file of ['wellness-followup', 'wellness-planner', 'wellness-review', 'health-metrics', 'mood',
  'service-execution', 'stage26-operations', 'assistant-actions', 'assistant-tools', 'model-adapter', 'migrations']) {
  if (baseline) {
    const body = read(path.join(src, `${file}.js`));
    assert.doesNotMatch(body, /export\s+\*/);
    const declarations = [...body.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let)\s+(\w+)/g)].map(m => m[1]);
    const forwarded = [...body.matchAll(/export\s*\{([^}]+)\}/g)].flatMap(m => m[1].split(',').map(s => s.trim().split(/\s+as\s+/).at(-1)));
    exports[file] = [...new Set([...declarations, ...forwarded])].sort();
  } else exports[file] = Object.keys(await import(pathToFileURL(path.join(src, `${file}.js`)))).sort();
}
if (!baseline) await (await import(pathToFileURL(path.join(src, 'db.js')))).db.close();
const snapshot = { schemas, metadata, sequences, exports };
const filename = path.join(out, `${phase}${baseline ? '-git' : ''}-snapshot.json`);
fs.writeFileSync(filename, JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx' });
const original = path.join(out, 'before-snapshot.json');
if (baseline && fs.existsSync(original)) assert.deepEqual(snapshot, JSON.parse(fs.readFileSync(original)));
if (phase === 'after') assert.deepEqual(snapshot, JSON.parse(fs.readFileSync(fs.existsSync(original) ? original : path.join(out, 'before-git-snapshot.json'))));
console.log(JSON.stringify({ status: 'PASS', phase, schemaExports: 12, migrations: 29,
  calls: Object.fromEntries(Object.entries(sequences).map(([key, value]) => [key, value.length])), exports, filename }));
