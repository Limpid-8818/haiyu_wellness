#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDataRetention, validateRetentionConfig } from '../src/data-retention.js';

export async function retentionCli(argv, env = process.env, dependencies = {}) {
  const config = { enabled: false, auditEnabled: false };
  let mode = 'preview', maintenance = false;
  const numbers = { '--run-days': 'runDays', '--mood-days': 'moodDays', '--audit-days': 'auditDays',
    '--batch-size': 'batchSize', '--scan-rows': 'scanRows', '--scan-bytes': 'scanBytes', '--group-rows': 'groupRows' };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (seen.has(flag)) throw new Error('RETENTION_INVALID: duplicate flag');
    seen.add(flag);
    if (flag === '--enabled') config.enabled = true;
    else if (flag === '--audit-enabled') config.auditEnabled = true;
    else if (flag === '--apply') mode = 'apply';
    else if (flag === '--preview' || flag === '--dry-run') {
      if (mode === 'apply') throw new Error('RETENTION_INVALID: conflicting modes');
    } else if (flag === '--maintenance') maintenance = true;
    else if (numbers[flag] && /^\d+$/.test(argv[index + 1] || '')) config[numbers[flag]] = Number(argv[++index]);
    else throw new Error('RETENTION_INVALID: unsupported flag or numeric value');
  }
  if (seen.has('--apply') && (seen.has('--preview') || seen.has('--dry-run'))) throw new Error('RETENTION_INVALID: conflicting modes');
  validateRetentionConfig(config);
  return runDataRetention({ config, mode, maintenance, clock: dependencies.clock,
    openDatabase: async options => {
      // This import happens only after enable/config/apply checks. Never db.js.
      const adapter = await import('../src/data-retention-connection.js');
      const database = adapter.existingDatabaseConfig(env);
      return (dependencies.openDatabase || adapter.openExistingRetentionDatabase)(database, options);
    } });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await retentionCli(process.argv.slice(2)))); }
  catch (error) { console.error(JSON.stringify({ status: 'ERROR', error: error.message })); process.exitCode = 1; }
}
