import assert from 'node:assert/strict';
import { withTemporaryApi } from './helpers.js';
import { login, request, withDatabase } from './q7-helpers.js';

export async function run() {
  return withTemporaryApi(async ({ baseUrl, databasePath }) => {
    const originalAllergies = JSON.stringify(['燕麦']);
    withDatabase(databasePath, database => database.prepare('UPDATE guest_profiles SET allergies_json=? WHERE user_id=?').run(originalAllergies, 'guest_001'));
    const token = await login(baseUrl, 'guest_demo', 'guest2026', 'guest');
    const result = await request(baseUrl, '/assistant/chat', {
      method: 'POST', token, body: { text: '我对虾过敏' }
    });
    assert.equal(result.status, 200);

    const state = withDatabase(databasePath, database => ({
      intake: database.prepare('SELECT guest_id,content,source,status FROM health_intakes ORDER BY id DESC LIMIT 1').get(),
      allergies: database.prepare('SELECT allergies_json FROM guest_profiles WHERE user_id=?').get('guest_001').allergies_json
    }));
    assert.deepEqual({ ...state.intake }, {
      guest_id: 'guest_001', content: '我对虾过敏', source: 'assistant', status: 'pending'
    });
    assert.equal(state.allergies, originalAllergies);
    assert.equal(JSON.parse(state.allergies).includes('虾'), false, 'intake must not modify the formal profile');
    return { output: [
      'guest POST /assistant/chat HTTP 200',
      'health_intakes row status=pending content=我对虾过敏',
      'formal guest_profiles.allergies_json unchanged=true'
    ] };
  }, 'haiyu-quest-q7-9-');
}
