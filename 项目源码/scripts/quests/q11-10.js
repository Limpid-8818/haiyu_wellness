import { assert, assertOk, checkWebSource, dateRange, login, registerGuest, request, withQ11Apis } from './q11-helpers.js';

export async function run() {
  await withQ11Apis(async context => {
    const dean = assertOk(await login(context.baseUrl, 'dean')).token;
    const { body, result } = await registerGuest(context.baseUrl);
    const guest = assertOk(result, 201).user;
    const three = dateRange(0, 3);
    const savedThree = assertOk(await request(context.baseUrl, `/dean/guests/${guest.id}/stay`, {
      method: 'PATCH', token: dean, body: { roomNo: 'Q11-301', ...three, stayPlan: 'three_night' }
    }));
    assert.equal(savedThree.admissionStatus, 'in_house');
    const tooLongThree = await request(context.baseUrl, `/dean/guests/${guest.id}/stay`, {
      method: 'PATCH', token: dean, body: { roomNo: 'Q11-301', ...dateRange(0, 4), stayPlan: 'three_night' }
    });
    assert.equal(tooLongThree.status, 400);
    const ten = dateRange(0, 10);
    const savedTen = assertOk(await request(context.baseUrl, `/dean/guests/${guest.id}/stay`, {
      method: 'PATCH', token: dean, body: { roomNo: 'Q11-301', ...ten, stayPlan: 'ten_night' }
    }));
    assert.deepEqual(
      [savedTen.profile.room_no, savedTen.profile.check_in, savedTen.profile.check_out, savedTen.profile.stay_plan],
      ['Q11-301', ten.checkIn, ten.checkOut, 'ten_night']
    );
    const inHouseTen = assertOk(await request(context.baseUrl, '/dean/guests?status=in_house', { token: dean }));
    assert.ok(inHouseTen.some(row => row.id === guest.id && row.roomNo === 'Q11-301'
      && row.checkIn === ten.checkIn && row.checkOut === ten.checkOut && row.stayPlan === 'ten_night'));
    const tooLongTen = await request(context.baseUrl, `/dean/guests/${guest.id}/stay`, {
      method: 'PATCH', token: dean, body: { roomNo: 'Q11-301', ...dateRange(0, 11), stayPlan: 'ten_night' }
    });
    assert.equal(tooLongTen.status, 400);
    const guestToken = assertOk(await request(context.baseUrl, '/auth/login', { method: 'POST', body: {
      username: body.phone, password: body.password, role: 'guest'
    } }), 200).token;
    const guestProfile = assertOk(await request(context.baseUrl, '/me', { token: guestToken }));
    assert.deepEqual(
      [guestProfile.profile.room_no, guestProfile.profile.check_in, guestProfile.profile.check_out, guestProfile.profile.stay_plan],
      ['Q11-301', ten.checkIn, ten.checkOut, 'ten_night']
    );
    for (const dates of [dateRange(0, 0), dateRange(1, -1)]) {
      assert.equal((await request(context.baseUrl, `/dean/guests/${guest.id}/stay`, {
        method: 'PATCH', token: dean, body: { roomNo: 'Q11-301', ...dates, stayPlan: 'three_night' }
      })).status, 400);
    }
    const future = dateRange(2, 2);
    const pending = assertOk(await request(context.baseUrl, `/dean/guests/${guest.id}/stay`, {
      method: 'PATCH', token: dean, body: { roomNo: 'Q11-301', ...future, stayPlan: 'three_night' }
    }));
    assert.equal(pending.admissionStatus, 'pending');
    const ended = dateRange(-1, 1);
    const checkedOut = assertOk(await request(context.baseUrl, `/dean/guests/${guest.id}/stay`, {
      method: 'PATCH', token: dean, body: { roomNo: 'Q11-301', checkIn: ended.checkIn, checkOut: requireToday(), stayPlan: 'three_night' }
    }));
    assert.equal(checkedOut.admissionStatus, 'checked_out');
    assert.equal(assertOk(await request(context.baseUrl, '/me', { token: guestToken })).admissionStatus, 'checked_out');
  });
  await checkWebSource(['<option value="ten_night">10晚类别（最多登记10晚）</option>', 'value={profile.checkOut || profile.check_out}']);
  return { output: ['3-night stay accepts 3 nights and rejects 4; 10-night stay accepts, saves and queries 10 nights, while 11 nights rejects', '10-night stay dates and category synchronize to the guest profile; invalid same-day/reversed dates reject; pending, in-house and checked-out states stay synchronized'] };
}

function requireToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
