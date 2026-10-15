import app from './app.js';
import { db } from './db.js';
import { startStage25Scheduler } from './daily-brief.js';

const port = Number(process.env.PORT || 3020);
const server = app.listen(port, () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  console.log(`[community] API running at http://localhost:${actualPort}/api`);
});
const stage25Scheduler = startStage25Scheduler({
  onInitialTick: result => console.info('[stage25-scheduler] initial tick completed ' + JSON.stringify({
    businessDate: result.businessDate, localTime: result.localTime, briefsCreated: result.briefsCreated,
    remindersCreated: result.remindersCreated, careSignals: result.careSignals,
    guestFailureCount: result.guestFailures.length
  }))
});
let shuttingDown = false;
// G26：未捕获的 Promise 拒绝此前会让进程以默认行为崩溃且无上下文日志。
process.on('unhandledRejection', reason => {
  console.error(`[community] unhandled rejection: ${String(reason?.stack || reason).slice(0, 1000)}`);
});

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const schedulerDrained = stage25Scheduler.stop();
  // G26：keep-alive 连接会让 server.close 的回调永不触发，进程挂起到被强杀、
  // 跳过 db.close()；加超时兜底并主动断开存量连接。
  const forceExit = setTimeout(() => {
    console.error('[community] graceful shutdown timed out after 10s; forcing exit');
    server.closeAllConnections?.();
    void db.close().catch(() => {}).finally(() => process.exit(1));
  }, 10_000);
  forceExit.unref?.();
  server.close(() => {
    clearTimeout(forceExit);
    schedulerDrained.then(() => db.close()).then(() => process.exit(0), error => {
      console.error(`database pool shutdown failed: ${error.message}`);
      process.exit(1);
    });
  });
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
