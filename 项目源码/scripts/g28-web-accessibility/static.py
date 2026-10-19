#!/usr/bin/env python3
"""Finite full-file whitespace, syntax, protected tree and package-boundary check."""
import ast, hashlib, json, os, re, signal, subprocess
from pathlib import Path
signal.alarm(45)
root = Path(__file__).resolve().parents[3]
baseline = 'd62608266aa7ee118ab43c30ced5847c204fb100'
def git(*args):
    return subprocess.run(['git', *args], cwd=root, capture_output=True, check=True, timeout=6).stdout
assert git('rev-parse', 'HEAD').decode().strip() == baseline
assert (root/'AGENTS.md').read_bytes().endswith(git('show', f'{baseline}:AGENTS.md'))
index = Path(git('rev-parse', '--git-path', 'index').decode().strip())
if not index.is_absolute(): index = root/index
sha = lambda data: hashlib.sha256(data).hexdigest()
index_before = sha(index.read_bytes())
assert not git('diff', '--cached', '--name-only')
tracked = list(filter(None, git('diff', '--name-only', '-z').decode().split('\0')))
untracked = list(filter(None, git('ls-files', '--others', '--exclude-standard', '-z').decode().split('\0')))
git('diff', '--check')
for file in untracked:
    check = subprocess.run(['git', 'diff', '--no-index', '--check', '--', '/dev/null', file], cwd=root, capture_output=True, timeout=6)
    assert check.returncode in [0, 1] and check.stdout == check.stderr == b'', (file, check.stdout, check.stderr)
js, py = [], []
for file in tracked + untracked:
    if file.endswith(('.js', '.mjs')):
        subprocess.run(['node', '--check', file], cwd=root, check=True, capture_output=True, timeout=4); js.append(file)
    if file.endswith('.py'): ast.parse((root/file).read_text()); py.append(file)
protected = []
for file in filter(None, git('ls-tree', '-r', '--name-only', '-z', baseline).decode().split('\0')):
    if (file.startswith(('项目源码/server/', '项目源码/scripts/resources/', '项目源码/scripts/g12-', '项目源码/scripts/g23-', '项目源码/scripts/g42-', '项目源码/scripts/g45-', '项目源码/scripts/g46-'))
        or file in ['项目源码/package.json', '项目源码/package-lock.json', '项目源码/web/package.json', '项目源码/web/vite.config.js', '项目源码/web/vitest.config.js']
        or re.search(r'wangshanchong/第(?:14[0-8])轮报告\.md$', file)):
        assert (root/file).read_bytes() == git('show', f'{baseline}:{file}'), file
        protected.append(file)
for directory in ['项目源码/web/src/lib', '项目源码/web/src/shared']:
    for file in (root/directory).glob('*'):
        if file.suffix not in ['.js', '.jsx']: continue
        for target in re.findall(r"(?:from\s+|import\s*)['\"]([^'\"]+)", file.read_text()):
            assert not re.search(r'(?:^|/)(?:components|app)/', target), (str(file), target)
assert all(not re.search(r'(?:^|/)\.env(?:\.|$)', file) for file in tracked+untracked)
assert sha(index.read_bytes()) == index_before
result = dict(status='PASS', baseline=baseline, tracked=tracked, untrackedWhitespace=untracked,
              javascriptSyntax=js, pythonSyntax=py, protected=protected, indexSha256=index_before,
              indexUnchangedDuringCheck=True, stagedFiles=0, packageDirection='PASS')
out = Path(os.environ['G28_AUDIT_ROOT'])/(os.environ['G28_ATTEMPT']+'-details.json')
with out.open('x') as handle: json.dump(result, handle, ensure_ascii=False, indent=2)
print(json.dumps(dict(status='PASS', tracked=len(tracked), untracked=len(untracked), protected=len(protected), js=len(js), py=len(py), staged=0)))
