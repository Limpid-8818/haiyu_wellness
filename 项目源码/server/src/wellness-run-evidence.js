function parseJson(value) {
  if (typeof value !== 'string' || !value) return value;
  try { return JSON.parse(value); } catch { return value; }
}

function asObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  const parsed = parseJson(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function sourceIds(value) {
  let refs = value;
  if (typeof refs === 'string') refs = asObject(refs);
  if (!Array.isArray(refs)) return [];
  return refs.filter(item => item && typeof item.type === 'string' && item.id !== undefined && item.id !== null)
    .slice(0, 80).map(item => ({ type: item.type.slice(0, 64), id: String(item.id).slice(0, 160) }));
}

function countsBy(items, key) {
  const result = {};
  for (const item of items) {
    const name = String(item?.[key] || 'unknown').slice(0, 48);
    result[name] = (result[name] || 0) + 1;
  }
  return result;
}

function isDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function summarizeReadOnlyToolResult(toolName, resultJson, sourceJson = []) {
  const parsed = parseJson(resultJson);
  const result = asObject(parsed);
  const data = result.data ?? parsed;
  const refs = sourceIds(Array.isArray(result.sources) ? result.sources : sourceJson);

  if (toolName === 'get_nutrition_context') {
    const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
    const excluded = Array.isArray(data?.excluded) ? data.excluded : [];
    const restrictions = Array.isArray(data?.restrictions) ? data.restrictions : [];
    return {
      kind: 'nutrition_context',
      candidateCount: candidates.length,
      candidateCountsByMeal: countsBy(candidates, 'mealType'),
      candidateIds: candidates.slice(0, 80).map(item => String(item?.candidateId || '').slice(0, 160)).filter(Boolean),
      excludedCandidateCount: excluded.length,
      excludedCountsByMeal: countsBy(excluded, 'mealType'),
      excludedCountsByReason: countsBy(excluded, 'reason'),
      catalogMainDishCount: candidates.length + excluded.length,
      restrictionCount: restrictions.length,
      profileVersion: Number.isFinite(Number(data?.profileVersion)) ? Number(data.profileVersion) : null,
      sources: refs
    };
  }

  if (toolName === 'get_exercise_context') {
    const activities = Array.isArray(data?.activities) ? data.activities : null;
    const activityShapeValid = Boolean(activities && activities.every(activity => activity
      && typeof activity === 'object' && !Array.isArray(activity)
      && typeof activity.projectId === 'string' && activity.projectId.length > 0
      && ['allow', 'restrict', 'reject'].includes(activity.outcome) && typeof activity.reviewRequired === 'boolean'
      && ['activity_slots', 'project.openWindows.demo'].includes(activity.availabilitySource)
      && Array.isArray(activity.openWindows)
      && activity.openWindows.every(slot => slot && typeof slot === 'object' && !Array.isArray(slot))
      && (activity.availabilitySource !== 'activity_slots' || activity.openWindows.every(slot =>
        typeof slot.id === 'string' && slot.id.length > 0 && Number.isSafeInteger(slot.availableCount)
        && slot.availableCount >= 0 && typeof slot.closed === 'boolean'))));
    const actualSlots = activityShapeValid ? activities.flatMap(activity => activity.availabilitySource === 'activity_slots'
      ? activity.openWindows.map(slot => ({ activity, slot })) : []) : null;
    const availableActualSlots = actualSlots?.filter(({ activity, slot }) => activity.outcome !== 'reject'
      && !slot.closed && slot.availableCount > 0) ?? null;
    const demoWindows = activityShapeValid ? activities.flatMap(activity => activity.availabilitySource === 'project.openWindows.demo'
      ? activity.openWindows : []) : null;
    const projectSummaryComplete = Boolean(activityShapeValid && activities.length <= 30);
    return {
      kind: 'exercise_context',
      inventoryShapeValid: Boolean(data && typeof data === 'object' && !Array.isArray(data)
        && isDateOnly(data.date) && activityShapeValid),
      projectSummaryComplete,
      date: isDateOnly(data?.date) ? data.date : null,
      projectCount: activityShapeValid ? activities.length : null,
      actualActivitySlotCount: actualSlots?.length ?? null,
      potentiallyAvailableActualSlotCount: availableActualSlots?.length ?? null,
      unavailableActualSlotCount: actualSlots && availableActualSlots
        ? actualSlots.length - availableActualSlots.length : null,
      demoOpenWindowCount: demoWindows?.length ?? null,
      existingScheduleCount: Array.isArray(data?.existingSchedule) ? data.existingSchedule.length : null,
      projects: activityShapeValid ? activities.slice(0, 30).map(activity => {
        const windows = activity.openWindows;
        const isActual = activity?.availabilitySource === 'activity_slots';
        return {
          projectId: activity.projectId.slice(0, 160),
          outcome: typeof activity.outcome === 'string' ? activity.outcome.slice(0, 32) : null,
          reviewRequired: Boolean(activity?.reviewRequired),
          availabilitySource: activity.availabilitySource,
          actualSlotCount: isActual ? windows.length : 0,
          potentiallyAvailableActualSlotCount: isActual ? windows.filter(slot => activity.outcome !== 'reject'
            && !slot.closed && slot.availableCount > 0).length : 0,
          demoWindowCount: activity.availabilitySource === 'project.openWindows.demo' ? windows.length : 0
        };
      }) : [],
      sources: refs
    };
  }

  if (toolName === 'get_nutrition_knowledge' || toolName === 'get_exercise_knowledge') {
    const items = Array.isArray(data) ? data : [];
    return { kind: 'knowledge_context', itemCount: items.length,
      knowledgeIds: items.slice(0, 80).map(item => String(item?.knowledgeId || '').slice(0, 160)).filter(Boolean),
      sources: refs };
  }

  return { kind: 'read_only_tool_result', sourceCount: refs.length, sources: refs };
}

function invalid(condition, details = {}) {
  return { valid: false, rejection: { condition, ...details } };
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function inspectExerciseInventorySummary(summary, expectedDate) {
  if (!isDateOnly(expectedDate)) {
    return invalid('exercise_inventory_expected_date_invalid', { expectedDate: expectedDate ?? null });
  }
  if (!summary || summary.kind !== 'exercise_context' || summary.inventoryShapeValid !== true
    || summary.projectSummaryComplete !== true) {
    return invalid('exercise_inventory_summary_incomplete', { inventoryShapeValid: summary?.inventoryShapeValid ?? null,
      projectSummaryComplete: summary?.projectSummaryComplete ?? null });
  }
  if (summary.date !== expectedDate) return invalid('exercise_inventory_date_mismatch', {
    expectedDate, observedDate: summary.date ?? null
  });
  const requiredCounts = ['projectCount', 'actualActivitySlotCount', 'potentiallyAvailableActualSlotCount',
    'unavailableActualSlotCount', 'demoOpenWindowCount'];
  const invalidCounts = requiredCounts.filter(key => !nonNegativeInteger(summary[key]));
  if (invalidCounts.length) return invalid('exercise_inventory_count_invalid', { invalidCounts });
  if (summary.potentiallyAvailableActualSlotCount > summary.actualActivitySlotCount
    || summary.unavailableActualSlotCount !== summary.actualActivitySlotCount - summary.potentiallyAvailableActualSlotCount) {
    return invalid('exercise_inventory_count_inconsistent');
  }
  if (!Array.isArray(summary.projects) || summary.projects.length !== summary.projectCount) {
    return invalid('exercise_inventory_project_summary_incomplete', { projectCount: summary.projectCount,
      summarizedProjectCount: Array.isArray(summary.projects) ? summary.projects.length : null });
  }
  const projectIds = new Set();
  for (const project of summary.projects) {
    if (!project || typeof project.projectId !== 'string' || !project.projectId || projectIds.has(project.projectId)) {
      return invalid('exercise_inventory_project_identity_invalid');
    }
    projectIds.add(project.projectId);
    if (!['activity_slots', 'project.openWindows.demo'].includes(project.availabilitySource)
      || !nonNegativeInteger(project.actualSlotCount)
      || !nonNegativeInteger(project.potentiallyAvailableActualSlotCount)
      || !nonNegativeInteger(project.demoWindowCount)
      || project.potentiallyAvailableActualSlotCount > project.actualSlotCount
      || (project.availabilitySource === 'activity_slots'
        && (project.actualSlotCount < 1 || project.demoWindowCount !== 0))
      || (project.availabilitySource === 'project.openWindows.demo'
        && (project.actualSlotCount !== 0 || project.potentiallyAvailableActualSlotCount !== 0))) {
      return invalid('exercise_inventory_project_count_invalid', { projectId: project.projectId });
    }
  }
  const projectSlotCount = summary.projects.reduce((sum, project) => sum + project.actualSlotCount, 0);
  const potentiallyAvailableCount = summary.projects.reduce((sum, project) => sum + project.potentiallyAvailableActualSlotCount, 0);
  const demoWindowCount = summary.projects.reduce((sum, project) => sum + project.demoWindowCount, 0);
  if (projectSlotCount !== summary.actualActivitySlotCount
    || potentiallyAvailableCount !== summary.potentiallyAvailableActualSlotCount
    || demoWindowCount !== summary.demoOpenWindowCount) {
    return invalid('exercise_inventory_project_counts_inconsistent');
  }
  const sources = sourceIds(summary.sources);
  const inventorySources = sources.filter(source => source.type === 'activity_slot_inventory');
  if (inventorySources.length !== 1 || inventorySources[0].id !== expectedDate) {
    return invalid('exercise_inventory_provenance_missing', { observedInventorySources: inventorySources });
  }
  const sourceProjects = new Set(sources.filter(source => source.type === 'project').map(source => source.id));
  const missingProjectSources = [...projectIds].filter(projectId => !sourceProjects.has(projectId));
  if (missingProjectSources.length) return invalid('exercise_inventory_project_provenance_missing', { missingProjectSources });
  const slotSourceCount = sources.filter(source => source.type === 'project_slot').length;
  if (slotSourceCount !== summary.actualActivitySlotCount) return invalid('exercise_inventory_slot_provenance_incomplete', {
    expectedProjectSlotSources: summary.actualActivitySlotCount, observedProjectSlotSources: slotSourceCount
  });
  return { valid: true, inventory: { date: expectedDate, projectCount: summary.projectCount,
    actualActivitySlotCount: summary.actualActivitySlotCount,
    potentiallyAvailableActualSlotCount: summary.potentiallyAvailableActualSlotCount,
    unavailableActualSlotCount: summary.unavailableActualSlotCount,
    demoOpenWindowCount: summary.demoOpenWindowCount,
    sources: inventorySources, projectSources: sources.filter(source => source.type === 'project') } };
}

function summarizeCandidateCounts(collaboration, agent) {
  const childIds = new Set(Array.isArray(agent?.candidateIds) ? agent.candidateIds : []);
  const merged = Array.isArray(collaboration?.candidates) ? collaboration.candidates : [];
  return {
    childCandidateCount: childIds.size,
    mergedCandidateCount: merged.filter(item => item?.domain === agent?.agentId?.replace('domain.', '')
      && childIds.has(item.candidateId)).length,
    adoptedSelectedCount: merged.filter(item => item?.domain === agent?.agentId?.replace('domain.', '')
      && item.status === 'adopted' && childIds.has(item.candidateId)
      && (collaboration.finalAdoptedCandidateIds || []).includes(item.candidateId)).length
  };
}

function provesNoLegalNutritionCandidate(agent) {
  const candidateIds = Array.isArray(agent?.candidateIds) ? agent.candidateIds : null;
  const context = agent?.tools?.find(tool => tool.toolName === 'get_nutrition_context')?.resultSummary;
  const inventorySource = context?.sources?.some(source => source.type === 'nutrition_candidate_inventory'
    && source.id === 'main-dish-catalog');
  const candidateCount = Number(context?.candidateCount);
  const excludedCount = Number(context?.excludedCandidateCount);
  const catalogCount = Number(context?.catalogMainDishCount);
  const inventoryIsEmpty = catalogCount === 0 && excludedCount === 0;
  const everyCatalogCandidateExcluded = catalogCount > 0 && excludedCount === catalogCount;
  return candidateIds?.length === 0 && context?.candidateCount === 0 && inventorySource
    && (inventoryIsEmpty || everyCatalogCandidateExcluded)
    ? { candidateCount, excludedCandidateCount: excludedCount, catalogMainDishCount: catalogCount,
      inventoryStatus: inventoryIsEmpty ? 'catalog_empty' : 'all_candidates_excluded',
      sources: context.sources.filter(source => ['nutrition_candidate_inventory', 'guest_profile', 'health_intake', 'dish']
        .includes(source.type)).slice(0, 40) }
    : null;
}

export function inspectWellnessCollaboration(run, { expectedExerciseDate } = {}) {
  if (!run || !['live', 'recorded_fixture'].includes(run.executionMode)) {
    return invalid('unsupported_execution_mode', { observed: run?.executionMode || null });
  }
  if (run.status !== 'completed') return invalid('parent_run_not_completed', { observed: run.status || null,
    errorCode: run.errorCode || null });
  const collaboration = run.collaboration;
  if (!collaboration) return invalid('collaboration_missing');
  if (collaboration.coordinatorStatus !== 'completed') {
    return invalid('coordinator_not_completed', { observed: collaboration.coordinatorStatus || null,
      coordinatorError: collaboration.coordinatorError || null });
  }
  if (collaboration.selectionValidation?.schemaValid !== true) {
    return invalid('coordinator_selection_schema_invalid', { observed: collaboration.selectionValidation || null });
  }
  if (collaboration.selectionValidation?.allowlistValid !== true) {
    return invalid('coordinator_selection_allowlist_invalid', { observed: collaboration.selectionValidation || null });
  }
  if (collaboration.selectionValidation?.responseComplete !== true) {
    return invalid('coordinator_selection_incomplete', { observed: collaboration.selectionValidation || null });
  }
  if (collaboration.coordinatorEvidence?.task === 'wellness_draft'
    && collaboration.selectionValidation?.semanticValid !== true) {
    return invalid('coordinator_selection_semantics_invalid', {
      observed: collaboration.selectionValidation?.semanticValid ?? null,
      errorCode: collaboration.coordinatorEvidence.validation?.errorCode || null
    });
  }
  if (collaboration.selectionSource !== 'model' || collaboration.fallbackSource) {
    return invalid('coordinator_selection_not_model', { selectionSource: collaboration.selectionSource || null,
      fallbackSource: collaboration.fallbackSource || null });
  }
  const coordinatorModelSteps = collaboration.parent?.modelSteps;
  if (!Array.isArray(coordinatorModelSteps) || coordinatorModelSteps.length === 0
    || coordinatorModelSteps.some(step => step.status !== 'completed')) {
    return invalid('coordinator_model_steps_incomplete', { observedModelStepCount: Array.isArray(coordinatorModelSteps)
      ? coordinatorModelSteps.length : 0 });
  }

  const agentList = Array.isArray(collaboration.agents) ? collaboration.agents : [];
  const agents = new Map(agentList.map(agent => [agent.agentId, agent]));
  for (const [agentId, tools] of [
    ['domain.nutrition', ['get_nutrition_context', 'get_nutrition_knowledge']],
    ['domain.exercise', ['get_exercise_context', 'get_exercise_knowledge']]
  ]) {
    const agent = agents.get(agentId);
    if (!agent) return invalid('required_domain_agent_missing', { agentId });
    if (agent.status !== 'completed') return invalid('domain_agent_not_completed', { agentId,
      observed: agent.status || null, errorCode: agent.errorCode || null });
    if (!agent.runId || agent.executionMode !== run.executionMode) return invalid('domain_run_identity_or_mode_invalid', {
      agentId, childRunId: agent.runId || null, expectedExecutionMode: run.executionMode,
      observedExecutionMode: agent.executionMode || null
    });
    if (!Array.isArray(agent.candidateIds)) return invalid('domain_candidate_ids_missing', { agentId });
    const completedModelSteps = (agent.modelSteps || []).filter(step => step.status === 'completed').length;
    if (completedModelSteps < 2) return invalid('domain_model_steps_incomplete', { agentId,
      completedModelSteps, observedModelStepCount: (agent.modelSteps || []).length });
    const missingTools = tools.filter(name => !agent.tools?.some(tool => tool.toolName === name && tool.status === 'completed'));
    if (missingTools.length) return invalid('required_domain_tool_incomplete', { agentId, missingTools,
      observedTools: (agent.tools || []).slice(0, 12).map(tool => ({ toolName: tool.toolName, status: tool.status, errorCode: tool.errorCode || null })) });
    if (!Array.isArray(agent.sources) || agent.sources.length === 0) {
      return invalid('domain_source_provenance_missing', { agentId, sourceCount: Array.isArray(agent.sources) ? agent.sources.length : 0 });
    }
  }

  const selectedIds = new Set(collaboration.finalAdoptedCandidateIds || []);
  const candidates = (collaboration.candidates || []).filter(candidate => candidate.status === 'adopted'
    && selectedIds.has(candidate.candidateId));
  const belongsToValidRun = candidate => {
    const agentId = candidate.domain === 'nutrition' ? 'domain.nutrition'
      : candidate.domain === 'exercise' ? 'domain.exercise' : '';
    return Boolean(agentId && agents.get(agentId)?.candidateIds.includes(candidate.candidateId));
  };
  const safe = candidates.filter(belongsToValidRun);
  const reviewCandidates = (collaboration.candidates || []).filter(candidate => candidate.domain === 'exercise'
    && ['requires_review', 'rejected'].includes(candidate.status) && belongsToValidRun(candidate));
  const planningCandidates = [...safe, ...reviewCandidates.filter(candidate => !safe.some(item => item.candidateId === candidate.candidateId))];
  const emptyCandidateDomains = {};
  if (!safe.some(item => item.domain === 'nutrition')) {
    const agent = agents.get('domain.nutrition');
    const context = agent.tools?.find(tool => tool.toolName === 'get_nutrition_context')?.resultSummary || null;
    const emptyProof = provesNoLegalNutritionCandidate(agent);
    if (emptyProof) {
      emptyCandidateDomains.nutrition = emptyProof;
    } else {
      return invalid('nutrition_adopted_candidate_missing', { candidateCounts: summarizeCandidateCounts(collaboration, agent),
        toolContext: context ? { candidateCount: context.candidateCount ?? null,
          excludedCandidateCount: context.excludedCandidateCount ?? null,
          catalogMainDishCount: context.catalogMainDishCount ?? null,
          inventoryProven: Boolean(context.sources?.some(source => source.type === 'nutrition_candidate_inventory'
            && source.id === 'main-dish-catalog')) } : null });
    }
  }
  const exerciseAgent = agents.get('domain.exercise');
  const exerciseTool = exerciseAgent.tools.find(tool => tool.toolName === 'get_exercise_context');
  const exerciseInventory = inspectExerciseInventorySummary(exerciseTool.resultSummary, expectedExerciseDate);
  if (!exerciseInventory.valid) return { ...exerciseInventory,
    rejection: { ...exerciseInventory.rejection, agentId: 'domain.exercise', childRunId: exerciseAgent.runId } };
  if (!planningCandidates.some(item => item.domain === 'exercise')) {
    const inventory = exerciseInventory.inventory;
    if (inventory.actualActivitySlotCount !== 0 || inventory.potentiallyAvailableActualSlotCount !== 0) {
      return invalid('exercise_planning_candidate_missing', { candidateCounts: summarizeCandidateCounts(collaboration, exerciseAgent),
        toolContext: inventory });
    }
    emptyCandidateDomains.exercise = { inventoryStatus: 'verified_no_actual_slots', ...inventory,
      parentRunId: run.runId || null, childRunId: exerciseAgent.runId,
      childCandidateCount: exerciseAgent.candidateIds.length,
      coordinatorSelectedExerciseCandidateCount: safe.filter(item => item.domain === 'exercise').length };
  }
  return { valid: true, collaboration, agents, candidates: safe,
    emptyCandidateDomains, exerciseInventory: exerciseInventory.inventory,
    planningCandidates: planningCandidates.map(candidate => ({
      ...candidate, coordinatorSelected: selectedIds.has(candidate.candidateId)
    })) };
}
