#!/usr/bin/env python3
"""Pure syntax/whitespace/index check; never stages any file."""
import hashlib, json, os, signal, subprocess
from pathlib import Path
signal.alarm(40)
root = Path(__file__).resolve().parents[3]
out = Path(os.environ['G12_AUDIT_ROOT'])
def run(args):
    r = subprocess.run(args, cwd=root, text=True, capture_output=True, timeout=8)
    return dict(command=args, exitCode=r.returncode, stdout=r.stdout, stderr=r.stderr)
preflight = json.loads((out/'preflight.json').read_text())
index = Path(preflight['indexPath'])
assert hashlib.sha256(index.read_bytes()).hexdigest() == preflight['indexSha256']
changed = subprocess.check_output(['git', 'diff', '--name-only', '-z'], cwd=root).decode().split('\0')
new = subprocess.check_output(['git', 'ls-files', '--others', '--exclude-standard', '-z'], cwd=root).decode().split('\0')
files = sorted(set(filter(None, changed + new)))
results = []
for file in files:
    if file.endswith(('.js', '.mjs')):
        r = run(['node', '--check', file]); results.append(r); assert r['exitCode'] == 0, r
    if file in new:
        r = run(['git', 'diff', '--no-index', '--check', '--', '/dev/null', file]); results.append(r)
        assert r['exitCode'] in [0, 1] and not r['stdout'] and not r['stderr'], r
r = run(['git', 'diff', '--check']); results.append(r); assert r['exitCode'] == 0 and not r['stdout'], r
assert hashlib.sha256(index.read_bytes()).hexdigest() == preflight['indexSha256']
record = dict(status='PASS', indexUnchanged=True, indexSha256=preflight['indexSha256'], files=files, checks=results)
(out/'static-check.json').write_text(json.dumps(record, ensure_ascii=False, indent=2)+'\n')
print(json.dumps(dict(status='PASS', files=len(files), nodeSyntax=sum(1 for r in results if r['command'][0]=='node'), newFiles=sum(bool(x) for x in new), indexUnchanged=True)))
