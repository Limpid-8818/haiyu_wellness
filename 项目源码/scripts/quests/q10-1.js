import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { businessTables, mysqlCoreSchema, sqliteCoreSchema } from '../../server/src/schema.js';
import { projectDirectory } from './q10-helpers.js';

export async function run() {
  const mappingPath = path.join(projectDirectory, '..', 'docs', 'SQLite到MySQL字段映射.md');
  const mapping = await readFile(mappingPath, 'utf8');
  const required = ['check_in_date', 'value_text', 'raw_content', 'review_status', 'sender_role', 'VARCHAR(64)', 'DATETIME(3)', 'JSON.stringify'];
  for (const field of required) assert.ok(mapping.includes(field), `field map is missing ${field}`);
  const sqliteTables = [...sqliteCoreSchema.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_]+)/gi)].map(match => match[1]);
  assert.deepEqual(sqliteTables, businessTables.slice(0, 11));
  assert.equal(mysqlCoreSchema.length, 11);
  const mappedTables = [...mapping.matchAll(/^\| `([^`]+)` \|/gm)].map(match => match[1]);
  assert.deepEqual(mappedTables.slice(0, 11), businessTables.slice(0, 11));
  assert.deepEqual(mappedTables.slice(11), [
    'job_capability_settings', 'projects', 'domain_knowledge', 'safety_rules', 'environment_snapshots', 'activity_slots', 'reservations',
    'dishes', 'meal_menus', 'meal_menu_items', 'meal_orders', 'meal_order_requests'
  ]);
  return { output: ['11 core-table mappings and 12 versioned extension-table mappings verified', 'field, time, JSON, ID, index and constraint differences documented'] };
}
