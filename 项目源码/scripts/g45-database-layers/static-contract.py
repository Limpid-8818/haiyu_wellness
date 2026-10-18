#!/usr/bin/env python3
"""Read-only G45 relocation, protected-schema and literal import graph contract."""
import argparse, hashlib, json, re, signal, subprocess
from pathlib import Path
signal.alarm(60)
p = argparse.ArgumentParser()
p.add_argument('--task-id', required=True)
p.add_argument('--baseline', default='54bb7d26abaf22d177f94841156ab511f3ebd13b')
p.add_argument('--name', default='static-contract')
a = p.parse_args()
root = Path(__file__).resolve().parents[3]
src = root/'项目源码/server/src'
out = root/'项目源码/output/resource-audit/engineering-20261018/g45'/a.task_id
def old(file):
    return subprocess.run(['git', 'show', f'{a.baseline}:项目源码/server/src/{file}'], cwd=root,
        capture_output=True, text=True, check=True, timeout=15).stdout
original = old('db.js')
for file in ['demo-team.js', 'password.js', 'clock.js', 'staffing.js', 'catalog-data.js', 'meal-data.js']:
    assert old(file) == (src/file).read_text(), file
def section(start, end):
    return original[original.index(start):original.index(end)]
blocks = {
    'infrastructure-and-dialect': ('db-infrastructure.js', section('const here', 'async function migrationRecord')),
    'connection-and-default-path': ('db-infrastructure.js', section('async function initialize()', '  migrationResult = await migrate();')
        .replace('async function initialize()', 'export async function initializeConnection()')+'}\n'),
    'migration-errors': ('migrations.js', section('async function migrationRecord', 'async function seedStage13Catalog')),
    'both-dialect-migrations': ('migrations.js', section('async function applyMysqlMigration', 'export function hashPassword')),
    'catalog-seed': ('catalog-seed.js', section('async function seedStage13Catalog', 'async function applyMysqlMigration')
        .replace('async function seedStage13Catalog', 'export async function seedStage13Catalog')
        .replace('async function seedMealCatalog', 'export async function seedMealCatalog')
        .replace('async function correctOlderAdultActivityKnowledgeSource', 'export async function correctOlderAdultActivityKnowledgeSource')),
    'optional-demo-seed': ('demo-seed.js', section('async function seedDemo', 'export const demoSeed').replace('async function seedDemo', 'export async function seedDemo')),
    'values-and-password': ('db-values.js', section('export function hashPassword', 'export async function log')),
    'audit-log': ('db-infrastructure.js', section('export async function log', 'async function seedDemo')),
    'guest-projections': ('guest-queries.js', original[original.index('export function publicUser'):])
}
fingerprints = {}
for name, (file, body) in blocks.items():
    assert (src/file).read_text().count(body.rstrip('\n')) == 1, name
    fingerprints[name] = dict(file=file, sha256=hashlib.sha256(body.encode()).hexdigest(), bytes=len(body.encode()))
h = old('health-metrics.js')
shared = h[h.index('export const HEALTH_METRIC_RULE_VERSION'):h.index('function strictNumber')]
legacy = h[h.index('function parseLegacyValues'):h.index('function asStructured')]
assert (shared.replace('function metricKey', 'export function metricKey')+legacy).rstrip('\n') in (src/'health-metric-values.js').read_text()
expected = h.replace(shared, "import { HEALTH_METRIC_RULE_VERSION, HEALTH_DEMO_RULE, HEALTH_METRICS, metricKey, legacyStructuredValue } from './health-metric-values.js';\nexport { HEALTH_METRIC_RULE_VERSION, HEALTH_DEMO_RULE, HEALTH_METRICS, legacyStructuredValue } from './health-metric-values.js';\n\n").replace(legacy, '')
assert (src/'health-metrics.js').read_text() == expected
metadata = re.findall(r"version: (\d+), name: '([^']+)'", original)
assert len(metadata) == 58
assert metadata[:29] == metadata[29:]
assert [int(v) for v, _ in metadata[:29]] == list(range(1, 30))
protected = json.loads((out/'protection-before.json').read_text())
for file, digest in protected.items():
    if 'schema.js' in file or re.search(r'第1[12][0-9]轮报告', file):
        assert hashlib.sha256((root/file).read_bytes()).hexdigest() == digest, file
assert hashlib.sha256((root/'.git/index').read_bytes()).hexdigest() == protected['index']
# Resolve both static imports/reexports and literal dynamic imports across the actual source tree.
files = {str(file.relative_to(src)): file.read_text() for file in src.rglob('*.js')}
pattern = r"(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)[\"'](\.[^\"']+)[\"']"
def graph(contents):
    result = {}
    for file, body in contents.items():
        edges = []
        for spec in re.findall(pattern, body):
            target = str((src/file).parent.joinpath(spec).resolve().relative_to(src.resolve()))
            if target in contents: edges.append(target)
        result[file] = sorted(set(edges))
    return result
def cycles(g):
    found = []; done = set(); active = []
    def visit(node):
        if node in active:
            found.append(active[active.index(node):]+[node]); return
        if node in done: return
        active.append(node)
        for child in g[node]: visit(child)
        active.pop(); done.add(node)
    for node in g: visit(node)
    return found
g = graph(files)
layers = ['db.js', 'db-infrastructure.js', 'db-values.js', 'migrations.js', 'catalog-seed.js',
    'demo-seed.js', 'guest-queries.js', 'health-metric-values.js']
def reach(node, seen):
    assert node not in seen, seen+[node]
    for child in g[node]: reach(child, seen+[node])
reach('db.js', [])
for file in layers[1:]:
    assert 'db.js' not in g[file], file
    assert 'import(' not in files[file] and not re.search(r'\bimport\s+\(', files[file]), file
baseline_files = {k: v for k, v in files.items() if k not in layers[1:]}
baseline_files['db.js'] = original; baseline_files['health-metrics.js'] = h
before_cycles = cycles(graph(baseline_files)); after_cycles = cycles(g)
assert all(not set(cycle).intersection(layers) for cycle in after_cycles)
assert all(set(cycle).issubset(set().union(*map(set, before_cycles))) for cycle in after_cycles)
comparison = []
for seed in [0, 1]:
    for phase in ['new', 'restart']:
        key = f'seed{seed}-{phase}'
        before = json.loads((out/f'baseline01-{key}.json').read_text())
        after = json.loads((out/f'comparison01-{key}.json').read_text())
        assert before == after, key
        comparison.append(dict(case=key, exactNormalizedMatch=True, exports=len(before['exports']),
            schemaObjects=len(before['schema']), applied=before['migrationResult']['applied'],
            users=len(before['data']['users']), news=len(before['data']['news'])))
result = dict(status='PASS', baseline=a.baseline, taskId=a.task_id, fingerprints=fingerprints,
    metadata=metadata, baselineComparison=comparison, graph=g, layerGraph={k:g[k] for k in layers},
    baselineCycles=before_cycles, remainingExistingCycles=after_cycles,
    note='MySQL static relocation only; no server connected; default path statically preserved without opening it')
with (out/(a.name+'.json')).open('x') as file: json.dump(result, file, ensure_ascii=False, indent=2); file.write('\n')
print(json.dumps(dict(status='PASS', blocks=len(blocks), modules=len(g), comparison=comparison,
    baselineCycles=len(before_cycles), remainingExistingCycles=len(after_cycles)), ensure_ascii=False))
