import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
assert.ok(process.env.RESOURCE_TMPDIR?.startsWith('/tmp/haiyu-resource-'));
const env = { ...process.env, NODE_ENV: 'production',
  HAIYU_RESOURCE_BUILD_OUT_DIR: path.join(process.env.RESOURCE_TMPDIR, 'production-build'),
  HAIYU_VITE_CACHE_DIR: path.join(process.env.RESOURCE_TMPDIR, 'vite-cache') };
const result = spawnSync('npm', ['run', 'build', '-w', 'web'], { env, stdio: 'inherit', timeout: 30000 });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
if (process.exitCode === 0) {
  const files = fs.readdirSync(env.HAIYU_RESOURCE_BUILD_OUT_DIR, { recursive: true })
    .map(file => path.join(env.HAIYU_RESOURCE_BUILD_OUT_DIR, file)).filter(file => fs.statSync(file).isFile());
  const bundle = files.map(file => fs.readFileSync(file, 'utf8')).join('');
  for (const password of ['guest2026', 'staff2026', 'dean2026']) assert.ok(!bundle.includes(password), 'production bundle must omit demo passwords');
  console.log(JSON.stringify({ productionBundleFiles: files.length, demoPasswordsPresent: false }));
}
