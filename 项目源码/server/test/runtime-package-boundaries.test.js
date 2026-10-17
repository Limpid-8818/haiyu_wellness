import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isBuiltin } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as historical from '../../shared/release-presentation.js';
import * as server from '../src/release-presentation.js';
import * as web from '../../web/src/lib/release-presentation.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
function result(fn, args) {
  try { return { value: fn(...args) }; }
  catch (error) { return { error: error.name, message: error.message }; }
}
function consistent(name, inputs) {
  for (const args of inputs) for (const copy of [server, web]) {
    assert.deepEqual(result(copy[name], args), result(historical[name], args), `${name}: ${String(args[0])}`);
  }
}

test('both package presentation entries expose all historical exports and labels', () => {
  for (const copy of [server, web]) {
    assert.deepEqual(Object.keys(copy), Object.keys(historical));
    assert.deepEqual(copy.BUSINESS_LABELS, historical.BUSINESS_LABELS);
  }
});
test('businessText is identical for every label, unknown values, IDs, timestamps and non-string inputs', () => {
  consistent('businessText', [...Object.keys(historical.BUSINESS_LABELS), ...Object.values(historical.BUSINESS_LABELS),
    'future_status', '未完成，请核对', '', null, undefined, 0, 123, false, {}, Symbol('unknown'),
    'run_abc guest_123 env:abc 01234567-89ab-cdef-0123-456789abcdef',
    '2030-01-01T00:05:00Z 与 2030-01-01T23:59:59.123Z'].map(v => [v]));
});
test('businessTime preserves Shanghai conversion, missing/invalid inputs and offset boundaries', () => {
  consistent('businessTime', [null, undefined, '', 0, false, 'bad', '2030-01-01 00:05:00',
    '2030-01-01T00:05:00Z', '2029-12-31T16:00:00Z', '2030-01-01T08:05:00+08:00',
    '2030-01-01', '2030-02-31T00:00:00Z', new Date('2030-01-01T00:00:00Z'), {}, Symbol('bad')].map(v => [v]));
});
test('all notification type/source combinations and invalid inputs retain identical behavior', () => {
  const inputs = [[], [null], [undefined]];
  for (const notificationType of ['brief', 'reminder', 'care', 'update', 'future', undefined, null, '']) {
    for (const sourceType of ['wellness_review_event', 'daily_brief', 'mood_focus_item', 'future', undefined, null]) {
      inputs.push([{ notificationType, sourceType, message: '文字不决定类型' }]);
    }
  }
  consistent('notificationCategory', inputs);
});
test('check-in matches before/exact/after start, checked/cancelled/no-show and malformed times', () => {
  const start = '2030-01-01T01:00:00Z';
  const inputs = [[null, start], [undefined, start], [{}, start]];
  for (const reservationStatus of ['confirmed', 'cancelled', 'no_show', 'future', undefined]) {
    for (const startsAt of [start, 'bad', null]) for (const instant of ['2030-01-01T00:59:59Z', start, '2030-01-02T01:00:00Z', 'bad', null]) {
      for (const checkin of [null, { id: 'synthetic-existing-checkin' }]) inputs.push([{ reservationStatus, startsAt, checkin }, instant]);
    }
  }
  consistent('checkinAvailability', inputs);
});

function productionFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? productionFiles(file) : /\.(?:js|jsx)$/.test(file) ? [file] : [];
  });
}
function imports(source) {
  // All current production imports are literal static/re-export or dynamic imports.
  // A computed dynamic import fails the count check instead of escaping this gate.
  const dynamic = [...source.matchAll(/\bimport\s*\(\s*(['"])([^'"]+)\1/g)];
  assert.equal(dynamic.length, [...source.matchAll(/\bimport\s*\(/g)].length, 'computed dynamic import needs explicit boundary review');
  const statics = [...source.matchAll(/\b(?:import|export)\s+(?:[^;]*?\bfrom\s*)?(['"])([^'"]+)\1/g)];
  return [...dynamic, ...statics].map(match => match[2]);
}
test('all current server/web production relative import closures remain inside their runtime package', t => {
  let files = 0, edges = 0;
  for (const pkg of ['server', 'web']) {
    const boundary = path.join(root, pkg);
    const declared = JSON.parse(fs.readFileSync(path.join(boundary, 'package.json'), 'utf8')).dependencies;
    for (const file of productionFiles(path.join(boundary, 'src'))) {
      files += 1;
      for (const spec of imports(fs.readFileSync(file, 'utf8'))) {
        if (!spec.startsWith('.')) {
          const packageName = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
          assert.ok(isBuiltin(spec) || Object.hasOwn(declared, packageName), `${file}: undeclared runtime import ${spec}`);
          continue;
        }
        edges += 1;
        const target = path.resolve(path.dirname(file), spec);
        assert.ok(target.startsWith(`${boundary}${path.sep}`), `${file}: ${spec} escapes ${pkg}`);
        assert.ok(fs.existsSync(target), `${file}: missing ${spec}`);
      }
    }
  }
  assert.ok(files > 50 && edges > 100);
  t.diagnostic(`scanned ${files} production modules and ${edges} relative import edges`);
});
test('provider and both pure entries load with no scripts/root shared/dependencies present', async t => {
  const temp = fs.mkdtempSync(path.join(process.env.RESOURCE_TMPDIR || os.tmpdir(), 'g04-isolated-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const files = ['server/src/environment-providers.js', 'server/src/environment-config.js',
    'server/src/environment-budget.js', 'server/src/release-presentation.js', 'web/src/lib/release-presentation.js'];
  for (const relative of files) {
    const target = path.join(temp, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, relative), target);
  }
  for (const pkg of ['server', 'web']) fs.writeFileSync(path.join(temp, pkg, 'package.json'), '{"type":"module"}\n');
  assert.equal(fs.existsSync(path.join(temp, 'scripts')), false);
  assert.equal(fs.existsSync(path.join(temp, 'shared')), false);
  assert.equal(fs.existsSync(path.join(temp, 'node_modules')), false);
  const provider = await import(pathToFileURL(path.join(temp, files[0])));
  const environmentKeys = ['ENVIRONMENT_PROVIDER_BUDGET_LEDGER_PATH', 'CODEX_TASK_ID', 'ENVIRONMENT_PROVIDER_BUDGET_BASELINE'];
  const previous = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  delete process.env.ENVIRONMENT_PROVIDER_BUDGET_LEDGER_PATH;
  t.after(() => { for (const key of environmentKeys) {
    if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  } });
  const weather = await provider.fetchOpenMeteoWeather({ latitude: 0, longitude: 0, date: '2030-01-01',
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  assert.equal(weather.status, 'available');
  const filePath = path.join(temp, 'synthetic-budget.jsonl');
  process.env.ENVIRONMENT_PROVIDER_BUDGET_LEDGER_PATH = filePath;
  process.env.CODEX_TASK_ID = 'g04-isolated-caller';
  process.env.ENVIRONMENT_PROVIDER_BUDGET_BASELINE = '2';
  await provider.fetchOpenMeteoWeather({ latitude: 0, longitude: 0, date: '2030-01-01',
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  const accounting = await import(pathToFileURL(path.join(temp, 'server/src/environment-budget.js')));
  assert.deepEqual(accounting.reconcileEnvironmentBudget({ rows: accounting.readHashedBudgetJsonl(filePath),
    taskId: 'g04-isolated-caller', baselineUsed: 2 }), { used: 3, remaining: 3 });
  for (const relative of files.slice(3)) {
    const copy = await import(pathToFileURL(path.join(temp, relative)));
    assert.equal(copy.businessText('pending_review'), '待医护审核');
    assert.deepEqual(Object.keys(copy), Object.keys(historical));
  }
  t.diagnostic(`isolated runtime copied only ${files.length} source files (${files.reduce((n, f) => n + fs.statSync(path.join(root, f)).size, 0)} bytes)`);
});
