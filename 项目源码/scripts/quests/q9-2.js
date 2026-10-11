import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseQuestArgs, questsForStage } from '../quest-args.js';

export async function run() {
  const oneQuest = parseQuestArgs(['Q9.2', '--db', '/tmp/q9-quest.sqlite']);
  assert.equal(oneQuest.questId, 'Q9.2');
  assert.equal(oneQuest.dbPath, '/tmp/q9-quest.sqlite');
  assert.equal(oneQuest.live, false, 'live model access is opt-in');
  assert.equal(parseQuestArgs(['Q9.2']).live, false);
  assert.equal(parseQuestArgs(['--stage', '9']).stage, 9);
  assert.equal(parseQuestArgs(['Q9.2', '--live']).live, true);
  assert.deepEqual(questsForStage(9, ['Q9.2', 'Q9.3', 'Q9.4']), ['Q9.2', 'Q9.3', 'Q9.4']);
  assert.throws(() => parseQuestArgs(['--stage', 'nope']), /positive integer/);
  assert.throws(() => parseQuestArgs(['Q9.2', '--stage', '9']), /either a quest ID or --stage/);

  const runnerPath = fileURLToPath(new URL('../quest.js', import.meta.url));
  const invalid = spawnSync(process.execPath, [runnerPath, 'Q9.NOT_A_REAL_QUEST'], {
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, LLM_BASE_URL: '', LLM_API_KEY: '' }
  });
  assert.equal(invalid.error, undefined, invalid.error?.message);
  assert.equal(invalid.status, 1, 'an unknown Quest must fail with a nonzero exit code');
  assert.match(invalid.stderr, /Invalid quest ID/);
  return { output: ['Runner accepts quest ID, --stage, --db and opt-in --live; invalid IDs exit 1.', 'Default run keeps model endpoint and key empty.'] };
}
