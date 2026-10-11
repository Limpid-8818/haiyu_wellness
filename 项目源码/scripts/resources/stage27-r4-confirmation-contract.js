import assert from 'node:assert/strict';

function requiredId(value, label) {
  const result = String(value ?? '').trim();
  assert.ok(result, `${label} is present`);
  return result;
}

export function validateQ275ConfirmationContract({ browserFlow, preConfirmationDatabaseReadback,
  selectionActionCard, reservation, confirmedReservationCount, expected }) {
  assert.ok(browserFlow && typeof browserFlow === 'object', 'webpage flow evidence is present');
  assert.ok(expected && typeof expected === 'object', 'expected Q27.5 run and slot identifiers are present');
  assert.equal(browserFlow.selectionSubmitted, true, 'guest submitted the offered slot through the webpage');
  assert.equal(browserFlow.confirmationSubmitted, true, 'guest submitted confirmation through the webpage');

  const graphRunId = requiredId(expected.graphRunId, 'expected graph run ID');
  const proposalRunId = requiredId(expected.proposalRunId, 'expected proposal run ID');
  const needsInputCardId = requiredId(expected.needsInputCardId, 'expected needs-input action-card ID');
  const selectionRunId = requiredId(expected.selectionRunId, 'expected selection run ID');
  const slotId = requiredId(expected.slotId, 'expected selected slot ID');
  const selectedActionCardId = requiredId(selectionActionCard?.id, 'selected action-card ID');
  assert.equal(selectionActionCard.status, 'confirmed', 'selection trace records the selected action card as confirmed');
  assert.equal(selectionActionCard.actionType, 'book_program', 'selected action card is the booking action');

  assert.equal(requiredId(browserFlow.runId, 'webpage graph run ID'), graphRunId,
    'webpage history belongs to the exact collaboration run');
  assert.equal(requiredId(browserFlow.actionRunId, 'webpage proposal run ID'), proposalRunId,
    'webpage proposal belongs to the exact model action run');
  assert.equal(requiredId(browserFlow.needsInputCardId, 'webpage needs-input card ID'), needsInputCardId,
    'webpage began from the exact needs-input action card');
  assert.equal(requiredId(browserFlow.selectionRunId, 'webpage selection run ID'), selectionRunId,
    'webpage selection matches the deterministic selection run');
  assert.equal(requiredId(browserFlow.selectedSlotId, 'webpage selected slot ID'), slotId,
    'webpage selected the offered database slot');

  const confirmation = browserFlow.confirmation;
  assert.ok(confirmation && typeof confirmation === 'object', 'actual webpage confirmation response is present');
  assert.deepEqual(browserFlow.externalRequests || [], [], 'Q27.5 browser flow made no external request');
  assert.deepEqual(browserFlow.pageErrors || [], [], 'Q27.5 browser flow recorded no page exception');
  assert.equal(browserFlow.confirmationBodyError || null, null, 'confirmation response body parsed as JSON');
  assert.equal(browserFlow.confirmedCardVisible, true, 'guest webpage rendered the confirmed action card');
  assert.equal(Number(confirmation.httpStatus), 200, 'confirmation HTTP response completed successfully');
  assert.equal(requiredId(browserFlow.pendingActionCardId, 'pending webpage action-card ID'), selectedActionCardId,
    'the pending webpage card is the selected follow-up action card');
  assert.equal(requiredId(browserFlow.confirmedActionCardId, 'confirmed webpage action-card ID'), selectedActionCardId,
    'the webpage confirms the selected follow-up action card');
  assert.equal(requiredId(confirmation.actionCardId, 'confirmation response action-card ID'), selectedActionCardId,
    'the HTTP response identifies the selected follow-up action card');
  assert.equal(confirmation.actionCardStatus, 'confirmed', 'HTTP response confirms the action card');
  assert.equal(confirmation.businessType, 'reservation', 'HTTP response identifies a reservation result');
  const responseReservationId = requiredId(confirmation.reservationId, 'webpage response reservation ID');

  assert.ok(preConfirmationDatabaseReadback && typeof preConfirmationDatabaseReadback === 'object',
    'pre-confirmation database evidence is present');
  assert.equal(Number(preConfirmationDatabaseReadback.reservationCount), 0,
    'no reservation existed immediately before confirmation');
  assert.equal(requiredId(preConfirmationDatabaseReadback.actionCardId, 'pre-confirmation action-card ID'), selectedActionCardId,
    'pre-confirmation database read belongs to the selected action card');
  assert.equal(requiredId(preConfirmationDatabaseReadback.selectionRunId, 'pre-confirmation selection run ID'), selectionRunId,
    'pre-confirmation database read belongs to the exact selection run');
  assert.equal(requiredId(preConfirmationDatabaseReadback.slotId, 'pre-confirmation slot ID'), slotId,
    'pre-confirmation database read checks the selected slot');

  assert.ok(reservation && typeof reservation === 'object', 'independent SQL readback returned a reservation row');
  const databaseReservationId = requiredId(reservation.id, 'database reservation ID');
  const databaseSlotId = requiredId(reservation.slot_id ?? reservation.slotId, 'database reservation slot ID');
  assert.equal(String(reservation.status), 'confirmed', 'database row is confirmed');
  assert.equal(databaseReservationId, responseReservationId,
    'actual webpage response and independent database row identify the same reservation');
  assert.equal(databaseSlotId, slotId, 'database row belongs to the selected slot');
  assert.equal(Number(confirmedReservationCount), 1, 'exactly one confirmed reservation exists after webpage submission');

  return { status: 'PASS', graphRunId, proposalRunId, needsInputCardId, selectionRunId,
    selectedActionCardId, slotId, responseReservationId, databaseReservationId,
    preConfirmationReservationCount: Number(preConfirmationDatabaseReadback.reservationCount),
    confirmedReservationCount: Number(confirmedReservationCount), httpStatus: Number(confirmation.httpStatus) };
}
