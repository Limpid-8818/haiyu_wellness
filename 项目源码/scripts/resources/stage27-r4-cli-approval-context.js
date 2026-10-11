import { STAGE27_R4_SOURCE_APPROVAL } from './stage27-r4-budget-accounts.js';

const approvalPathKey = 'STAGE27_R4_SOURCE_EXTRA12_APPROVAL_PATH';
const approvalSha256Key = 'STAGE27_R4_SOURCE_EXTRA12_APPROVAL_SHA256';

export function sanitizeManagedQuestEnvironment(environment, { taskId, stage27, stage27Scope,
  questId, live, stage21AttemptKind = '', stage21EvidencePath = '' }) {
  const inherited = { ...environment };
  const safePath = inherited.PATH || '/usr/bin:/bin';
  const sourceApprovalEligible = stage27 === true && live === true && questId === 'Q27.5'
    && taskId === STAGE27_R4_SOURCE_APPROVAL.sourceTaskId
    && inherited.CODEX_TASK_ID === taskId
    && inherited.CODEX_STAGE27_SCOPE === 'R4'
    && stage27Scope === 'R4';
  const sanitized = { PATH: safePath, CODEX_TASK_ID: taskId, TZ: 'UTC' };
  if (stage27 && ['R2', 'R3', 'R4', 'R5'].includes(stage27Scope)) sanitized.CODEX_STAGE27_SCOPE = stage27Scope;
  if (stage21AttemptKind) sanitized.STAGE21_LIVE_ATTEMPT_KIND = stage21AttemptKind;
  if (stage21EvidencePath) sanitized.STAGE21_EVIDENCE_PATH = stage21EvidencePath;
  if (sourceApprovalEligible) {
    if (typeof inherited[approvalPathKey] === 'string') sanitized[approvalPathKey] = inherited[approvalPathKey];
    if (typeof inherited[approvalSha256Key] === 'string') sanitized[approvalSha256Key] = inherited[approvalSha256Key];
  }
  for (const key of Object.keys(environment)) delete environment[key];
  Object.assign(environment, sanitized);
  return { sourceApprovalEligible, forwardedApprovalFields: [
    ...(Object.hasOwn(sanitized, approvalPathKey) ? [approvalPathKey] : []),
    ...(Object.hasOwn(sanitized, approvalSha256Key) ? [approvalSha256Key] : [])
  ] };
}

export function q275SourceApprovalParameters(environment = process.env) {
  return {
    approvalPath: typeof environment[approvalPathKey] === 'string' ? environment[approvalPathKey] : '',
    approvalSha256: typeof environment[approvalSha256Key] === 'string' ? environment[approvalSha256Key] : ''
  };
}
