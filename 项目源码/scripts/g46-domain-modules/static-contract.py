#!/usr/bin/env python3
"""Prove original migration logic, SQL and relocated functions were not rewritten."""
import argparse, hashlib, json, subprocess, sys
sys.dont_write_bytecode = True
from pathlib import Path
from graph import dependency_graph, reachable, scc
p = argparse.ArgumentParser(); p.add_argument('--task-id', required=True)
p.add_argument('--baseline', default='45d9af9a0a568494cf6b3e835b60ad35274ace74'); p.add_argument('--name', default='static-contract')
a = p.parse_args(); root = Path(__file__).resolve().parents[3]; src = root/'项目源码/server/src'
out = root/'项目源码/output/resource-audit/engineering-20261019/g46'/a.task_id
def old(file):
    return subprocess.run(['git','show',f'{a.baseline}:项目源码/server/src/{file}'],cwd=root,capture_output=True,text=True,check=True,timeout=10).stdout
def block(body, start, end=None): return body[body.index(start):body.index(end) if end else len(body)]
fingerprints = {}
def contains(file, body, label):
    assert (src/file).read_text().count(body.rstrip('\n')) == 1, label
    fingerprints[label] = dict(file=file, bytes=len(body.encode()), sha256=hashlib.sha256(body.encode()).hexdigest())
names = [('assessment-wellness-draft','AssessmentWellnessDraft'),('wellness-review','WellnessReview'),
    ('assistant-action','AssistantAction'),('wellness-followup','WellnessFollowup'),
    ('wellness-notification','WellnessNotification'),('operations','Operations')]
migrations = old('migrations.js')
for n, (file, name) in enumerate(names, 21):
    assert (src/f'{file}-schema.js').read_text() == old(f'stage{n}-schema.js').replace(f'Stage{n}Schema',f'{name}Schema')
    migrations = migrations.replace(f'./stage{n}-schema.js',f'./{file}-schema.js').replace(f'Stage{n}Schema',f'{name}Schema')
assert migrations == (src/'migrations.js').read_text(), 'entire migration source except import/value names'
assert old('stage26-operations.js') == (src/'operations.js').read_text()
planner = old('wellness-planner.js'); followup = old('wellness-followup.js')
contains('wellness-source-events.js',block(followup,'export async function recordReplanSourceEvent','async function reservationForGuest'),'source-event')
contains('wellness-source-events.js',block(followup,'export async function markReplanDraftActive'),'active-event')
contains('wellness-draft-queries.js',block(planner,'function decodeItem','function adoptionBody'),'draft-decoders')
contains('wellness-draft-queries.js',block(planner,'export async function getWellnessDraft'),'draft-queries')
contains('wellness-draft-changes.js',block(planner,'export async function createRestChangeDraft','export async function getWellnessDraft'),'rest-change')
contains('wellness-planner.js',block(planner,'export async function createWellnessDraft','export async function createRestChangeDraft'),'create-adopt-unchanged')
# Only the five former lazy call sites and the lower-layer relocation change followup bodies.
expected = block(followup,'async function reservationForGuest','export async function markReplanDraftActive')
expected = expected.replace("await (await import('./service-execution.js')).reservationExecutions",'await reservationExecutions')
for line in ["  const { getWellnessDraft } = await import('./wellness-planner.js');\n", "    const { createWellnessDraft } = await import('./wellness-planner.js');\n", "  const { autoActivateWellnessDraft } = await import('./wellness-review.js');\n"]: expected=expected.replace(line,'')
contains('wellness-followup.js',expected,'followup-orchestration')
g = dependency_graph(src); roots=['wellness-followup.js','wellness-planner.js','wellness-review.js','health-metrics.js','mood.js','operations.js']
closure = reachable(g, roots); assert not scc(g)
protected = ['AGENTS.md','wangshanchong/第140轮报告.md','wangshanchong/第141轮报告.md','wangshanchong/第142轮报告.md','wangshanchong/第143轮报告.md','wangshanchong/第144轮报告.md']
for file in protected:
    original=subprocess.run(['git','show',f'{a.baseline}:{file}'],cwd=root,capture_output=True,check=True,timeout=10).stdout
    assert (root/file).read_bytes()==original, file
assert subprocess.run(['git','diff','--cached','--quiet'],cwd=root).returncode==0
result=dict(status='PASS',baseline=a.baseline,taskId=a.task_id,relocations=fingerprints,
    migrationsSourceExactExceptNames=True,schemaFiles=6,dialects=2,operationsByteExact=True,
    graph=g,scc=scc(g),correctedReachable=sorted(closure),protectedHistoricalFiles=protected,
    indexSha256=hashlib.sha256((root/'.git/index').read_bytes()).hexdigest())
with (out/(a.name+'.json')).open('x') as f: json.dump(result,f,ensure_ascii=False,indent=2);f.write('\n')
print(json.dumps(dict(status='PASS',modules=len(g),edges=sum(map(len,g.values())),reachable=len(closure),scc=[])))
