import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertActiveResourceSession } from '../resources/resource-runtime.js';

const serverDirectory = fileURLToPath(new URL('../../server/', import.meta.url));
let defaultResourceSession = null;

export function setDefaultResourceSession(resourceSession) {
  defaultResourceSession = resourceSession || null;
}

export async function withTemporaryApi(callback, prefix = 'haiyu-quest-', extraEnv = {}, {
  databasePath: suppliedDatabasePath, resourceSession
} = {}) {
  const activeResourceSession = resourceSession || defaultResourceSession;
  assertActiveResourceSession(activeResourceSession, 'withTemporaryApi');
  if (typeof callback !== 'function') throw new Error('withTemporaryApi requires a callback');
  return await withManagedTemporaryApi(callback, extraEnv, suppliedDatabasePath, activeResourceSession);
}

async function withManagedTemporaryApi(callback, extraEnv, suppliedDatabasePath, resourceSession) {
  let temporaryDirectory = null;
  let databasePath = suppliedDatabasePath ? path.resolve(suppliedDatabasePath) : null;
  if (databasePath) {
    const managedRoot = `${path.resolve(resourceSession.tempDir)}${path.sep}`;
    if (!databasePath.startsWith(managedRoot)) {
      throw new Error('resource-managed API database must be inside its ResourceSession directory');
    }
    await mkdir(path.dirname(databasePath), { recursive: true });
  } else {
    temporaryDirectory = await resourceSession.allocateDir(`quest-api-${randomUUID()}`);
    databasePath = path.join(temporaryDirectory, 'community.sqlite');
  }

  let apiResource;
  let activePort = null;
  let activeEnvironment = { ...extraEnv };
  async function stopApi(reason) {
    if (!apiResource) return;
    const status = await resourceSession.status();
    const current = status.resources?.find(item => item.id === apiResource.id);
    if (current && ['starting', 'running'].includes(current.status)) {
      const stopped = await resourceSession.stop(apiResource.id, reason);
      if (!stopped.ok) throw new Error(stopped.error || `could not stop API resource ${apiResource.id}`);
    }
    const exited = await resourceSession.waitProcess(apiResource.id, 10_000);
    if (exited.timedOut || exited.unavailable || ['starting', 'running'].includes(exited.status)) {
      throw new Error(`API resource ${apiResource.id} did not exit: ${JSON.stringify(exited)}`);
    }
    apiResource = undefined;
  }

  async function startApi(preferredPort = null) {
    const port = preferredPort || await availableLoopbackPort();
    const allowedEnvironment = Object.fromEntries(
      ['CODEX_TASK_ID', 'DB_DRIVER', 'DEMO_SEED', 'BUSINESS_CLOCK_NOW', 'MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE']
      .concat(['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_TIMEOUT_MS', 'NODE_ENV', 'ENVIRONMENT_MODE', 'ENVIRONMENT_LIVE',
          'ASSISTANT_MODEL_SOURCE',
          'ASSISTANT_TOOL_TIMEOUT_MS', 'ASSISTANT_MAX_RUNTIME_MS', 'ASSISTANT_MAX_MODEL_CALLS',
          'ASSISTANT_MAX_ACTION_MODEL_CALLS',
          'ASSISTANT_MAX_TOOL_ROUNDS', 'ASSISTANT_MAX_TOOL_CALLS', 'ASSISTANT_MAX_TOKENS',
          'ASSISTANT_MAX_ESTIMATED_COST_USD', 'ASSISTANT_INPUT_USD_PER_MILLION_TOKENS',
          'ASSISTANT_OUTPUT_USD_PER_MILLION_TOKENS', 'Q19_ACCEPTANCE_HOOKS',
          'Q19_TEST_ENV_TOOL_TIMEOUT_MS', 'Q19_TEST_EFFECT_ROOT', 'Q19_TEST_EFFECT_PATH',
          'Q20_ACCEPTANCE_HOOKS', 'Q20_TEST_FAIL_AGENT', 'Q21_ACCEPTANCE_HOOKS',
          'WELLNESS_DRAFT_REVIEW_POLICY', 'WELLNESS_DRAFT_REVIEW_SAMPLE_PERCENT',
          'ENVIRONMENT_MODE', 'ENVIRONMENT_LIVE', 'ENVIRONMENT_LOCATION_ID', 'ENVIRONMENT_LOCATION_NAME',
          'ENVIRONMENT_LATITUDE', 'ENVIRONMENT_LONGITUDE', 'ENVIRONMENT_TIME_ZONE',
          'ENVIRONMENT_COORDINATES_STATUS', 'ENVIRONMENT_LOCATION_SOURCE', 'ENVIRONMENT_INSTITUTION_LOCATION_CONFIGURED',
          'ENVIRONMENT_OFFLINE_FIXTURE',
          'ENVIRONMENT_TIDE_PROVIDER', 'ENVIRONMENT_PROVIDER_BUDGET_LEDGER_PATH', 'ENVIRONMENT_PROVIDER_BUDGET_BASELINE',
          'QWEATHER_TIDE_STATION_ID', 'QWEATHER_API_HOST', 'QWEATHER_API_KEY',
          'OPEN_METEO_WEATHER_BASE_URL', 'OPEN_METEO_MARINE_BASE_URL',
          'OPERATIONS_FAILURE_THRESHOLD'])
        .filter(key => Object.hasOwn(activeEnvironment, key))
        .map(key => [key, String(activeEnvironment[key])])
    );
    apiResource = await resourceSession.startProcess({
      label: `quest-api-${allowedEnvironment.DB_DRIVER || 'sqlite'}`, kind: 'api', role: 'api',
      command: process.execPath, args: ['src/index.js'], cwd: serverDirectory, port,
      env: {
        PATH: process.env.PATH || '', PORT: String(port), DB_DRIVER: allowedEnvironment.DB_DRIVER || 'sqlite',
        DEMO_SEED: allowedEnvironment.DEMO_SEED || '1', DB_PATH: databasePath,
        AUTH_SECRET: 'quest-black-box-test-secret', LLM_BASE_URL: '', LLM_API_KEY: '', LLM_MODEL: '', LLM_TIMEOUT_MS: '',
        ENVIRONMENT_MODE: 'demo', ENVIRONMENT_LIVE: '0', ...allowedEnvironment
      }
    });
    if (apiResource.status !== 'running') {
      throw new Error(`API failed to start: ${JSON.stringify(apiResource)}`);
    }
    activePort = port;
    await waitForManagedApi(resourceSession, apiResource.id, port);
    return `http://127.0.0.1:${port}/api`;
  }

  try {
    let baseUrl = await startApi();
    const restartApi = async (environmentOverride = null, { preservePort = false } = {}) => {
      const preferredPort = preservePort ? activePort : null;
      await stopApi('quest-api-restart');
      activeEnvironment = environmentOverride && typeof environmentOverride === 'object'
        ? { ...extraEnv, ...environmentOverride } : { ...extraEnv };
      baseUrl = await startApi(preferredPort);
      return baseUrl;
    };
    return await callback({ baseUrl, databasePath, restartApi });
  } finally {
    await stopApi('quest-api-complete');
  }
}

async function availableLoopbackPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close(error => error ? reject(error) : port ? resolve(port) : reject(new Error('could not reserve a loopback port')));
    });
  });
}

async function waitForManagedApi(resourceSession, resourceId, expectedPort) {
  const timeoutAt = Date.now() + 10_000;
  while (Date.now() < timeoutAt) {
    const status = await resourceSession.status();
    const resource = status.resources?.find(item => item.id === resourceId);
    const log = await resourceSession.rpc({ op: 'log-tail', id: resourceId, maxBytes: 4096 });
    const match = (log.tail || '').match(/API running at http:\/\/localhost:(\d+)\/api/);
    if (match) {
      if (Number(match[1]) !== expectedPort) throw new Error(`API reported unexpected port ${match[1]}`);
      return;
    }
    if (!resource || !['starting', 'running'].includes(resource.status)) {
      const exit = resource
        ? `status=${resource.status} pid=${resource.pid} port=${resource.port} exitCode=${resource.exitCode} signal=${resource.signal} stopReason=${resource.stopReason || 'none'}`
        : 'resource missing';
      throw new Error(`API exited before readiness (${exit}): ${log.tail || 'no API output'}`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const log = await resourceSession.rpc({ op: 'log-tail', id: resourceId, maxBytes: 4096 });
  throw new Error(`API startup timed out: ${log.tail || 'no API output'}`);
}

export function withApiAtDatabase(databasePath, callback, extraEnv = {}, { resourceSession } = {}) {
  return withTemporaryApi(callback, 'haiyu-quest-unused-', extraEnv, { databasePath, resourceSession });
}
