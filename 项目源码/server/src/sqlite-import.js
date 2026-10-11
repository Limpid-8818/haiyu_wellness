import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { db, driver, transaction } from './db.js';
import { businessTables } from './schema.js';
import { legacyStructuredValue } from './health-metrics.js';

export const migratedTables = businessTables;

const thisDirectory = path.dirname(fileURLToPath(import.meta.url));
const demoDatabase = path.resolve(thisDirectory, '../data/community-v2.sqlite');

const relationshipChecks = [
  ['guest_profiles.user_id', `SELECT COUNT(*) AS count FROM guest_profiles c LEFT JOIN users p ON p.id=c.user_id WHERE p.id IS NULL`],
  ['staff_guest_assignments.staff_id', `SELECT COUNT(*) AS count FROM staff_guest_assignments c LEFT JOIN users p ON p.id=c.staff_id WHERE p.id IS NULL`],
  ['staff_guest_assignments.guest_id', `SELECT COUNT(*) AS count FROM staff_guest_assignments c LEFT JOIN users p ON p.id=c.guest_id WHERE p.id IS NULL`],
  ['staff_guest_assignments.created_by', `SELECT COUNT(*) AS count FROM staff_guest_assignments c LEFT JOIN users p ON p.id=c.created_by WHERE p.id IS NULL`],
  ['health_records.guest_id', `SELECT COUNT(*) AS count FROM health_records c LEFT JOIN users p ON p.id=c.guest_id WHERE p.id IS NULL`],
  ['health_records.recorded_by', `SELECT COUNT(*) AS count FROM health_records c LEFT JOIN users p ON p.id=c.recorded_by WHERE p.id IS NULL`],
  ['health_records.voided_by', `SELECT COUNT(*) AS count FROM health_records c LEFT JOIN users p ON p.id=c.voided_by WHERE c.voided_by IS NOT NULL AND p.id IS NULL`],
  ['medical_advice.guest_id', `SELECT COUNT(*) AS count FROM medical_advice c LEFT JOIN users p ON p.id=c.guest_id WHERE p.id IS NULL`],
  ['medical_advice.author_id', `SELECT COUNT(*) AS count FROM medical_advice c LEFT JOIN users p ON p.id=c.author_id WHERE p.id IS NULL`],
  ['news.author_id', `SELECT COUNT(*) AS count FROM news c LEFT JOIN users p ON p.id=c.author_id WHERE c.author_id IS NOT NULL AND p.id IS NULL`],
  ['audit_logs.actor_id', `SELECT COUNT(*) AS count FROM audit_logs c LEFT JOIN users p ON p.id=c.actor_id WHERE c.actor_id IS NOT NULL AND p.id IS NULL`],
  ['staff_reviews.staff_id', `SELECT COUNT(*) AS count FROM staff_reviews c LEFT JOIN users p ON p.id=c.staff_id WHERE p.id IS NULL`],
  ['staff_reviews.dean_id', `SELECT COUNT(*) AS count FROM staff_reviews c LEFT JOIN users p ON p.id=c.dean_id WHERE p.id IS NULL`],
  ['assistant_sessions.user_id', `SELECT COUNT(*) AS count FROM assistant_sessions c LEFT JOIN users p ON p.id=c.user_id WHERE c.user_id IS NOT NULL AND p.id IS NULL`],
  ['assistant_sessions.related_guest_id', `SELECT COUNT(*) AS count FROM assistant_sessions c LEFT JOIN users p ON p.id=c.related_guest_id WHERE c.related_guest_id IS NOT NULL AND p.id IS NULL`],
  ['assistant_messages.session_id', `SELECT COUNT(*) AS count FROM assistant_messages c LEFT JOIN assistant_sessions p ON p.id=c.session_id WHERE p.id IS NULL`],
  ['assistant_messages.user_id', `SELECT COUNT(*) AS count FROM assistant_messages c LEFT JOIN users p ON p.id=c.user_id WHERE c.user_id IS NOT NULL AND p.id IS NULL`],
  ['health_intakes.guest_id', `SELECT COUNT(*) AS count FROM health_intakes c LEFT JOIN users p ON p.id=c.guest_id WHERE p.id IS NULL`],
  ['health_intakes.session_id', `SELECT COUNT(*) AS count FROM health_intakes c LEFT JOIN assistant_sessions p ON p.id=c.session_id WHERE c.session_id IS NOT NULL AND p.id IS NULL`],
  ['activity_slots.project_id', `SELECT COUNT(*) AS count FROM activity_slots c LEFT JOIN projects p ON p.id=c.project_id WHERE p.id IS NULL`],
  ['reservations.guest_id', `SELECT COUNT(*) AS count FROM reservations c LEFT JOIN users p ON p.id=c.guest_id WHERE p.id IS NULL`],
  ['reservations.slot_id', `SELECT COUNT(*) AS count FROM reservations c LEFT JOIN activity_slots p ON p.id=c.slot_id WHERE p.id IS NULL`],
  ['health_intakes.reviewed_by', `SELECT COUNT(*) AS count FROM health_intakes c LEFT JOIN users p ON p.id=c.reviewed_by WHERE c.reviewed_by IS NOT NULL AND p.id IS NULL`],
  ['meal_menus.guest_id', `SELECT COUNT(*) AS count FROM meal_menus c LEFT JOIN users p ON p.id=c.guest_id WHERE p.id IS NULL`],
  ['meal_menu_items.menu_id', `SELECT COUNT(*) AS count FROM meal_menu_items c LEFT JOIN meal_menus p ON p.id=c.menu_id WHERE p.id IS NULL`],
  ['meal_menu_items.dish_id', `SELECT COUNT(*) AS count FROM meal_menu_items c LEFT JOIN dishes p ON p.id=c.dish_id WHERE c.dish_id IS NOT NULL AND p.id IS NULL`],
  ['meal_orders.guest_id', `SELECT COUNT(*) AS count FROM meal_orders c LEFT JOIN users p ON p.id=c.guest_id WHERE p.id IS NULL`],
  ['meal_orders.menu_id', `SELECT COUNT(*) AS count FROM meal_orders c LEFT JOIN meal_menus p ON p.id=c.menu_id WHERE p.id IS NULL`],
  ['meal_order_requests.guest_id', `SELECT COUNT(*) AS count FROM meal_order_requests c LEFT JOIN users p ON p.id=c.guest_id WHERE p.id IS NULL`],
  ['meal_order_requests.order_id', `SELECT COUNT(*) AS count FROM meal_order_requests c LEFT JOIN meal_orders p ON p.id=c.order_id WHERE p.id IS NULL`]
];

function quoteIdentifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error(`Unexpected SQLite identifier: ${value}`);
  return `\`${value}\``;
}

export async function importSqliteSnapshot(sourcePath) {
  if (driver !== 'mysql') throw new Error('SQLite import target must use DB_DRIVER=mysql');
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) throw new Error('An explicit synthetic SQLite snapshot path is required');
  const resolvedPath = path.resolve(sourcePath);
  if (resolvedPath === demoDatabase) throw new Error('The default demo SQLite database is prohibited as an import source');

  const source = new DatabaseSync(resolvedPath, { readOnly: true });
  try {
    const available = new Set(source.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    const missing = migratedTables.filter(table => !available.has(table));
    if (missing.length) throw new Error(`SQLite snapshot is missing required tables: ${missing.join(', ')}`);
    const foreignKeyProblems = source.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeyProblems.length) throw new Error(`SQLite snapshot contains ${foreignKeyProblems.length} foreign-key violations`);

    const sourceRows = Object.fromEntries(migratedTables.map(table => {
      const orderBy = table === 'guest_profiles' ? ['user_id']
        : table === 'meal_order_requests' ? ['guest_id', 'idempotency_key']
          : ['id'];
      const ordering = orderBy.map(quoteIdentifier).join(',');
      return [table, source.prepare(`SELECT * FROM ${quoteIdentifier(table)} ORDER BY ${ordering}`).all()];
    }));
    const sourceCounts = Object.fromEntries(migratedTables.map(table => [table, sourceRows[table].length]));
    const imported = Object.fromEntries(migratedTables.map(table => [table, 0]));
    const duplicates = Object.fromEntries(migratedTables.map(table => [table, 0]));

    await transaction(async () => {
      for (const table of migratedTables) {
        for (const row of sourceRows[table]) {
          const importRow = { ...row };
          if (table === 'health_records') {
            importRow.source ||= 'staff';
            importRow.created_at ||= importRow.recorded_at;
            if (!importRow.structured_value_json) {
              importRow.structured_value_json = JSON.stringify(legacyStructuredValue({
                record_type: importRow.record_type,
                value: importRow.value ?? importRow.value_text,
                unit: importRow.unit
              }));
            }
            importRow.voided_at ??= null;
            importRow.voided_by ??= null;
            importRow.void_reason ??= null;
          }
          const columns = Object.keys(importRow);
          const statement = `INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(',')}) VALUES (${columns.map(() => '?').join(',')})`;
          try {
            const result = await db.prepare(statement).run(...columns.map(column => importRow[column]));
            imported[table] += Number(result.changes || 0);
          } catch (error) {
            if (error.code === 'ER_DUP_ENTRY') {
              duplicates[table] += 1;
              continue;
            }
            throw new Error(`SQLite import failed at ${table} row ${row.id ?? row.user_id ?? 'unknown'}: ${error.message}`, { cause: error });
          }
        }
      }
    });

    const targetCounts = {};
    for (const table of migratedTables) {
      targetCounts[table] = Number((await db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get()).count);
    }
    for (const table of migratedTables) {
      if (targetCounts[table] < sourceCounts[table]) {
        throw new Error(`SQLite import count mismatch for ${table}: source=${sourceCounts[table]}, target=${targetCounts[table]}`);
      }
    }
    const violations = [];
    for (const [name, query] of relationshipChecks) {
      const count = Number((await db.prepare(query).get()).count);
      if (count) violations.push({ relation: name, count });
    }
    if (violations.length) throw new Error(`Imported MySQL relationships failed validation: ${JSON.stringify(violations)}`);
    return { sourceCounts, targetCounts, imported, duplicates, relationshipsChecked: relationshipChecks.length, relationshipViolations: 0 };
  } finally {
    source.close();
  }
}
