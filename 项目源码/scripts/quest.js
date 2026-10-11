import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseQuestArgs } from './quest-args.js';
import { quests, questsForStage, runRegisteredQuest } from './quest-registry.js';
import { ResourceSession } from './resources/resource-runtime.js';
import { setDefaultResourceSession } from './quests/helpers.js';
import { startQ17Mysql } from './quests/q17-resources.js';
import { loadApprovedLlmConfig } from './resources/load-approved-llm-config.js';
import { loadApprovedEnvironmentConfig } from './resources/load-approved-environment-config.js';
import { DALIAN_ETDZ_REGION_REPRESENTATIVE, liveEnvironmentConfig } from '../server/src/environment-config.js';
import { sanitizeManagedQuestEnvironment } from './resources/stage27-r4-cli-approval-context.js';

export { parseQuestArgs } from './quest-args.js';



function usage() {
  return 'Usage: npm run quest -- <quest-id> [--db <sqlite-path>|--db=mysql] [--preflight|--live] | --stage <number> [--db <sqlite-path>|--db=mysql] [--live]';
}

export async function main(args = process.argv.slice(2)) {
  let options;
  try {
    options = parseQuestArgs(args);
  } catch (error) {
    console.error(`${error.message}\n${usage()}`);
    return 1;
  }
  if (options.help) {
    console.log(`${usage()}\nAvailable quests: ${Object.keys(quests).join(', ')}`);
    return 0;
  }

  let selected = options.questId
    ? (quests[options.questId] ? [options.questId] : [])
    : questsForStage(options.stage);
  // R5's full-stage command is an evidence-only aggregate. It must never
  // replay Q27.1–Q27.8 as the generic stage selector normally would.
  if (!options.questId && options.stage === 27 && process.env.CODEX_STAGE27_SCOPE === 'R5') {
    selected = quests['Q27.9'] ? ['Q27.9'] : [];
  }
  if (!selected.length) {
    console.error(options.questId
      ? `Invalid quest ID: ${options.questId}`
      : `No terminal quests are registered for stage ${options.stage}`);
    console.error(usage());
    return 1;
  }
  if (options.preflight && options.questId !== 'Q22.9') {
    console.error('--preflight is only supported for Q22.9');
    return 1;
  }

  let ownedDirectory;
  let resourceSession;
  let taskFailed = false;
  let blocked = false;
  const stage15 = options.stage === 15 || options.questId?.startsWith('Q15.');
  const stage16 = options.stage === 16 || options.questId?.startsWith('Q16.');
  const stage17 = options.stage === 17 || options.questId?.startsWith('Q17.');
  const stage18 = options.stage === 18 || options.questId?.startsWith('Q18.');
  const stage19 = options.stage === 19 || options.questId?.startsWith('Q19.');
  const stage20 = options.stage === 20 || options.questId?.startsWith('Q20.');
  const stage21 = options.stage === 21 || options.questId?.startsWith('Q21.');
  const stage22 = options.stage === 22 || options.questId?.startsWith('Q22.');
  const stage23 = options.stage === 23 || options.questId?.startsWith('Q23.');
  const stage24 = options.stage === 24 || options.questId?.startsWith('Q24.');
  const stage25 = options.stage === 25 || options.questId?.startsWith('Q25.');
  const stage26 = options.stage === 26 || options.questId?.startsWith('Q26.');
  const stage27 = options.stage === 27 || options.questId?.startsWith('Q27.');
  const stage27Scope = stage27 && ['R2', 'R3', 'R4', 'R5'].includes(process.env.CODEX_STAGE27_SCOPE)
    ? process.env.CODEX_STAGE27_SCOPE : '';
  const managedLegacyQuest = selected.some(id => /^Q[1-7]\./u.test(id));
  const managedStage = managedLegacyQuest || stage15 || stage16 || stage17 || stage18 || stage19 || stage20 || stage21 || stage22 || stage23 || stage24 || stage25 || stage26 || stage27;
  let liveModelConfig = null;
  let liveEnvironment = null;
  const liveStage20Quests = new Set(['Q20.2', 'Q20.3', 'Q20.4', 'Q20.5', 'Q20.6']);
  if (options.live && (stage17 || stage18 || options.stage === 17 || options.stage === 18 || options.stage === 19 || options.stage === 20)) {
    console.error('Run one supported Stage19/20 quest with --live; full-stage acceptance uses recorded fixtures.');
    return 1;
  }
  if (options.live && stage20 && !liveStage20Quests.has(options.questId)) {
    console.error(`BLOCKED ${options.questId || 'Stage20'}: only Q20.2–Q20.6 have bounded live-provider acceptance.`);
    return 2;
  }
  const liveStage21Quests = new Set(['Q21.2', 'Q21.5']);
  if (options.live && stage21 && !liveStage21Quests.has(options.questId)) {
    console.error(`BLOCKED ${options.questId || 'Stage21'}: only Q21.2 and Q21.5 have one-shot live-provider acceptance.`);
    return 2;
  }
  const liveStage22Quests = new Set(['Q22.9']);
  if (options.live && stage22 && !liveStage22Quests.has(options.questId)) {
    console.error(`BLOCKED ${options.questId || 'Stage22'}: only Q22.9 has one-shot live-provider acceptance.`);
    return 2;
  }
  if (options.live && stage23 && options.questId !== 'Q23.2') {
    console.error(`BLOCKED ${options.questId || 'Stage23'}: only one Q23.2 live-provider run is allowed after offline gates.`);
    return 2;
  }
  if (options.live && stage24) {
    console.error(`BLOCKED ${options.questId || 'Stage24'}: Stage24 uses offline fixtures only; no provider calls are authorized.`);
    return 2;
  }
  if (options.live && stage25) {
    console.error(`BLOCKED ${options.questId || 'Stage25'}: Stage25 uses local fixtures only; no provider or external notification calls are authorized.`);
    return 2;
  }
  if (options.live && stage26) {
    console.error(`BLOCKED ${options.questId || 'Stage26'}: Stage26 uses isolated local protocol fixtures only; no external provider or notification calls are authorized.`);
    return 2;
  }
  if (options.live && stage27 && (stage27Scope === 'R5' || !['Q27.5', 'Q27.6'].includes(options.questId))) {
    console.error(`BLOCKED ${options.questId || 'Stage27'}: only Q27.5 and Q27.6 have bounded live acceptance.`);
    return 2;
  }
  if (options.live && (stage19 || stage20 || stage21 || stage22 || stage23 || options.questId === 'Q27.5')) {
    liveModelConfig = await loadApprovedLlmConfig();
    if (!liveModelConfig.configured) {
      console.error(`BLOCKED ${options.questId}: ${liveModelConfig.error || '模型配置不可用'}`);
      return 2;
    }
    if (stage23 && liveModelConfig.env?.LLM_MODEL !== 'deepseek-flash') {
      console.error(`BLOCKED ${options.questId}: Stage23 live acceptance requires the approved deepseek-flash model; no provider request was made.`);
      return 2;
    }
  }
  if (options.live && options.questId === 'Q27.6') {
    const approved = await loadApprovedEnvironmentConfig();
    const effectiveEnv = { ...approved.env };
    const configuredLocationKeys = ['ENVIRONMENT_LOCATION_ID', 'ENVIRONMENT_LOCATION_NAME',
      'ENVIRONMENT_LATITUDE', 'ENVIRONMENT_LONGITUDE', 'ENVIRONMENT_TIME_ZONE'];
    const completeLocationConfigured = configuredLocationKeys.every(key => String(effectiveEnv[key] || '').trim());
    if (!completeLocationConfigured) Object.assign(effectiveEnv, {
      ENVIRONMENT_LOCATION_ID: DALIAN_ETDZ_REGION_REPRESENTATIVE.id,
      ENVIRONMENT_LOCATION_NAME: DALIAN_ETDZ_REGION_REPRESENTATIVE.name,
      ENVIRONMENT_LATITUDE: String(DALIAN_ETDZ_REGION_REPRESENTATIVE.latitude),
      ENVIRONMENT_LONGITUDE: String(DALIAN_ETDZ_REGION_REPRESENTATIVE.longitude),
      ENVIRONMENT_TIME_ZONE: DALIAN_ETDZ_REGION_REPRESENTATIVE.timeZone,
      ENVIRONMENT_COORDINATES_STATUS: DALIAN_ETDZ_REGION_REPRESENTATIVE.coordinatesStatus,
      ENVIRONMENT_LOCATION_SOURCE: DALIAN_ETDZ_REGION_REPRESENTATIVE.locationSource,
      ENVIRONMENT_INSTITUTION_LOCATION_CONFIGURED: '0'
    });
    liveEnvironment = { ...liveEnvironmentConfig(effectiveEnv),
      approvedConfiguration: { file: approved.file, configuredKeys: approved.configuredKeys,
        configuredSourcesByKey: approved.sourceByKey, credentialValuesRecorded: false },
      representativePointApplied: !completeLocationConfigured,
      regionConfirmed: '大连开发区' };
  }
  try {
    if (managedStage) {
      const taskId = process.env.CODEX_TASK_ID;
      if (!taskId) throw new Error(`Stage${stage15 ? '15' : stage16 ? '16' : stage17 ? '17' : stage18 ? '18' : stage19 ? '19' : stage20 ? '20' : stage21 ? '21' : stage22 ? '22' : stage23 ? '23' : stage24 ? '24' : stage25 ? '25' : stage26 ? '26' : '27'} resource-managed acceptance requires CODEX_TASK_ID`);
      const stage21AttemptKind = stage21 && ['diagnostic', 'repair-validation'].includes(process.env.STAGE21_LIVE_ATTEMPT_KIND)
        ? process.env.STAGE21_LIVE_ATTEMPT_KIND : '';
      const stage21EvidencePath = stage21 && process.env.STAGE21_EVIDENCE_PATH
        ? path.resolve(process.env.STAGE21_EVIDENCE_PATH) : '';
      if (stage21EvidencePath) {
        const evidenceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../output/resource-audit');
        const relativeEvidencePath = path.relative(evidenceRoot, stage21EvidencePath);
        if (relativeEvidencePath === '..' || relativeEvidencePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativeEvidencePath)) {
          throw new Error('STAGE21_EVIDENCE_PATH must stay under output/resource-audit');
        }
      }
      sanitizeManagedQuestEnvironment(process.env, { taskId, stage27, stage27Scope,
        questId: options.questId, live: options.live, stage21AttemptKind, stage21EvidencePath });
      if (stage27Scope === 'R5' && process.env.CODEX_STAGE27_SCOPE !== 'R5') {
        throw new Error('R5 managed Quest routing marker was not preserved by environment sanitization; refusing to run against a legacy evidence path.');
      }
      resourceSession = await ResourceSession.create({
        taskId, projectRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), tempParent: '/tmp'
      });
      setDefaultResourceSession(resourceSession);
      if ((stage15 || stage16 || stage17 || stage18 || stage19 || stage20 || stage21 || stage22 || stage23 || stage24 || stage25 || stage26 || stage27)
        && !options.live && !options.preflight) {
        const needsMysql = !stage27 || ['Q27.2', 'Q27.7'].includes(options.questId);
        if (needsMysql) {
          const prefix = stage15 ? 'q15' : stage16 ? 'q16' : stage17 ? 'q17' : stage18 ? 'q18' : stage19 ? 'q19' : stage20 ? 'q20' : stage21 ? 'q21' : stage22 ? 'q22' : stage23 ? 'q23' : stage24 ? 'q24' : stage25 ? 'q25' : stage26 ? 'q26' : 'q27';
          const mysql = await startQ17Mysql(resourceSession, prefix);
          Object.assign(process.env, mysql.env);
        }
      }
    }

    let dbPath = options.dbPath;
    if (managedStage) {
      const questDirectory = await resourceSession.allocateDir('quest-main');
      dbPath = path.join(questDirectory, 'quest.sqlite');
    } else if (dbPath) {
      dbPath = path.resolve(dbPath);
      await mkdir(path.dirname(dbPath), { recursive: true });
    } else {
      ownedDirectory = await mkdtemp(path.join(os.tmpdir(), 'haiyu-quest-run-'));
      dbPath = path.join(ownedDirectory, 'quest.sqlite');
    }

    process.env.DB_DRIVER = options.dbDriver || 'sqlite';
    process.env.DB_PATH = dbPath;
    // Quest API fixtures opt into the demo seed explicitly; regular server
    // starts remain empty unless DEMO_SEED=1 is supplied by the operator.
    process.env.DEMO_SEED = '1';
    process.env.QUEST_LIVE = options.live ? '1' : '0';
    if (!options.live) {
      // A regular Quest run has no model credentials or endpoint, even when the
      // shell inherited them. Quest modules receive an explicit `live: false`.
      process.env.LLM_BASE_URL = '';
      process.env.LLM_API_KEY = '';
      process.env.LLM_MODEL = '';
    }

    let failed = false;
    for (const questId of selected) {
      try {
        const result = await runRegisteredQuest(questId, { stage: options.stage ?? (stage20 && !options.live ? 20 : stage21 && !options.live ? 21 : stage22 && !options.live ? 22 : stage23 && !options.live ? 23 : stage24 && !options.live ? 24 : stage25 && !options.live ? 25 : stage26 && !options.live ? 26 : stage27 && !options.questId && !options.live ? 27 : null), dbPath,
          live: options.live, preflight: options.preflight, liveConfig: liveModelConfig?.env || null,
          liveEnvironment: liveEnvironment || null, resourceSession });
        if (!result || !Array.isArray(result.output)) throw new Error('quest did not return an output array');
        console.log(`PASS ${questId}`);
        for (const line of result.output) console.log(line);
      } catch (error) {
        taskFailed = true;
        if (error?.stageBlocked === true) {
          blocked = true;
          console.error(`BLOCKED ${questId}: ${error.message}`);
        } else {
          failed = true;
          console.error(`FAIL ${questId}: ${error?.stack || error}`);
        }
      }
    }
    if (stage17) {
      for (const questId of ['Q12.7', 'Q12.11']) {
        try {
          const { run } = await import(quests[questId]);
          const result = await run({ questId, resourceSession });
          if (!result || !Array.isArray(result.output)) throw new Error('regression quest did not return an output array');
          console.log(`PASS ${questId} (Stage12 regression)`);
          for (const line of result.output) console.log(line);
        } catch (error) {
          failed = true;
          taskFailed = true;
          console.error(`FAIL ${questId} (Stage12 regression): ${error?.stack || error}`);
        }
      }
    }
    return failed ? 1 : blocked ? 2 : 0;
  } catch (error) {
    taskFailed = true;
    throw error;
  } finally {
    if (ownedDirectory) await rm(ownedDirectory, { recursive: true, force: true });
    if (resourceSession) {
      setDefaultResourceSession(null);
      const label = stage15 ? 'stage15' : stage16 ? 'stage16' : stage17 ? 'stage17' : stage18 ? 'stage18' : stage19 ? 'stage19' : stage20 ? 'stage20' : stage21 ? 'stage21' : stage22 ? 'stage22' : stage23 ? 'stage23' : stage24 ? 'stage24' : stage25 ? 'stage25' : stage26 ? 'stage26' : 'stage27';
      if (stage19 || stage20 || stage22 || stage24 || stage25 || stage26 || stage27) {
        try {
          const { db } = await import('../server/src/db.js');
          await db.close();
        } catch (error) {
          taskFailed = true;
          console.error(`STAGE19_MANAGER_DATABASE_CLOSE_FAIL ${error.message}`);
        }
      }
      await resourceSession.close(taskFailed ? `${label}-quest-failure` : `${label}-quest-complete`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) {
    console.error(`QUEST_RUN_FAIL ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}
