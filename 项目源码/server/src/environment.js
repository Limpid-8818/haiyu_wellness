import crypto from 'node:crypto';
import { db, driver, now, json } from './db.js';
import { createCachedLoader } from './environment-cache.js';
import { makeEnvironmentMockSnapshot } from './environment-mock.js';
import {
  DEMO_ENVIRONMENT_LOCATION, ENVIRONMENT_DEMO_RULES, ENVIRONMENT_SOURCES,
  getEnvironmentMode, liveEnvironmentConfig
} from './environment-config.js';
import {
  alignMarineAndTide, EnvironmentProviderError, fetchOpenMeteoMarine,
  fetchOpenMeteoWeather, fetchQWeatherTide, makeDemoEnvironment
} from './environment-providers.js';

const DOMAIN_TTL_MS = Object.freeze({ weather: 30 * 60_000, marine: 30 * 60_000, tide: 2 * 60 * 60_000 });
const VALID_DOMAINS = new Set(Object.keys(DOMAIN_TTL_MS));

function sqlTimestamp(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError('environment timestamp is invalid');
  return driver === 'mysql' ? parsed.toISOString().slice(0, -1).replace('T', ' ') : parsed.toISOString();
}

function readTimestamp(value) {
  if (!value || driver !== 'mysql' || typeof value !== 'string') return value;
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
}

function snapshotKey({ locationId, stationId = '', targetDate, domain }) {
  const key = JSON.stringify([locationId, stationId, targetDate, domain]);
  return `env:${crypto.createHash('sha256').update(key).digest('hex').slice(0, 48)}`;
}

function fromRow(row) {
  return {
    ...(json(row.payload_json, {}) || {}),
    snapshotKey: row.snapshot_key,
    domain: row.domain,
    status: row.status,
    sourceName: row.source_name,
    sourceUrl: row.source_url,
    observedAt: readTimestamp(row.observed_at),
    expiresAt: readTimestamp(row.expires_at)
  };
}

async function readSnapshot(key) {
  const row = await db.prepare('SELECT * FROM environment_snapshots WHERE snapshot_key=?').get(key);
  return row ? fromRow(row) : null;
}

export async function saveEnvironmentSnapshot({
  locationId, stationId = '', targetDate, domain, data,
  status = data?.status || 'available', expiresAt, observedAt = data?.observedAt || data?.updatedAt || null
}) {
  if (typeof locationId !== 'string' || !locationId.trim() || typeof targetDate !== 'string'
    || !VALID_DOMAINS.has(domain) || !data || !['available', 'demo'].includes(status)) {
    throw new TypeError('environment snapshot metadata is invalid');
  }
  const key = snapshotKey({ locationId, stationId, targetDate, domain });
  const sourceName = String(data.sourceName || '未知来源');
  const sourceUrl = String(data.sourceUrl || '');
  const savedAt = now();
  const expiry = expiresAt || new Date(Date.parse(savedAt) + DOMAIN_TTL_MS[domain]).toISOString();
  const payload = { ...data };
  delete payload.snapshotKey;
  delete payload.cache;
  delete payload.freshness;
  const payloadJson = JSON.stringify(payload);
  const payloadHash = crypto.createHash('sha256').update(payloadJson).digest('hex');
  const existingMeta = await db.prepare('SELECT payload_hash,status FROM environment_snapshots WHERE snapshot_key=?').get(key);
  const existing = existingMeta ? await readSnapshot(key) : null;
  if (existingMeta?.status === status && existingMeta.payload_hash === payloadHash) {
    return { inserted: false, duplicate: true, snapshotKey: key };
  }

  const values = [key, locationId, stationId, targetDate, domain, status, sourceName, sourceUrl,
    sqlTimestamp(observedAt), sqlTimestamp(expiry), payloadHash, payloadJson,
    sqlTimestamp(savedAt), sqlTimestamp(savedAt)];
  const sqliteSql = `INSERT INTO environment_snapshots
    (snapshot_key,location_id,station_id,target_date,domain,status,source_name,source_url,observed_at,expires_at,payload_hash,payload_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(snapshot_key) DO UPDATE SET location_id=excluded.location_id,station_id=excluded.station_id,
    target_date=excluded.target_date,domain=excluded.domain,status=excluded.status,source_name=excluded.source_name,
    source_url=excluded.source_url,observed_at=excluded.observed_at,expires_at=excluded.expires_at,
    payload_hash=excluded.payload_hash,payload_json=excluded.payload_json,updated_at=excluded.updated_at`;
  const mysqlSql = `INSERT INTO environment_snapshots
    (snapshot_key,location_id,station_id,target_date,domain,status,source_name,source_url,observed_at,expires_at,payload_hash,payload_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE location_id=VALUES(location_id),station_id=VALUES(station_id),target_date=VALUES(target_date),
    domain=VALUES(domain),status=VALUES(status),source_name=VALUES(source_name),source_url=VALUES(source_url),
    observed_at=VALUES(observed_at),expires_at=VALUES(expires_at),payload_hash=VALUES(payload_hash),
    payload_json=VALUES(payload_json),updated_at=VALUES(updated_at)`;
  await db.prepare(driver === 'mysql' ? mysqlSql : sqliteSql).run(...values);
  return { inserted: !existing, duplicate: Boolean(existing), snapshotKey: key };
}

async function writeSnapshot({ locationId, stationId, targetDate, domain }, record) {
  return saveEnvironmentSnapshot({
    locationId, stationId, targetDate, domain, data: record, status: record.status,
    expiresAt: record.expiresAt, observedAt: record.observedAt || record.updatedAt || null
  });
}

function unavailableRecord(domain, errorCode, missingConfig = []) {
  return {
    domain,
    status: 'unavailable',
    freshness: 'unavailable',
    sourceName: ENVIRONMENT_SOURCES[domain]?.name || '环境服务',
    sourceUrl: ENVIRONMENT_SOURCES[domain]?.url || '',
    payload: null,
    errorCode,
    missingConfig
  };
}

export async function getEnvironmentSnapshot(targetDate, { forceRefresh = false, mockScenario } = {}) {
  const mode = getEnvironmentMode();
  if (mode === 'demo') {
    const snapshot = makeEnvironmentMockSnapshot(targetDate, now(), mockScenario);
    if (snapshot.status === 'demo') {
      for (const domain of ['weather', 'tide', 'marine']) await saveEnvironmentSnapshot({
        locationId: snapshot.location.id,
        stationId: `mock:${snapshot.mock.scenario}:${snapshot.mock.timeStep}`,
        targetDate, domain, data: snapshot[domain], expiresAt: snapshot[domain].expiresAt
      });
    }
    return snapshot;
  }
  const liveConfig = mode === 'live' ? liveEnvironmentConfig() : null;
  const location = mode === 'demo' ? DEMO_ENVIRONMENT_LOCATION : liveConfig?.location || {
    id: 'institution-location-unconfigured',
    name: '机构地点未配置',
    latitude: null,
    longitude: null,
    coordinatesStatus: 'missing-institution-configuration',
    tideStationId: null,
    timeZone: null,
    institutionLocationConfigured: false
  };
  const missingConfig = liveConfig?.missing || [];
  const clock = () => new Date(now());
  const domains = {};

  const domainsToLoad = mode === 'live' && liveConfig?.tideProvider === 'open-meteo'
    ? ['weather', 'marine'] : ['weather', 'tide', 'marine'];
  for (const domain of domainsToLoad) {
    const stationId = domain === 'tide' ? (location.tideStationId || '') : '';
    const domainMissing = liveConfig?.missingByDomain?.[domain] || [];
    const key = snapshotKey({ locationId: location.id, stationId, targetDate, domain });
    const loader = createCachedLoader({
      read: async requestedKey => readSnapshot(requestedKey),
      write: async (requestedKey, record) => writeSnapshot({ locationId: location.id, stationId, targetDate, domain }, record),
      clock,
      ttlMs: DOMAIN_TTL_MS[domain]
    });
    let record = await loader(key, async () => {
      if (mode === 'demo') return makeDemoEnvironment(targetDate, clock().toISOString(), location)[domain];
      if (mode !== 'live') throw new EnvironmentProviderError('ENVIRONMENT_NOT_CONFIGURED', '环境服务未启用');
      if (domainMissing.length) throw Object.assign(
        new EnvironmentProviderError('ENVIRONMENT_CONFIGURATION_MISSING', '当前环境数据源缺少所需配置'),
        { missingConfig: domainMissing });
      if (domain === 'weather') return fetchOpenMeteoWeather({
        latitude: location.latitude, longitude: location.longitude, date: targetDate,
        timeZone: location.timeZone, baseUrl: liveConfig.weatherBaseUrl
      });
      if (domain === 'marine') return fetchOpenMeteoMarine({
        latitude: location.latitude, longitude: location.longitude, date: targetDate,
        timeZone: location.timeZone, baseUrl: liveConfig.marineBaseUrl
      });
      if (liveConfig.tideProvider === 'open-meteo') {
        throw new EnvironmentProviderError('TIDE_MODEL_DEPENDENCY_UNAVAILABLE', '含潮汐的模式海面高度需要同一Marine响应中的sea_level_height_msl字段');
      }
      return fetchQWeatherTide({
        stationId: location.tideStationId, date: targetDate,
        apiHost: liveConfig.apiHost, apiKey: liveConfig.apiKey
      });
    }, { forceRefresh });
    record = { ...record, domain };
    if (record.freshness === 'unavailable' && domainMissing.length) record.missingConfig = domainMissing;
    domains[domain] = record;
  }

  if (mode === 'live' && liveConfig?.tideProvider === 'open-meteo') {
    const marine = domains.marine;
    const seaLevelAvailable = ['available', 'demo'].includes(marine?.status)
      && marine?.variableStatus?.modeledSeaLevelIncludingTides === 'available'
      && Array.isArray(marine.hourly) && marine.hourly.length > 0
      && marine.hourly.every(item => Number.isFinite(item.modelSeaLevelHeightMsl));
    const modeledTide = {
      domain: 'tide', status: seaLevelAvailable ? 'available' : marine?.status === 'stale' ? 'stale' : 'unavailable',
      freshness: seaLevelAvailable ? marine.freshness || 'fresh' : marine?.status === 'stale' ? 'stale' : 'unavailable',
      mode: 'modeled-sea-level-including-tides',
      typeLabel: '含潮汐的模式海面高度（预测）',
      sourceName: ENVIRONMENT_SOURCES.tide.name,
      sourceUrl: ENVIRONMENT_SOURCES.tide.url,
      sourceResponseHash: marine?.providerResponseHash || null,
      sourceMarineSnapshotKey: marine?.snapshotKey || null,
      providerCoordinates: marine?.providerCoordinates || null,
      targetDate,
      retrievedAt: marine?.retrievedAt || null,
      observedAt: null,
      expiresAt: marine?.expiresAt || null,
      timezone: marine?.timezone || location.timeZone || null,
      unit: marine?.units?.modelSeaLevel || 'm',
      units: { height: marine?.units?.modelSeaLevel || 'm' },
      verticalDatum: 'global mean sea level',
      verticalDatumStatus: 'global-mean-sea-level-model; not a local station datum',
      includes: ['tides', 'inverted-barometer effect', 'sea-surface-height variation', 'global mean steric and mass-volume variation'],
      stationId: null,
      events: [],
      hourly: Array.isArray(marine?.hourly) ? marine.hourly.map(item => ({ time: item.time,
        localTime: item.time, heightM: Number.isFinite(item.modelSeaLevelHeightMsl) ? item.modelSeaLevelHeightMsl : null,
        modeled: true, sourceResponseHash: marine?.providerResponseHash || null })) : [],
      errorCode: seaLevelAvailable ? null : marine?.modeledSeaLevelUnavailableReason ? 'TIDE_MODEL_DATA_INCOMPLETE'
        : marine?.errorCode || 'TIDE_MODEL_DATA_UNAVAILABLE',
      missingConfig: seaLevelAvailable ? [] : (liveConfig?.missingByDomain?.marine || [])
    };
    domains.tide = modeledTide;
    if (seaLevelAvailable) {
      await saveEnvironmentSnapshot({ locationId: location.id, targetDate, domain: 'tide', data: modeledTide,
        status: 'available', expiresAt: modeledTide.expiresAt,
        observedAt: modeledTide.retrievedAt });
      const tideKey = snapshotKey({ locationId: location.id, targetDate, domain: 'tide' });
      domains.tide = { ...modeledTide, snapshotKey: tideKey };
    }
  }

  const weather = domains.weather;
  const tide = domains.tide;
  const marine = domains.marine;
  const statusList = [weather.status, tide.status, marine.status];
  const overallStatus = statusList.every(status => status === 'demo') ? 'demo'
    : statusList.every(status => status === 'available') ? 'available'
      : statusList.includes('stale') ? 'stale' : 'unavailable';
  const stationTideHourly = tide.mode === 'modeled-sea-level-including-tides' ? [] : tide.hourly || [];
  const alignedHourly = alignMarineAndTide(marine.hourly || [], stationTideHourly).map(row => {
    const weatherHour = (weather.hourly || []).find(item => item.time === row.time);
    return {
      ...row,
      temperatureC: weatherHour?.temperatureC ?? null,
      windSpeedKmh: weatherHour?.windSpeedKmh ?? null,
      uvIndex: weatherHour?.uvIndex ?? null,
      uvLevel: weatherHour?.uvLevel || 'unknown'
    };
  });
  const snapshotId = `environment:${location.id}:${targetDate}:${[weather, tide, marine].map(item => item.retrievedAt || item.updatedAt || item.status).join(':')}`;
  const expiries = [weather.expiresAt, tide.expiresAt, marine.expiresAt].filter(Boolean).sort();
  return {
    snapshotId,
    targetDate,
    timeZone: location.timeZone || null,
    status: overallStatus,
    location,
    observedAt: weather.observedAt || weather.retrievedAt || null,
    expiresAt: expiries[0] || null,
    weather,
    tide,
    marine,
    hourly: alignedHourly,
    demoRules: ENVIRONMENT_DEMO_RULES,
    missingConfig,
    ...(process.env.ENVIRONMENT_OFFLINE_FIXTURE === '1'
      ? { providerFixture: { mode: 'offline_fixture', label: '离线网页夹具 · 未访问外部供应商' } } : {}),
    limitations: [
      location.coordinatesStatus === 'region-representative'
        ? '坐标是地区代表点，不是机构精确地址；机构实际地点尚未核实。'
        : !location.institutionLocationConfigured ? '机构实际地点尚未配置；地点与坐标均为合成标记。'
          : '地点使用已配置的机构坐标。',
      liveConfig?.tideProvider === 'open-meteo'
        ? '含潮汐的模式海面高度来自Open-Meteo Marine同一响应，以全球平均海平面为基准；它不是本地官方台站实测潮位。'
        : !location.tideStationId || liveConfig?.missingByDomain?.tide?.length
          ? '可选QWeather站点模式未配置；默认数据模式仍为Open-Meteo含潮汐的预测海面高度。'
          : '潮汐结果仅对应配置的站点，垂直基准按服务契约说明。',
      '波高、含潮汐的模式海面高度、站点实测潮高是不同字段；缺失或过期数据不会替代另一字段。',
      ENVIRONMENT_DEMO_RULES.note,
      '环境快照不代表临床、海事或航海安全结论；缺失或过期数据不放行下海项目。'
    ]
  };
}

export async function readEnvironmentSnapshotCount({ locationId, targetDate, domain, stationId = '' }) {
  const key = snapshotKey({ locationId, stationId, targetDate, domain });
  const row = await db.prepare('SELECT COUNT(*) AS count FROM environment_snapshots WHERE snapshot_key=?').get(key);
  return Number(row?.count || 0);
}
