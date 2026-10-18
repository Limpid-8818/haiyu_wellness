// Stable public facade: one connection, then historical migrations, then optional demo seed.
import { initializeConnection } from './db-infrastructure.js';
import { migrate } from './migrations.js';
import { seedDemo } from './demo-seed.js';

export { db, driver, escapeLikeValue, likeEscapeClause, transaction, hasActiveTransaction,
  inTransaction, mysqlLockSuffix, isUniqueViolation, sqliteCachedStatementCount, log } from './db-infrastructure.js';
export { hashPassword, verifyPassword, id, now, json } from './db-values.js';
export { migrate, runVersionedMigration } from './migrations.js';
export { publicUser, guestProfile, guestSummary } from './guest-queries.js';

export const demoSeed = process.env.DEMO_SEED === '1';
export let migrationResult = { applied: 0 };
export let demoSeedResult = { seeded: false, reason: 'DEMO_SEED is not enabled' };

await initializeConnection();
migrationResult = await migrate();
if (demoSeed) demoSeedResult = await seedDemo();
