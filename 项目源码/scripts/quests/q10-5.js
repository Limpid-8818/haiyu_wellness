import assert from 'node:assert/strict';
import { assertOk, login, request, withBothDatabaseApis } from './q10-helpers.js';
import { databaseQuery } from './q10-helpers.js';

export async function run() {
  await withBothDatabaseApis(async context => {
    const guest = (await login(context.baseUrl, 'guest')).data.token;
    const staff = (await login(context.baseUrl, 'staff')).data.token;
    const dean = (await login(context.baseUrl, 'dean')).data.token;
    const updated = await request(context.baseUrl, '/me/profile', {
      method: 'PATCH', token: guest, body: { phone: '13987650002', emergencyContact: 'Synthetic contact', mobility: 'assisted' }
    });
    assertOk(updated, 200, 'profile patch');
    assert.equal(updated.data.phone, '13987650002');
    assert.equal(updated.data.profile.emergency_contact, 'Synthetic contact');
    assert.equal(updated.data.profile.mobility, 'assisted');

    const allowed = await request(context.baseUrl, '/staff/guests/guest_001', { token: staff });
    assertOk(allowed, 200, 'active assignment');
    await databaseQuery(context,
      "UPDATE staff_guest_assignments SET start_at=?, end_at=NULL, status='active' WHERE staff_id=? AND guest_id=?",
      ['2099-01-01 00:00:00.000', 'staff_001', 'guest_001'], 'run');
    assert.equal((await request(context.baseUrl, '/staff/guests/guest_001', { token: staff })).status, 403, 'future assignment is not effective');

    await databaseQuery(context,
      "UPDATE staff_guest_assignments SET start_at=?, end_at=?, status='active' WHERE staff_id=? AND guest_id=?",
      ['2026-01-01 00:00:00.000', '2026-01-02 00:00:00.000', 'staff_001', 'guest_001'], 'run');
    assert.equal((await request(context.baseUrl, '/staff/guests/guest_001', { token: staff })).status, 403, 'expired assignment is not effective');

    await databaseQuery(context,
      "UPDATE staff_guest_assignments SET start_at=?, end_at=?, status='active' WHERE staff_id=? AND guest_id=?",
      ['2026-01-01 00:00:00.000', '2099-01-01 00:00:00.000', 'staff_001', 'guest_001'], 'run');
    assert.equal((await request(context.baseUrl, '/staff/guests/guest_001', { token: staff })).status, 200, 'assignment before end boundary is effective');
    await databaseQuery(context,
      "UPDATE staff_guest_assignments SET status='closed' WHERE staff_id=? AND guest_id=?",
      ['staff_001', 'guest_001'], 'run');
    assert.equal((await request(context.baseUrl, '/staff/guests/guest_001', { token: staff })).status, 403, 'closed assignment is denied');

    const restartedBaseUrl = await context.restartApi();
    assert.equal((await request(restartedBaseUrl, '/staff/guests/guest_001', { token: staff })).status, 403, 'restart must not revive closed assignment');
    assert.equal((await request(restartedBaseUrl, '/me', { token: guest })).data.phone, '13987650002');
    assert.equal((await request(restartedBaseUrl, '/staff/guests/guest_001', { token: dean })).status, 200, 'dean scope remains unchanged');
  });
  return { output: ['profile changes persisted', 'active/future/expired/closed assignment boundaries matched across both databases', 'restart did not restore the closed assignment'] };
}
