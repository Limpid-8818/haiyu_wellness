import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWellnessAdoptionSelection } from '../src/wellness-planner.js';
import { finishWellnessDraftPost } from '../src/wellness-draft-post.js';

test('adoption accepts selected candidates from the same completed parent run', () => {
  assert.deepEqual(validateWellnessAdoptionSelection({
    sessionId: 'as_same', runSessionId: 'as_same', runStatus: 'completed',
    selectedCandidateIds: ['nutrition:1', 'exercise:1'],
    candidateIds: ['nutrition:1', 'exercise:1', 'exercise:2'],
    adoptedCandidateIds: ['nutrition:1', 'exercise:1']
  }), { ok: true, selectedCandidateIds: ['nutrition:1', 'exercise:1'] });
});

test('adoption rejects mismatched source session, unfinished runs, and non-selected candidates', () => {
  const base = { selectedCandidateIds: ['nutrition:1'], candidateIds: ['nutrition:1'], adoptedCandidateIds: ['nutrition:1'] };
  assert.equal(validateWellnessAdoptionSelection({ ...base, sessionId: 'as_a', runSessionId: 'as_b', runStatus: 'completed' }).errorCode,
    'WELLNESS_ADOPTION_SESSION_MISMATCH');
  assert.equal(validateWellnessAdoptionSelection({ ...base, sessionId: 'as_a', runSessionId: 'as_a', runStatus: 'running' }).errorCode,
    'WELLNESS_ADOPTION_RUN_INCOMPLETE');
  assert.equal(validateWellnessAdoptionSelection({ ...base, sessionId: 'as_a', runSessionId: 'as_a', runStatus: 'completed', selectedCandidateIds: ['exercise:missing'] }).errorCode,
    'WELLNESS_ADOPTION_CANDIDATE_FORBIDDEN');
});

test('empty-body legacy generation is not a valid adoption selection', () => {
  assert.equal(validateWellnessAdoptionSelection({ sessionId: 'as_a', runSessionId: 'as_a', runStatus: 'completed',
    selectedCandidateIds: [], candidateIds: [], adoptedCandidateIds: [] }).errorCode,
    'WELLNESS_ADOPTION_CANDIDATES_INVALID');
});

test('explicit adoption never auto-activates; ordinary creation retains auto-activation', async () => {
  const calls = [];
  const autoActivate = async draftId => {
    calls.push(['autoActivate', draftId]);
    return { action: 'auto_activated' };
  };
  const getDraft = async (guestId, draftId) => {
    calls.push(['getDraft', guestId, draftId]);
    return { draftId, reviewStatus: 'active' };
  };
  const draft = { draftId: 'draft-1', reviewStatus: 'pending_review', deduplicated: false };
  const adoption = await finishWellnessDraftPost({ draft, isAdoption: true, guestId: 'guest-1', autoActivate, getDraft });
  assert.deepEqual(calls, []);
  assert.equal(adoption.reviewStatus, 'pending_review');
  assert.equal(adoption.autoActivation, null);

  const ordinary = await finishWellnessDraftPost({ draft, isAdoption: false, guestId: 'guest-1', autoActivate, getDraft });
  assert.deepEqual(calls, [['autoActivate', 'draft-1'], ['getDraft', 'guest-1', 'draft-1']]);
  assert.equal(ordinary.reviewStatus, 'active');
  assert.deepEqual(ordinary.autoActivation, { action: 'auto_activated' });

  const replay = await finishWellnessDraftPost({ draft: { ...draft, deduplicated: true }, isAdoption: false,
    guestId: 'guest-1', autoActivate, getDraft });
  assert.equal(calls.length, 2);
  assert.equal(replay.autoActivation, null);
});
