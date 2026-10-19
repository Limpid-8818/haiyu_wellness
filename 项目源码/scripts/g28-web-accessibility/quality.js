import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
const eager = fs.readdirSync('web/src/styles').filter(f => f.endsWith('.css') && !['index.css', 'assistant.css', 'agent.css', 'operations.css'].includes(f));
const commands = [
  ['npm', ['run', 'lint', '-w', 'web']],
  [process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'scripts/g28-web-accessibility/vitest.config.js']],
  [process.execPath, ['scripts/g28-web-accessibility/build.js']],
  [process.execPath, ['web/scripts/css-conflict-check.mjs', 'assistant.css', 'agent.css', 'operations.css', '--eager', ...eager]],
  [process.execPath, ['web/scripts/css-shorthand-conflict-check.mjs']],
  [process.execPath, ['scripts/g28-web-accessibility/css-contract.js']],
  [process.execPath, ['scripts/css-multiset-diff.mjs', 'd62608266aa7ee118ab43c30ced5847c204fb100', 'WORKTREE'], 'web'],
];
for (const [command, args, cwd] of (process.argv.includes('--build-css') ? commands.slice(2) : commands)) {
  console.log(JSON.stringify({ command, args }));
  const result = spawnSync(command, args, { stdio: 'inherit', timeout: 20000, ...(cwd ? { cwd } : {}) });
  console.log(JSON.stringify({ command, exit: result.status, signal: result.signal }));
  if (result.error || result.status !== 0) throw result.error || new Error('quality command failed');
}
