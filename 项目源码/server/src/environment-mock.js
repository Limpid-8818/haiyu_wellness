import crypto from 'node:crypto';
import { DEMO_ENVIRONMENT_LOCATION, ENVIRONMENT_DEMO_RULES } from './environment-config.js';
import { makeDemoEnvironment, validDate } from './environment-providers.js';

export const ENVIRONMENT_MOCK_SCENARIOS = Object.freeze(['normal', 'risk', 'missing', 'stale']);

export function environmentMockScenario(value = process.env.ENVIRONMENT_MOCK_SCENARIO || 'missing') {
  if (typeof value !== 'string' || !ENVIRONMENT_MOCK_SCENARIOS.includes(value)) {
    throw new TypeError('mock scenario must be normal, risk, missing or stale');
  }
  return value;
}

export function makeEnvironmentMockSnapshot(targetDate, retrievedAt, requestedScenario) {
  const scenario = environmentMockScenario(requestedScenario);
  if (!validDate(targetDate) || !Number.isFinite(Date.parse(retrievedAt))) {
    throw new TypeError('mock date and clock are required');
  }
  const timeStep = Math.floor(Date.parse(retrievedAt) / 3_600_000);
  const generatedAt = new Date(timeStep * 3_600_000).toISOString();
  const domains = makeDemoEnvironment(targetDate, generatedAt, DEMO_ENVIRONMENT_LOCATION);
  const expired = scenario === 'stale';
  const missing = scenario === 'missing';
  const phase = (timeStep % 24) / 24;
  for (const [domain, data] of Object.entries(domains)) {
    data.status = missing ? 'unavailable' : expired ? 'stale' : 'demo';
    data.freshness = missing ? 'unavailable' : expired ? 'stale' : 'fresh';
    data.sourceName = `本地合成/mock · ${scenario} · 非实时 · 非机构批准`;
    data.retrievedAt = expired ? new Date((timeStep - 48) * 3_600_000).toISOString() : generatedAt;
    if (domain === 'tide') data.updatedAt = data.retrievedAt;
    data.expiresAt = new Date((timeStep + (expired ? -47 : 1)) * 3_600_000).toISOString();
    data.errorCode = missing ? 'MOCK_FIELDS_UNAVAILABLE' : expired ? 'MOCK_SNAPSHOT_EXPIRED' : null;
    data.hourly = data.hourly.map((row, hour) => {
      const variation = Number(((Math.sin((hour / 24 + phase) * Math.PI * 2) + 1) / 2).toFixed(3));
      if (domain === 'weather') {
        const uvIndex = missing ? null : scenario === 'risk' ? 9 + variation : Number((row.uvIndex + variation).toFixed(2));
        return { ...row, temperatureC: missing ? null : Number((row.temperatureC + variation).toFixed(2)),
          windSpeedKmh: missing ? null : Number((6 + variation * 4).toFixed(2)), uvIndex,
          uvLevel: uvIndex === null ? 'unknown' : uvIndex >= ENVIRONMENT_DEMO_RULES.uvStrongIndexAt ? 'strong' : 'moderate' };
      }
      if (domain === 'tide') return { ...row, heightM: missing ? null : Number((row.heightM + variation * 0.05).toFixed(3)) };
      return { ...row, waveHeightM: missing ? null : Number(((scenario === 'risk' ? 2.8 : 0.45) + variation * 0.1).toFixed(3)),
        modelSeaLevelHeightMsl: missing ? null : Number((row.modelSeaLevelHeightMsl + variation * 0.05).toFixed(3)) };
    });
    if (domain === 'weather') data.current = data.hourly[12];
    if (domain === 'tide') data.events = missing ? [] : data.events.map(event => ({ ...event,
      heightM: data.hourly.find(row => row.localTime === event.localTime).heightM }));
  }
  const payloadHash = crypto.createHash('sha256').update(JSON.stringify({ targetDate, scenario, timeStep, domains })).digest('hex');
  const mock = { mode: 'synthetic_mock', scenario, scenarios: ENVIRONMENT_MOCK_SCENARIOS, timeStep,
    generatedAt, payloadHash, nonRealtime: true, institutionApproved: false,
    label: `合成/mock · ${scenario} · 非实时 · 非机构批准` };
  return {
    snapshotId: `environment:mock:${scenario}:${targetDate}:${timeStep}:${payloadHash.slice(0, 16)}`,
    targetDate, timeZone: 'Asia/Shanghai', status: domains.weather.status,
    location: DEMO_ENVIRONMENT_LOCATION, observedAt: null, expiresAt: domains.weather.expiresAt,
    ...domains,
    hourly: domains.weather.hourly.map((row, i) => ({ ...row, waveHeightM: domains.marine.hourly[i].waveHeightM,
      tideHeightM: domains.tide.hourly[i].heightM })),
    mock, demoRules: ENVIRONMENT_DEMO_RULES, safetyThresholds: null, missingConfig: [],
    limitations: [mock.label, '每小时推进的本地测试快照，不访问外部环境供应商。',
      '地点、潮位与天气均为合成夹具；未核实机构地点。', ENVIRONMENT_DEMO_RULES.note,
      '正常场景仅验证演示候选；风险、缺失和过期场景不得用于真实安全放行。']
  };
}
