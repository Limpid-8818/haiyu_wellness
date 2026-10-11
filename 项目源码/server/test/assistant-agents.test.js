import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WELLNESS_DRAFT_COORDINATION_TASK, buildCoordinatorSelectionContract, parseCoordinatorSelection,
  publicAgentContracts, summarizeCoordinatorSelectionEvidence, validateCoordinatorSelection,
  validateCoordinatorSelectionForTask
} from '../src/assistant-agents.js';

const allowed = ['breakfast:chicken', 'lunch:fish'];

test('coordinator selection validates its exact JSON schema and candidate allowlist', () => {
  const result = validateCoordinatorSelection('{"selectedCandidateIds":["breakfast:chicken"]}', allowed);
  assert.deepEqual(result, { ok: true, selectedCandidateIds: ['breakfast:chicken'], schemaValid: true, allowlistValid: true });
  assert.deepEqual(parseCoordinatorSelection('{"selectedCandidateIds":[]}', allowed), []);
});

test('coordinator rejects empty output, invalid JSON, schema violations, duplicates, and unauthorized candidates', () => {
  for (const [content, code] of [
    ['', 'COORDINATOR_OUTPUT_EMPTY'],
    ['   ', 'COORDINATOR_OUTPUT_EMPTY'],
    ['{not json', 'COORDINATOR_OUTPUT_INVALID_JSON'],
    ['{"selectedCandidateIds":["breakfast:chicken"],"extra":true}', 'COORDINATOR_OUTPUT_SCHEMA_INVALID'],
    ['{"selectedCandidateIds":[""]}', 'COORDINATOR_OUTPUT_SCHEMA_INVALID'],
    ['{"selectedCandidateIds":["breakfast:chicken","breakfast:chicken"]}', 'COORDINATOR_OUTPUT_SCHEMA_INVALID'],
    ['{"selectedCandidateIds":["invented:candidate"]}', 'COORDINATOR_CANDIDATE_NOT_ALLOWED']
  ]) {
    const result = validateCoordinatorSelection(content, allowed);
    assert.equal(result.ok, false, code);
    assert.equal(result.errorCode, code);
    assert.equal(parseCoordinatorSelection(content, allowed), null);
  }
});

test('coordinator selection validation never returns model text or extra properties', () => {
  const result = validateCoordinatorSelection('{"selectedCandidateIds":["invented:candidate"]}', allowed);
  assert.deepEqual(Object.keys(result).sort(), ['allowlistValid', 'errorCode', 'ok', 'schemaValid'].sort());
});

test('coordinator prompt and payload share the same adoptedCandidateIds allowlist', () => {
  const contract = buildCoordinatorSelectionContract({ request: '普通咨询', candidates: [
    { candidateId: 'breakfast:chicken', domain: 'nutrition', title: '鸡肉粥', status: 'adopted', sourceIds: [{ type: 'dish', id: 'dish-1' }] },
    { candidateId: 'blocked:item', domain: 'nutrition', title: '已排除', status: 'rejected' }
  ] });
  assert.match(contract.systemPrompt, /adoptedCandidateIds/u);
  assert.deepEqual(contract.allowedCandidateIds, ['breakfast:chicken']);
  assert.deepEqual(contract.payload.adoptedCandidateIds, contract.allowedCandidateIds);
  assert.deepEqual(contract.payload.adoptedCandidates.map(item => item.candidateId), contract.allowedCandidateIds);
  assert.deepEqual(parseCoordinatorSelection('{"selectedCandidateIds":[]}', contract.allowedCandidateIds), []);
});

test('published coordinator input schema describes the runtime selection payload and still permits empty output', () => {
  const coordinator = publicAgentContracts().find(contract => contract.agentId === 'household.concierge');
  assert.equal(coordinator.instructionVersion, '1.1.0');
  assert.deepEqual(coordinator.inputSchema.required,
    ['request', 'adoptedCandidateIds', 'adoptedCandidates', 'gaps']);
  assert.ok(Object.hasOwn(coordinator.inputSchema.properties, 'coordinationTask'));
  assert.equal(coordinator.outputSchema.properties.selectedCandidateIds.items.type, 'string');
  assert.equal(coordinator.outputSchema.properties.selectedCandidateIds.minItems, undefined);
});

test('wellness-draft input retains source dates and actual activity inventory while excluding demo candidates', () => {
  const candidates = [
    ...['breakfast', 'lunch', 'dinner'].map(mealType => ({ candidateId: `${mealType}:dish`, domain: 'nutrition',
      title: `${mealType} dish`, status: 'adopted', details: { mealType } })),
    { candidateId: 'project-real', domain: 'exercise', title: '海边步行', status: 'adopted',
      details: { availabilitySource: 'activity_slots', windows: [{ id: 'slot-1', closed: false, availableCount: 1 }] } },
    { candidateId: 'project-demo', domain: 'exercise', title: '演示瑜伽', status: 'adopted',
      details: { availabilitySource: 'project.openWindows.demo', windows: [{ start: '09:00', end: '10:00' }] } },
    { candidateId: 'project-review', domain: 'exercise', title: '需复核', status: 'requires_review',
      details: { availabilitySource: 'activity_slots', windows: [{ id: 'slot-2', closed: false, availableCount: 1 }] } }
  ];
  const contract = buildCoordinatorSelectionContract({ request: '生成七日草案', candidates,
    task: WELLNESS_DRAFT_COORDINATION_TASK, sourceDates: { nutrition: '2026-10-06', exercise: '2026-10-06' } });
  assert.deepEqual(contract.allowedCandidateIds,
    ['breakfast:dish', 'lunch:dish', 'dinner:dish', 'project-real']);
  assert.deepEqual(contract.payload.adoptedCandidateIds, contract.allowedCandidateIds);
  assert.ok(contract.payload.adoptedCandidates.filter(item => item.domain === 'nutrition')
    .every(item => item.sourceDate === '2026-10-06'));
  assert.equal(contract.payload.adoptedCandidates.find(item => item.domain === 'exercise').availableSlotCount, 1);
  assert.match(contract.systemPrompt, /每个 mealType/u);
  assert.match(contract.systemPrompt, /演示开放窗口/u);
});

test('wellness draft requires each available meal and legal actual activity, but preserves proven empty semantics', () => {
  const candidates = [
    ...['breakfast', 'lunch', 'dinner'].map(mealType => ({ candidateId: `${mealType}:dish`, domain: 'nutrition',
      title: mealType, status: 'adopted', details: { mealType } })),
    { candidateId: 'project-real', domain: 'exercise', title: '步行', status: 'adopted',
      details: { availabilitySource: 'activity_slots', windows: [{ closed: false, availableCount: 1 }] } }
  ];
  const contract = buildCoordinatorSelectionContract({ request: '草案', candidates,
    task: WELLNESS_DRAFT_COORDINATION_TASK, sourceDates: { nutrition: '2026-10-06', exercise: '2026-10-06' } });
  const validIds = contract.allowedCandidateIds;
  const complete = validateCoordinatorSelectionForTask(
    validateCoordinatorSelection(JSON.stringify({ selectedCandidateIds: validIds }), validIds), contract);
  assert.equal(complete.ok, true);
  assert.equal(complete.semanticValid, true);

  const missingMeal = validateCoordinatorSelectionForTask(
    validateCoordinatorSelection(JSON.stringify({ selectedCandidateIds: validIds.slice(1) }), validIds), contract);
  assert.equal(missingMeal.ok, false);
  assert.equal(missingMeal.errorCode, 'COORDINATOR_WELLNESS_MEAL_SELECTION_MISSING');

  const missingActivity = validateCoordinatorSelectionForTask(
    validateCoordinatorSelection(JSON.stringify({ selectedCandidateIds: validIds.slice(0, 3) }), validIds), contract);
  assert.equal(missingActivity.ok, false);
  assert.equal(missingActivity.errorCode, 'COORDINATOR_WELLNESS_ACTIVITY_SELECTION_MISSING');

  const emptyContract = buildCoordinatorSelectionContract({ request: '空库存', candidates: [],
    task: WELLNESS_DRAFT_COORDINATION_TASK, sourceDates: { nutrition: '2026-10-06', exercise: '2026-10-06' } });
  const empty = validateCoordinatorSelectionForTask(
    validateCoordinatorSelection('{"selectedCandidateIds":[]}', emptyContract.allowedCandidateIds), emptyContract);
  assert.equal(empty.ok, true);
  assert.equal(parseCoordinatorSelection('{"selectedCandidateIds":[]}', []).length, 0,
    'generic assistant empty selection remains valid');
});

test('coordinator evidence stores bounded hashes and validation metadata, not raw prompt or response', () => {
  const privateRequest = '私密请求内容不能写入诊断正文';
  const privateResponse = '{"selectedCandidateIds":["breakfast:chicken"]}';
  const contract = buildCoordinatorSelectionContract({ request: privateRequest, candidates: [
    { candidateId: 'breakfast:chicken', domain: 'nutrition', title: '示例', status: 'adopted' }
  ] });
  const validation = validateCoordinatorSelection(privateResponse, contract.allowedCandidateIds);
  const evidence = summarizeCoordinatorSelectionEvidence({ contract, responseContent: privateResponse, validation });
  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes(privateRequest), false);
  assert.equal(serialized.includes(privateResponse), false);
  assert.equal(evidence.response.byteLength, Buffer.byteLength(privateResponse));
  assert.equal(evidence.validation.schemaValid, true);
  assert.equal(evidence.input.allowedCandidateIds[0], 'breakfast:chicken');
});
