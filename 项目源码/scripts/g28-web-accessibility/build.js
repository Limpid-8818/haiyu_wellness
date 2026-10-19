import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { build } from 'vite';
process.env.NODE_ENV = 'production';
const temp = process.env.RESOURCE_TMPDIR;
assert.ok(temp.startsWith('/tmp/haiyu-resource-'));
const outDir = path.join(temp, 'build');
await build({ root: path.resolve('web'), envDir: temp, cacheDir: path.join(temp, 'cache'), build: { outDir, emptyOutDir: true } });
const files = fs.readdirSync(outDir, { recursive: true }).map(file => path.join(outDir, file)).filter(file => fs.statSync(file).isFile());
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  for (const password of ['guest2026', 'staff2026', 'dean2026']) assert.ok(!text.includes(password));
}
console.log(JSON.stringify({ productionFiles: files.length, demoPasswordsPresent: false, envDir: temp, outDir }));
