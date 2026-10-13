import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectExerciseInventorySummary, inspectWellnessCollaboration, summarizeReadOnlyToolResult } from '../src/wellness-run-evidence.js';

function completedAgent(agentId, candidateIds, contextTool, knowledgeTool) {
  return {
    agentId, runId: `run-${agentId}`, executionMode: 'live', status: 'completed', candidateIds,
    modelSteps: [{ status: 'completed' }, { status: 'completed' }],
    tools: [{ toolName: contextTool, status: 'completed' }, { toolName: knowledgeTool, status: 'completed' }],
    sources: [{ type: 'domain_knowledge', id: `${agentId}:knowledge` }]
  };
}

function validRun() {
  const nutrition = completedAgent('domain.nutrition', ['meal:breakfast'], 'get_nutrition_context', 'get_nutrition_knowledge');
  const exercise = completedAgent('domain.exercise', ['exercise:walk'], 'get_exercise_context', 'get_exercise_knowledge');
  nutrition.tools[0].resultSummary = { candidateCount: 1, excludedCandidateCount: 2, catalogMainDishCount: 3 };
  exercise.tools[0].resultSummary = exerciseSummary('2026-10-06', [{ projectId: 'project-walk',
    availabilitySource: 'activity_slots', outcome: 'allow', openWindows: [{ id: 'slot-1', availableCount: 2, closed: false }] }]);
  return {
    runId: 'run-parent', status: 'completed', executionMode: 'live', collaboration: {
      parent: { modelSteps: [{ status: 'completed' }] },
      coordinatorStatus: 'completed', selectionSource: 'model', fallbackSource: null,
      selectionValidation: { schemaValid: true, allowlistValid: true, responseComplete: true },
      agents: [nutrition, exercise], finalAdoptedCandidateIds: ['meal:breakfast', 'exercise:walk'],
      candidates: [
        { candidateId: 'meal:breakfast', domain: 'nutrition', status: 'adopted' },
        { candidateId: 'exercise:walk', domain: 'exercise', status: 'adopted' }
      ]
    }
  };
}

function exerciseSummary(date, activities) {
  const completeActivities = activities.map(activity => ({ ...activity, reviewRequired: activity.reviewRequired ?? false }));
  return summarizeReadOnlyToolResult('get_exercise_context', { data: { date, activities: completeActivities, existingSchedule: [] },
    sources: [{ type: 'activity_slot_inventory', id: date },
      ...completeActivities.flatMap(activity => [{ type: 'project', id: activity.projectId },
        ...(activity.availabilitySource === 'activity_slots'
          ? activity.openWindows.map(slot => ({ type: 'project_slot', id: slot.id })) : [])])] });
}

function zeroExerciseRun() {
  const run = validRun();
  const nutrition = run.collaboration.agents[0];
  const exercise = run.collaboration.agents[1];
  const activities = [
    { projectId: 'project-morning-beach-exercise', availabilitySource: 'project.openWindows.demo',
      outcome: 'allow', openWindows: [{ start: '07:00', end: '08:00' }] },
    { projectId: 'project-beach-walk', availabilitySource: 'project.openWindows.demo',
      outcome: 'allow', openWindows: [{ start: '07:00', end: '08:00' }, { start: '16:00', end: '17:00' }] },
    { projectId: 'project-swimming-training', availabilitySource: 'project.openWindows.demo',
      outcome: 'reject', reviewRequired: true, openWindows: [] },
    { projectId: 'project-coastal-hike', availabilitySource: 'project.openWindows.demo',
      outcome: 'allow', openWindows: [{ start: '08:00', end: '09:00' }] }
  ];
  nutrition.candidateIds = ['breakfast:dish-chicken-rice', 'lunch:dish-chicken-rice', 'dinner:dish-chicken-rice'];
  exercise.candidateIds = ['project-morning-beach-exercise', 'project-beach-walk', 'project-coastal-hike'];
  exercise.tools[0].resultSummary = exerciseSummary('2026-10-05', activities);
  run.collaboration.candidates = [
    ...nutrition.candidateIds.map(candidateId => ({ candidateId, domain: 'nutrition', status: 'adopted' })),
    ...exercise.candidateIds.slice(0, 2).map(candidateId => ({ candidateId, domain: 'exercise', status: 'adopted' })),
    { candidateId: 'project-swimming-training', domain: 'exercise', status: 'rejected' }
  ];
  run.collaboration.finalAdoptedCandidateIds = nutrition.candidateIds;
  return run;
}

test('four-domain adoption retains physio/companionship candidates and rejects missing or failed professional evidence', () => {
  const run=validRun();
  run.collaboration.agents.push(completedAgent('domain.physio',['mud'],'get_physio_context','get_therapy_knowledge'),
    completedAgent('domain.psychology',['breathing'],'get_psychology_context','get_companionship_knowledge'));
  run.collaboration.candidates.push({candidateId:'mud',domain:'physio',status:'adopted'},
    {candidateId:'breathing',domain:'psychology',status:'adopted'});
  run.collaboration.finalAdoptedCandidateIds.push('mud','breathing');
  const result=inspectWellnessCollaboration(run,{expectedExerciseDate:'2026-10-06'});
  assert.equal(result.valid,true);assert.equal(result.candidates.length,4);
  run.collaboration.agents[3].status='failed';
  assert.equal(inspectWellnessCollaboration(run,{expectedExerciseDate:'2026-10-06'}).rejection.condition,'domain_agent_not_completed');
  run.collaboration.agents.pop();
  assert.equal(inspectWellnessCollaboration(run,{expectedExerciseDate:'2026-10-06'}).rejection.condition,'required_domain_agent_missing');
});

test('read-only tool summaries retain bounded inventory counts and source IDs without raw result data', () => {
  const summary = summarizeReadOnlyToolResult('get_nutrition_context', {
    data: { candidates: [{ candidateId: 'meal:breakfast', mealType: 'breakfast' }],
      excluded: [{ mealType: 'lunch', reason: 'allergy' }], restrictions: [{ value: 'sensitive' }], profileVersion: 2 },
    sources: [{ type: 'nutrition_candidate_inventory', id: 'main-dish-catalog', label: 'private label' }]
  });
  assert.deepEqual(summary, {
    kind: 'nutrition_context', candidateCount: 1, candidateCountsByMeal: { breakfast: 1 },
    candidateIds: ['meal:breakfast'], excludedCandidateCount: 1, excludedCountsByMeal: { lunch: 1 },
    excludedCountsByReason: { allergy: 1 }, catalogMainDishCount: 2, restrictionCount: 1, profileVersion: 2,
    sources: [{ type: 'nutrition_candidate_inventory', id: 'main-dish-catalog' }]
  });
  assert.equal(JSON.stringify(summary).includes('private label'), false);
  assert.equal(JSON.stringify(summary).includes('sensitive'), false);
});

test('exercise and knowledge summaries parse stored JSON payloads instead of counting empty fallbacks', () => {
  const exercise = summarizeReadOnlyToolResult('get_exercise_context', JSON.stringify({ date: '2026-10-06',
    activities: [{ projectId: 'walk', availabilitySource: 'activity_slots', outcome: 'allow', reviewRequired: false,
      openWindows: [{ id: 'slot-1', availableCount: 2, closed: false }, { id: 'slot-2', availableCount: 0, closed: false }] },
    { projectId: 'demo', availabilitySource: 'project.openWindows.demo', outcome: 'allow', reviewRequired: false,
      openWindows: [{ start: '08:00' }] }],
    existingSchedule: [] }), [{ type: 'activity_slot_inventory', id: '2026-10-06' }]);
  assert.equal(exercise.date, '2026-10-06');
  assert.equal(exercise.projectCount, 2);
  assert.equal(exercise.actualActivitySlotCount, 2);
  assert.equal(exercise.potentiallyAvailableActualSlotCount, 1);
  assert.equal(exercise.demoOpenWindowCount, 1);
  assert.deepEqual(exercise.sources, [{ type: 'activity_slot_inventory', id: '2026-10-06' }]);

  const knowledge = summarizeReadOnlyToolResult('get_exercise_knowledge', JSON.stringify([
    { knowledgeId: 'exercise-1', sourceReference: 'do not persist this body' }, { knowledgeId: 'exercise-2' }
  ]), [{ type: 'domain_knowledge', id: 'exercise-1' }]);
  assert.deepEqual(knowledge, { kind: 'knowledge_context', itemCount: 2,
    knowledgeIds: ['exercise-1', 'exercise-2'], sources: [{ type: 'domain_knowledge', id: 'exercise-1' }] });
  assert.equal(JSON.stringify(knowledge).includes('do not persist this body'), false);
});

test('a malformed exercise tool result stays unknown instead of becoming a zero inventory', () => {
  const summary = summarizeReadOnlyToolResult('get_exercise_context', { data: { date: '2026-10-06' },
    sources: [{ type: 'activity_slot_inventory', id: '2026-10-06' }] });
  assert.equal(summary.inventoryShapeValid, false);
  assert.equal(summary.projectCount, null);
  assert.equal(summary.actualActivitySlotCount, null);
  assert.equal(inspectExerciseInventorySummary(summary, '2026-10-06').rejection.condition,
    'exercise_inventory_summary_incomplete');
});

test('valid completed domain graph requires coordinator validation, both required tools, provenance, and selected candidates', () => {
  const result = inspectWellnessCollaboration(validRun(), { expectedExerciseDate: '2026-10-06' });
  assert.equal(result.valid, true);
  assert.equal(result.planningCandidates.length, 2);
});

test('collaboration rejection retains the exact failed child condition', () => {
  const run = validRun();
  run.collaboration.agents[1].status = 'failed';
  run.collaboration.agents[1].errorCode = 'TOOL_TIMEOUT';
  assert.deepEqual(inspectWellnessCollaboration(run, { expectedExerciseDate: '2026-10-06' }).rejection, {
    condition: 'domain_agent_not_completed', agentId: 'domain.exercise', observed: 'failed', errorCode: 'TOOL_TIMEOUT'
  });
});

test('collaboration rejection identifies an incomplete required tool', () => {
  const run = validRun();
  run.collaboration.agents[0].tools = run.collaboration.agents[0].tools.filter(tool => tool.toolName !== 'get_nutrition_knowledge');
  const rejection = inspectWellnessCollaboration(run, { expectedExerciseDate: '2026-10-06' }).rejection;
  assert.equal(rejection.condition, 'required_domain_tool_incomplete');
  assert.deepEqual(rejection.missingTools, ['get_nutrition_knowledge']);
});

test('collaboration rejection identifies invalid coordinator validation', () => {
  const run = validRun();
  run.collaboration.selectionValidation.allowlistValid = false;
  assert.equal(inspectWellnessCollaboration(run, { expectedExerciseDate: '2026-10-06' }).rejection.condition,
    'coordinator_selection_allowlist_invalid');
});

test('wellness draft evidence rejects a coordinator response that lacks task semantics', () => {
  const run = validRun();
  run.collaboration.coordinatorEvidence = { task: 'wellness_draft', validation: {
    errorCode: 'COORDINATOR_WELLNESS_MEAL_SELECTION_MISSING'
  } };
  run.collaboration.selectionValidation.semanticValid = false;
  assert.deepEqual(inspectWellnessCollaboration(run, { expectedExerciseDate: '2026-10-06' }).rejection, {
    condition: 'coordinator_selection_semantics_invalid', observed: false,
    errorCode: 'COORDINATOR_WELLNESS_MEAL_SELECTION_MISSING'
  });
});

test('model omissions remain rejected when a read-only inventory contains legal candidates', () => {
  const run = validRun();
  run.collaboration.agents[0].candidateIds = [];
  run.collaboration.finalAdoptedCandidateIds = ['exercise:walk'];
  assert.equal(inspectWellnessCollaboration(run, { expectedExerciseDate: '2026-10-06' }).rejection.condition,
    'nutrition_adopted_candidate_missing');
});

test('an empty nutrition result is accepted only when the completed inventory proves every catalog candidate was excluded', () => {
  const run = validRun();
  const nutrition = run.collaboration.agents[0];
  nutrition.candidateIds = [];
  nutrition.tools[0].resultSummary = { kind: 'nutrition_context', candidateCount: 0, excludedCandidateCount: 5,
    catalogMainDishCount: 5, sources: [{ type: 'nutrition_candidate_inventory', id: 'main-dish-catalog' },
      { type: 'guest_profile', id: 'guest-1' }] };
  run.collaboration.candidates = run.collaboration.candidates.filter(item => item.domain !== 'nutrition');
  run.collaboration.finalAdoptedCandidateIds = ['exercise:walk'];
  const result = inspectWellnessCollaboration(run, { expectedExerciseDate: '2026-10-06' });
  assert.equal(result.valid, true);
  assert.equal(result.emptyCandidateDomains.nutrition.inventoryStatus, 'all_candidates_excluded');
  assert.equal(result.emptyCandidateDomains.nutrition.catalogMainDishCount, 5);
});

test('an empty nutrition result is rejected when candidate IDs are empty but inventory provenance is missing', () => {
  const run = validRun();
  const nutrition = run.collaboration.agents[0];
  nutrition.candidateIds = [];
  nutrition.tools[0].resultSummary = { candidateCount: 0, excludedCandidateCount: 5, catalogMainDishCount: 5, sources: [] };
  run.collaboration.candidates = run.collaboration.candidates.filter(item => item.domain !== 'nutrition');
  run.collaboration.finalAdoptedCandidateIds = ['exercise:walk'];
  assert.equal(inspectWellnessCollaboration(run, { expectedExerciseDate: '2026-10-06' }).rejection.condition,
    'nutrition_adopted_candidate_missing');
});

test('source-proven zero actual inventory accepts nutrition-only coordination without adopting exercise candidates', () => {
  const run = zeroExerciseRun();
  const result = inspectWellnessCollaboration(run, { expectedExerciseDate: '2026-10-05' });
  assert.equal(result.valid, true);
  assert.deepEqual(run.collaboration.finalAdoptedCandidateIds,
    ['breakfast:dish-chicken-rice', 'lunch:dish-chicken-rice', 'dinner:dish-chicken-rice']);
  assert.equal(result.planningCandidates.some(item => item.domain === 'exercise'), false);
  assert.deepEqual(result.emptyCandidateDomains.exercise, {
    inventoryStatus: 'verified_no_actual_slots', date: '2026-10-05', projectCount: 4,
    actualActivitySlotCount: 0, potentiallyAvailableActualSlotCount: 0, unavailableActualSlotCount: 0,
    demoOpenWindowCount: 4, sources: [{ type: 'activity_slot_inventory', id: '2026-10-05' }],
    projectSources: ['project-morning-beach-exercise', 'project-beach-walk', 'project-swimming-training',
      'project-coastal-hike'].map(id => ({ type: 'project', id })),
    parentRunId: 'run-parent', childRunId: 'run-domain.exercise', childCandidateCount: 3,
    coordinatorSelectedExerciseCandidateCount: 0
  });
});

test('zero actual inventory evidence is bound to the exercise child input date and complete source list', () => {
  const summary = zeroExerciseRun().collaboration.agents[1].tools[0].resultSummary;
  assert.equal(inspectExerciseInventorySummary(summary, '2026-10-05').valid, true);
  assert.equal(inspectExerciseInventorySummary(summary, '2026-10-06').rejection.condition,
    'exercise_inventory_date_mismatch');
  const missingSource = { ...summary, sources: summary.sources.filter(source => source.type !== 'activity_slot_inventory') };
  assert.equal(inspectExerciseInventorySummary(missingSource, '2026-10-05').rejection.condition,
    'exercise_inventory_provenance_missing');
});

test('unknown, illegal, or inconsistent inventory counts never become a zero-inventory exception', () => {
  const summary = zeroExerciseRun().collaboration.agents[1].tools[0].resultSummary;
  for (const value of [undefined, '0', -1, Number.NaN, 0.5]) {
    const broken = { ...summary, actualActivitySlotCount: value };
    assert.equal(inspectExerciseInventorySummary(broken, '2026-10-05').rejection.condition,
      'exercise_inventory_count_invalid');
  }
  const inconsistent = { ...summary, actualActivitySlotCount: 1 };
  assert.equal(inspectExerciseInventorySummary(inconsistent, '2026-10-05').rejection.condition,
    'exercise_inventory_count_inconsistent');
});

test('a coordinator omission remains rejected when real inventory exists, even if no slot is potentially available', () => {
  const run = zeroExerciseRun();
  const exercise = run.collaboration.agents[1];
  exercise.tools[0].resultSummary = exerciseSummary('2026-10-05', [{ projectId: 'project-walk',
    availabilitySource: 'activity_slots', outcome: 'allow', openWindows: [{ id: 'slot-closed', availableCount: 0, closed: true }] }]);
  const result = inspectWellnessCollaboration(run, { expectedExerciseDate: '2026-10-05' });
  assert.equal(result.valid, false);
  assert.equal(result.rejection.condition, 'exercise_planning_candidate_missing');
  assert.equal(result.rejection.toolContext.actualActivitySlotCount, 1);
  assert.equal(result.rejection.toolContext.potentiallyAvailableActualSlotCount, 0);
});

test('parent failure, coordinator model fallback, and mismatched child mode stay rejected', () => {
  const parentFailure = validRun();
  parentFailure.status = 'failed';
  assert.equal(inspectWellnessCollaboration(parentFailure, { expectedExerciseDate: '2026-10-06' }).rejection.condition,
    'parent_run_not_completed');
  const fallback = validRun();
  fallback.collaboration.selectionSource = 'fallback';
  fallback.collaboration.fallbackSource = 'completed_domain_candidates';
  assert.equal(inspectWellnessCollaboration(fallback, { expectedExerciseDate: '2026-10-06' }).rejection.condition,
    'coordinator_selection_not_model');
  const wrongChildMode = validRun();
  wrongChildMode.collaboration.agents[1].executionMode = 'safe_guidance';
  assert.equal(inspectWellnessCollaboration(wrongChildMode, { expectedExerciseDate: '2026-10-06' }).rejection.condition,
    'domain_run_identity_or_mode_invalid');
});
