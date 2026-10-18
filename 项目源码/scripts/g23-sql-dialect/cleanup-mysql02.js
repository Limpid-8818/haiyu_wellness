// Source130 authorizes exactly one already-exited synthetic directory. No MySQL commands.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { appendResourceRegistry, assertResourceRegistryCapacity, RESOURCE_REGISTRY_CLEANUP_RESERVE_BYTES,
  processIdentity, processGroupMembers } from '../resources/resource-runtime.js';

const taskId = '01a14cff-5566-7971-8b0c-4153a8ab6b00';
const instanceId = 'ffb6652a-895f-439c-b3c0-e0558cdad630';
const target = `/tmp/haiyu-resource-01a14cff-${instanceId}`;
const project = process.cwd(), out = process.env.G23_AUDIT_ROOT, attempt = process.env.G23_ATTEMPT;
assert.equal(process.env.CODEX_TASK_ID, taskId); assert.ok(out && attempt && process.env.HAIYU_RESOURCE_MANAGED === '1');
assert.equal(path.resolve(out), path.join(project, 'output/resource-audit/engineering-20261018/g23', taskId));
const registry = path.join(out, 'runtime/mysql02-fixture/registry.jsonl');
const backup = path.join(out, `${attempt}-diagnostic`), receipt = path.join(out, `${attempt}-receipt.json`);
const authorizationPath = path.resolve(project, '../docs/G23诊断目录清理与离线工具返修_20261018.md');
const source = '01a0cbfe-a161-72d0-992d-12fad655d4ef';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const started = Date.now();
const record = { status: 'BLOCKED', taskId, instanceId, target, source, authorizationPath, backup };
function save(file, data) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(data, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
function run(command, args) {
  assert.ok(Date.now() - started < 30000, 'cleanup work deadline reached');
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 2000, maxBuffer: 2 * 1024 * 1024 });
  assert.ifError(result.error); assert.equal(result.signal, null);
  return { command: [command, ...args], exit: result.status, stdout: result.stdout, stderr: result.stderr };
}
function inventory() {
  const root = fs.lstatSync(target);
  assert.ok(root.isDirectory() && !root.isSymbolicLink()); assert.equal(root.uid, process.getuid());
  assert.equal(root.mode & 0o777, 0o700);
  assert.equal(fs.realpathSync(target), path.join(fs.realpathSync('/tmp'), path.basename(target)));
  const entries = [];
  for (const top of fs.readdirSync(target)) assert.ok(['mysql-data', 'logs', 'work', 'tmp'].includes(top), `unexpected root entry ${top}`);
  function walk(directory) {
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name), item = fs.lstatSync(file);
      assert.equal(item.dev, root.dev, `unexpected mount ${file}`);
      assert.equal(item.uid, root.uid, `unexpected owner ${file}`);
      assert.equal(item.isSymbolicLink(), false, `unexpected link ${file}`);
      assert.ok(item.isFile() || item.isDirectory(), `unexpected special entry ${file}`);
      if (item.isDirectory()) walk(file);
      else {
        assert.equal(item.nlink, 1, `unexpected hard link ${file}`);
        entries.push({ path: path.relative(target, file), bytes: item.size, blocks: item.blocks });
      }
      assert.ok(entries.length <= 500, 'unexpected directory growth');
    }
  }
  walk(target);
  return { inode: root.ino, device: root.dev, uid: root.uid, mode: root.mode & 0o777,
    entries: entries.sort((a, b) => a.path.localeCompare(b.path)), fileBytes: entries.reduce((n, e) => n + e.bytes, 0),
    fileAllocatedBytes: entries.reduce((n, e) => n + e.blocks * 512, 0) };
}
function identities(events) {
  const expected = new Map(), groups = new Set();
  for (const e of events) {
    for (const [pid, start, fingerprint] of [['pid', 'processStartTime', 'processFingerprint'],
      ['ownerPid', 'ownerStartTime', 'ownerFingerprint'], ['guardianPid', 'guardianStartTime', 'guardianFingerprint']]) {
      if (e[pid] && e[start] && e[fingerprint]) expected.set(`${e[pid]}:${e[start]}:${e[fingerprint]}`,
        { pid: e[pid], startTime: e[start], fingerprint: e[fingerprint] });
    }
    if (e.pgid) groups.add(e.pgid); if (e.processGroup) groups.add(e.processGroup);
    if (e.guardianPgid) groups.add(e.guardianPgid);
  }
  const checks = [...expected.values()].map(e => {
    const current = processIdentity(e.pid);
    assert.ok(!current || current.startTime !== e.startTime || current.fingerprint !== e.fingerprint,
      `exact identity still alive ${e.pid}`);
    return { ...e, state: current ? 'pid-reused' : 'absent', current };
  });
  const groupChecks = [...groups].map(pgid => ({ pgid, members: processGroupMembers(pgid) }));
  assert.ok(groupChecks.every(g => g.members.length === 0), 'old process group not empty');
  return { checks, groups: groupChecks, exactIdentitiesPresent: 0, processGroupsRemaining: 0 };
}
function handles(directoryPresent) {
  const real = path.join(fs.realpathSync('/tmp'), path.basename(target));
  const needles = [target, real, `/tmp/haiyu-rg-${instanceId}.sock`];
  const results = [];
  if (directoryPresent) {
    const scan = run('lsof', ['-nP', '+D', target]);
    assert.ok([0, 1].includes(scan.exit)); assert.equal(scan.stdout.trim(), ''); assert.equal(scan.stderr.trim(), '');
    results.push({ command: scan.command, exit: scan.exit, matches: 0 });
  }
  const deleted = run('lsof', ['-nP', '+L1']); assert.ok([0, 1].includes(deleted.exit));
  const matches = deleted.stdout.split('\n').filter(line => needles.some(n => line.includes(n)));
  assert.deepEqual(matches, []); results.push({ command: deleted.command, exit: deleted.exit, matchingPaths: needles, matches: 0 });
  const ports = run('lsof', ['-nP', '-iTCP:51016', '-iTCP:50634', '-sTCP:LISTEN']);
  assert.ok([0, 1].includes(ports.exit)); assert.equal(ports.stdout.trim(), '');
  results.push({ command: ports.command, exit: ports.exit, listeners: 0 });
  assert.equal(fs.existsSync(`/tmp/haiyu-rg-${instanceId}.sock`), false);
  assert.equal(fs.existsSync(path.join(target, 'mysql.sock')), false);
  return results;
}
try {
  assert.equal(fs.existsSync(receipt), false); assert.equal(fs.existsSync(backup), false);
  const packet = json(path.join(out, 'resume01-final-packet.json'));
  const prefix = fs.readFileSync(registry), expected = packet.evidence['runtime/mysql02-fixture/registry.jsonl'];
  assert.equal(prefix.length, expected.bytes); assert.equal(sha(prefix), expected.sha256);
  const events = prefix.toString('utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.every(e => e.taskId === taskId && e.instanceId === instanceId));
  assert.equal(events.findLast(e => e.event === 'instance_cleanup_preserved')?.reason, 'mysql-shutdown-command-failed:1');
  assert.equal(events.findLast(e => e.event === 'shutdown_command_exit')?.exitCode, 1);
  assert.ok(!events.some(e => e.event === 'instance_cleaned' || e.event === 'posthoc_resource_directory_removed'));
  const starts = events.filter(e => ['process_started', 'child_process_started'].includes(e.event));
  const exits = events.filter(e => e.event === 'pid_exit_confirmed' && e.exactIdentityExited);
  assert.ok(starts.every(s => exits.some(e => e.pid === s.pid && e.processStartTime === s.processStartTime && e.processFingerprint === s.processFingerprint)));
  assert.ok(events.some(e => e.event === 'guardian_pid_exited' && e.exitConfirmed));
  record.before = { inventory: inventory(), identities: identities(events), handles: handles(true) };
  const previous = json(path.join(out, 'resume01-preserved-diagnostic-inventory.json'));
  assert.equal(record.before.inventory.entries.length, previous.files.length);
  assert.equal(record.before.inventory.fileBytes, previous.bytes);
  assert.deepEqual(record.before.inventory.entries.map(e => ({ path: e.path, bytes: e.bytes })),
    previous.files.map(e => ({ path: e.path, bytes: e.bytes })).sort((a, b) => a.path.localeCompare(b.path)));
  const du = run('du', ['-sk', target]); assert.equal(du.exit, 0);
  record.before.allocatedKiB = Number(du.stdout.trim().split(/\s+/)[0]);
  fs.mkdirSync(backup, { mode: 0o700 });
  const logs = previous.files.filter(e => e.path.startsWith('logs/') && e.sha256);
  assert.equal(logs.length, 7); record.logs = [];
  for (const log of logs) {
    const data = fs.readFileSync(path.join(target, log.path)); assert.equal(data.length, log.bytes); assert.equal(sha(data), log.sha256);
    const copy = path.join(backup, path.basename(log.path)); fs.writeFileSync(copy, data, { flag: 'wx', mode: 0o600 });
    assert.equal(sha(fs.readFileSync(copy)), log.sha256); record.logs.push({ ...log, copy });
  }
  for (const name of ['resume01-preserved-diagnostic-inventory.json', 'mysql02.json', 'mysql02-fixture-evidence.json', 'resume01-after-exit.json']) {
    fs.copyFileSync(path.join(out, name), path.join(backup, name), fs.constants.COPYFILE_EXCL);
    assert.equal(sha(fs.readFileSync(path.join(backup, name))), sha(fs.readFileSync(path.join(out, name))));
  }
  fs.writeFileSync(path.join(backup, 'registry-before.jsonl'), prefix, { flag: 'wx', mode: 0o600 });
  record.originalRegistry = { path: registry, bytes: prefix.length, sha256: sha(prefix) };
  record.authorizationSha256 = sha(fs.readFileSync(authorizationPath));
  const manifest = path.join(backup, 'diagnostic-manifest.json'); save(manifest, record);
  const manifestSha = sha(fs.readFileSync(manifest));
  const common = { taskId, instanceId, executingAppThreadId: taskId, sourceSolThreadId: source,
    authorizationPath, authorizationSha256: record.authorizationSha256,
    diagnosticPath: path.relative(project, manifest), diagnosticSha256: manifestSha,
    originalRegistryPrefixBytes: prefix.length, originalRegistryPrefixSha256: sha(prefix), historicalExitEventFabricated: false };
  const preserved = { ...common, event: 'posthoc_failure_diagnostic_preserved', originalPreserveReason: 'mysql-shutdown-command-failed:1',
    historicalShutdownCommandExitCode: 1, historicalMysqldExitCode: 0, backupLogCount: 7 };
  const removed = { ...common, event: 'posthoc_resource_directory_removed', tempDir: target, exitCode: 0,
    directoryAbsentAfterRemoval: true, exactIdentityChecks: record.before.identities.checks.length,
    exactIdentitiesPresent: 0, processGroupsRemaining: 0, lsofPlusDMatches: 0, lsofPlusL1MatchesAfterRemoval: 0,
    preCleanupAllocatedKiB: record.before.allocatedKiB };
  assertResourceRegistryCapacity(registry, [preserved, removed], RESOURCE_REGISTRY_CLEANUP_RESERVE_BYTES);
  appendResourceRegistry(registry, preserved, { reserveBytes: RESOURCE_REGISTRY_CLEANUP_RESERVE_BYTES });
  record.immediatelyBeforeRemoval = { identities: identities(events), handles: handles(true), inventory: inventory() };
  assert.deepEqual(record.immediatelyBeforeRemoval.inventory, record.before.inventory);
  assert.ok(Date.now() - started < 28000, 'insufficient deletion/postcheck reserve');
  fs.rmSync(target, { recursive: true });
  assert.equal(fs.existsSync(target), false);
  record.after = { identities: identities(events), handles: handles(false), directoryAbsent: !fs.existsSync(target) };
  appendResourceRegistry(registry, removed, { reserveBytes: RESOURCE_REGISTRY_CLEANUP_RESERVE_BYTES });
  const final = fs.readFileSync(registry); assert.equal(sha(final.subarray(0, prefix.length)), sha(prefix));
  assert.equal(final.subarray(prefix.length).toString().trim().split('\n').length, 2);
  record.registryAfter = { bytes: final.length, sha256: sha(final), appendedEvents: [preserved.event, removed.event], originalPrefixPreserved: true };
  record.manifest = { path: manifest, sha256: manifestSha }; record.status = 'POSTHOC_CLEANUP_PASS_HISTORICAL_MYSQL_FAIL_RETAINED';
} catch (error) { record.error = error.stack; process.exitCode = 1; }
record.elapsedMs = Date.now() - started; record.rootStillPresent = fs.existsSync(target);
save(receipt, record);
console.log(JSON.stringify({ status: record.status, receipt, error: record.error, rootStillPresent: record.rootStillPresent, elapsedMs: record.elapsedMs }));
