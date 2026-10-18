#!/usr/bin/env python3
"""Finite G23 post-exit verification with exact authorized posthoc provenance.

This does not change the old checker or historical failures. A preserved terminal
is accepted only for mysql02 with both genuine appended events and verified backup.
"""
import argparse, hashlib, json, re, signal, subprocess
from pathlib import Path
signal.alarm(55)
p = argparse.ArgumentParser(); p.add_argument('--task-id', required=True); p.add_argument('--name', required=True); a = p.parse_args()
root = Path(__file__).resolve().parents[2]
assert a.task_id == '01a14cff-5566-7971-8b0c-4153a8ab6b00'
out = root/'output/resource-audit/engineering-20261018/g23'/a.task_id
instance = 'ffb6652a-895f-439c-b3c0-e0558cdad630'
expected_root = '/tmp/haiyu-resource-01a14cff-'+instance
identities = set(); groups = set(); paths = set(); instances = {}; count = 0; gaps = []
sha = lambda data: hashlib.sha256(data).hexdigest()
posthoc = None
for registry in sorted((out/'runtime').rglob('registry.jsonl')):
    data = registry.read_bytes(); rows = [json.loads(line) for line in data.splitlines() if line]
    for e in rows:
        count += 1; assert e['taskId'] == a.task_id
        instances.setdefault(e['instanceId'], []).append(e)
        for field in ['tempDir', 'socket', 'datadir', 'logPath']:
            value = e.get(field)
            if value and value.startswith(('/tmp/haiyu-resource-', '/tmp/haiyu-rg-')): paths.add(value)
        for pid, start, fingerprint in [('pid', 'processStartTime', 'processFingerprint'),
            ('ownerPid', 'ownerStartTime', 'ownerFingerprint'), ('guardianPid', 'guardianStartTime', 'guardianFingerprint')]:
            if e.get(pid) and e.get(start) and e.get(fingerprint): identities.add((int(e[pid]), e[start], e[fingerprint]))
        for field in ['pgid', 'processGroup', 'guardianPgid']:
            if e.get(field): groups.add(int(e[field]))
    if rows[0]['instanceId'] == instance:
        kept = [e for e in rows if e['event'] == 'posthoc_failure_diagnostic_preserved']
        removed = [e for e in rows if e['event'] == 'posthoc_resource_directory_removed']
        assert len(kept) == len(removed) == 1
        kept = kept[0]; removed = removed[0]
        assert removed['tempDir'] == expected_root and removed['directoryAbsentAfterRemoval'] and removed['exitCode'] == 0
        assert removed['executingAppThreadId'] == a.task_id and not removed['historicalExitEventFabricated']
        packet = json.loads((out/'resume01-final-packet.json').read_text())
        expected = packet['evidence']['runtime/mysql02-fixture/registry.jsonl']
        assert sha(data[:expected['bytes']]) == expected['sha256']
        assert len(data[expected['bytes']:].strip().splitlines()) == 2
        manifest_path = root/kept['diagnosticPath']; manifest_bytes = manifest_path.read_bytes()
        assert sha(manifest_bytes) == kept['diagnosticSha256'] == removed['diagnosticSha256']
        manifest = json.loads(manifest_bytes)
        assert sha(Path(manifest['authorizationPath']).read_bytes()) == manifest['authorizationSha256']
        assert len(manifest['logs']) == 7
        for log in manifest['logs']:
            copied = Path(log['copy']).read_bytes(); assert len(copied) == log['bytes'] and sha(copied) == log['sha256']
        assert (manifest_path.parent/'registry-before.jsonl').read_bytes() == data[:expected['bytes']]
        assert rows[-1]['event'] == 'posthoc_resource_directory_removed'
        assert not any(e['event'] in ['instance_cleaned', 'mysql_graceful_exit_confirmed'] for e in rows)
        posthoc = dict(originalPrefixPreserved=True, diagnosticManifest=str(manifest_path), logsVerified=7,
                       originalFailureRetained=True, directoryAbsent=not Path(expected_root).exists())
assert posthoc and posthoc['directoryAbsent']
for key, rows in instances.items():
    starts = {(e['pid'], e['processStartTime'], e['processFingerprint']) for e in rows if e['event'] in ['process_started','child_process_started']}
    exits = {(e['pid'], e['processStartTime'], e['processFingerprint']) for e in rows if e['event']=='pid_exit_confirmed' and e.get('exactIdentityExited')}
    if starts-exits: gaps.append(dict(instance=key, missingExactExits=len(starts-exits)))
    terminal = [e for e in rows if e['event'] in ['instance_cleaned','instance_cleanup_preserved','instance_cleanup_blocked']]
    expected_terminal = 'instance_cleanup_preserved' if key == instance else 'instance_cleaned'
    if len(terminal)!=1 or terminal[0]['event']!=expected_terminal: gaps.append(dict(instance=key, badTerminal=True))
    if not terminal or not terminal[0].get('openHandleCheck'): gaps.append(dict(instance=key, missingHandleCheck=True))
    for guardian in [e for e in rows if e['event']=='guardian_started']:
        if not any(e['event']=='guardian_pid_exited' and e.get('exitConfirmed') and e.get('guardianPid')==guardian['guardianPid']
            and e.get('guardianFingerprint')==guardian['guardianFingerprint'] for e in rows): gaps.append(dict(instance=key, guardianGap=True))
ps = subprocess.run(['ps','-axo','pid=,ppid=,pgid=,uid=,lstart=,stat=,command='],capture_output=True,text=True,timeout=8); assert ps.returncode==0
live = set(); group_members = {}
for line in ps.stdout.splitlines():
    m = re.match(r'\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.{24})\s+(\S+)\s+(.+)',line)
    if not m: continue
    pid, ppid, pgid, uid = map(int,m.group(1,2,3,4)); start = m.group(5).strip()
    live.add((pid,start,sha(f'{pid}\0{start}\0{pgid}\0{uid}'.encode())))
    group_members.setdefault(pgid,[]).append(pid)
lsof = subprocess.run(['lsof','-nP','-Fpcn'],capture_output=True,text=True,timeout=10); assert lsof.returncode in [0,1]
handles = [line[1:] for line in lsof.stdout.splitlines() if line.startswith('n') and any(path in line[1:] for path in paths)]
remaining = [path for path in paths if Path(path).exists()]
alive = sorted(identities & live); occupied_groups = {g:group_members[g] for g in groups if group_members.get(g)}
result = dict(status='PASS_CURRENT_RESIDUE_POSTHOC_HISTORY_RETAINED' if not (gaps or handles or remaining or alive or occupied_groups) else 'FAIL',
    taskId=a.task_id, instances=len(instances), events=count, exactIdentities=len(identities), processGroups=len(groups), ownPaths=len(paths),
    remainingIdentities=alive, remainingGroups=occupied_groups, remainingPaths=remaining, handlePaths=handles,
    historicalExitGaps=gaps, posthoc=posthoc, oldFailurePacketsNotReclassified=True,
    scope='this G23 task including old attempts and auditor; independent posthoc check, old checker unchanged')
with (out/(a.name+'.json')).open('x') as f: json.dump(result,f,ensure_ascii=False,indent=2); f.write('\n')
print(json.dumps(result,ensure_ascii=False)); assert result['status'].startswith('PASS_')
