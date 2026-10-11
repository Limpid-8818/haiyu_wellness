import { assert, assertOk, checkWebSource, dateRange, login, registerGuest, request, withQ11Apis } from './q11-helpers.js';

export async function run() {
  await withQ11Apis(async context => {
    const dean = assertOk(await login(context.baseUrl, 'dean')).token;
    const { body, result } = await registerGuest(context.baseUrl);
    const guest = assertOk(result, 201).user;
    const stay = dateRange(-1, 3);
    assertOk(await request(context.baseUrl, `/dean/guests/${guest.id}/stay`, {
      method: 'PATCH', token: dean, body: { roomNo: 'Q11-411', ...stay, stayPlan: 'three_night' }
    }));
    let inHouse = assertOk(await request(context.baseUrl, '/dean/guests?status=in_house', { token: dean }));
    assert.ok(inHouse.some(row => row.id === guest.id && row.roomNo === 'Q11-411'));
    const guestToken = assertOk(await request(context.baseUrl, '/auth/login', { method: 'POST', body: {
      username: body.phone, password: body.password, role: 'guest'
    } }), 200).token;
    const profile = assertOk(await request(context.baseUrl, '/me', { token: guestToken }));
    assert.deepEqual([profile.profile.room_no, profile.profile.check_in, profile.profile.stay_plan], ['Q11-411', stay.checkIn, 'three_night']);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    assertOk(await request(context.baseUrl, `/dean/guests/${guest.id}/stay`, {
      method: 'PATCH', token: dean, body: { roomNo: 'Q11-411', checkIn: stay.checkIn, checkOut: today, stayPlan: 'three_night' }
    }));
    const checkedOut = assertOk(await request(context.baseUrl, '/dean/guests?status=checked_out', { token: dean }));
    assert.ok(checkedOut.some(row => row.id === guest.id));
    assert.equal(assertOk(await request(context.baseUrl, '/me', { token: guestToken })).admissionStatus, 'checked_out');
  });
  await checkWebSource(['function StayManagement(', '办理离店', '当前选择：', '入住类别']);
  return { output: ['stay form saves room, dates and plan; in-house and checked-out filters return the guest', 'guest profile reflects registered room, plan and checked-out state'] };
}
