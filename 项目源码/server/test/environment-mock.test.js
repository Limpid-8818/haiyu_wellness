import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnvironmentMockSnapshot, environmentMockScenario } from '../src/environment-mock.js';
import { assessEnvironmentWindow } from '../src/environment-availability.js';
import { PROJECT_SEEDS } from '../src/catalog-data.js';

const date = '2026-10-13', clock = '2026-10-12T04:00:00.000Z';
const beach = PROJECT_SEEDS.find(x => x.id === 'project-beach-walk');
const sea = PROJECT_SEEDS.find(x => x.id === 'project-swimming-training');
const assessment = (snapshot, project = beach) => assessEnvironmentWindow({ project, snapshot, time: '08:00' });

test('four synthetic scenarios have hourly evidence, distinct identities and conservative safety outcomes', () => {
  const snapshots = ['normal', 'risk', 'missing', 'stale'].map(s => makeEnvironmentMockSnapshot(date, clock, s));
  assert.equal(new Set(snapshots.map(x => x.snapshotId)).size, 4);
  assert.equal(new Set(snapshots.map(x => x.mock.payloadHash)).size, 4);
  for (const s of snapshots) {
    for (const domain of ['weather', 'marine', 'tide']) assert.equal(s[domain].hourly.length, 24);
    assert.equal(s.mock.institutionApproved, false);
    assert.equal(s.safetyThresholds, null);
    assert.match(s.mock.label, /非实时.*非机构批准/);
  }
  const [normal, risk, missing, stale] = snapshots;
  assert.equal(assessment(normal).available, true);
  assert.equal(assessment(normal).isDemo, true);
  assert.equal(assessment(risk).status, 'restricted');
  assert.equal(assessment(risk).available, false);
  assert.ok(assessment(risk).ruleDecisions.some(x => x.ruleId === 'R3' && x.matched));
  assert.ok(assessment(risk, sea).ruleDecisions.some(x => x.ruleId === 'R5' && x.matched));
  assert.ok(risk.marine.hourly.every(x => x.waveHeightM > risk.demoRules.maxWaveHeightM));
  assert.ok(missing.weather.hourly.every(x => x.uvIndex === null));
  for (const s of [missing, stale]) assert.equal(assessment(s).status, 'pending');
  assert.ok(Date.parse(stale.expiresAt) < Date.parse(clock));
});

test('time advancement changes payload and default/invalid selection cannot silently enable normal', () => {
  const a = makeEnvironmentMockSnapshot(date, clock, 'normal');
  const b = makeEnvironmentMockSnapshot(date, '2026-10-12T05:00:00.000Z', 'normal');
  assert.notEqual(a.mock.payloadHash, b.mock.payloadHash);
  assert.notEqual(a.weather.hourly[8].uvIndex, b.weather.hourly[8].uvIndex);
  assert.equal(b.mock.timeStep, a.mock.timeStep + 1);
  assert.equal(environmentMockScenario('missing'), 'missing');
  assert.throws(() => environmentMockScenario('unsafe-override'), TypeError);
  assert.throws(() => environmentMockScenario(['normal']), TypeError);
  assert.throws(() => makeEnvironmentMockSnapshot('2026-02-30', clock, 'normal'));
});

test('live and mixed inputs still need institutional thresholds', () => {
  const s = makeEnvironmentMockSnapshot(date, clock, 'normal');
  const live = { ...s, mock: undefined, weather: { ...s.weather, status: 'available' } };
  assert.equal(assessment(live).available, false);
  assert.equal(assessment(live).status, 'pending');
  assert.match(assessment(live).reason, /机构安全阈值尚未确认/);
});
