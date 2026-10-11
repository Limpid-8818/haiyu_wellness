import { RULE_SEEDS } from './catalog-data.js';

const chronicTerms = ['高血压', '心脏病', '冠心病', '心衰'];
const skinTerms = ['破损', '伤口', '开放'];
const mobilityTerms = /(受限|不便|需要协助|需协助|需要辅助|轮椅|需扶|扶行)/;

function text(value) { return typeof value === 'string' ? value : ''; }
function includesTerm(value, terms) {
  const normalized = text(value).toLocaleLowerCase();
  return terms.some(term => normalized.includes(term.toLocaleLowerCase()));
}

function reportedItems(value, field, source, sourceId = null) {
  const entry = value?.[field];
  if (entry?.status !== 'reported' || !Array.isArray(entry.items)) return [];
  return entry.items.filter(item => typeof item === 'string').map(item => ({
    field: `healthProfile.${field}`,
    value: item,
    source,
    sourceId,
    status: source === 'pending-intake' ? 'pending' : 'confirmed'
  }));
}

function reportedText(value, field, source, sourceId = null) {
  const entry = value?.[field];
  if (entry?.status !== 'reported' || typeof entry.details !== 'string' || !entry.details.trim()) return [];
  return [{ field: `healthProfile.${field}.details`, value: entry.details, source, sourceId,
    status: source === 'pending-intake' ? 'pending' : 'confirmed' }];
}

function profileSources(field, { verifiedProfile, legacyProfile, pendingIntakes }) {
  const sources = [];
  if (field === 'chronic' && Array.isArray(legacyProfile?.chronic)) {
    sources.push(...legacyProfile.chronic.filter(item => typeof item === 'string').map(value => ({
      field: 'legacyProfile.chronic', value, source: 'legacy-profile', sourceId: null, status: 'existing'
    })));
  }
  if (field === 'mobility' && typeof legacyProfile?.mobility === 'string' && legacyProfile.mobility.trim()) {
    sources.push({ field: 'legacyProfile.mobility', value: legacyProfile.mobility, source: 'legacy-profile', sourceId: null, status: 'existing' });
  }
  if (field === 'skin' || field === 'mobility') sources.push(...reportedText(verifiedProfile, field, 'verified-profile'));
  else sources.push(...reportedItems(verifiedProfile, field, 'verified-profile'));
  for (const intake of pendingIntakes) {
    const candidate = intake.candidate || intake.profile || intake.structuredJson || {};
    const sourceId = intake.id ?? intake.sourceId ?? null;
    if (field === 'skin' || field === 'mobility') sources.push(...reportedText(candidate, field, 'pending-intake', sourceId));
    else sources.push(...reportedItems(candidate, field, 'pending-intake', sourceId));
  }
  return sources;
}

function fieldSource(source) {
  return { field: source.field, value: source.value, source: source.source, sourceId: source.sourceId, status: source.status };
}

function ruleResult(rule, matched, fieldSources = [], reason = '') {
  return {
    ruleId: rule.id,
    version: rule.version,
    matched,
    action: matched ? rule.action : 'allow',
    reason: reason || (matched ? rule.triggerCondition : '条件未满足'),
    fieldSources: fieldSources.map(fieldSource),
    reviewRequired: matched && rule.action !== 'allow',
    sourceReference: rule.sourceReference,
    sourceUrl: rule.sourceUrl
  };
}

export function evaluateProjectRules({
  project,
  verifiedProfile = {},
  legacyProfile = {},
  pendingIntakes = [],
  environment = {},
  effectiveHealthConstraints = null,
  rules = RULE_SEEDS
}) {
  if (!project?.id || typeof project.activityTag !== 'string') throw new TypeError('project must include id and activityTag');
  const ruleById = new Map(rules.map(rule => [rule.ruleId || rule.id, rule]));
  const getRule = id => {
    const persisted = ruleById.get(id);
    if (!persisted) throw new Error(`Required safety rule is unavailable: ${id}`);
    return {
      id: persisted.ruleId || persisted.id,
      version: persisted.version,
      action: persisted.action,
      triggerCondition: persisted.triggerCondition,
      sourceReference: persisted.sourceReference,
      sourceUrl: persisted.sourceUrl || ''
    };
  };
  const decisions = [];
  const chronic = profileSources('chronic', { verifiedProfile, legacyProfile, pendingIntakes });
  const skin = profileSources('skin', { verifiedProfile, legacyProfile, pendingIntakes });
  const mobility = profileSources('mobility', { verifiedProfile, legacyProfile, pendingIntakes });

  const chronicHits = chronic.filter(item => includesTerm(item.value, chronicTerms));
  decisions.push(ruleResult(getRule('R1'), project.activityTag === 'hot_spring' && chronicHits.length > 0,
    project.activityTag === 'hot_spring' ? chronicHits : []));

  const skinHits = skin.filter(item => includesTerm(item.value, skinTerms));
  decisions.push(ruleResult(getRule('R2'), ['sea_bath', 'mud_application'].includes(project.activityTag) && skinHits.length > 0,
    ['sea_bath', 'mud_application'].includes(project.activityTag) ? skinHits : []));

  const strongUv = text(environment.uvLevel).toLowerCase() === 'strong';
  decisions.push(ruleResult(getRule('R3'), Boolean(project.outdoor) && strongUv,
    Boolean(project.outdoor) && strongUv ? [{ field: 'environment.uvLevel', value: 'strong', source: environment.source || 'request-demo-input', sourceId: null, status: 'provided' }] : []));

  const mobilityHits = mobility.filter(item => item.field.endsWith('.status')
    ? item.value === 'assistance'
    : mobilityTerms.test(text(item.value)));
  // Include the structured status itself as provenance when the assistance state is selected.
  const structuredMobility = [verifiedProfile, ...pendingIntakes.map(item => item.candidate || item.profile || {})]
    .map((profile, index) => {
      if (profile?.mobility?.status !== 'assistance') return null;
      const intake = pendingIntakes[index - 1];
      return { field: 'healthProfile.mobility.status', value: 'assistance', source: intake ? 'pending-intake' : 'verified-profile', sourceId: intake?.id ?? null, status: intake ? 'pending' : 'confirmed' };
    }).filter(Boolean);
  decisions.push(ruleResult(getRule('R4'), project.activityTag === 'swimming_training' && (mobilityHits.length > 0 || structuredMobility.length > 0),
    project.activityTag === 'swimming_training' ? [...mobilityHits, ...structuredMobility] : []));

  const seaStatus = text(environment.seaStatus).toLowerCase() || 'missing';
  const requiresSeaConfirmation = Boolean(project.seaEntry) && seaStatus !== 'safe';
  decisions.push(ruleResult(getRule('R5'), requiresSeaConfirmation,
    Boolean(project.seaEntry) ? [{ field: 'environment.seaStatus', value: seaStatus, source: environment.source || (seaStatus === 'missing' ? 'not-provided' : 'request-demo-input'), sourceId: null, status: seaStatus === 'missing' ? 'missing' : 'provided' }] : []));

  const constraintSources = ['allergies', 'dietaryRestrictions'].flatMap(field =>
    (effectiveHealthConstraints?.[field] || []).map(entry => ({
      field: `effectiveHealthConstraints.${field}`,
      value: entry.value,
      source: entry.source,
      sourceId: entry.sourceId ?? null,
      status: entry.status,
      conflictsWithVerified: Boolean(entry.conflictsWithVerified)
    })));
  const pendingConstraints = constraintSources.some(source => source.status === 'pending' || source.conflictsWithVerified);

  const matched = decisions.filter(decision => decision.matched);
  const actionRank = { allow: 0, restrict: 1, reject: 2 };
  const ruleOutcome = matched.reduce((current, decision) =>
    actionRank[decision.action] > actionRank[current] ? decision.action : current, 'allow');
  const outcome = ruleOutcome === 'reject' ? 'reject' : (ruleOutcome === 'restrict' || pendingConstraints) ? 'restrict' : 'allow';
  return {
    projectId: project.id,
    outcome,
    reviewRequired: matched.some(decision => decision.reviewRequired) || pendingConstraints,
    decisions,
    effectiveHealthConstraints,
    constraintSources,
    pendingConstraintsRequireReview: pendingConstraints,
    environmentSources: Object.entries(environment).map(([key, value]) => ({ field: `environment.${key}`, value, source: environment.source || 'request-demo-input' }))
  };
}
