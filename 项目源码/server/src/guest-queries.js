import { db } from './db-infrastructure.js';
import { json } from './db-values.js';
import { stayStatus } from './staffing.js';

export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id, username: row.username, role: row.role, name: row.name, phone: row.phone || '', avatar: row.avatar || '',
    jobType: row.role === 'staff' ? (row.job_type || 'clinician') : null
  };
}

export async function guestProfile(userId) {
  const row = await db.prepare(`SELECT user_id,gender,birth_date,room_no,check_in,check_out,stay_plan,
    emergency_contact,chronic_json,allergies_json,mobility,health_profile_json,health_profile_version,updated_at
    FROM guest_profiles WHERE user_id=?`).get(userId);
  if (!row) return null;
  return {
    ...row,
    chronic: json(row.chronic_json),
    allergies: json(row.allergies_json),
    health_profile: json(row.health_profile_json, {}),
    health_profile_version: Number(row.health_profile_version || 0),
    chronic_json: undefined,
    allergies_json: undefined,
    health_profile_json: undefined
  };
}

export async function guestSummary(userId) {
  const user = await db.prepare("SELECT id,name,username,phone,role,status,avatar FROM users WHERE id=? AND role='guest' AND status='active'").get(userId);
  if (!user) return null;
  const profile = await guestProfile(userId);
  const latestHealth = await db.prepare(`SELECT id,guest_id,record_type,value,unit,note,recorded_at,recorded_by,source,
    structured_value_json,created_at FROM health_records WHERE guest_id=? AND voided_at IS NULL
    ORDER BY recorded_at DESC,id DESC LIMIT 5`).all(userId);
  const health = latestHealth.map(row => ({ ...row, structured_value_json: json(row.structured_value_json, null) }));
  const advice = await db.prepare(`SELECT a.id,a.title,a.content,a.priority,a.status,a.created_at,a.updated_at,u.name AS author_name
    FROM medical_advice a JOIN users u ON u.id=a.author_id
    WHERE a.guest_id=? AND a.status='active' ORDER BY a.created_at DESC`).all(userId);
  return { ...publicUser(user), profile, admissionStatus: stayStatus(profile?.check_in, profile?.check_out), health, advice };
}
