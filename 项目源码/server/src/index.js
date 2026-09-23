import app from './app.js';
import { db } from './db.js';

const port = Number(process.env.PORT || 3020);
const server = app.listen(port, () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  console.log(`[community] API running at http://localhost:${actualPort}/api`);
});

function shutdown() {
  server.close(() => {
    try { db.close(); } finally { process.exit(0); }
  });
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
