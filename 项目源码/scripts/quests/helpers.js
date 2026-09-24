import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDirectory = fileURLToPath(new URL('../../server/', import.meta.url));

export async function withTemporaryApi(callback, prefix = 'haiyu-quest-', extraEnv = {}) {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), prefix));
  const databasePath = path.join(temporaryDirectory, 'community.sqlite');
  let api;
  let baseUrl;

  async function startApi() {
    api = spawn(process.execPath, ['src/index.js'], {
      cwd: serverDirectory,
      env: {
        ...process.env,
        PORT: '0',
        DB_PATH: databasePath,
        AUTH_SECRET: 'quest-black-box-test-secret',
        LLM_BASE_URL: '',
        LLM_API_KEY: '',
        ...extraEnv
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const port = await waitForApi(api);
    baseUrl = `http://127.0.0.1:${port}/api`;
    return baseUrl;
  }

  try {
    await startApi();
    const restartApi = async () => {
      if (api && api.exitCode === null && api.signalCode === null) await stopApi(api);
      api = undefined;
      return startApi();
    };
    return await callback({ baseUrl, databasePath, restartApi });
  } finally {
    if (api && api.exitCode === null && api.signalCode === null) await stopApi(api);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function waitForApi(api) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => finish(new Error(`API startup timed out. stdout=${stdout} stderr=${stderr}`)), 10_000);
    timeout.unref();

    function finish(error, port) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(port);
    }

    api.stdout.setEncoding('utf8');
    api.stderr.setEncoding('utf8');
    api.stdout.on('data', chunk => {
      stdout += chunk;
      const match = stdout.match(/API running at http:\/\/localhost:(\d+)\/api/);
      if (match) finish(null, Number(match[1]));
    });
    api.stderr.on('data', chunk => { stderr += chunk; });
    api.once('error', error => finish(error));
    api.once('exit', (code, signal) => {
      finish(new Error(`API exited before listening (code=${code}, signal=${signal}). stdout=${stdout} stderr=${stderr}`));
    });
  });
}

function stopApi(api) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      api.kill('SIGKILL');
      finish(new Error('API did not stop after SIGTERM'));
    }, 5_000);
    timeout.unref();

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    }

    api.once('exit', () => finish());
    api.kill('SIGTERM');
  });
}
