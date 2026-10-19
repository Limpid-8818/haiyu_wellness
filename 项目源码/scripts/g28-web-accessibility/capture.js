import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const log = path.join(process.env.G28_AUDIT_ROOT, `${process.env.G28_ATTEMPT}-full.log`);
const fd = fs.openSync(log, 'wx');
let bytes = 0;
const child = spawn(process.argv[2], process.argv.slice(3), { stdio: ['ignore', 'pipe', 'pipe'] });
for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
  bytes += data.length;
  if (bytes > 8388608) { child.kill('SIGTERM'); process.exitCode = 1; return; }
  fs.writeSync(fd, data); process.stdout.write(data);
});
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('close', (code, signal) => { fs.closeSync(fd); process.exitCode = signal ? 1 : code; });
