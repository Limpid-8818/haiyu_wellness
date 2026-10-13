export async function finishWellnessDraftPost({ draft, isAdoption, guestId, autoActivate, getDraft }) {
  const autoActivation = isAdoption || draft.deduplicated ? null : await autoActivate(draft.draftId);
  const currentDraft = autoActivation ? await getDraft(guestId, draft.draftId) : draft;
  return { ...currentDraft, autoActivation };
}
