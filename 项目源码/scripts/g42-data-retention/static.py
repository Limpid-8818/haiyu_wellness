#!/usr/bin/env python3
"""Bounded G42 package, baseline preservation, and full whitespace/index checks."""
import argparse, ast, hashlib, json, os, re, signal, subprocess
from pathlib import Path
signal.alarm(45)
p = argparse.ArgumentParser(); p.add_argument('--task-id', required=True); p.add_argument('--name', required=True)
a = p.parse_args(); root = Path(__file__).resolve().parents[3]; src = root/'项目源码/server/src'
out = root/'项目源码/output/resource-audit/engineering-20261018/g42'/a.task_id
baseline = '853c068e8ea312fe70ee96a8027427550e16df61'
def git(*args):
    return subprocess.run(['git', *args], cwd=root, capture_output=True, check=True, timeout=5).stdout
sha = lambda value: hashlib.sha256(value).hexdigest()
assert git('rev-parse', 'HEAD').decode().strip() == baseline
assert git('diff', '--cached', '--name-only') == b''
index = root/git('rev-parse', '--git-path', 'index').decode().strip()
index_sha = sha(index.read_bytes())
allowed = {'AGENTS.md', '待修复工程问题清单.md', '项目源码/package.json'}
changed = git('diff', '--name-only', '-z').decode().strip('\0').split('\0')
assert set(filter(None, changed)) <= allowed, changed
protected = {}
for name in ['db.js', 'db-infrastructure.js', 'mysql-dialect.js', 'migrations.js', *[file.name for file in src.glob('*schema.js')]]:
    current = (src/name).read_bytes()
    assert git('show', f'{baseline}:项目源码/server/src/{name}') == current, name
    protected[f'项目源码/server/src/{name}'] = dict(bytes=len(current), sha256=sha(current))
for name in ['项目源码/package-lock.json', 'wangshanchong/第140轮报告.md', 'docs/工程第7阶段G42执行计划_20261018.md']:
    current = (root/name).read_bytes(); assert git('show', f'{baseline}:{name}') == current, name
    protected[name] = dict(bytes=len(current), sha256=sha(current))
for file in (root/'项目源码/scripts/g42-data-retention').glob('*.py'): ast.parse(file.read_text())
git('diff', '--check')
untracked = [name for name in git('ls-files', '--others', '--exclude-standard', '-z').decode().split('\0') if name]
for name in untracked:
    checked = subprocess.run(['git', 'diff', '--no-index', '--check', '/dev/null', name], cwd=root, capture_output=True, timeout=5)
    # --no-index returns 1 for an added file even when --check reports no errors.
    assert checked.returncode in [0, 1] and checked.stdout == checked.stderr == b'', (name, checked.stdout, checked.stderr)
files = {str(file.relative_to(src)): file.read_text() for file in src.rglob('*.js')}
pattern = r'''(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'](\.[^"']+)["']'''
graph = {}
for name, body in files.items():
    graph[name] = []
    for spec in re.findall(pattern, body):
        target = (src/name).parent.joinpath(spec).resolve()
        assert target.is_relative_to(src.resolve()), (name, spec)
        relative = str(target.relative_to(src.resolve()))
        assert relative in files, (name, spec)
        graph[name].append(relative)
for start in ['data-retention.js', 'data-retention-connection.js']:
    def visit(node, active):
        assert node not in active, active+[node]
        assert node != 'db.js' and node != 'migrations.js'
        for child in graph[node]: visit(child, active+[node])
    visit(start, [])
assert graph['data-retention.js'] == []
assert graph['data-retention-connection.js'] == ['mysql-dialect.js']
for name, dependencies in graph.items():
    assert name.startswith('data-retention') or not set(dependencies).intersection({'data-retention.js', 'data-retention-connection.js'}), name
assert sha(index.read_bytes()) == index_sha
result = dict(status='PASS', taskId=a.task_id, hostId='local', baseline=baseline,
    modules=len(graph), edges=sum(map(len, graph.values())), newModuleGraph={key: graph[key] for key in graph if key.startswith('data-retention')},
    protected=protected, trackedChanged=changed, untrackedWhitespaceChecked=untracked, pythonSyntax=3,
    indexSha256=index_sha, indexUnchanged=True, stagedFiles=0,
    note='All source literal imports resolve inside the server package; no startup path imports retention; no model/weather/browser.')
with (out/(a.name+'-details.json')).open('x') as file: json.dump(result, file, ensure_ascii=False, indent=2); file.write('\n')
print(json.dumps({key: result[key] for key in ['status', 'modules', 'edges', 'indexSha256', 'stagedFiles']}))
