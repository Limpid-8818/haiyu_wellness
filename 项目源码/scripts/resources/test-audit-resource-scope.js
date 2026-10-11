import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs, parseProcessTable, resolveAuditProvenance, scanScopedRegistries, selfResourceSession,
  SOURCE_SOL_THREAD_ID, taskIdMatchesScope } from './audit-resource-scope.js';

const luna = '01a107fa-cd18-7102-934a-48cba874c37f';
const aliasWithout7102 = '01a107fa-cd18-934a-48cba874c37f';
const aliasDifferentSuffix = '01a107fa-cd18-7102-b399-d43613f117cc';
const sourceSol = SOURCE_SOL_THREAD_ID;
const unrelated = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const executingLuna = ['--executing-app-thread-id', luna];
const executingSol = ['--executing-app-thread-id', sourceSol];

assert.throws(() => parseArgs(['--task-id', '01a107fa-cd18-7102']), /complete canonical UUID/,
  'incomplete task IDs are rejected before process inventory can start');
assert.throws(() => parseArgs(['--task-id', luna]), /--executing-app-thread-id must be a complete UUID/,
  'audit scope must never be silently copied into executor provenance');

const lunaPrimary = parseArgs(['--task-id', luna, '--include-task-id', sourceSol, ...executingLuna]);
const solPrimary = parseArgs(['--task-id', sourceSol, '--include-task-id', luna, ...executingSol]);
const managed = selfResourceSession(parseProcessTable());
assert.ok(managed?.root, 'scope fixtures require a ResourceRunner-managed temp root');
  assert.match(managed.taskId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    'registry task ID is read from the current managed ResourceRunner session');
  const fixtureRoot = path.join(managed.root, 'work', `scope-fixtures-${randomUUID()}`);
  const fixtureTaskIds = [luna, aliasWithout7102, aliasDifferentSuffix, sourceSol, unrelated];

try {
  for (const taskId of fixtureTaskIds) {
    const instanceId = randomUUID();
    const registryPath = path.join(fixtureRoot, 'segments', taskId, instanceId, 'registry.jsonl');
    fs.mkdirSync(path.dirname(registryPath), { recursive: true, mode: 0o700 });
    const missingEventTaskId = taskId === aliasWithout7102;
    const events = [
      { event: 'runner_started', ...(missingEventTaskId ? {} : { taskId }), instanceId },
      { event: 'process_started', ...(missingEventTaskId ? {} : { taskId }), instanceId,
        pid: 70000 + fixtureTaskIds.indexOf(taskId), ppid: 1, pgid: 70000 + fixtureTaskIds.indexOf(taskId),
        processStartTime: 'Tue Oct  6 12:00:00 2026', processFingerprint: `fixture-${taskId}`,
        tempDir: `/tmp/haiyu-resource-${taskId.slice(0, 8)}-${instanceId}`,
        logPath: `/tmp/haiyu-resource-${taskId.slice(0, 8)}-${instanceId}/logs/test.log`,
        socket: `/tmp/haiyu-rg-${instanceId}.sock`, datadir: `/tmp/haiyu-resource-${taskId.slice(0, 8)}-${instanceId}/mysql-data`,
        port: 47000 + fixtureTaskIds.indexOf(taskId) }
    ];
    fs.writeFileSync(registryPath, `${events.map(event => JSON.stringify(event)).join('\n')}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }
  const legacyAliasInstance = randomUUID();
  fs.mkdirSync(fixtureRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(fixtureRoot, 'registry.jsonl'),
    `${JSON.stringify({ event: 'runner_started', taskId: aliasWithout7102, instanceId: legacyAliasInstance })}\n`,
    { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  assert.equal(taskIdMatchesScope(aliasWithout7102, solPrimary), true,
    'source Sol as primary plus Luna as related task must include the missing-7102 alias');
  assert.equal(taskIdMatchesScope(aliasDifferentSuffix, solPrimary), true,
    'source Sol as primary plus Luna as related task must include every historical same-prefix suffix');
  assert.equal(taskIdMatchesScope(unrelated, solPrimary), false, 'unrelated task IDs remain excluded');
  const scopeRegistries = async options => {
    const selected = await scanScopedRegistries(fixtureRoot, options);
    const selectedTaskIds = selected.selectedRegistries.map(item => item.segmentTaskId).filter(Boolean).sort();
    assert.deepEqual(selectedTaskIds, [aliasDifferentSuffix, aliasWithout7102, luna, sourceSol].sort(),
      'primary and every included task prefix select the same-prefix aliases and source Sol, but not unrelated IDs');
    assert.equal(selected.groups.size, 5);
    assert.equal(selected.structuralErrors.length, 0);
    const legacyRows = selected.selectedRegistries.filter(item => item.segmentTaskId === null);
    assert.equal(legacyRows.length, 1, 'legacy registry rows are filtered with the same union of task prefixes');
    assert.equal(legacyRows[0].selectedRows, 1);
    const missingGroupAlias = [...selected.groups.values()].find(group => group.segmentTaskId === aliasWithout7102);
    assert.ok(missingGroupAlias, 'path-selected malformed alias is retained even when its events have no taskId');
    assert.equal(missingGroupAlias.taskIds.size, 0);
    assert.equal(missingGroupAlias.resourceStarts.size, 1);
    assert.equal(missingGroupAlias.ports.size, 1);
    assert.equal([...missingGroupAlias.paths.values()].filter(item => item.kinds.has('tempDir')).length, 1);
    assert.equal([...missingGroupAlias.paths.values()].filter(item => item.kinds.has('socket')).length, 1);
    return selectedTaskIds;
  };
  await scopeRegistries(lunaPrimary);
  await scopeRegistries(solPrimary);

  const lunaProvenance = resolveAuditProvenance({ executingAppThreadId: luna,
    resourceSessionTaskId: luna, environmentTaskId: luna });
  assert.ok(lunaPrimary.taskIds.includes(sourceSol) && lunaPrimary.taskIds.includes(luna));
  assert.deepEqual(lunaProvenance, { executingAppThreadId: luna, registryTaskId: luna,
    sourceSolThreadId: sourceSol, errors: [] }, 'Luna executor identity is independent from audited targets');
  const solProvenance = resolveAuditProvenance({ executingAppThreadId: sourceSol,
    resourceSessionTaskId: sourceSol, environmentTaskId: sourceSol });
  assert.ok(solPrimary.taskIds.includes(sourceSol) && solPrimary.taskIds.includes(luna));
  assert.deepEqual(solProvenance, { executingAppThreadId: sourceSol, registryTaskId: sourceSol,
    sourceSolThreadId: sourceSol, errors: [] }, 'Sol executor identity stays Sol when the audit target includes Luna');
  const missingProvenance = resolveAuditProvenance({ resourceSessionTaskId: null });
  assert.equal(missingProvenance.executingAppThreadId, null);
  assert.equal(missingProvenance.registryTaskId, null);
  assert.equal(missingProvenance.sourceSolThreadId, sourceSol);
  assert.equal(missingProvenance.errors.length, 2, 'missing executor evidence is reported rather than inferred from scope');
  assert.match(resolveAuditProvenance({ executingAppThreadId: sourceSol, resourceSessionTaskId: sourceSol,
    environmentTaskId: luna }).errors.join(' '), /does not match/);
  const wrongExecutor = resolveAuditProvenance({ executingAppThreadId: sourceSol,
    resourceSessionTaskId: luna, environmentTaskId: luna });
  assert.match(wrongExecutor.errors.join(' '), /executing App thread ID does not match/,
    'declaring source Sol while the current ResourceRunner and CODEX_TASK_ID are Luna is blocked');
  console.log('RESOURCE_SCOPE_AUDIT_TESTS_PASS: bidirectional task prefixes, malformed and eventless alias, unrelated exclusion, executor provenance');
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
