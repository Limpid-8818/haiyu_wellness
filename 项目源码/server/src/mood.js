import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from './errors.js';
import { db, now } from './db.js';
import { shiftDateKey, systemBusinessClock } from './clock.js';
import { recordReplanSourceEvent } from './wellness-followup.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const mediaRoot = path.resolve(here, '../media/mood');

export const MOOD_RULE = Object.freeze({
  id: 'demo-negative-streak-v1',
  version: '1.0.0',
  thresholdScore: configuredInteger('MOOD_NEGATIVE_SCORE_MAX', 2, 1, 2),
  consecutiveDays: configuredInteger('MOOD_NEGATIVE_STREAK_DAYS', 3, 3, 7),
  note: '仅按演示评分规则生成待人工关注项，不作诊断或治疗判断。'
});

function configuredInteger(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

const MOOD_LABELS = Object.freeze({
  1: { key: 'very_low', label: '很难受', icon: '☁' },
  2: { key: 'low', label: '有些烦闷', icon: '🌧' },
  3: { key: 'steady', label: '一般', icon: '◐' },
  4: { key: 'calm', label: '比较平静', icon: '🌤' },
  5: { key: 'good', label: '心情不错', icon: '☀' }
});

const RESOURCES = Object.freeze([
  {
    id: 'breathing', category: 'guided', title: '慢慢呼吸', subtitle: '一段轻柔的呼吸放松练习',
    durationSeconds: 82.326, audioFile: 'breathing.wav', coverFile: 'breathing.svg',
    source: '海屿康养社区原创脚本；本机 macOS Tingting 普通话系统语音合成演示音频。',
    license: '脚本文字为项目原创；合成音频随本地演示使用，不声明系统语音音色的外部分发权。正式对外使用前需替换为取得明确许可的录音。'
  },
  {
    id: 'body-scan', category: 'guided', title: '身体扫描', subtitle: '从头到脚留意身体的感受',
    durationSeconds: 103.855, audioFile: 'body-scan.wav', coverFile: 'body-scan.svg',
    source: '海屿康养社区原创脚本；本机 macOS Tingting 普通话系统语音合成演示音频。',
    license: '脚本文字为项目原创；合成音频随本地演示使用，不声明系统语音音色的外部分发权。正式对外使用前需替换为取得明确许可的录音。'
  },
  {
    id: 'seaside-meditation', category: 'guided', title: '海边片刻', subtitle: '以想象中的海风和潮声安顿片刻',
    durationSeconds: 99.366, audioFile: 'seaside-meditation.wav', coverFile: 'seaside-meditation.svg',
    source: '海屿康养社区原创脚本；本机 macOS Tingting 普通话系统语音合成演示音频。',
    license: '脚本文字为项目原创；合成音频随本地演示使用，不声明系统语音音色的外部分发权。正式对外使用前需替换为取得明确许可的录音。'
  },
  {
    id: 'ocean-waves', category: 'ambient', title: '海浪声', subtitle: '原创合成的柔和浪涌环境声',
    durationSeconds: 60, audioFile: 'ocean-waves.wav', coverFile: 'ocean-waves.svg',
    source: '项目内本地程序合成的立体声浪涌环境音；未使用外部录音或采样。',
    license: '由项目代码生成的原创演示音频，不含第三方素材；可随本项目演示使用。'
  }
].map(resource => Object.freeze({
  ...resource,
  audioUrl: `/api/mood/resources/${resource.id}/audio`,
  coverUrl: `/api/mood/resources/${resource.id}/cover`
})));

export function listMoodResources() {
  return RESOURCES.map(({ audioFile, coverFile, ...resource }) => ({ ...resource }));
}

export function getMoodResourceFile(resourceId, kind) {
  const resource = RESOURCES.find(item => item.id === resourceId);
  if (!resource) throw new AppError(404, 'MOOD_RESOURCE_NOT_FOUND', '放松资源不存在');
  const filename = kind === 'audio' ? resource.audioFile : kind === 'cover' ? resource.coverFile : null;
  if (!filename) throw new AppError(404, 'MOOD_RESOURCE_NOT_FOUND', '放松资源不存在');
  const target = path.join(mediaRoot, filename);
  if (!fs.existsSync(target)) throw new AppError(503, 'MOOD_RESOURCE_UNAVAILABLE', '该资源文件暂时无法读取，请稍后重试');
  return target;
}

export function getMoodResource(resourceId) {
  return RESOURCES.find(item => item.id === resourceId) || null;
}

function normalizeMood(row) {
  const score = Number(row.score);
  const mood = MOOD_LABELS[score];
  return {
    id: Number(row.id),
    guestId: row.guestId ?? row.guest_id,
    businessDate: String(row.businessDate ?? row.business_date).slice(0, 10),
    score,
    moodKey: mood.key,
    label: mood.label,
    note: row.note || '',
    revision: Number(row.revision || 1),
    createdAt: row.createdAt ?? row.created_at,
    updatedAt: row.updatedAt ?? row.updated_at
  };
}

export function validateMoodInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(400, 'MOOD_INVALID_BODY', '心情记录请求体必须是对象');
  }
  const unknown = Object.keys(body).filter(key => !['score', 'note'].includes(key));
  if (unknown.length) throw new AppError(400, 'MOOD_FIELD_NOT_ALLOWED', '请求中包含不允许的字段', { fields: unknown });
  if (!Number.isInteger(body.score) || body.score < 1 || body.score > 5) {
    throw new AppError(400, 'MOOD_SCORE_INVALID', '请选择 1 至 5 档心情', { field: 'score' });
  }
  if (body.note !== undefined && (typeof body.note !== 'string' || body.note.trim().length > 500)) {
    throw new AppError(400, 'MOOD_NOTE_INVALID', '备注不能超过 500 个字符', { field: 'note' });
  }
  return { score: body.score, note: (body.note || '').trim() };
}

export async function getTodayMood(guestId, clock = systemBusinessClock) {
  const row = await db.prepare(`SELECT id,guest_id AS guestId,business_date AS businessDate,score,note,revision,
    created_at AS createdAt,updated_at AS updatedAt FROM mood_records WHERE guest_id=? AND business_date=?`).get(guestId, clock.dateKey());
  return row ? normalizeMood(row) : null;
}

export async function listMoodRecords(guestId, limit = 100) {
  const rows = await db.prepare(`SELECT id,guest_id AS guestId,business_date AS businessDate,score,note,revision,
    created_at AS createdAt,updated_at AS updatedAt FROM mood_records WHERE guest_id=?
    ORDER BY business_date DESC,id DESC LIMIT ?`).all(guestId, limit);
  return rows.map(normalizeMood);
}

export async function createMoodRecord({ guestId, actorId, score, note, clock = systemBusinessClock }) {
  const stamp = now();
  const businessDate = clock.dateKey();
  const result = await db.prepare(`INSERT INTO mood_records
    (guest_id,business_date,score,note,revision,created_at,updated_at) VALUES(?,?,?,?,1,?,?)`)
    .run(guestId, businessDate, score, note, stamp, stamp);
  await db.prepare(`INSERT INTO audit_logs(actor_id,action,target_type,target_id,detail,created_at)
    VALUES(?,?,?,?,?,?)`).run(actorId, 'mood_record.create', 'mood_record', String(result.lastInsertRowid), '客人记录今日心情', stamp);
  const row = await db.prepare(`SELECT id,guest_id AS guestId,business_date AS businessDate,score,note,revision,
    created_at AS createdAt,updated_at AS updatedAt FROM mood_records WHERE id=?`).get(result.lastInsertRowid);
  const record = normalizeMood(row);
  await recordReplanSourceEvent({ guestId, sourceType: 'mood', sourceId: String(record.id), sourceVersion: record.revision,
    sourceLabel: `心情记录第 ${record.revision} 版 · ${record.businessDate}`,
    sourceSnapshot: { recordId: record.id, score: record.score, label: record.label, note: record.note,
      businessDate: record.businessDate, revision: record.revision },
    triggerReason: record.score <= 2 ? '心情记录为较低分值，需把该来源交由人工核对。' : '',
    requiresAttention: record.score <= 2 });
  return record;
}

export async function updateMoodRecord({ guestId, actorId, recordId, score, note, clock = systemBusinessClock }) {
  const row = await db.prepare(`SELECT id,guest_id AS guestId,business_date AS businessDate,score,note,revision,
    created_at AS createdAt,updated_at AS updatedAt FROM mood_records WHERE id=? AND guest_id=?`).get(recordId, guestId);
  if (!row) throw new AppError(404, 'MOOD_RECORD_NOT_FOUND', '心情记录不存在');
  if (String(row.businessDate ?? row.business_date).slice(0, 10) !== clock.dateKey()) {
    throw new AppError(409, 'MOOD_EDIT_WINDOW_CLOSED', '只能修改上海时间今天的心情记录');
  }
  const stamp = now();
  const revision = Number(row.revision || 1) + 1;
  const updated = await db.prepare('UPDATE mood_records SET score=?,note=?,revision=?,updated_at=? WHERE id=? AND guest_id=? AND revision=?')
    .run(score, note, revision, stamp, recordId, guestId, row.revision || 1);
  if (!updated.changes) throw new AppError(409, 'MOOD_RECORD_CHANGED', '心情记录已变化，请刷新后重试');
  await db.prepare(`INSERT INTO audit_logs(actor_id,action,target_type,target_id,detail,created_at)
    VALUES(?,?,?,?,?,?)`).run(actorId, 'mood_record.update', 'mood_record', String(recordId), '客人修改今日心情记录', stamp);
  const fresh = await db.prepare(`SELECT id,guest_id AS guestId,business_date AS businessDate,score,note,revision,
    created_at AS createdAt,updated_at AS updatedAt FROM mood_records WHERE id=?`).get(recordId);
  const record = normalizeMood(fresh);
  await recordReplanSourceEvent({ guestId, sourceType: 'mood', sourceId: String(record.id), sourceVersion: record.revision,
    sourceLabel: `心情记录第 ${record.revision} 版 · ${record.businessDate}`,
    sourceSnapshot: { recordId: record.id, score: record.score, label: record.label, note: record.note,
      businessDate: record.businessDate, revision: record.revision },
    triggerReason: record.score <= 2 ? '心情记录为较低分值，需把该来源交由人工核对。' : '',
    requiresAttention: record.score <= 2 });
  return record;
}

export async function getMoodTrend(guestId, days, clock = systemBusinessClock) {
  if (![7, 30].includes(Number(days))) throw new AppError(400, 'MOOD_TREND_WINDOW_INVALID', '趋势窗口只支持 7 日或 30 日');
  const endDate = clock.dateKey();
  const startDate = shiftDateKey(endDate, 1 - Number(days));
  const rows = await db.prepare(`SELECT id,business_date AS businessDate,score,note,revision FROM mood_records
    WHERE guest_id=? AND business_date>=? AND business_date<=? ORDER BY business_date,id`).all(guestId, startDate, endDate);
  const byDate = new Map(rows.map(row => [String(row.businessDate ?? row.business_date).slice(0, 10), normalizeMood(row)]));
  const points = Array.from({ length: Number(days) }, (_unused, index) => {
    const date = shiftDateKey(startDate, index);
    const record = byDate.get(date) || null;
    return { date, score: record?.score ?? null, note: record?.note ?? null, recordId: record?.id ?? null };
  });
  const sourceIds = rows.map(row => String(row.id));
  let replanEvents = [];
  if (sourceIds.length) {
    const placeholders = sourceIds.map(() => '?').join(',');
    const events = await db.prepare(`SELECT e.id,e.source_id AS sourceId,e.source_version AS sourceVersion,
      e.source_snapshot_json AS sourceSnapshotJson,e.requires_attention AS requiresAttention,e.status,
      e.candidate_draft_id AS candidateDraftId,d.version AS candidateVersion,d.review_status AS candidateReviewStatus
      FROM wellness_replan_events e LEFT JOIN wellness_drafts d ON d.id=e.candidate_draft_id
      WHERE e.guest_id=? AND e.source_type='mood' AND e.source_id IN (${placeholders})
      ORDER BY e.created_at,e.id`).all(guestId, ...sourceIds);
    replanEvents = events.map(event => {
      let sourceSnapshot = event.sourceSnapshotJson;
      if (typeof sourceSnapshot === 'string') {
        try { sourceSnapshot = JSON.parse(sourceSnapshot); } catch { sourceSnapshot = {}; }
      }
      return { id: event.id, sourceId: Number(event.sourceId), sourceVersion: Number(event.sourceVersion),
        businessDate: sourceSnapshot?.businessDate || '', score: Number(sourceSnapshot?.score ?? 0),
        requiresAttention: Boolean(event.requiresAttention), status: event.status,
        candidateDraftId: event.candidateDraftId || null,
        candidateVersion: event.candidateVersion == null ? null : Number(event.candidateVersion),
        candidateReviewStatus: event.candidateReviewStatus || null };
    });
  }
  return {
    days: Number(days), startDate, endDate, points,
    sampleCount: rows.length,
    missingDayCount: Number(days) - rows.length,
    focusEvents: [], replanEvents
  };
}

function allConsecutiveNegativeRuns(records) {
  const ordered = [...records].sort((a, b) => a.businessDate.localeCompare(b.businessDate));
  const runs = [];
  let current = [];
  for (const record of ordered) {
    if (record.score <= MOOD_RULE.thresholdScore && (!current.length || shiftDateKey(current.at(-1).businessDate, 1) === record.businessDate)) {
      current.push(record);
    } else {
      if (current.length >= MOOD_RULE.consecutiveDays) runs.push(current);
      current = record.score <= MOOD_RULE.thresholdScore ? [record] : [];
    }
  }
  if (current.length >= MOOD_RULE.consecutiveDays) runs.push(current);
  return runs;
}

export async function evaluateMoodFollowups(guestId, clock = systemBusinessClock) {
  const rows = await db.prepare(`SELECT id,guest_id AS guestId,business_date AS businessDate,score,note,
    created_at AS createdAt,updated_at AS updatedAt FROM mood_records WHERE guest_id=? ORDER BY business_date DESC LIMIT 90`).all(guestId);
  const records = rows.map(normalizeMood);
  const runs = allConsecutiveNegativeRuns(records);
  const stamp = now();
  for (const run of runs) {
    const existing = await db.prepare(`SELECT id,status FROM mood_focus_items
      WHERE guest_id=? AND rule_id=? AND streak_start=?`).get(guestId, MOOD_RULE.id, run[0].businessDate);
    const recordIds = JSON.stringify(run.map(record => record.id));
    if (existing) {
      await db.prepare(`UPDATE mood_focus_items SET streak_end=?,source_record_ids_json=?,status='open',
        updated_at=?,resolved_at=NULL WHERE id=?`).run(run.at(-1).businessDate, recordIds, stamp, existing.id);
    } else {
      await db.prepare(`INSERT INTO mood_focus_items
        (guest_id,rule_id,streak_start,streak_end,source_record_ids_json,status,created_at,updated_at)
        VALUES(?,?,?,?,?,'open',?,?)`).run(guestId, MOOD_RULE.id, run[0].businessDate, run.at(-1).businessDate, recordIds, stamp, stamp);
    }
  }

  const openItems = await db.prepare(`SELECT id,streak_end AS streakEnd,status FROM mood_focus_items
    WHERE guest_id=? AND rule_id=? AND status='open'`).all(guestId, MOOD_RULE.id);
  for (const item of openItems) {
    const improved = records.some(record => record.businessDate >= String(item.streakEnd ?? item.streak_end).slice(0, 10)
      && record.score > MOOD_RULE.thresholdScore);
    if (improved) {
      await db.prepare(`UPDATE mood_focus_items SET status='improved',updated_at=?,resolved_at=? WHERE id=? AND status='open'`)
        .run(stamp, clock.utc(), item.id);
    }
  }
  return listMoodFocusItems(guestId);
}

export async function listMoodFocusItems(guestId) {
  const rows = await db.prepare(`SELECT id,guest_id AS guestId,rule_id AS ruleId,streak_start AS streakStart,
    streak_end AS streakEnd,source_record_ids_json AS sourceRecordIdsJson,status,
    created_at AS createdAt,updated_at AS updatedAt,resolved_at AS resolvedAt
    FROM mood_focus_items WHERE guest_id=? ORDER BY id DESC LIMIT 50`).all(guestId);
  return rows.map(row => ({
    id: Number(row.id), guestId: row.guestId ?? row.guest_id, ruleId: row.ruleId ?? row.rule_id,
    startDate: String(row.streakStart ?? row.streak_start).slice(0, 10),
    endDate: String(row.streakEnd ?? row.streak_end).slice(0, 10),
    sourceRecordIds: JSON.parse(row.sourceRecordIdsJson ?? row.source_record_ids_json),
    status: row.status,
    statusLabel: row.status === 'open' ? '待人工关注' : '有改善记录',
    createdAt: row.createdAt ?? row.created_at, updatedAt: row.updatedAt ?? row.updated_at,
    resolvedAt: row.resolvedAt ?? row.resolved_at ?? null,
    rule: { ...MOOD_RULE }
  }));
}

export async function recordMoodResourcePlay({ guestId, resourceId, eventId }) {
  if (!getMoodResource(resourceId)) throw new AppError(404, 'MOOD_RESOURCE_NOT_FOUND', '放松资源不存在');
  if (typeof eventId !== 'string' || !/^[0-9a-f-]{36}$/i.test(eventId)) {
    throw new AppError(400, 'MOOD_RESOURCE_EVENT_INVALID', '播放事件编号格式不正确');
  }
  const playedAt = now();
  try {
    const result = await db.prepare(`INSERT INTO mood_resource_events(guest_id,resource_id,event_id,played_at)
      VALUES(?,?,?,?)`).run(guestId, resourceId, eventId, playedAt);
    return { id: Number(result.lastInsertRowid), resourceId, eventId, playedAt, duplicate: false };
  } catch (error) {
    if (error?.code !== 'SQLITE_CONSTRAINT_UNIQUE' && error?.errcode !== 2067 && error?.errcode !== 1555
      && error?.code !== 'ER_DUP_ENTRY' && error?.errno !== 1062) throw error;
    const row = await db.prepare(`SELECT id,resource_id AS resourceId,event_id AS eventId,played_at AS playedAt
      FROM mood_resource_events WHERE guest_id=? AND event_id=?`).get(guestId, eventId);
    return { id: Number(row.id), resourceId: row.resourceId ?? row.resource_id, eventId: row.eventId ?? row.event_id,
      playedAt: row.playedAt ?? row.played_at, duplicate: true };
  }
}

export async function getMoodSummary(guestId, clock = systemBusinessClock) {
  const profile = await db.prepare(`SELECT u.id AS guestId,u.name,g.birth_date AS birthDate,g.gender,g.mobility
    FROM users u LEFT JOIN guest_profiles g ON g.user_id=u.id WHERE u.id=? AND u.role='guest'`).get(guestId);
  if (!profile) throw new AppError(404, 'GUEST_NOT_FOUND', '客人不存在');
  const allRecords = await listMoodRecords(guestId, 200);
  const records = allRecords.filter(record => record.businessDate <= clock.dateKey()).slice(0, 30);
  const age = ageAt(profile.birthDate ?? profile.birth_date, clock.dateKey());
  const usageRows = await db.prepare(`SELECT resource_id AS resourceId,COUNT(*) AS playCount,MAX(played_at) AS lastPlayedAt
    FROM mood_resource_events WHERE guest_id=? GROUP BY resource_id`).all(guestId);
  const usageById = new Map(usageRows.map(row => [row.resourceId ?? row.resource_id, row]));
  const recentIds = new Set(records.map(record => record.id));
  const focusItems = await listMoodFocusItems(guestId);
  return {
    profile: {
      guestId: profile.guestId ?? profile.guest_id,
      name: profile.name,
      ageBand: age === null ? 'unknown' : age >= 60 ? 'older_adult' : 'young_middle_aged',
      ageBandLabel: age === null ? '年龄资料不足' : age >= 60 ? '长者演示范围' : '中青年演示范围',
      gender: profile.gender || '',
      mobility: profile.mobility || ''
    },
    recentMoods: records.map(record => ({ id: record.id, businessDate: record.businessDate, score: record.score,
      label: record.label, note: record.note })),
    dataSufficiency: {
      status: records.length >= 3 ? 'available' : 'insufficient_data',
      recordCount: records.length,
      message: records.length >= 3 ? '近期有可供人工查看的心情记录。' : '近期记录不足，暂不能概括变化；请勿据此推断心理状况。'
    },
    resources: listMoodResources().map(({ id, title, category, durationSeconds, audioUrl, coverUrl, source, license }) => ({
      id, title, category, durationSeconds, audioUrl, coverUrl, source, license,
      playCount: Number(usageById.get(id)?.playCount || 0),
      lastPlayedAt: usageById.get(id)?.lastPlayedAt || null
    })),
    focusItems: focusItems.filter(item => item.sourceRecordIds.some(id => recentIds.has(id))),
    interpretationBoundary: '只返回已记录的心情、资源目录与播放次数。播放次数不表示心理改善；摘要不作诊断或治疗判断。'
  };
}

function ageAt(birthDate, today) {
  if (typeof birthDate !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(birthDate)) return null;
  const [birthYear, birthMonth, birthDay] = birthDate.slice(0, 10).split('-').map(Number);
  const [year, month, day] = today.split('-').map(Number);
  let age = year - birthYear;
  if (month < birthMonth || (month === birthMonth && day < birthDay)) age -= 1;
  return age >= 0 && age <= 120 ? age : null;
}
