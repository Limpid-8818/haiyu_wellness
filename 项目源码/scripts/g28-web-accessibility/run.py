#!/usr/bin/env python3
"""One bounded, isolated G28 command; caller must supply their real task ID."""
import hashlib, json, os, pathlib, shutil, subprocess, sys, time

root = pathlib.Path(__file__).resolve().parents[2]
task, name, *command = sys.argv[1:]
assert len(task) == 36 and command
out = root / 'output/resource-audit/engineering-20261019/g28' / task
out.mkdir(parents=True, exist_ok=True)
receipt = out / (name + '-runner.json')
assert not receipt.exists(), 'attempt names are immutable; do not overwrite failures'
env = {k: os.environ[k] for k in ['PATH', 'HOME'] if k in os.environ}
env.update(LANG='en_US.UTF-8', LC_ALL='en_US.UTF-8', CODEX_TASK_ID=task, G28_AUDIT_ROOT=str(out), G28_ATTEMPT=name,
           HAIYU_RESOURCE_MANAGED='1', NODE_ENV='test', DB_DRIVER='sqlite', DB_PATH=':memory:',
           DEMO_SEED='0', LLM_API_KEY='', LLM_BASE_URL='', LLM_MODEL='',
           ENVIRONMENT_MODE='unavailable', ENVIRONMENT_LIVE='0', STAGE25_SCHEDULER_ENABLED='0')
args = ['perl', '-e', 'alarm 60; exec @ARGV', 'node', 'scripts/resources/resource-runner.js',
        '--task-id', task, '--audit-root', str(out / 'runtime' / name), '--name', name,
        '--timeout-ms', '45000', '--lease-ms', '900000', '--log-bytes', '8388608',
        '--directory-bytes', '536870912', '--cwd', '.', '--',
        'node', 'scripts/g28-web-accessibility/capture.js', *command]
started = time.monotonic()
disk_before = shutil.disk_usage('/tmp')._asdict()
with receipt.open('xb') as handle:
    result = subprocess.run(args, cwd=root, env=env, stdout=handle, stderr=subprocess.STDOUT, timeout=60)
log = out / (name + '-full.log')
metadata = dict(command=args, payload=command, taskId=task, hostId='local', exitCode=result.returncode,
                durationMs=round((time.monotonic()-started)*1000), diskBefore=disk_before,
                diskAfter=shutil.disk_usage('/tmp')._asdict(), environmentNames=sorted(env),
                fullLogBytes=log.stat().st_size if log.exists() else 0,
                fullLogSha256=hashlib.sha256(log.read_bytes()).hexdigest() if log.exists() else None)
with (out / (name + '-command.json')).open('x') as handle:
    json.dump(metadata, handle, ensure_ascii=False, indent=2)
print(json.dumps({'attempt': name, 'exit': result.returncode, 'receipt': str(receipt)}))
sys.exit(result.returncode)
