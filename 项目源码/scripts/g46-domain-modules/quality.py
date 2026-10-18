#!/usr/bin/env python3
"""Syntax, full added-file whitespace, tracked diff and frozen infrastructure checks."""
import ast, hashlib, json, os, subprocess
from pathlib import Path
root = Path(__file__).resolve().parents[3]
baseline = '45d9af9a0a568494cf6b3e835b60ad35274ace74'
def git(*args): return subprocess.run(['git',*args],cwd=root,capture_output=True,check=True,timeout=5).stdout
assert git('rev-parse','HEAD').decode().strip() == baseline
index = root/git('rev-parse','--git-path','index').decode().strip()
sha = lambda b: hashlib.sha256(b).hexdigest()
index_sha = sha(index.read_bytes()); assert git('diff','--cached','--name-only') == b''
tracked = [n for n in git('diff','--name-only','-z').decode().split('\0') if n]
untracked = [n for n in git('ls-files','--others','--exclude-standard','-z').decode().split('\0') if n]
git('diff','--check')
for name in untracked:
    r = subprocess.run(['git','diff','--no-index','--check','/dev/null',name],cwd=root,capture_output=True,timeout=5)
    assert r.returncode in [0,1] and r.stdout == r.stderr == b'', (name,r.stdout,r.stderr)
js, py = [], []
for name in tracked+untracked:
    if name.endswith('.js'):
        r = subprocess.run(['node','--check',name],cwd=root,capture_output=True,timeout=3)
        assert r.returncode == 0, (name,r.stderr); js.append(name)
    if name.endswith('.py'): ast.parse((root/name).read_text()); py.append(name)
protected = []
for name in git('ls-tree','-r','--name-only','-z',baseline).decode().split('\0'):
    if (name.startswith('项目源码/server/test/') or name.startswith('项目源码/scripts/g23-')
        or name.startswith('项目源码/scripts/g42-') or name.startswith('项目源码/scripts/g45-')
        or name in ['AGENTS.md','项目源码/package.json','项目源码/package-lock.json','项目源码/web/vite.config.js']
        or name in [f'项目源码/server/src/{f}.js' for f in ['db','db-infrastructure','db-values','mysql-dialect','data-retention','data-retention-connection']]):
        assert (root/name).read_bytes() == git('show',f'{baseline}:{name}'), name
        protected.append(name)
assert sha(index.read_bytes()) == index_sha
result = dict(status='PASS',baseline=baseline,javascriptSyntax=js,pythonSyntax=py,
    trackedChanged=tracked,untrackedWhitespaceChecked=untracked,protected=protected,
    indexSha256=index_sha,indexUnchanged=True,stagedFiles=0)
out = Path(os.environ['G46_AUDIT_ROOT'])/(os.environ['G46_ATTEMPT']+'-details.json')
with out.open('x') as f: json.dump(result,f,ensure_ascii=False,indent=2);f.write('\n')
print(json.dumps(dict(status='PASS',javascriptSyntax=len(js),pythonSyntax=len(py),protected=len(protected),
    trackedChanged=len(tracked),untrackedWhitespaceChecked=len(untracked),indexUnchanged=True)))
