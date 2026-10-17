// API integration fixture only: importing the app must not start the daily scheduler.
import app from '../../src/app.js';
import { db } from '../../src/db.js';

const server = app.listen(Number(process.env.PORT || 0), '127.0.0.1', () => {
  console.log(`[community] API running at http://localhost:${server.address().port}/api`);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(async error => {
    try {
      if (error) throw error;
      await db.close();
    } catch (failure) {
      console.error(failure);
      process.exitCode = 1;
    }
  });
  server.closeIdleConnections();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
