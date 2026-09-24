import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { verifyPassword } from '../../server/src/password.js';
import { withTemporaryApi } from './helpers.js';

const demoAccounts = [
  { username: 'guest_demo', password: 'guest2026', role: 'guest', name: '林海宁' },
  { username: 'staff_demo', password: 'staff2026', role: 'staff', name: '王医生' },
  { username: 'dean_demo', password: 'dean2026', role: 'dean', name: '周院长' }
];

export async function run() {
  return withTemporaryApi(async ({ databasePath, restartApi }) => {
    const firstRun = readAccounts(databasePath);
    assertSeededAccounts(firstRun);

    const restartedBaseUrl = await restartApi();
    const health = await fetch(`${restartedBaseUrl}/health`);
    assert.equal(health.status, 200, 'API must restart against the same temporary database');
    const secondRun = readAccounts(databasePath);
    assert.deepEqual(secondRun, firstRun, 'a restart must not duplicate or rewrite demo accounts');
    assertSeededAccounts(secondRun);

    return {
      output: [
        'users=3',
        'guest=1 staff=1 dean=1',
        'passwordHashes=verified',
        'restart HTTP 200 duplicateSeeds=0'
      ]
    };
  }, 'haiyu-quest-q3-1-');
}

function readAccounts(databasePath) {
  const database = new DatabaseSync(databasePath);
  try {
    return database.prepare(`
      SELECT id,username,role,name,password_hash AS passwordHash
      FROM users ORDER BY role
    `).all().map(row => ({ ...row }));
  } finally {
    database.close();
  }
}

function assertSeededAccounts(rows) {
  assert.equal(rows.length, 3, 'temporary database must contain exactly three demo users');
  for (const expected of demoAccounts) {
    const matches = rows.filter(row => row.role === expected.role);
    assert.equal(matches.length, 1, `${expected.role} must be seeded exactly once`);
    const account = matches[0];
    assert.equal(account.username, expected.username);
    assert.equal(account.name, expected.name);
    assert.notEqual(account.passwordHash, expected.password, 'stored password must not be plaintext');
    assert.ok(verifyPassword(expected.password, account.passwordHash), 'stored scrypt hash must verify the demo password');
  }
}
