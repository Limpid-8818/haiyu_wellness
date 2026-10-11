import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hashPassword } from '../../server/src/password.js';
import { withApiAtDatabase } from './helpers.js';
import { withDatabase } from './q5-helpers.js';

export const syntheticGuests = [
  {
    id: 'quest_guest_older_01', username: 'quest_guest_older_01', name: '合成长者样本',
    gender: '女', birthDate: '1944-03-08', roomNo: 'Q9-OLDER',
    chronic: ['高血压'], allergies: ['虾'], mobility: '行走需扶手并有人陪同'
  },
  {
    id: 'quest_guest_rehab_01', username: 'quest_guest_rehab_01', name: '合成康复样本',
    gender: '男', birthDate: '1965-11-30', roomNo: 'Q9-REHAB',
    chronic: ['膝关节术后康复', '2型糖尿病'], allergies: ['青霉素'], mobility: '使用助行器，步行需陪同'
  },
  {
    id: 'quest_guest_young_01', username: 'quest_guest_young_01', name: '合成年轻客人',
    gender: '女', birthDate: '1995-04-15', roomNo: 'Q9-YOUNG',
    chronic: [], allergies: ['花生'], mobility: '可独立行走'
  }
].map(guest => ({
  ...guest,
  phone: '',
  emergencyContact: '',
  checkIn: '2026-09-01',
  checkOut: '2026-10-01',
  updatedAt: '2026-09-29T00:00:00.000Z'
}));

export function seedSyntheticGuests(database) {
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const guest of syntheticGuests) {
      const user = database.prepare('SELECT id,username,role,name,phone,status FROM users WHERE id=?').get(guest.id);
      const profile = database.prepare('SELECT * FROM guest_profiles WHERE user_id=?').get(guest.id);
      if (!user && !profile) {
        database.prepare(`INSERT INTO users(id,username,password_hash,role,name,phone,status)
          VALUES(?,?,?,?,?,?,?)`).run(
          guest.id, guest.username, hashPassword('quest-synthetic-only'), 'guest', guest.name, guest.phone, 'active'
        );
        database.prepare(`INSERT INTO guest_profiles
          (user_id,gender,birth_date,room_no,check_in,check_out,emergency_contact,chronic_json,allergies_json,mobility,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
          guest.id, guest.gender, guest.birthDate, guest.roomNo, guest.checkIn, guest.checkOut,
          guest.emergencyContact, JSON.stringify(guest.chronic), JSON.stringify(guest.allergies), guest.mobility, guest.updatedAt
        );
      } else {
        assert.ok(user && profile, `fixture ${guest.id} is only partially present`);
        assert.deepEqual({ ...user }, {
          id: guest.id, username: guest.username, role: 'guest', name: guest.name,
          phone: guest.phone, status: 'active'
        }, `fixture user ${guest.id} has unexpected data`);
        assert.deepEqual({
          gender: profile.gender,
          birth_date: profile.birth_date,
          room_no: profile.room_no,
          check_in: profile.check_in,
          check_out: profile.check_out,
          emergency_contact: profile.emergency_contact,
          chronic_json: profile.chronic_json,
          allergies_json: profile.allergies_json,
          mobility: profile.mobility,
          updated_at: profile.updated_at
        }, {
          gender: guest.gender,
          birth_date: guest.birthDate,
          room_no: guest.roomNo,
          check_in: guest.checkIn,
          check_out: guest.checkOut,
          emergency_contact: guest.emergencyContact,
          chronic_json: JSON.stringify(guest.chronic),
          allergies_json: JSON.stringify(guest.allergies),
          mobility: guest.mobility,
          updated_at: guest.updatedAt
        }, `fixture profile ${guest.id} has unexpected data`);
      }
    }
    database.exec('COMMIT');
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* preserve the original error */ }
    throw error;
  }
}

function demoSnapshot(database) {
  return {
    user: database.prepare("SELECT id,username,role,name,phone,status FROM users WHERE id='guest_001'").get(),
    profile: database.prepare("SELECT * FROM guest_profiles WHERE user_id='guest_001'").get(),
    healthCount: database.prepare("SELECT COUNT(*) AS count FROM health_records WHERE guest_id='guest_001'").get().count,
    adviceCount: database.prepare("SELECT COUNT(*) AS count FROM medical_advice WHERE guest_id='guest_001'").get().count
  };
}

function assertFixtures(database) {
  const rows = database.prepare(`SELECT u.id,u.role,u.name,p.birth_date,p.chronic_json,p.allergies_json,p.mobility
    FROM users u JOIN guest_profiles p ON p.user_id=u.id
    WHERE u.id IN (${syntheticGuests.map(() => '?').join(',')}) ORDER BY u.id`).all(...syntheticGuests.map(guest => guest.id));
  assert.equal(rows.length, 3, 'each database must contain the three fixture IDs exactly once');
  assert.deepEqual(rows.map(row => row.id).sort(), syntheticGuests.map(guest => guest.id).sort());
  for (const row of rows) {
    const expected = syntheticGuests.find(guest => guest.id === row.id);
    assert.equal(row.role, 'guest');
    assert.equal(row.name, expected.name);
    assert.equal(row.birth_date, expected.birthDate);
    assert.deepEqual(JSON.parse(row.chronic_json), expected.chronic);
    assert.deepEqual(JSON.parse(row.allergies_json), expected.allergies);
    assert.equal(row.mobility, expected.mobility);
  }
  assert.equal(new Set(rows.map(row => row.mobility)).size, 3, 'mobility needs vary across the fixtures');
  assert.equal(new Set(rows.map(row => row.allergies_json)).size, 3, 'allergy profiles need to vary across the fixtures');
  assert.equal(new Set(rows.map(row => row.chronic_json)).size, 3, 'chronic profiles need to vary across the fixtures');
}

export async function run({ dbPath } = {}) {
  assert.ok(dbPath, 'Quest runner must provide an isolated database path');
  let primaryDemoBefore;
  await withApiAtDatabase(dbPath, async ({ databasePath }) => {
    withDatabase(databasePath, database => { primaryDemoBefore = demoSnapshot(database); });
    withDatabase(databasePath, seedSyntheticGuests);
    withDatabase(databasePath, seedSyntheticGuests);
    withDatabase(databasePath, database => {
      assertFixtures(database);
      assert.deepEqual(demoSnapshot(database), primaryDemoBefore, 'seeding must leave demo guest data untouched');
    });
  }, { LLM_BASE_URL: '', LLM_API_KEY: '', LLM_MODEL: '' });

  const secondaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'haiyu-q9-3-independent-'));
  const secondaryPath = path.join(secondaryDirectory, 'second.sqlite');
  try {
    await withApiAtDatabase(secondaryPath, async ({ databasePath }) => {
      withDatabase(databasePath, seedSyntheticGuests);
      withDatabase(databasePath, seedSyntheticGuests);
      withDatabase(databasePath, assertFixtures);
    }, { LLM_BASE_URL: '', LLM_API_KEY: '', LLM_MODEL: '' });
  } finally {
    await rm(secondaryDirectory, { recursive: true, force: true });
  }

  return { output: [
    `Seeded the same three fixed synthetic IDs twice in two independent SQLite databases: ${syntheticGuests.map(guest => guest.id).join(', ')}.`,
    'Chronic conditions, allergies and mobility differ; demo guest profile, health and advice counts stayed unchanged.'
  ] };
}
