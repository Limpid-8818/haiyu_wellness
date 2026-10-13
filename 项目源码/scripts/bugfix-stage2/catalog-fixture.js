import assert from 'node:assert/strict';
import { db, now } from '../../server/src/db.js';

export async function prepareSyntheticIndoorExercise() {
  assert.equal(db.driver, 'sqlite');
  assert.ok(process.env.DB_PATH === ':memory:' || process.env.DB_PATH?.startsWith('/tmp/haiyu-resource-'));
  // Only catalog preconditions. Reservations/attendance/execution are never SQL fixtures.
  await db.prepare(`INSERT INTO projects(id,slug,name,category,intensity,location,description,suitable_people,
    contraindications,open_windows_json,capacity_per_window,sea_entry,outdoor,activity_tag,active,is_demo,source_reference,created_at,updated_at)
    VALUES('stage2-indoor-exercise','stage2-indoor-exercise','合成室内教练指导','exercise','low','合成室内场地',
    '仅隔离岗位流程验收的明确合成目录','合成前置，非真实运营开放','沿用现有健康规则，不声明临床适用性',?,4,0,0,'stage2_indoor',1,1,'阶段2明确合成前置',?,?)`)
    .run(JSON.stringify({ demo: true, timezone: 'Asia/Shanghai', windows: [{ days: ['每日'], start: '09:00', end: '12:00' }] }), now(), now());
}
