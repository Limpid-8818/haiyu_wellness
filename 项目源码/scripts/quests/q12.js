import { assert, assertOk, checkWebSource, createStaff, loginAccount, login, request, withQ11Apis } from './q11-helpers.js';
import { databaseQuery } from './q10-helpers.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recommendationHealthContext } from '../../server/src/health-profile.js';

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const assistantSource = path.join(projectDirectory, 'server/src/assistant.js');
let activeResourceSession;

function emptyProfile() {
  return {
    chronic: { status: 'unanswered', items: [] },
    medications: { status: 'unanswered', items: [] },
    allergies: { status: 'unanswered', items: [] },
    dietaryRestrictions: { status: 'unanswered', items: [] },
    mobility: { status: 'unanswered', details: '' },
    sleep: { status: 'unanswered', details: '' },
    skin: { status: 'unanswered', details: '' },
    audienceTags: { status: 'unanswered', items: [] }
  };
}

function completeProfile() {
  return {
    chronic: { status: 'reported', items: ['高血压'] },
    medications: { status: 'reported', items: [{ originalText: '氨氯地平 5mg（家属原文）', timing: '早餐后、晚餐后' }] },
    allergies: { status: 'none', items: [] },
    dietaryRestrictions: { status: 'reported', items: ['忌生冷'] },
    mobility: { status: 'assistance', details: '上下楼需要扶手' },
    sleep: { status: 'reported', details: '夜间容易醒，原文自述' },
    skin: { status: 'unknown', details: '' },
    audienceTags: { status: 'reported', items: ['首次入住'] }
  };
}

async function accounts(baseUrl) {
  const guest = assertOk(await login(baseUrl, 'guest'));
  const clinician = assertOk(await login(baseUrl, 'staff'));
  return { guest, clinician };
}

async function submit(baseUrl, token, profile, baseProfileVersion = 0) {
  return request(baseUrl, '/me/health-intakes', {
    method: 'POST', token, body: { profile, baseProfileVersion }
  });
}

async function useDriver(context, test) {
  await test(context);
}

async function clearFormalHealthProfile(context, value = emptyProfile()) {
  const serialized = JSON.stringify(value);
  if (context.driver === 'mysql') {
    await databaseQuery(context, `UPDATE guest_profiles SET allergies_json=JSON_ARRAY(),health_profile_json=CAST(? AS JSON),
      health_profile_version=0 WHERE user_id='guest_001'`, [serialized], 'run');
  } else {
    await databaseQuery(context, `UPDATE guest_profiles SET allergies_json='[]',health_profile_json=?,
      health_profile_version=0 WHERE user_id='guest_001'`, [serialized], 'run');
  }
}

async function testQ121(context) {
  const { guest } = await accounts(context.baseUrl);
  const before = assertOk(await request(context.baseUrl, '/me/health-profile', { token: guest.token }));
  assert.equal(before.verifiedProfile.chronic.status, 'unanswered');
  const profile = completeProfile();
  const saved = await submit(context.baseUrl, guest.token, profile);
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  assert.deepEqual(saved.data.intake.candidate, profile);
  assert.equal(saved.data.intake.source, 'form');
  assert.equal(saved.data.intake.submittedBy, guest.user.id);
  assert.ok(saved.data.intake.submittedAt);
  assert.deepEqual(saved.data.verifiedProfile, before.verifiedProfile, 'submitting a self-report must not update the verified profile');
  assert.equal(saved.data.intake.candidate.medications.items[0].originalText, '氨氯地平 5mg（家属原文）');
  assert.equal(saved.data.intake.candidate.medications.items[0].timing, '早餐后、晚餐后');
  const refreshed = assertOk(await request(context.baseUrl, '/me/health-profile', { token: guest.token }));
  assert.deepEqual(refreshed.profile, profile);
  assert.deepEqual(refreshed.verifiedProfile, before.verifiedProfile);
}

async function testQ123(context) {
  const { guest } = await accounts(context.baseUrl);
  const first = emptyProfile();
  first.allergies = { status: 'reported', items: ['虾'] };
  const saved = assertOk(await submit(context.baseUrl, guest.token, first), 201);
  const duplicate = assertOk(await submit(context.baseUrl, guest.token, first));
  assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.intake.id, saved.intake.id);
  const second = structuredClone(first);
  second.dietaryRestrictions = { status: 'reported', items: ['忌生冷'] };
  const next = assertOk(await submit(context.baseUrl, guest.token, second), 201);
  assert.notEqual(next.intake.id, saved.intake.id);
  assert.notEqual(next.intake.revision, saved.intake.revision);
  assert.equal(next.intake.baseProfileVersion, 0);
  assert.equal(next.intake.submittedBy, guest.user.id);
  assert.equal(next.intake.source, 'form');
  assert.ok(next.intake.submittedAt);
  const invalid = structuredClone(first);
  invalid.extraDiagnosis = 'unknown';
  const rejected = await submit(context.baseUrl, guest.token, invalid);
  assert.equal(rejected.status, 400);
  assert.equal(rejected.data.code, 'HEALTH_PROFILE_FIELD_NOT_ALLOWED');
  const rows = await databaseQuery(context, context.driver === 'mysql'
    ? `SELECT source,review_status AS status,submitted_by,revision FROM health_intakes WHERE guest_id='guest_001' AND source='form' ORDER BY revision`
    : `SELECT source,status,submitted_by,revision FROM health_intakes WHERE guest_id='guest_001' AND source='form' ORDER BY revision`);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.status), ['pending', 'pending']);
  assert.ok(rows.every(row => row.source === 'form' && row.submitted_by === guest.user.id));
}

async function testQ124(context) {
  const { guest } = await accounts(context.baseUrl);
  const profile = emptyProfile();
  profile.allergies = { status: 'reported', items: ['虾'] };
  const saved = assertOk(await submit(context.baseUrl, guest.token, profile), 201);
  const refreshed = assertOk(await request(context.baseUrl, '/me/health-profile', { token: guest.token }));
  assert.deepEqual(refreshed.profile.allergies, profile.allergies);
  assert.equal(refreshed.pendingIntakes[0].id, saved.intake.id);
  assert.equal(refreshed.pendingIntakes[0].status, 'pending');
  assert.deepEqual(refreshed.verifiedProfile.allergies, { status: 'unanswered', items: [] });
}

async function testQ125(context) {
  const { guest } = await accounts(context.baseUrl);
  const profile = emptyProfile();
  profile.chronic = { status: 'none', items: [] };
  profile.allergies = { status: 'none', items: [] };
  profile.dietaryRestrictions = { status: 'none', items: [] };
  profile.mobility = { status: 'independent', details: '' };
  profile.sleep = { status: 'unknown', details: '' };
  profile.skin = { status: 'unknown', details: '' };
  profile.audienceTags = { status: 'none', items: [] };
  const partial = assertOk(await submit(context.baseUrl, guest.token, profile), 201);
  assert.equal(partial.completeness.total, 8);
  assert.equal(partial.completeness.completed, 7);
  assert.deepEqual(partial.completeness.missing.map(field => field.key), ['medications']);
  profile.medications = { status: 'none', items: [] };
  const complete = assertOk(await submit(context.baseUrl, guest.token, profile), 201);
  assert.equal(complete.completeness.completed, 8);
  assert.equal(complete.completeness.missing.length, 0);
}

async function testQ126(context) {
  const { guest, clinician } = await accounts(context.baseUrl);
  const profile = emptyProfile();
  profile.sleep = { status: 'reported', details: '夜间醒来两次' };
  const saved = assertOk(await submit(context.baseUrl, guest.token, profile), 201);
  const guestHistory = assertOk(await request(context.baseUrl, '/me/health-profile', { token: guest.token }));
  const staffHistory = assertOk(await request(context.baseUrl, '/staff/guests/guest_001/health-intakes', { token: clinician.token }));
  const guestEntry = guestHistory.history.find(item => item.id === saved.intake.id);
  const staffEntry = staffHistory.history.find(item => item.id === saved.intake.id);
  assert.deepEqual(guestEntry, staffEntry);
  assert.deepEqual(guestEntry.before, emptyProfile());
  assert.equal(guestEntry.after.sleep.details, '夜间醒来两次');
  assert.equal(guestEntry.source, 'form');
  assert.equal(guestEntry.submittedBy, guest.user.id);
  assert.ok(guestEntry.submittedAt);
}

async function testQ127(context) {
  const { guest, clinician } = await accounts(context.baseUrl);
  const profile = emptyProfile();
  profile.allergies = { status: 'reported', items: ['花生'] };
  const saved = assertOk(await submit(context.baseUrl, guest.token, profile), 201);
  const assistant = assertOk(await request(context.baseUrl, '/assistant/chat', {
    method: 'POST', token: guest.token, body: { role: 'guest', text: '我有过敏，想补充健康信息。' }
  }), 200);
  assert.equal(assistant.live, false);
  const history = assertOk(await request(context.baseUrl, '/staff/guests/guest_001/health-intakes', { token: clinician.token }));
  const newCandidate = history.history.find(item => item.id === saved.intake.id);
  const oldText = history.history.find(item => item.source === 'assistant' && item.content.includes('我有过敏'));
  assert.ok(newCandidate?.candidate?.allergies.items.includes('花生'));
  assert.ok(oldText, 'legacy assistant raw text intake is retained in review history');
  assert.equal(oldText.candidate, null);
  assert.ok(oldText.sessionId);
  assert.equal(oldText.status, 'pending');
  assert.equal((await request(context.baseUrl, '/staff/guests/guest_001/health-intakes')).status, 401);

  const dean = assertOk(await login(context.baseUrl, 'dean'));
  const nonClinician = await createStaff(context.baseUrl, dean.token, 'administrator');
  assert.equal(nonClinician.result.status, 201, JSON.stringify(nonClinician.result.data));
  const other = assertOk(await loginAccount(context.baseUrl, nonClinician.input.username, 'stage11-pass-2026'));
  const denied = await request(context.baseUrl, '/staff/guests/guest_001/health-intakes', { token: other.token });
  assert.equal(denied.status, 403);
  assert.equal(denied.data.code, 'CLINICIAN_REQUIRED');
}

async function testQ128(context) {
  await clearFormalHealthProfile(context);
  const { guest, clinician } = await accounts(context.baseUrl);
  const first = emptyProfile();
  first.allergies = { status: 'reported', items: ['虾'] };
  const saved = assertOk(await submit(context.baseUrl, guest.token, first), 201);
  const staleProfile = emptyProfile();
  staleProfile.allergies = { status: 'reported', items: ['蟹'] };
  const stale = assertOk(await submit(context.baseUrl, guest.token, staleProfile), 201);
  const confirmed = assertOk(await request(context.baseUrl, `/staff/health-intakes/${saved.intake.id}/confirm`, {
    method: 'POST', token: clinician.token, body: { baseProfileVersion: 0 }
  }));
  assert.equal(confirmed.intake.status, 'confirmed');
  assert.equal(confirmed.intake.reviewedBy, clinician.user.id);
  assert.ok(confirmed.intake.reviewedAt);
  assert.equal(confirmed.profileVersion, 1);
  assert.deepEqual(confirmed.verifiedProfile.allergies, { status: 'reported', items: ['虾'] });
  const repeated = assertOk(await request(context.baseUrl, `/staff/health-intakes/${saved.intake.id}/confirm`, {
    method: 'POST', token: clinician.token, body: { baseProfileVersion: 0 }
  }));
  assert.equal(repeated.alreadyApplied, true);
  assert.equal(repeated.profileVersion, 1);
  assert.deepEqual(repeated.verifiedProfile.allergies, confirmed.verifiedProfile.allergies);
  const conflict = await request(context.baseUrl, `/staff/health-intakes/${stale.intake.id}/confirm`, {
    method: 'POST', token: clinician.token, body: { baseProfileVersion: 0 }
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.code, 'HEALTH_PROFILE_STALE_VERSION');
  const afterConflict = assertOk(await request(context.baseUrl, '/me/health-profile', { token: guest.token }));
  assert.equal(afterConflict.profileVersion, 1);
  assert.deepEqual(afterConflict.verifiedProfile.allergies, confirmed.verifiedProfile.allergies);
}

async function testQ129(context) {
  await clearFormalHealthProfile(context);
  const { guest, clinician } = await accounts(context.baseUrl);
  const profile = emptyProfile();
  profile.sleep = { status: 'reported', details: '睡得很好，实际填写有误' };
  const saved = assertOk(await submit(context.baseUrl, guest.token, profile), 201);
  const missingReason = await request(context.baseUrl, `/staff/health-intakes/${saved.intake.id}/reject`, {
    method: 'POST', token: clinician.token, body: { reason: '' }
  });
  assert.equal(missingReason.status, 400);
  assert.equal(missingReason.data.code, 'HEALTH_REVIEW_REASON_REQUIRED');
  const rejected = assertOk(await request(context.baseUrl, `/staff/health-intakes/${saved.intake.id}/reject`, {
    method: 'POST', token: clinician.token, body: { reason: '与客人现场复核后确认该项填错，请重新填写。' }
  }));
  assert.equal(rejected.intake.status, 'rejected');
  assert.match(rejected.intake.reviewNote, /重新填写/);
  assert.equal(rejected.intake.reviewedBy, clinician.user.id);
  assert.ok(rejected.intake.reviewedAt);
  assert.deepEqual(rejected.verifiedProfile, emptyProfile());
}

async function testQ1210(context) {
  const { guest, clinician } = await accounts(context.baseUrl);
  const profile = emptyProfile();
  profile.allergies = { status: 'reported', items: ['腰果'] };
  const saved = assertOk(await submit(context.baseUrl, guest.token, profile), 201);
  const review = assertOk(await request(context.baseUrl, '/staff/guests/guest_001/health-intakes', { token: clinician.token }));
  assert.equal(review.pendingIntakes[0].id, saved.intake.id);
  const updated = assertOk(await request(context.baseUrl, `/staff/health-intakes/${saved.intake.id}/confirm`, {
    method: 'POST', token: clinician.token, body: { baseProfileVersion: 0 }
  }));
  const guestView = assertOk(await request(context.baseUrl, '/me/health-profile', { token: guest.token }));
  assert.deepEqual(guestView.verifiedProfile, updated.verifiedProfile);
  assert.equal(guestView.history.find(item => item.id === saved.intake.id).status, 'confirmed');
  assert.equal(guestView.history.find(item => item.id === saved.intake.id).reviewerName, '王医生');
}

async function testQ1211(context) {
  const formal = emptyProfile();
  formal.allergies = { status: 'none', items: [] };
  await clearFormalHealthProfile(context, formal);
  const { guest } = await accounts(context.baseUrl);
  const profile = emptyProfile();
  profile.allergies = { status: 'reported', items: ['虾'] };
  const saved = assertOk(await submit(context.baseUrl, guest.token, profile), 201);
  const state = assertOk(await request(context.baseUrl, '/me/health-profile', { token: guest.token }));
  const constraint = state.effectiveHealthConstraints.allergies.find(item => item.value === '虾' && item.status === 'pending');
  assert.ok(constraint);
  assert.equal(constraint.sourceId, saved.intake.id);
  assert.equal(state.effectiveHealthConstraints.conflictState, 'conflict');
  assert.ok(state.effectiveHealthConstraints.conflicts.some(item => item.sourceId === saved.intake.id));
  const assistantContext = recommendationHealthContext(state.effectiveHealthConstraints);
  assert.deepEqual(assistantContext.effectiveHealthConstraints, state.effectiveHealthConstraints);
  const assistant = await readFile(assistantSource, 'utf8');
  assert.ok(assistant.includes('effectiveHealthConstraints'));
  assert.ok(assistant.includes('recommendationHealthContext(constraints)'));
  const noModel = assertOk(await request(context.baseUrl, '/assistant/chat', {
    method: 'POST', token: guest.token, body: { role: 'guest', text: '请结合我的过敏给出饮食建议。' }
  }));
  assert.equal(noModel.live, false);
}

async function runApiTest(test) {
  await withQ11Apis(async context => useDriver(context, test), { resourceSession: activeResourceSession });
}

export async function run({ questId, resourceSession }) {
  activeResourceSession = resourceSession;
  const tests = {
    'Q12.1': async () => runApiTest(testQ121),
    'Q12.2': async () => {
      await checkWebSource([
        '健康自述', '档案完整度', 'fieldErrors', 'scrollIntoView',
        'health-profile', 'baseProfileVersion', '只读', '客人自述', '待核实'
      ]);
      await runApiTest(async context => {
        const { guest } = await accounts(context.baseUrl);
        const unchanged = await request(context.baseUrl, '/me/profile', {
          method: 'PATCH', token: guest.token, body: { allergies: ['虾'], chronic: ['高血压'] }
        });
        assert.equal(unchanged.status, 400, JSON.stringify(unchanged.data));
        assert.equal(unchanged.data.code, 'PROFILE_FIELD_NOT_ALLOWED');
      });
    },
    'Q12.3': async () => runApiTest(testQ123),
    'Q12.4': async () => {
      await checkWebSource(['pendingIntakes', 'verifiedProfile', '待核实', '正式档案']);
      await runApiTest(testQ124);
    },
    'Q12.5': async () => {
      await checkWebSource(['completeness', 'missing', 'scrollIntoView', '长期用药']);
      await runApiTest(testQ125);
    },
    'Q12.6': async () => {
      await checkWebSource(['HealthIntakeHistory', '修改前', '修改后', '客人提交内容', '提交人', '处理人']);
      await runApiTest(testQ126);
    },
    'Q12.7': async () => runApiTest(testQ127),
    'Q12.8': async () => runApiTest(testQ128),
    'Q12.9': async () => runApiTest(testQ129),
    'Q12.10': async () => {
      await checkWebSource(['健康自述核实', '确认并更新正式档案', '驳回并保留原文', '/staff/guests/${guestId}/health-intakes']);
      await runApiTest(testQ1210);
    },
    'Q12.11': async () => runApiTest(testQ1211)
  };
  const test = tests[questId];
  assert.ok(test, `unknown Stage 12 quest: ${questId}`);
  await test();
  return { output: [`${questId} structured health self-report, review, history, access and constraints verified on SQLite and MySQL 8.`] };
}
