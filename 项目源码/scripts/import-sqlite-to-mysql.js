import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../server');
const demoDatabase = path.join(serverDirectory, 'data', 'community-v2.sqlite');

async function main(sourcePath) {
  if (!sourcePath) throw new Error('Usage: node scripts/import-sqlite-to-mysql.js <synthetic-sqlite-copy>');
  if (process.env.DB_DRIVER !== 'mysql') throw new Error('Set DB_DRIVER=mysql and explicit test-target credentials before importing');
  if (path.resolve(sourcePath) === path.resolve(demoDatabase)) {
    throw new Error('The default demo SQLite database is prohibited as an import source');
  }
  process.env.DEMO_SEED = '0';
  const { db } = await import('../server/src/db.js');
  try {
    const { importSqliteSnapshot } = await import('../server/src/sqlite-import.js');
    const result = await importSqliteSnapshot(sourcePath);
    console.log(`SQLITE_IMPORT=${JSON.stringify(result)}`);
  } finally { await db.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv[2]); }
  catch (error) {
    console.error(error.stack || error);
    process.exitCode = 1;
  }
}
