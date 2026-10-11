#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const MAX_REGISTRY_BYTES = 32 * 1024 * 1024;
const MAX_REGISTRY_ROW_BYTES = 64 * 1024;
const INSTANCE_EVENTS = new Set([
  'runner_started', 'guardian_ready', 'guardian_started', 'guardian_start_failed',
  'guardian_exit_wait_timeout', 'guardian_control_plane_closed', 'guardian_pid_exited',
  'guardian_pid_exit_reconciled', 'process_starting', 'process_started', 'child_process_started',
  'process_exit', 'pid_exit_confirmed', 'resource_cleanup_summary', 'owner_exit_detected',
  'instance_cleaned', 'instance_cleanup_preserved', 'instance_cleanup_blocked',
  'posthoc_failure_diagnostic_preserved', 'posthoc_resource_directory_removed'
]);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseRoot(argv) {
  const index = argv.indexOf('--root');
  return index >= 0 && argv[index + 1]
    ? path.resolve(argv[index + 1])
    : path.join(projectRoot, 'output', 'resource-audit');
}

function collectRegistries(root) {
  const result = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    if (!fs.existsSync(current)) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(target);
      else if (entry.isFile() && entry.name === 'registry.jsonl') result.push(path.resolve(target));
    }
  }
  return result.sort();
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function streamJsonLines(filePath, { optional = false, onEvent = () => {} } = {}) {
  if (!fs.existsSync(filePath)) {
    if (optional) return { events: 0, errors: [] };
    return { events: 0, errors: [`missing file: ${filePath}`] };
  }
  const errors = [];
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  let eventCount = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line) continue;
    if (Buffer.byteLength(line) > MAX_REGISTRY_ROW_BYTES) {
      errors.push(`row ${lineNumber} exceeds ${MAX_REGISTRY_ROW_BYTES} bytes`);
      continue;
    }
    try { onEvent(JSON.parse(line)); eventCount += 1; }
    catch { errors.push(`row ${lineNumber} is not valid JSON`); }
  }
  return { events: eventCount, errors };
}

function identityKey(event, prefix = '') {
  const pid = event[`${prefix}pid`] ?? event.pid;
  const startTime = event[`${prefix}StartTime`] ?? event.processStartTime ?? event.ownerStartTime;
  const fingerprint = event[`${prefix}Fingerprint`] ?? event.processFingerprint ?? event.ownerFingerprint;
  return `${pid ?? ''}|${startTime ?? ''}|${fingerprint ?? ''}`;
}

function summarizeInstance(state) {
  const starts = [...state.processStarts.values()];
  const missingPidExits = starts.filter(event => !state.processExitKeys.has(identityKey(event)));
  const guardianStart = state.guardianStart;
  const guardianExit = state.guardianExit;
  const guardianExitMatches = Boolean(guardianStart && guardianExit &&
    Number(guardianStart.guardianPid) === Number(guardianExit.guardianPid) &&
    guardianStart.guardianStartTime === guardianExit.guardianStartTime &&
    (!guardianStart.guardianFingerprint || !guardianExit.guardianFingerprint ||
      guardianStart.guardianFingerprint === guardianExit.guardianFingerprint));
  const countMismatch = state.terminal && Number.isInteger(state.terminal.resourceCount)
    ? state.terminal.resourceCount !== state.cleanupSummaryCount : false;
  return {
    taskId: state.taskId,
    instanceId: state.instanceId,
    registryPath: state.registryPath,
    resourceStarts: starts.length, exactPidExitEvents: state.processExitKeys.size,
    missingPidExitCount: missingPidExits.length,
    missingPidExitSample: missingPidExits.slice(0, 5).map(event => ({ pid: event.pid,
      startTime: event.processStartTime, fingerprint: event.processFingerprint, resourceId: event.resourceId })),
    resourceCleanupSummaries: state.cleanupSummaryCount, terminalEvent: state.terminal?.event || null,
    terminalResourceCountMismatch: countMismatch, guardianStarted: Boolean(guardianStart),
    guardianExitEventMatches: guardianExitMatches,
    guardianExitEvidenceType: guardianExit?.event || null,
    guardianExitEvidenceGap: Boolean(guardianStart && !guardianExitMatches),
    posthocDiagnosticPreserved: state.posthocDiagnostic ? {
      path: state.posthocDiagnostic.diagnosticPath || null,
      sha256: state.posthocDiagnostic.diagnosticSha256 || null
    } : null,
    posthocDirectoryRemoval: state.posthocRemoval ? {
      path: state.posthocRemoval.tempDir || null,
      exitCode: state.posthocRemoval.exitCode ?? null,
      exactIdentityChecks: state.posthocRemoval.exactIdentityChecks ?? null,
      exactIdentitiesPresent: state.posthocRemoval.exactIdentitiesPresent ?? null,
      processGroupsRemaining: state.posthocRemoval.processGroupsRemaining ?? null,
      lsofPlusDMatches: state.posthocRemoval.lsofPlusDMatches ?? null,
      lsofPlusL1MatchesAfterRemoval: state.posthocRemoval.lsofPlusL1MatchesAfterRemoval ?? null,
      directoryAbsentAfterRemoval: state.posthocRemoval.directoryAbsentAfterRemoval ?? null
    } : null
  };
}

async function auditRegistry(filePath) {
  const stat = fs.statSync(filePath);
  const eventCounts = {};
  const instances = new Map();
  const parsed = await streamJsonLines(filePath, { onEvent: event => {
    eventCounts[event.event || 'unknown'] = (eventCounts[event.event || 'unknown'] || 0) + 1;
    if (!event.instanceId || !INSTANCE_EVENTS.has(event.event)) return;
    let state = instances.get(event.instanceId);
    if (!state) {
      state = { taskId: event.taskId || null, instanceId: event.instanceId, registryPath: filePath,
        processStarts: new Map(), processExitKeys: new Set(), cleanupSummaryCount: 0,
        terminal: null, guardianStart: null, guardianExit: null, posthocDiagnostic: null, posthocRemoval: null };
      instances.set(event.instanceId, state);
    }
    if (event.event === 'runner_started') state.taskId = event.taskId;
    else if (event.event === 'process_started' || event.event === 'child_process_started') {
      if (Number.isInteger(event.pid)) state.processStarts.set(identityKey(event), event);
    } else if (event.event === 'pid_exit_confirmed' && event.exactIdentityExited === true) {
      state.processExitKeys.add(identityKey(event));
    } else if (event.event === 'resource_cleanup_summary') state.cleanupSummaryCount += 1;
    else if (['instance_cleaned', 'instance_cleanup_preserved', 'instance_cleanup_blocked'].includes(event.event)) state.terminal = event;
    else if (event.event === 'guardian_started' || event.event === 'guardian_ready') state.guardianStart = event;
    else if (event.event === 'guardian_pid_exited' ||
        (event.event === 'guardian_pid_exit_reconciled' && event.exactIdentityExited === true)) state.guardianExit = event;
    else if (event.event === 'posthoc_failure_diagnostic_preserved') state.posthocDiagnostic = event;
    else if (event.event === 'posthoc_resource_directory_removed') state.posthocRemoval = event;
  } });
  const summarizedInstances = [...instances.values()].map(summarizeInstance);
  return {
    path: filePath, bytes: stat.size, hardLimitBytes: MAX_REGISTRY_BYTES,
    sha256: await sha256File(filePath), rows: parsed.events,
    eventCounts, instanceCount: instances.size,
    cleanupTerminalGaps: summarizedInstances.filter(item => !item.terminalEvent).length,
    guardianExitGaps: summarizedInstances.filter(item => item.guardianExitEvidenceGap).length,
    pidExitEvidenceGaps: summarizedInstances.reduce((sum, item) => sum + item.missingPidExitCount, 0),
    resourceCountMismatches: summarizedInstances.filter(item => item.terminalResourceCountMismatch).length,
    instanceSummaries: summarizedInstances,
    errors: [...(stat.size > MAX_REGISTRY_BYTES ? [`registry exceeds ${MAX_REGISTRY_BYTES} byte hard limit`] : []), ...parsed.errors]
  };
}

async function main() {
  const root = parseRoot(process.argv.slice(2));
  const paths = collectRegistries(root);
  const registries = [];
  for (const registryPath of paths) registries.push(await auditRegistry(registryPath));
  const manifestPath = path.join(root, 'registry-segments.jsonl');
  const manifestBytes = fs.existsSync(manifestPath) ? fs.statSync(manifestPath).size : 0;
  let segmentEntries = 0;
  let firstSegment = null;
  const listedPaths = new Set();
  const legacySnapshots = new Set();
  const manifestPathErrors = [];
  const manifest = await streamJsonLines(manifestPath, { optional: true, onEvent: event => {
    if (event.event !== 'resource_registry_segment_selected') return;
    segmentEntries += 1;
    firstSegment ||= event;
    const segmentRoot = path.resolve(event.segmentRoot || '');
    const registryPath = path.resolve(event.registryPath || '');
    const expectedRegistryPath = path.join(segmentRoot, 'registry.jsonl');
    const segmentsRoot = path.join(root, 'segments');
    const relativeRegistryPath = path.relative(segmentsRoot, registryPath);
    if (!event.segmentRoot || !event.registryPath || registryPath !== expectedRegistryPath ||
        relativeRegistryPath === '..' || relativeRegistryPath.startsWith(`..${path.sep}`) || path.isAbsolute(relativeRegistryPath)) {
      manifestPathErrors.push(`invalid segment paths in manifest row for instance ${event.instanceId || 'unknown'}`);
    } else listedPaths.add(registryPath);
    if (event.hardLimitBytes !== MAX_REGISTRY_BYTES) {
      manifestPathErrors.push(`segment manifest has an unexpected hard limit for instance ${event.instanceId || 'unknown'}`);
    }
    if (!Number.isInteger(event.cleanupReserveBytes) || event.cleanupReserveBytes < 0 ||
        event.cleanupReserveBytes >= MAX_REGISTRY_BYTES) {
      manifestPathErrors.push(`segment manifest has an invalid cleanup reserve for instance ${event.instanceId || 'unknown'}`);
    }
    if (!Number.isInteger(event.legacyRegistryBytes) || !/^[a-f0-9]{64}$/.test(event.legacyRegistrySha256 || '')) {
      manifestPathErrors.push(`segment manifest has an invalid legacy snapshot for instance ${event.instanceId || 'unknown'}`);
    }
    if (path.resolve(event.legacyRegistryPath || '') !== path.resolve(root, 'registry.jsonl')) {
      manifestPathErrors.push(`segment manifest points outside the legacy registry for instance ${event.instanceId || 'unknown'}`);
    }
    legacySnapshots.add(`${path.resolve(event.legacyRegistryPath || root)}|${event.legacyRegistryBytes}|${event.legacyRegistrySha256}`);
  } });
  const segmentPaths = paths.filter(filePath => filePath.startsWith(`${path.join(root, 'segments')}${path.sep}`));
  const unlistedSegmentPaths = segmentPaths.filter(filePath => !listedPaths.has(filePath));
  const missingListedPaths = [...listedPaths].filter(filePath => !fs.existsSync(filePath));
  const legacySnapshotInconsistency = legacySnapshots.size > 1;
  const legacyPath = path.join(root, 'registry.jsonl');
  const expectedLegacyBytes = firstSegment?.legacyRegistryBytes;
  const expectedLegacySha = firstSegment?.legacyRegistrySha256;
  const legacyExists = fs.existsSync(legacyPath);
  const legacyBytes = legacyExists ? fs.statSync(legacyPath).size : 0;
  const legacySha = legacyExists ? await sha256File(legacyPath) : crypto.createHash('sha256').digest('hex');
  const legacySnapshotMatches = expectedLegacyBytes === undefined ||
    (legacyBytes === expectedLegacyBytes && legacySha === expectedLegacySha);
  const duplicateInstanceIds = [];
  const seenInstances = new Map();
  for (const registry of registries) {
    for (const instance of registry.instanceSummaries) {
      const previous = seenInstances.get(instance.instanceId);
      if (previous && previous !== registry.path) duplicateInstanceIds.push(instance.instanceId);
      else seenInstances.set(instance.instanceId, registry.path);
    }
  }
  const structuralErrors = [
    ...registries.flatMap(registry => registry.errors.map(error => `${registry.path}: ${error}`)),
    ...manifest.errors.map(error => `${manifestPath}: ${error}`),
    ...(manifestBytes > MAX_REGISTRY_BYTES ? [`${manifestPath}: manifest exceeds ${MAX_REGISTRY_BYTES} byte hard limit`] : []),
    ...manifestPathErrors,
    ...unlistedSegmentPaths.map(filePath => `segment registry missing manifest entry: ${filePath}`),
    ...missingListedPaths.map(filePath => `manifest registry path is missing: ${filePath}`),
    ...(legacySnapshotInconsistency ? ['segment manifest contains inconsistent legacy registry snapshots'] : []),
    ...(!legacySnapshotMatches ? ['legacy registry no longer matches the captured size and SHA-256'] : []),
    ...duplicateInstanceIds.map(instanceId => `instanceId appears in more than one registry: ${instanceId}`)
  ];
  const result = {
    status: structuralErrors.length ? 'FAIL' : 'PASS_STRUCTURAL_AUDIT',
    root, legacyRegistry: { path: legacyPath, exists: legacyExists, bytes: legacyBytes, sha256: legacySha,
      expectedBytes: expectedLegacyBytes ?? null, expectedSha256: expectedLegacySha ?? null, snapshotMatches: legacySnapshotMatches },
    manifest: { path: manifestPath, exists: fs.existsSync(manifestPath), bytes: manifestBytes, rows: manifest.events,
      selectedSessionEntries: segmentEntries, uniqueRegistryPaths: listedPaths.size,
      unlistedSegmentPaths, missingListedPaths, inconsistentLegacySnapshot: legacySnapshotInconsistency },
    registryCount: registries.length,
    totalBytes: registries.reduce((sum, registry) => sum + registry.bytes, 0),
    totalInstances: registries.reduce((sum, registry) => sum + registry.instanceCount, 0),
    registries: registries.map(({ instanceSummaries, ...registry }) => registry),
    historicalCompleteness: {
      instancesWithoutTerminalRecord: registries.reduce((sum, registry) => sum + registry.cleanupTerminalGaps, 0),
      instancesWithoutMatchingGuardianExitEvent: registries.reduce((sum, registry) => sum + registry.guardianExitGaps, 0),
      processIdentitiesWithoutExactExitEvent: registries.reduce((sum, registry) => sum + registry.pidExitEvidenceGaps, 0),
      terminalResourceCountMismatches: registries.reduce((sum, registry) => sum + registry.resourceCountMismatches, 0)
    },
    structuralErrors
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (structuralErrors.length) process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write(`RESOURCE_REGISTRY_AUDIT_FAIL ${String(error?.message || error)}\n`);
  process.exitCode = 1;
});
