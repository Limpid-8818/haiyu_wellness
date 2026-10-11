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

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const schedulerDrained = stage25Scheduler.stop();
  server.close(() => {
    schedulerDrained.then(() => db.close()).then(() => process.exit(0), error => {
      console.error(`database pool shutdown failed: ${error.message}`);
      process.exit(1);
    });
  });
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
