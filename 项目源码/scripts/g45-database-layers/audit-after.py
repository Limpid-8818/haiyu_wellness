#!/usr/bin/env python3
"""Finite read-only post-exit audit of this G45 task, including its auditor."""
import argparse, hashlib, json, re, signal, subprocess
from pathlib import Path
signal.alarm(55)
p = argparse.ArgumentParser(); p.add_argument('--task-id', required=True); p.add_argument('--name', default='after-exit')
a = p.parse_args(); root = Path(__file__).resolve().parents[2]
out = root/'output/resource-audit/engineering-20261018/g45'/a.task_id
identities = {}; groups = set(); paths = set(); instances = {}; count = 0; failures = []
for file in sorted((out/'runtime').rglob('registry.jsonl')):
    for line in file.read_text().splitlines():
        e = json.loads(line); count += 1
        assert e['taskId'] == a.task_id
        rows = instances.setdefault(e['instanceId'], []); rows.append(e)
        for key in ['tempDir', 'socket', 'datadir', 'logPath']:
            value = e.get(key)
            if value and value.startswith(('/tmp/haiyu-resource-', '/tmp/haiyu-rg-')): paths.add(value)
        for prefix, pidkey, startkey, fingerprintkey in [
            ('owner', 'ownerPid', 'ownerStartTime', 'ownerFingerprint'),
            ('guardian', 'guardianPid', 'guardianStartTime', 'guardianFingerprint'),
            ('process', 'pid', 'processStartTime', 'processFingerprint')]:
            if e.get(pidkey) and e.get(startkey) and e.get(fingerprintkey):
                k = (int(e[pidkey]), e[startkey], e[fingerprintkey]); identities[k] = prefix
        if e.get('pgid'): groups.add(int(e['pgid']))
        if e['event'] in ['guardian_started', 'guardian_ready'] and e.get('guardianPid'): groups.add(int(e['guardianPid']))
for instance, rows in instances.items():
    starts = {(e['pid'], e['processStartTime'], e['processFingerprint']) for e in rows if e['event'] in ['process_started','child_process_started']}
    exits = {(e['pid'], e['processStartTime'], e['processFingerprint']) for e in rows if e['event']=='pid_exit_confirmed' and e.get('exactIdentityExited')}
    if starts - exits: failures.append(dict(instance=instance, missingResourceExit=len(starts-exits)))
    terminals = [e for e in rows if e['event']=='instance_cleaned']
    if len(terminals)!=1: failures.append(dict(instance=instance, badTerminal=True))
    else:
        terminal = terminals[0]
        if not terminal.get('openHandleCheck') or terminal['resourceCount'] != sum(e['event']=='resource_cleanup_summary' for e in rows): failures.append(dict(instance=instance, cleanupGap=True))
    guardians = [e for e in rows if e['event']=='guardian_started']
    for guardian in guardians:
        if not any(e['event']=='guardian_pid_exited' and e.get('exitConfirmed') and e.get('guardianPid')==guardian['guardianPid'] and e.get('guardianFingerprint')==guardian['guardianFingerprint'] for e in rows): failures.append(dict(instance=instance, guardianGap=True))
ps = subprocess.run(['ps','-axo','pid=,ppid=,pgid=,uid=,lstart=,stat=,command='],capture_output=True,text=True,timeout=8)
assert ps.returncode==0
live = {}; groupMembers = {}
for line in ps.stdout.splitlines():
    m = re.match(r'\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.{24})\s+(\S+)\s+(.+)',line)
    if not m: continue
    pid, ppid, pgid, uid = map(int,m.group(1,2,3,4)); start = m.group(5).strip()
    fingerprint = hashlib.sha256(f'{pid}\0{start}\0{pgid}\0{uid}'.encode()).hexdigest()
    live[(pid,start,fingerprint)] = True; groupMembers.setdefault(pgid,[]).append(pid)
remainingIdentities = [dict(pid=k[0],startTime=k[1],fingerprint=k[2],kind=v) for k,v in identities.items() if k in live]
remainingGroups = [dict(pgid=g,pids=groupMembers[g]) for g in groups if groupMembers.get(g)]
remainingPaths = sorted(path for path in paths if Path(path).exists())
lsof = subprocess.run(['lsof','-nP','-Fpcn'],capture_output=True,text=True,timeout=10)
assert lsof.returncode in [0,1]
handlePaths = [line[1:] for line in lsof.stdout.splitlines() if line.startswith('n') and any(path in line[1:] for path in paths)]
result = dict(status='PASS' if not (failures or remainingIdentities or remainingGroups or remainingPaths or handlePaths) else 'FAIL',
    taskId=a.task_id, hostId='local', instances=len(instances), events=count, exactIdentities=len(identities), processGroups=len(groups), ownPaths=len(paths),
    remainingIdentities=remainingIdentities, remainingGroups=remainingGroups, remainingPaths=remainingPaths, handlePaths=handlePaths,
    historicalGaps=failures, psExit=ps.returncode, lsofExit=lsof.returncode,
    scope='only this task runtime registries; includes failed attempts and auditor; no mutations or resource sessions')
file = out/(a.name+'.json')
with file.open('x') as f: json.dump(result,f,ensure_ascii=False,indent=2); f.write('\n')
print(json.dumps(result,ensure_ascii=False)); assert result['status']=='PASS'
