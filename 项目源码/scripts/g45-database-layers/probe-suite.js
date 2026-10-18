// All child probes and persistent synthetic files belong to this second, bounded session.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { ResourceSession } from '../resources/resource-runtime.js';

const out = process.env.G45_AUDIT_ROOT;
assert.ok(out && process.env.CODEX_TASK_ID);
const attempt = process.env.G45_ATTEMPT;
const session = await ResourceSession.create({ taskId: process.env.CODEX_TASK_ID,
  auditRoot: path.join(out, 'runtime', `${attempt}-probes`),
  limits: { leaseMs: 900000, logBytes: 8388608, directoryBytes: 536870912 } });
try {
  const directory = await session.allocateDir('synthetic-databases');
  for (const seed of ['0', '1']) {
    for (const phase of ['new', 'restart']) {
      const name = `seed${seed}-${phase}`;
      const file = path.join(out, `${attempt}-${name}.json`);
      assert.equal(fs.existsSync(file), false);
      const result = await session.runProcess({ command: process.execPath,
        args: ['scripts/g45-database-layers/snapshot.js', file], cwd: process.cwd(),
        label: name, kind: 'test', role: 'test', datadir: directory,
        env: { ...process.env, BUSINESS_CLOCK_NOW: '2030-06-15T04:00:00.000Z', DB_PATH: path.join(directory, `seed${seed}.sqlite`), DEMO_SEED: seed }
      }, { timeoutMs: 45000 });
      assert.equal(result.exitCode, 0, result.tail);
      assert.equal(result.timedOut, false);
      assert.ok(fs.existsSync(file));
    }
  }
} finally {
  const cleanup = await session.close('g45-probes-complete');
  assert.equal(cleanup.ok, true);
}
