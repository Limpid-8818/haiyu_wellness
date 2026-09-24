import assert from 'node:assert/strict';
import { withTemporaryApi } from './helpers.js';
import { login, request, withDatabase, addGuest, addAssignment } from './q5-helpers.js';

const deniedGuests = [
  { id: 'guest_q5_2_unassigned', reason: 'unassigned', code: 'GUEST_NOT_ASSIGNED' },
  { id: 'guest_q5_2_future', reason: 'future-start assignment', code: 'GUEST_NOT_ASSIGNED' },
  { id: 'guest_q5_2_expired', reason: 'expired assignment', code: 'GUEST_NOT_ASSIGNED' },
  { id: 'guest_q5_2_closed', reason: 'closed assignment', code: 'GUEST_NOT_ASSIGNED' },
  { id: 'guest_q5_2_disabled', reason: 'disabled guest account', code: 'GUEST_INACTIVE' }
];

export async function run() {
  return withTemporaryApi(async ({ baseUrl, databasePath }) => {
    addAuthorizationFixtures(databasePath);
    const staffToken = await login(baseUrl);
    const checks = [];

    for (const guest of deniedGuests) {
      for (const route of protectedRoutes(guest.id)) {
        const result = await request(baseUrl, route, { token: staffToken });
        assert.equal(result.status, 403, `${guest.reason} should be denied for ${route}`);
        assert.equal(result.data.code, guest.code, `${guest.reason} should return ${guest.code} for ${route}`);
        checks.push(`${route}=${result.status}/${result.data.code}`);
      }
    }

    for (const route of protectedRoutes('guest_001')) {
      const result = await request(baseUrl, route, { token: staffToken });
      assert.equal(result.status, 200, `effective assignment should allow ${route}`);
    }

    return { output: [
      `denied cases=${deniedGuests.length} paths=${deniedGuests.length * protectedRoutes('x').length}`,
      ...deniedGuests.map(guest => `${guest.reason}: all four scoped reads HTTP 403 ${guest.code}`),
      'effective current assignment: detail, health, advice, and Agent context HTTP 200'
    ] };
  }, 'haiyu-quest-q5-2-');
}

function protectedRoutes(guestId) {
  return [
    `/staff/guests/${guestId}`,
    `/me/health?guestId=${guestId}`,
    `/me/advice?guestId=${guestId}`,
    `/agent/status?guestId=${guestId}`
  ];
}

function addAuthorizationFixtures(databasePath) {
  const now = Date.now();
  withDatabase(databasePath, database => {
    addGuest(database, { id: 'guest_q5_2_unassigned' });
    addGuest(database, { id: 'guest_q5_2_future' });
    addGuest(database, { id: 'guest_q5_2_expired' });
    addGuest(database, { id: 'guest_q5_2_closed' });
    addGuest(database, { id: 'guest_q5_2_disabled', status: 'disabled' });
    addAssignment(database, { guestId: 'guest_q5_2_future', startAt: new Date(now + 3_600_000).toISOString() });
    addAssignment(database, { guestId: 'guest_q5_2_expired', startAt: new Date(now - 3_600_000).toISOString(), endAt: new Date(now - 60_000).toISOString() });
    addAssignment(database, { guestId: 'guest_q5_2_closed', status: 'closed' });
    addAssignment(database, { guestId: 'guest_q5_2_disabled' });
  });
}
