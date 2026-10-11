import { assert, assertOk, createStaff, databaseQuery, login, request, withQ11Apis } from './q11-helpers.js';

export async function run() {
  await withQ11Apis(async context => {
    const dean = assertOk(await login(context.baseUrl, 'dean')).token;
    const member = assertOk((await createStaff(context.baseUrl, dean, 'clinician')).result, 201);
    const signedIn = assertOk(await request(context.baseUrl, '/auth/login', { method: 'POST', body: {
      username: member.username, password: 'stage11-pass-2026', role: 'staff'
    } }), 200);
    const created = assertOk(await request(context.baseUrl, '/dean/guests/guest_001/assignments', {
      method: 'POST', token: dean, body: { staffId: member.id }
    }), 201);
    assert.ok((await request(context.baseUrl, '/staff/guests', { token: signedIn.token })).data.some(row => row.id === 'guest_001'));
    await request(context.baseUrl, `/dean/guests/guest_001/assignments/${created.id}`, { method: 'PATCH', token: dean, body: { status: 'closed' } });
    assert.deepEqual(assertOk(await request(context.baseUrl, '/staff/guests', { token: signedIn.token })), []);
    const oldLogs = await databaseQuery(context, 'SELECT COUNT(*) AS count FROM audit_logs WHERE actor_id=?', [member.id], 'get');
    assert.ok(Number(oldLogs.count) > 0);
    const base = await context.restartApi();
    assert.deepEqual(assertOk(await request(base, '/staff/guests', { token: signedIn.token })), []);
    const history = assertOk(await request(base, '/dean/guests/guest_001/assignments', { token: dean }));
    assert.ok(history.some(row => row.id === created.id && row.status === 'closed'));
    const afterRestartLogs = await databaseQuery(context, 'SELECT COUNT(*) AS count FROM audit_logs WHERE actor_id=?', [member.id], 'get');
    assert.equal(Number(afterRestartLogs.count), Number(oldLogs.count));
  });
  return { output: ['assigned staff can access the guest; closed assignment removes access while retaining the relation and logs', 'API restart does not restore a closed assignment'] };
}
