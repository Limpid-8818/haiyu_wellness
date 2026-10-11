import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyHealthProfile, effectiveHealthConstraints } from '../src/health-profile.js';
import { PROJECT_SEEDS } from '../src/catalog-data.js';
import { evaluateProjectRules } from '../src/rules-engine.js';

function project(slug) {
  const seed = PROJECT_SEEDS.find(item => item.slug === slug);
  assert.ok(seed);
  return seed;
}

test('deterministic evaluator returns R1 through R5 decisions with provenance', () => {
  const empty = emptyHealthProfile();
  const cases = [
    ['R1', project('marine-hot-spring'), { ...empty, chronic: { status: 'reported', items: ['高血压'] } }, {}, 'restrict'],
    ['R2', project('sea-bath'), { ...empty, skin: { status: 'reported', details: '皮肤破损' } }, { seaStatus: 'safe' }, 'reject'],
    ['R3', project('beach-walk'), empty, { uvLevel: 'strong' }, 'restrict'],
    ['R4', project('swimming-training'), { ...empty, mobility: { status: 'assistance', details: '' } }, { seaStatus: 'safe' }, 'reject'],
    ['R5', project('tidal-foraging'), empty, {}, 'reject']
  ];
  for (const [ruleId, activity, profile, environment, action] of cases) {
    const result = evaluateProjectRules({ project: activity, verifiedProfile: profile, environment });
    const decision = result.decisions.find(item => item.ruleId === ruleId);
    assert.equal(decision.matched, true);
    assert.equal(decision.action, action);
    assert.equal(decision.reviewRequired, true);
    assert.ok(decision.fieldSources.length);
    assert.equal(result.outcome, action);
  }
});

test('safe normal context is allowed and pending allergy remains a conservative constraint', () => {
  const profile = emptyHealthProfile();
  const normal = evaluateProjectRules({
    project: project('sea-bath'), verifiedProfile: profile,
    environment: { uvLevel: 'moderate', seaStatus: 'safe' }
  });
  assert.equal(normal.outcome, 'allow');
  assert.equal(normal.reviewRequired, false);

  const effective = effectiveHealthConstraints({
    verified: profile,
    pendingIntakes: [{ id: 42, source: 'form', profile: { ...profile, allergies: { status: 'reported', items: ['虾'] } } }]
  });
  const result = evaluateProjectRules({
    project: project('sea-bath'), verifiedProfile: profile,
    environment: { uvLevel: 'moderate', seaStatus: 'safe' }, effectiveHealthConstraints: effective
  });
  assert.equal(result.outcome, 'restrict');
  assert.equal(result.reviewRequired, true);
  assert.deepEqual(result.constraintSources.map(item => [item.value, item.sourceId, item.status]), [['虾', 42, 'pending']]);
});

test('rule output uses persisted rule metadata and marks missing environment provenance', () => {
  const seed = project('tidal-foraging');
  const metadata = Array.from({ length: 5 }, (_, index) => ({
    ruleId: `R${index + 1}`, version: 'stored-v7', action: 'restrict',
    triggerCondition: `stored condition ${index + 1}`, sourceReference: `stored source ${index + 1}`,
    sourceUrl: `https://example.test/R${index + 1}`
  }));
  const result = evaluateProjectRules({ project: seed, rules: metadata });
  const decision = result.decisions.find(item => item.ruleId === 'R5');
  assert.equal(decision.version, 'stored-v7');
  assert.equal(decision.action, 'restrict');
  assert.equal(decision.reason, 'stored condition 5');
  assert.equal(decision.sourceReference, 'stored source 5');
  assert.deepEqual(decision.fieldSources[0], {
    field: 'environment.seaStatus', value: 'missing', source: 'not-provided', sourceId: null, status: 'missing'
  });
});
