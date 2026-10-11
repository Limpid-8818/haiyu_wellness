import assert from 'node:assert/strict';
import { assertOk, checkWebSource, createStaff, login, loginAccount, request, withQ11Apis } from './q11-helpers.js';
import { databaseQuery } from './q10-helpers.js';
import { PROJECT_SEEDS, RULE_SEEDS } from '../../server/src/catalog-data.js';
import { evaluateProjectRules } from '../../server/src/rules-engine.js';
import { emptyHealthProfile, effectiveHealthConstraints } from '../../server/src/health-profile.js';

async function q131() {
  await withQ11Apis(async context => {
    const rows = await databaseQuery(context, `SELECT id,category,intensity,location,description,suitable_people,
      contraindications,open_windows_json,capacity_per_window,sea_entry FROM projects ORDER BY id`);
    assert.equal(rows.length, 11);
    const counts = Object.fromEntries(['water_therapy', 'exercise', 'seaside'].map(category => [
      category, rows.filter(row => row.category === category).length
    ]));
    assert.deepEqual(counts, { water_therapy: 4, exercise: 4, seaside: 3 });
    for (const row of rows) {
      for (const field of ['id', 'location', 'description', 'suitable_people', 'contraindications', 'open_windows_json']) {
        assert.ok(String(row[field] ?? '').trim(), `${context.driver} ${row.id} is missing ${field}`);
      }
      assert.ok(Number(row.capacity_per_window) >= 1);
      if (row.category === 'exercise') assert.ok(['low', 'medium', 'high'].includes(row.intensity));
      else assert.equal(row.intensity, null);
      assert.ok([0, 1, false, true].includes(row.sea_entry));
    }
    const sourceIds = new Set(PROJECT_SEEDS.map(item => item.id));
    assert.deepEqual(new Set(rows.map(row => row.id)), sourceIds);
  });
  return { output: ['SQLite and MySQL each persist the 11 Table 3 items with category counts 4/4/3', 'all required catalog fields and exercise intensity values are present; added locations/windows/capacities are labeled demonstration data'] };
}

async function q132() {
  await withQ11Apis(async context => {
    const water = assertOk(await request(context.baseUrl, '/projects?category=water_therapy'));
    assert.equal(water.items.length, 4);
    const search = assertOk(await request(context.baseUrl, '/projects?q=%E6%B8%A9%E6%B3%89'));
    assert.equal(search.items.length, 1);
    assert.equal(search.items[0].id, 'project-marine-hot-spring');
    assert.ok(assertOk(await request(context.baseUrl, '/projects/project-swimming-training')).name === '游泳训练');
    const missing = await request(context.baseUrl, '/projects/not-a-project');
    assert.equal(missing.status, 404);
    assert.equal(missing.data.code, 'PROJECT_NOT_FOUND');
    const empty = assertOk(await request(context.baseUrl, '/projects?q=%E4%B8%8D%E5%AD%98%E5%9C%A8%E7%9A%84%E9%A1%B9%E7%9B%AE'));
    assert.deepEqual(empty.items, []);
  });
  return { output: ['category=water_therapy returns four projects', 'search 温泉 returns one detail; unknown IDs return 404 and empty search returns []'] };
}

async function q133() {
  await withQ11Apis(async context => {
    const result = assertOk(await request(context.baseUrl, '/projects'));
    assert.equal(result.total, 11);
    assert.deepEqual(Object.fromEntries(['water_therapy', 'exercise', 'seaside'].map(category => [
      category, result.items.filter(item => item.category === category).length
    ])), { water_therapy: 4, exercise: 4, seaside: 3 });
    assert.ok(result.items.filter(item => item.category === 'exercise').every(item => item.intensityLabel));
    await checkWebSource(['function GuestProjects', '未找到相关项目', '全部项目', 'categoryLabel', 'intensityLabel']);
  });
  return { output: ['guest project list uses the API catalog and three category filters', 'empty state and exercise intensity labels are present in the rendered page implementation'] };
}

async function q134() {
  await withQ11Apis(async context => {
    for (const [id, name, category] of [
      ['project-sea-bath', '海水浴', 'water_therapy'],
      ['project-swimming-training', '游泳训练', 'exercise']
    ]) {
      const project = assertOk(await request(context.baseUrl, `/projects/${id}`));
      assert.equal(project.name, name);
      assert.equal(project.category, category);
      for (const field of ['description', 'location', 'suitablePeople', 'contraindications', 'openWindows']) assert.ok(project[field]);
      assert.ok(project.isDemo);
    }
    await checkWebSource(['function ProjectDetail', '返回项目列表', '开放时段', '适宜人群', '禁忌提示', '<ProjectBooking project={project} go={go}/>']);
  });
  return { output: ['sea-bath and swimming-training details expose location, description, open windows, suitability, and contraindications', 'detail view includes the service-backed booking panel and the project list retains its filter state'] };
}

async function q135() {
  await withQ11Apis(async context => {
    const dean = assertOk(await login(context.baseUrl, 'dean'));
    const created = await createStaff(context.baseUrl, dean.token, 'administrator');
    assert.equal(created.result.status, 201, JSON.stringify(created.result.data));
    const admin = assertOk(await loginAccount(context.baseUrl, created.input.username, 'stage11-pass-2026'));
    const list = assertOk(await request(context.baseUrl, '/admin/projects', { token: admin.token }));
    const project = list.items.find(item => item.id === 'project-seaside-photography');
    assert.ok(project);
    const saved = assertOk(await request(context.baseUrl, `/admin/projects/${project.id}`, {
      method: 'PATCH', token: admin.token,
      body: {
        description: 'Q13 maintenance persistence sample. This remains demonstration text.',
        openWindows: { windows: [{ days: ['每日'], start: '08:30', end: '10:30' }] }
      }
    }));
    assert.equal(saved.description, 'Q13 maintenance persistence sample. This remains demonstration text.');
    assert.equal(saved.openWindows[0].start, '08:30');
    const invalid = await request(context.baseUrl, `/admin/projects/${project.id}`, {
      method: 'PATCH', token: admin.token,
      body: { openWindows: { windows: [{ days: ['每日'], start: '16:00', end: '09:00' }] } }
    });
    assert.equal(invalid.status, 400);
    const deactivated = assertOk(await request(context.baseUrl, `/admin/projects/${project.id}`, {
      method: 'PATCH', token: admin.token, body: { active: false }
    }));
    assert.equal(deactivated.active, false);
    const guestList = assertOk(await request(context.baseUrl, '/projects'));
    assert.ok(!guestList.items.some(item => item.id === project.id));
    const archivedAdminList = assertOk(await request(context.baseUrl, '/admin/projects', { token: admin.token }));
    assert.ok(archivedAdminList.items.some(item => item.id === project.id && !item.active));
    const missingGuestDetail = await request(context.baseUrl, `/projects/${project.id}`);
    assert.equal(missingGuestDetail.status, 404);
    const persisted = await databaseQuery(context, 'SELECT active,description FROM projects WHERE id=?', [project.id], 'get');
    assert.equal(Number(persisted.active), 0);
    assert.equal(persisted.description, 'Q13 maintenance persistence sample. This remains demonstration text.');
  });
  return { output: ['administrator edits to description and valid open window survive reload', 'invalid time ranges return 400; deactivated project stays in administration and disappears from the guest directory'] };
}

async function q136() {
  await withQ11Apis(async context => {
    const dean = assertOk(await login(context.baseUrl, 'dean'));
    const created = await createStaff(context.baseUrl, dean.token, 'administrator');
    const admin = assertOk(await loginAccount(context.baseUrl, created.input.username, 'stage11-pass-2026'));
    assert.equal(assertOk(await request(context.baseUrl, '/admin/projects', { token: admin.token })).total, 11);
    await checkWebSource(['function ProjectAdmin', '停用后不会出现在客人目录', '示例开放窗口', 'project-admin-active']);
  });
  return { output: ['administrator project page is backed by authenticated project APIs', 'form includes description, open window, enable/disable controls, and the visible guest-catalog effect'] };
}

async function q137() {
  await withQ11Apis(async context => {
    for (const domain of ['therapy', 'nutrition', 'exercise', 'companionship']) {
      const result = assertOk(await request(context.baseUrl, `/knowledge?domain=${domain}`));
      assert.ok(result.items.length >= 2, `${domain} needs at least two records`);
      for (const item of result.items) {
        assert.ok(item.knowledgeId && item.summary && /^https:\/\//.test(item.sourceUrl) && item.updatedAt);
      }
      if (domain === 'exercise') {
        const olderAdults = result.items.find(item => item.knowledgeId === 'knowledge-exercise-02');
        assert.ok(olderAdults, 'older-adult balance/strength guidance is required');
        assert.equal(olderAdults.sourceName, 'WHO Regional Office for Europe: Physical activity');
        assert.equal(olderAdults.sourceUrl, 'https://www.who.int/europe/news-room/fact-sheets/item/physical-activity');
      }
    }
    assert.equal(assertOk(await request(context.baseUrl, '/knowledge?q=%E9%92%A0')).items.length, 1);
    assert.deepEqual(assertOk(await request(context.baseUrl, '/knowledge?q=%E6%9C%AA%E6%94%B6%E5%BD%95%E7%9A%84%E4%BF%A1%E6%81%AF')).items, []);
  });
  return { output: ['therapy, nutrition, exercise and companionship each return at least two searchable records', 'older-adult balance/strength frequency points to the WHO Europe fact sheet that states the 3-or-more-days guidance', 'every record includes a verified primary-source link, summary, updatedAt and stable knowledgeId'] };
}

async function q138() {
  await withQ11Apis(async context => {
    const result = assertOk(await request(context.baseUrl, '/rules'));
    assert.equal(result.total, 5);
    assert.deepEqual(result.items.map(item => item.ruleId), ['R1', 'R2', 'R3', 'R4', 'R5']);
    for (const rule of result.items) {
      assert.ok(rule.scope && rule.triggerCondition && rule.action && rule.version && rule.sourceReference && rule.demoNote);
    }
    assert.equal(result.items.find(item => item.ruleId === 'R2').action, 'reject');
    await checkWebSource(['function RulesWorkbench', '规则版本']);
  });
  assert.deepEqual(RULE_SEEDS.map(rule => rule.id), ['R1', 'R2', 'R3', 'R4', 'R5']);
  return { output: ['read-only rules endpoint exposes R1–R5 with condition, action, source, version, and demonstration limits'] };
}

function sampleProject(slug) {
  const seed = PROJECT_SEEDS.find(item => item.slug === slug);
  assert.ok(seed, `missing fixture project ${slug}`);
  return { ...seed, activityTag: seed.activityTag };
}

async function q139() {
  const empty = emptyHealthProfile();
  const cases = [
    {
      ruleId: 'R1', project: sampleProject('marine-hot-spring'),
      verifiedProfile: { ...empty, chronic: { status: 'reported', items: ['高血压'] } }, environment: { uvLevel: 'moderate' }, action: 'restrict'
    },
    {
      ruleId: 'R2', project: sampleProject('sea-bath'),
      verifiedProfile: { ...empty, skin: { status: 'reported', details: '有皮肤破损' } }, environment: { uvLevel: 'moderate', seaStatus: 'safe' }, action: 'reject'
    },
    {
      ruleId: 'R3', project: sampleProject('beach-walk'),
      verifiedProfile: empty, environment: { uvLevel: 'strong' }, action: 'restrict'
    },
    {
      ruleId: 'R4', project: sampleProject('swimming-training'),
      verifiedProfile: { ...empty, mobility: { status: 'assistance', details: '' } }, environment: { seaStatus: 'safe' }, action: 'reject'
    },
    {
      ruleId: 'R5', project: sampleProject('tidal-foraging'),
      verifiedProfile: empty, environment: {}, action: 'reject'
    }
  ];
  for (const sample of cases) {
    const result = evaluateProjectRules(sample);
    const matched = result.decisions.find(decision => decision.ruleId === sample.ruleId);
    assert.ok(matched?.matched, `${sample.ruleId} did not match`);
    assert.equal(matched.action, sample.action);
    assert.ok(matched.fieldSources.length, `${sample.ruleId} is missing field-source provenance`);
    assert.equal(matched.reviewRequired, true);
    assert.equal(result.outcome, sample.action);
  }
  const normal = evaluateProjectRules({
    project: sampleProject('sea-bath'), verifiedProfile: empty,
    environment: { uvLevel: 'moderate', seaStatus: 'safe', source: 'verified-synthetic-fixture' }
  });
  assert.equal(normal.outcome, 'allow');
  assert.equal(normal.reviewRequired, false);
  assert.ok(normal.decisions.every(decision => decision.action === 'allow' && decision.ruleId));

  const constraints = effectiveHealthConstraints({
    verified: empty,
    pendingIntakes: [{ id: 731, source: 'form', profile: { ...empty, allergies: { status: 'reported', items: ['虾'] } } }]
  });
  const pending = evaluateProjectRules({
    project: sampleProject('sea-bath'), verifiedProfile: empty,
    environment: { uvLevel: 'moderate', seaStatus: 'safe' }, effectiveHealthConstraints: constraints
  });
  assert.equal(pending.outcome, 'restrict');
  assert.equal(pending.reviewRequired, true);
  assert.deepEqual(pending.constraintSources.map(source => [source.value, source.sourceId, source.status]), [['虾', 731, 'pending']]);
  await withQ11Apis(async context => {
    const guest = assertOk(await login(context.baseUrl, 'guest'));
    const result = assertOk(await request(context.baseUrl, '/rules/evaluate', {
      method: 'POST', token: guest.token,
      body: { projectId: 'project-tidal-foraging', environment: { seaStatus: 'missing', source: 'q13-api-fixture' } }
    }));
    const decision = result.decisions.find(item => item.ruleId === 'R5');
    assert.equal(decision.version, 'stage13-v1');
    assert.equal(decision.action, RULE_SEEDS[4].action);
    assert.equal(decision.sourceReference, RULE_SEEDS[4].sourceReference);
    assert.deepEqual(decision.fieldSources[0], {
      field: 'environment.seaStatus', value: 'missing', source: 'q13-api-fixture', sourceId: null, status: 'missing'
    });
    assert.equal(result.outcome, 'reject');
  });
  return { output: ['R1–R5 each matched its designated sample and returned action, field source, and reviewRequired', 'normal sample allows; missing sea-condition input rejects a sea-entry project', 'pending explicit allergy remains attached with intake source ID and requires review', 'authenticated API evaluation reads rule version/action/source from persisted SQLite/MySQL records'] };
}

async function q1310() {
  await withQ11Apis(async context => {
    const result = assertOk(await request(context.baseUrl, '/rules?q=%E7%9A%AE%E8%82%A4'));
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].ruleId, 'R2');
    assert.equal(result.items[0].version, 'stage13-v1');
    assert.ok(result.items[0].triggerCondition && result.items[0].action);
    await checkWebSource(['function RulesWorkbench', 'id="rules-search"', '触发条件', '处置动作']);
  });
  return { output: ['searching 皮肤 returns R2 with the same version, condition and action as the CLI evaluator', 'clinician rules view is searchable and read-only'] };
}

const tests = {
  'Q13.1': q131,
  'Q13.2': q132,
  'Q13.3': q133,
  'Q13.4': q134,
  'Q13.5': q135,
  'Q13.6': q136,
  'Q13.7': q137,
  'Q13.8': q138,
  'Q13.9': q139,
  'Q13.10': q1310
};

export async function run({ questId }) {
  const test = tests[questId];
  if (!test) throw new Error(`Unknown Stage 13 quest: ${questId}`);
  return await test();
}
