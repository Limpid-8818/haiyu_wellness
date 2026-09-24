import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDirectory = fileURLToPath(new URL('../../server/', import.meta.url));

export async function run() {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'haiyu-quest-q1-6-'));
  const databasePath = path.join(temporaryDirectory, 'community.sqlite');
  let api;

  try {
    api = spawn(process.execPath, ['src/index.js'], {
      cwd: serverDirectory,
      env: { ...process.env, PORT: '0', DB_PATH: databasePath, AUTH_SECRET: 'quest-q1-6-test-secret' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const { port } = await waitForApi(api);
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    const body = await response.json();

    assert.equal(response.status, 200, 'health endpoint must return HTTP 200');
    assert.equal(body.ok, true, 'health response must contain ok=true');
    await access(databasePath);
    assert.ok((await stat(databasePath)).size > 0, 'API must create the temporary SQLite file');

    return { output: ['HTTP 200', 'ok=true'] };
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
      else resolve({ port });
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
