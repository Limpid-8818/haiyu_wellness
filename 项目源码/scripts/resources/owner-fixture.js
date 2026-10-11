import { ResourceSession } from './resource-runtime.js';
import fs from 'node:fs';
import { waitForResourcePredicate } from './resource-runtime.js';

const [taskId, projectRoot, auditRoot, mode = 'wait'] = process.argv.slice(2);
const session = await ResourceSession.create({ taskId, projectRoot, auditRoot });
const childScript = [
  "const fs=require('node:fs');const file=process.env.RESOURCE_TMPDIR+'/orphan-writer.bin';",
  "setInterval(()=>fs.appendFileSync(file,'writer\\n'),20);"
].join('');
const parentScript = [
  "const {spawn}=require('node:child_process');",
  `const child=spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore'});`,
  "console.log('WRITER_PID='+child.pid);setInterval(()=>{},1000);"
].join('');
const resource = await session.startProcess({
  label: 'owner-cancel-parent', kind: 'api', role: 'api', command: process.execPath,
  args: ['-e', parentScript], cwd: projectRoot, leaseMs: session.limits.leaseMs
});
process.stdout.write(`RESOURCE_OWNER_READY ${JSON.stringify({
  instanceId: session.instanceId, tempDir: session.tempDir, guardianPid: session.guardian.pid,
  guardianIdentity: session.guardianIdentity, ownerPid: process.pid, ownerIdentity: session.ownerIdentity,
  servicePid: resource.pid, serviceIdentity: { pid: resource.pid, startTime: resource.processStartTime,
    pgid: resource.processGroup, fingerprint: resource.processFingerprint },
  socketPath: session.socketPath, configPath: session.configPath, registryPath: session.registryPath, mode
})}\n`);
if (mode === 'natural-exit') {
  await new Promise(resolve => process.stdin.once('data', resolve));
} else if (mode === 'self-kill') {
  const childRegistered = await waitForResourcePredicate(() => {
    const stat = fs.statSync(session.registryPath);
    const count = Math.min(stat.size, 256 * 1024);
    const buffer = Buffer.alloc(count);
    const fd = fs.openSync(session.registryPath, 'r');
    try { fs.readSync(fd, buffer, 0, count, stat.size - count); }
    finally { fs.closeSync(fd); }
    return buffer.toString('utf8').split('\n').filter(Boolean).some(line => {
      try {
        const event = JSON.parse(line);
        return event.instanceId === session.instanceId && event.event === 'child_process_started' &&
          event.ppid === resource.pid;
      } catch { return false; }
    });
  }, 5000, 50);
  if (!childRegistered) throw new Error('writer child was not registered before the owner-kill fixture');
  process.kill(process.pid, 'SIGKILL');
} else {
  setInterval(() => {}, 1000);
}
