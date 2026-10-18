#!/usr/bin/env python3
"""One bounded, isolated G46 check. Requires the actual App task ID; never retries."""
import argparse, json, os, signal, subprocess, resource, shutil
from pathlib import Path
signal.alarm(60)
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
p = argparse.ArgumentParser()
p.add_argument('--task-id', required=True)
p.add_argument('--name', required=True)
p.add_argument('command', nargs=argparse.REMAINDER)
a = p.parse_args()
root = Path(__file__).resolve().parents[2]
command = a.command[1:] if a.command[0] == '--' else a.command
out = root / 'output/resource-audit/engineering-20261019/g46' / a.task_id
out.mkdir(parents=True, exist_ok=True)
receipt = out / (a.name + '.json')
if receipt.exists(): raise RuntimeError('attempt already exists; preserve prior evidence')
env = {key: os.environ[key] for key in ['PATH', 'HOME', 'LANG'] if key in os.environ}
env.update(CODEX_TASK_ID=a.task_id, HAIYU_RESOURCE_MANAGED='1', NODE_ENV='test',
    DB_DRIVER='sqlite', DB_PATH=':memory:', DEMO_SEED='0', AUTH_SECRET='g46-managed-synthetic-only-secret',
    LLM_API_KEY='', LLM_BASE_URL='', LLM_MODEL='', ENVIRONMENT_MODE='unavailable', ENVIRONMENT_LIVE='0',
    STAGE25_SCHEDULER_ENABLED='0', HAIYU_API_TEST_AUDIT_ROOT=str(out/'runtime'/(a.name+'-api')),
    G46_AUDIT_ROOT=str(out), G46_ATTEMPT=a.name, PYTHONDONTWRITEBYTECODE='1')
runner = ['node', 'scripts/resources/resource-runner.js', '--task-id', a.task_id,
    '--audit-root', str(out/'runtime'/a.name), '--kind', 'test', '--name', a.name,
    '--timeout-ms', '45000', '--lease-ms', '900000', '--log-bytes', '8388608',
    '--directory-bytes', '536870912', '--cwd', '.', '--'] + command
disk_before = shutil.disk_usage('/tmp')._asdict()
r = subprocess.run(runner, cwd=root, env=env, text=True, capture_output=True, timeout=58)
record = dict(taskId=a.task_id, hostId='local', command=runner, payload=command, exitCode=r.returncode,
    stdout=r.stdout, stderr=r.stderr, diskBefore=disk_before, diskAfter=shutil.disk_usage('/tmp')._asdict())
receipt.write_text(json.dumps(record, ensure_ascii=False, indent=2)+'\n')
print(json.dumps(dict(name=a.name, exitCode=r.returncode, receipt=str(receipt), stdoutTail=r.stdout[-1400:], stderrTail=r.stderr[-1000:]), ensure_ascii=False))
raise SystemExit(r.returncode)
