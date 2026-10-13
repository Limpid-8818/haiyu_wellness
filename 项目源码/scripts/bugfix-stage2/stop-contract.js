export function isCleanApiStop(result) {
  return ['exited', 'stopped'].includes(result?.status) && result.exitCode === 0
    && !result.signal && !result.timedOut && Array.isArray(result.pids) && result.pids.length > 0
    && result.pids.every(identity => identity.exitConfirmed === true);
}
