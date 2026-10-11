import { evaluateProjectRules } from './rules-engine.js';

const DAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function timeParts(value) {
  const match = String(value ?? '').match(/^(\d{2}):(\d{2})$/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function dateDay(date) {
  return DAY_LABELS[new Date(`${date}T12:00:00Z`).getUTCDay()];
}

function scheduledTimes(project, date) {
  const day = dateDay(date);
  const windows = Array.isArray(project.openWindows) ? project.openWindows : [];
  const candidates = [];
  for (const window of windows) {
    if (!Array.isArray(window.days) || !(window.days.includes('每日') || window.days.includes(day))) continue;
    const start = timeParts(window.start);
    const end = timeParts(window.end);
    if (start === null || end === null || end <= start) continue;
    let cursor = Math.ceil(start / 60) * 60;
    while (cursor < end) {
      candidates.push(`${String(Math.floor(cursor / 60)).padStart(2, '0')}:${String(cursor % 60).padStart(2, '0')}`);
      cursor += 60;
    }
  }
  return [...new Set(candidates)].sort();
}

export function assessEnvironmentWindow({ project, snapshot, time, profileState = {}, legacyProfile = {}, rules }) {
  const timeKey = `${snapshot.targetDate}T${time}`;
  const weather = (snapshot.weather?.hourly || []).find(item => item.time === timeKey);
  const stationTide = snapshot.tide?.mode === 'modeled-sea-level-including-tides' ? null
    : (snapshot.tide?.hourly || []).find(item => item.localTime === timeKey || item.time === timeKey);
  const marine = (snapshot.marine?.hourly || []).find(item => item.time === timeKey);
  const requiredDomains = project.seaEntry ? ['weather', 'tide', 'marine'] : project.outdoor ? ['weather'] : [];
  const requiredDomainsFresh = requiredDomains.every(domain => ['available', 'demo'].includes(snapshot[domain]?.status));
  const requiredValuesPresent = (!project.outdoor || Boolean(weather && Number.isFinite(weather.uvIndex)))
    && (!project.seaEntry || Boolean(Number.isFinite(stationTide?.heightM) && Number.isFinite(marine?.waveHeightM)));
  // Demo limits may only evaluate windows whose every required input is demo.
  // Mixed or live inputs require a separately approved institutional limit.
  const demoOnly = requiredDomains.length > 0
    && requiredDomains.every(domain => snapshot[domain]?.status === 'demo');
  const thresholds = demoOnly ? snapshot.demoRules : snapshot.safetyThresholds;
  const thresholdsConfigured = requiredDomains.length === 0 || (demoOnly
    ? (!project.outdoor || Number.isFinite(thresholds?.uvStrongIndexAt))
      && (!project.seaEntry || (Number.isFinite(thresholds?.maxStationTideHeightM) && Number.isFinite(thresholds?.maxWaveHeightM)))
    : Boolean(thresholds?.institutionApproved === true
      && (!project.outdoor || Number.isFinite(thresholds.uvStrongIndexAt))
      && (!project.seaEntry || (Number.isFinite(thresholds.maxStationTideHeightM) && Number.isFinite(thresholds.maxWaveHeightM)))));
  const requiredEnvironmentVerified = requiredDomainsFresh && requiredValuesPresent && thresholdsConfigured;
  const uvLevel = project.outdoor && weather && Number.isFinite(weather.uvIndex) && thresholdsConfigured
    ? (weather.uvIndex >= thresholds.uvStrongIndexAt ? 'strong' : 'moderate')
    : 'unknown';
  const seaStatus = !project.seaEntry ? 'not_applicable'
    : !requiredEnvironmentVerified ? 'missing'
    : (stationTide.heightM > thresholds.maxStationTideHeightM || marine.waveHeightM > thresholds.maxWaveHeightM) ? 'unsafe' : 'safe';
  const environment = {
    uvLevel,
    seaStatus,
    source: snapshot.snapshotId
  };
  const evaluation = evaluateProjectRules({
    project,
    verifiedProfile: profileState.verifiedProfile || {},
    legacyProfile,
    pendingIntakes: profileState.pendingIntakes || [],
    effectiveHealthConstraints: profileState.effectiveHealthConstraints || null,
    environment,
    rules
  });
  const allowedByRules = evaluation.outcome === 'allow' && requiredEnvironmentVerified;
  const status = !requiredEnvironmentVerified ? 'pending'
    : evaluation.outcome === 'allow' ? 'available' : 'restricted';
  const reasons = [];
  if (!requiredDomainsFresh || !requiredValuesPresent) {
    reasons.push('本项目所需环境字段缺失或已过期；不能据此确认安全。');
  }
  if (requiredDomains.length && !thresholdsConfigured) {
    reasons.push(demoOnly
      ? '演示安全阈值未配置；不能据此给出可参加结论。'
      : '机构安全阈值尚未确认；不能据此给出可参加结论。');
  }
  if (evaluation.outcome !== 'allow') {
    reasons.push(...evaluation.decisions.filter(item => item.matched).map(item => `${item.ruleId}：${item.reason}`));
  }
  if (demoOnly) reasons.push('本次计算使用合成演示环境与演示阈值，不代表真实可参加结论。');
  return {
    projectId: project.id,
    targetDate: snapshot.targetDate,
    time,
    status,
    available: allowedByRules,
    isDemo: demoOnly,
    reason: reasons.join(' ') || (requiredDomains.length
      ? '窗口开放且所需环境与健康规则未命中；仍需现场核实。'
      : '窗口开放；本项目不依赖潮汐、海浪或天气数据，健康规则未命中。'),
    nextAvailableTime: allowedByRules ? time : null,
    waveHeightM: marine?.waveHeightM ?? null,
    tideHeightM: stationTide?.heightM ?? null,
    tideDatum: stationTide ? snapshot.tide?.verticalDatumStatus || 'unknown' : 'unknown',
    ruleOutcome: evaluation.outcome,
    reviewRequired: evaluation.reviewRequired,
    ruleDecisions: evaluation.decisions
  };
}

export function assessProjectAvailability({ project, snapshot, profileState = {}, legacyProfile = {}, rules }) {
  const times = scheduledTimes(project, snapshot.targetDate);
  if (!times.length) return {
    projectId: project.id,
    targetDate: snapshot.targetDate,
    status: 'closed',
    available: false,
    reason: '项目在此日期没有配置开放窗口（当前窗口本身也是演示资料）。',
    windows: [],
    nextAvailableTime: null
  };
  const windows = times.map(time => assessEnvironmentWindow({ project, snapshot, time, profileState, legacyProfile, rules }));
  const next = windows.find(item => item.available) || null;
  const hasPending = windows.some(item => item.status === 'pending');
  return {
    projectId: project.id,
    targetDate: snapshot.targetDate,
    status: next ? 'available' : hasPending ? 'pending' : 'restricted',
    available: Boolean(next),
    reason: next?.reason || windows[0]?.reason || '没有可确认的开放窗口。',
    windows,
    nextAvailableTime: next?.time || null,
    nextAvailable: next ? { date: snapshot.targetDate, time: next.time, isDemo: next.isDemo } : null,
    demoRules: snapshot.demoRules
  };
}

export { scheduledTimes };
