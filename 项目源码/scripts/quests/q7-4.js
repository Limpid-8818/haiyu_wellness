import assert from 'node:assert/strict';
import { withTemporaryApi } from './helpers.js';
import { login, request } from './q7-helpers.js';

export async function run() {
  return withTemporaryApi(async ({ baseUrl }) => {
    const roles = [
      { username: 'guest_demo', password: 'guest2026', role: 'guest', marker: '我已经收到你的描述' },
      { username: 'staff_demo', password: 'staff2026', role: 'staff', marker: '已收到工作输入' },
      { username: 'dean_demo', password: 'dean2026', role: 'dean', marker: '工作人员的真实工作记录' }
    ];
    const outputs = [];
    for (const entry of roles) {
      const token = await login(baseUrl, entry.username, entry.password, entry.role);
      const result = await request(baseUrl, '/assistant/chat', {
        method: 'POST', token, body: { text: `Q7.4 ${entry.role} response check` }
      });
      assert.equal(result.status, 200, `${entry.role} can chat`);
      assert.match(result.data.reply, new RegExp(entry.marker));
      assert.equal(result.data.live, false);
      outputs.push(`${entry.role} HTTP 200 roleReply=true`);
    }

    const staffToken = await login(baseUrl, 'staff_demo', 'staff2026', 'staff');
    const spoofed = await request(baseUrl, '/assistant/chat', {
      method: 'POST', token: staffToken, body: { role: 'guest', text: '尝试切换助手身份' }
    });
    assert.equal(spoofed.status, 403);
    assert.equal(spoofed.data.code, 'ASSISTANT_ROLE_FORBIDDEN');
    outputs.push('staff spoof role=guest HTTP 403 ASSISTANT_ROLE_FORBIDDEN');
    return { output: outputs };
  }, 'haiyu-quest-q7-4-');
}
