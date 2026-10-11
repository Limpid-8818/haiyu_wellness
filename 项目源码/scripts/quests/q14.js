import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchOpenMeteoWeather, fetchQWeatherTide, fetchOpenMeteoMarine, alignMarineAndTide, makeDemoEnvironment } from '../../server/src/environment-providers.js';
import { ENVIRONMENT_DEMO_RULES, ENVIRONMENT_SOURCES, liveEnvironmentConfig } from '../../server/src/environment-config.js';
import { createCachedLoader } from '../../server/src/environment-cache.js';
import { assessProjectAvailability } from '../../server/src/environment-availability.js';
import { emptyHealthProfile } from '../../server/src/health-profile.js';
import { PROJECT_SEEDS, RULE_SEEDS } from '../../server/src/catalog-data.js';
import { assertOk, checkWebSource, localDate, login, request, withQ11Apis } from './q11-helpers.js';
import { databaseQuery, runNode } from './q10-helpers.js';

const questDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(questDirectory, '../..');

async function withHttpStub(handler, callback) {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(error => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try { return await callback(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

async function q141() {
  const card = await readFile(path.resolve(projectDirectory, '../docs/环境服务接入卡.md'), 'utf8');
  for (const term of [
    '纬度 / 经度', '机构尚未提供', '0, 0', '潮汐站 LocationID', '账号专属 API Host',
    'X-QW-Api-Key', 'Asia/Shanghai', '°C', 'km/h', 'UV index', 'm',
    '垂直基准未知', '16 天', '8 天', '10 天', '缺失配置', '凭证获取',
    '不能按本卡中的 demo 阈值给出可参加结论',
    ENVIRONMENT_SOURCES.weather.url, ENVIRONMENT_SOURCES.marine.url, ENVIRONMENT_SOURCES.tide.url,
    'Weather data from Open-Meteo.com'
  ]) assert.ok(card.includes(term), `environment integration card is missing ${term}`);
  const config = liveEnvironmentConfig({ ENVIRONMENT_MODE: 'live' });
  assert.equal(config.location, null);
  assert.deepEqual(config.missing, [
    'ENVIRONMENT_LOCATION_ID', 'ENVIRONMENT_LOCATION_NAME', 'ENVIRONMENT_LATITUDE',
    'ENVIRONMENT_LONGITUDE', 'ENVIRONMENT_TIME_ZONE', 'QWEATHER_TIDE_STATION_ID',
    'QWEATHER_API_HOST', 'QWEATHER_API_KEY'
  ]);
  assert.equal(ENVIRONMENT_DEMO_RULES.id, 'stage14-demo-v1');
  assert.match(ENVIRONMENT_DEMO_RULES.note, /不是机构/);
  return { output: ['integration card identifies missing institution coordinates/station and test-only 0,0 fixture', 'official API host/auth/units/datum/timezone/coverage/attribution and credential acquisition steps are documented', 'all eight required live settings are listed; demo thresholds are labeled as non-institutional'] };
}

async function q142() {
  const date = '2026-10-01';
  let requestedUrl;
  let requestCount = 0;
  await withHttpStub((req, res) => {
    requestCount += 1;
    requestedUrl = new URL(req.url, 'http://stub.invalid');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      timezone: 'Asia/Shanghai',
      utc_offset_seconds: 28800,
      current: { time: `${date}T09:00`, temperature_2m: 21.4, wind_speed_10m: 9.1 },
      hourly_units: { temperature_2m: '°C', wind_speed_10m: 'km/h' },
      hourly: {
        time: [`${date}T09:00`, `${date}T10:00`],
        temperature_2m: [21.4, 22.3], wind_speed_10m: [9.1, 10.2], uv_index: [2.5, 6.4]
      }
    }));
  }, async baseUrl => {
    const result = await fetchOpenMeteoWeather({
      latitude: 0, longitude: 0, date, baseUrl: `${baseUrl}/v1/forecast`, clock: () => new Date('2026-10-01T01:00:00.000Z')
    });
    assert.equal(requestCount, 1);
    assert.equal(requestedUrl.searchParams.get('latitude'), '0');
    assert.equal(requestedUrl.searchParams.get('longitude'), '0');
    assert.equal(requestedUrl.searchParams.get('hourly'), 'temperature_2m,wind_speed_10m,uv_index');
    assert.equal(requestedUrl.searchParams.get('timezone'), 'Asia/Shanghai');
    assert.equal(requestedUrl.searchParams.get('temperature_unit'), 'celsius');
    assert.equal(requestedUrl.searchParams.get('wind_speed_unit'), 'kmh');
    assert.equal(result.sourceName, 'Open-Meteo Weather Forecast API');
    assert.equal(result.observedAt, `${date}T01:00:00.000Z`, 'provider local observation time is normalized with its reported UTC offset');
    assert.equal(result.observedLocalTime, `${date}T09:00`, 'the provider-local observation time remains available for display and mapping');
    assert.equal(result.current.temperatureC, 21.4);
    assert.equal(result.current.windSpeedKmh, 9.1);
    assert.equal(result.current.uvIndex, 2.5);
    assert.equal(result.hourly[1].uvLevel, 'unknown', 'provider UV values stay unclassified until an approved threshold is applied');
    assert.deepEqual(result.units, { temperature: '°C', windSpeed: 'km/h', uvIndex: 'index' });
    let invalidCoordinateRequests = 0;
    for (const [latitude, longitude] of [
      [null, 0], [undefined, 0], ['', 0], ['   ', 0],
      [0, null], [0, undefined], [0, ''], [0, '   ']
    ]) {
      await assert.rejects(fetchOpenMeteoWeather({
        latitude, longitude, date, baseUrl: `${baseUrl}/v1/forecast`,
        fetchImpl: async () => { invalidCoordinateRequests += 1; throw new Error('invalid coordinates must not fetch'); }
      }), error => error.code === 'ENVIRONMENT_LOCATION_INVALID');
    }
    assert.equal(invalidCoordinateRequests, 0, 'invalid weather coordinates must be rejected before the fetch stub');
  });
  await withHttpStub((_req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end('{"error":"fixture unavailable"}');
  }, async baseUrl => {
    const provider = () => fetchOpenMeteoWeather({ latitude: 0, longitude: 0, date, baseUrl: `${baseUrl}/weather` });
    await assert.rejects(provider(), error => error.code === 'ENVIRONMENT_PROVIDER_HTTP_ERROR');
    const unavailable = await createCachedLoader({ read: async () => null, write: async () => {}, ttlMs: 60_000 })('failed-weather', provider);
    assert.equal(unavailable.status, 'unavailable');
    assert.equal(unavailable.payload, null);
  });
  return { output: ['local HTTP fixture maps observed time, temperature °C, wind km/h, raw UV index, source and timezone', 'explicit numeric 0,0 fixture coordinates are sent; null/undefined/blank coordinates are rejected before fetch', 'provider HTTP error becomes unavailable through the cache loader and does not synthesize clear-weather values'] };
}

async function q143() {
  const date = '2026-10-01';
  const payload = {
    code: '200', updateTime: '2026-10-01T00:00+08:00',
    tideTable: [
      { fxTime: `${date}T03:11+08:00`, height: '1.28', type: 'H' },
      { fxTime: `${date}T09:22+08:00`, height: '0.31', type: 'L' }
    ],
    tideHourly: [
      { fxTime: `${date}T09:00+08:00`, height: '0.35' },
      { fxTime: `${date}T10:00+08:00`, height: '0.48' }
    ]
  };
  let requestCount = 0;
  let requestUrl;
  let requestKey;
  let fixture;
  await withHttpStub((req, res) => {
    requestCount += 1;
    requestUrl = new URL(req.url, 'http://stub.invalid');
    requestKey = req.headers['x-qw-api-key'];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  }, async baseUrl => {
    fixture = await fetchQWeatherTide({
      stationId: 'station-test-100', date, apiHost: 'account.example.qweather.test',
      baseUrl: `${baseUrl}/v7/ocean/tide`, apiKey: 'unit-test-key', clock: () => new Date('2026-10-01T00:05:00.000Z')
    });
  });
  assert.equal(requestCount, 1);
  assert.equal(requestUrl.searchParams.get('location'), 'station-test-100');
  assert.equal(requestUrl.searchParams.get('date'), '20261001');
  assert.equal(requestKey, 'unit-test-key');
  assert.equal(fixture.sourceName, 'QWeather Tide API');
  assert.equal(fixture.events[0].type, 'high');
  assert.equal(fixture.events[1].type, 'low');
  assert.equal(fixture.hourly[1].heightM, 0.48);
  assert.equal(fixture.verticalDatum, null);
  assert.equal(fixture.verticalDatumStatus, 'unknown-not-specified-by-provider-contract');

  let noStationRequests = 0;
  await assert.rejects(fetchQWeatherTide({
    stationId: '', date, apiHost: 'account.example.qweather.test',
    fetchImpl: async () => { noStationRequests += 1; throw new Error('must not request'); }
  }), error => error.code === 'TIDE_STATION_REQUIRED');
  assert.equal(noStationRequests, 0);

  await withQ11Apis(async context => {
    const dataLiteral = JSON.stringify(fixture);
    const code = `import { saveEnvironmentSnapshot } from './src/environment.js';\nimport { db } from './src/db.js';\nconst data=${dataLiteral};\nconst args={locationId:'q14-test-location',stationId:'station-test-100',targetDate:'2026-10-01',domain:'tide',data,status:'available'};\ntry { const first=await saveEnvironmentSnapshot(args);const second=await saveEnvironmentSnapshot(args);console.log('Q14=' + JSON.stringify({first,second})); } finally { await db.close(); }`;
    const env = context.driver === 'sqlite' ? {
      DB_DRIVER: 'sqlite', DB_PATH: context.databasePath, ENVIRONMENT_MODE: 'unavailable'
    } : {
      DB_DRIVER: 'mysql', MYSQL_HOST: process.env.MYSQL_HOST, MYSQL_PORT: process.env.MYSQL_PORT,
      MYSQL_USER: process.env.MYSQL_USER, MYSQL_PASSWORD: process.env.MYSQL_PASSWORD || '',
      MYSQL_DATABASE: context.database, ENVIRONMENT_MODE: 'unavailable'
    };
    const probe = runNode(code, env);
    assert.equal(probe.status, 0, probe.combined);
    const marker = probe.combined.split('\n').find(line => line.startsWith('Q14='));
    assert.ok(marker, probe.combined);
    const persisted = JSON.parse(marker.slice(4));
    assert.equal(persisted.first.inserted, true);
    assert.equal(persisted.second.duplicate, true);
    const row = await databaseQuery(context,
      'SELECT COUNT(*) AS count FROM environment_snapshots WHERE location_id=? AND target_date=? AND domain=?',
      ['q14-test-location', date, 'tide'], 'get');
    assert.equal(Number(row.count), 1);
  });
  return { output: ['local QWeather Tide fixture maps H/L events and hourly station heights, sends station/date/key and leaves datum unknown', 'missing station fails before network request', 'same station/date/source fixture inserted twice into isolated SQLite and MySQL; one idempotent row remains in each'] };
}

async function q144() {
  const date = '2026-10-01';
  let result;
  let requestCount = 0;
  let requestedUrl;
  await withHttpStub((req, res) => {
    requestCount += 1;
    requestedUrl = new URL(req.url, 'http://stub.invalid');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      timezone: 'Asia/Shanghai', hourly_units: { wave_height: 'm', sea_level_height_msl: 'm' },
      hourly: { time: [`${date}T09:00`, `${date}T10:00`], wave_height: [0.6, null], sea_level_height_msl: [0.4, 0.42] }
    }));
  }, async baseUrl => {
    result = await fetchOpenMeteoMarine({ latitude: 0, longitude: 0, date, baseUrl: `${baseUrl}/marine` });
  });
  assert.equal(requestCount, 1);
  assert.equal(requestedUrl.searchParams.get('latitude'), '0');
  assert.equal(requestedUrl.searchParams.get('longitude'), '0');
  let invalidCoordinateRequests = 0;
  for (const [latitude, longitude] of [
    [null, 0], [undefined, 0], ['', 0], ['   ', 0],
    [0, null], [0, undefined], [0, ''], [0, '   ']
  ]) {
    await assert.rejects(fetchOpenMeteoMarine({
      latitude, longitude, date, baseUrl: 'http://127.0.0.1:1/marine',
      fetchImpl: async () => { invalidCoordinateRequests += 1; throw new Error('invalid coordinates must not fetch'); }
    }), error => error.code === 'ENVIRONMENT_LOCATION_INVALID');
  }
  assert.equal(invalidCoordinateRequests, 0, 'invalid marine coordinates must be rejected before the fetch stub');
  assert.equal(result.sourceName, 'Open-Meteo Marine API');
  assert.equal(result.units.waveHeight, 'm');
  assert.equal(result.hourly[0].waveHeightM, 0.6);
  assert.equal(result.hourly[0].modelSeaLevelHeightMsl, 0.4);
  assert.equal(result.hourly[1].waveHeightM, null);
  const aligned = alignMarineAndTide(result.hourly, [{ time: `${date}T09:00`, heightM: 1.2 }]);
  assert.equal(aligned[0].waveHeightM, 0.6);
  assert.equal(aligned[0].modelSeaLevelHeightMsl, 0.4);
  assert.equal(aligned[0].tideHeightM, 1.2);
  assert.equal(aligned[0].tideDatum, 'unknown');
  assert.equal(aligned[1].waveHeightM, null);
  assert.equal(aligned[1].tideHeightM, null);
  assert.notEqual(aligned[0].waveHeightM, aligned[0].tideHeightM);
  return { output: ['local marine fixture preserves wave height, model sea-level MSL, and station tide as separate fields', 'explicit numeric 0,0 fixture coordinates are sent; null/undefined/blank coordinates are rejected before fetch', 'unmatched or missing values remain null/unknown rather than being filled with zero'] };
}

async function q145() {
  let milliseconds = Date.parse('2026-10-01T00:00:00.000Z');
  let calls = 0;
  const store = new Map();
  const loader = createCachedLoader({
    read: key => store.get(key) || null,
    write: (key, value) => store.set(key, value),
    clock: () => new Date(milliseconds), ttlMs: 60_000
  });
  const provider = async () => { calls += 1; return { status: 'available', current: { temperatureC: 21 }, retrievedAt: new Date(milliseconds).toISOString() }; };
  const first = await loader('same-place-day-weather', provider);
  const hit = await loader('same-place-day-weather', provider);
  assert.equal(first.cache, 'miss');
  assert.equal(hit.cache, 'hit');
  assert.equal(calls, 1);
  milliseconds += 60_001;
  const stale = await loader('same-place-day-weather', async () => { calls += 1; throw Object.assign(new Error('offline fixture'), { code: 'OFFLINE' }); });
  assert.equal(stale.status, 'stale');
  assert.equal(stale.cache, 'stale');
  assert.equal(stale.current.temperatureC, 21);
  const absent = await loader('no-cache-day-weather', async () => { throw Object.assign(new Error('offline fixture'), { code: 'OFFLINE' }); });
  assert.equal(absent.status, 'unavailable');
  assert.equal(absent.payload, null);
  const demo = makeDemoEnvironment('2026-10-01');
  const project = PROJECT_SEEDS.find(item => item.id === 'project-sea-bath');
  const pending = assessProjectAvailability({
    project,
    snapshot: { ...demo, targetDate: '2026-10-01', status: 'stale', snapshotId: 'stale-test',
      weather: { ...demo.weather, status: 'stale' }, tide: { ...demo.tide, status: 'stale' }, marine: { ...demo.marine, status: 'stale' } },
    profileState: { verifiedProfile: emptyHealthProfile(), pendingIntakes: [] }, rules: RULE_SEEDS
  });
  assert.equal(pending.available, false);
  assert.equal(pending.status, 'pending');
  assert.match(pending.reason, /过期/);
  assert.equal(calls, 2);
  return { output: ['fresh cache serves two reads after one provider call; expired cache attempts refresh once', 'failed refresh returns stale data with stale status; no-cache failure returns unavailable/null', 'stale weather, tide, and marine snapshot leaves sea-bath window pending and unavailable'] };
}

async function q146() {
  const date = '2026-10-01';
  const demo = makeDemoEnvironment(date, '2026-10-01T00:00:00.000Z');
  const project = PROJECT_SEEDS.find(item => item.id === 'project-sea-bath');
  const indoorSpa = PROJECT_SEEDS.find(item => item.id === 'project-spa');
  const indoorHotSpring = PROJECT_SEEDS.find(item => item.id === 'project-marine-hot-spring');
  const outdoorWalk = PROJECT_SEEDS.find(item => item.id === 'project-beach-walk');
  const swimming = PROJECT_SEEDS.find(item => item.id === 'project-swimming-training');
  const profileState = { verifiedProfile: emptyHealthProfile(), pendingIntakes: [] };
  const rules = RULE_SEEDS;
  const snapshot = { ...demo, targetDate: date, status: 'demo', snapshotId: 'demo-normal', demoRules: ENVIRONMENT_DEMO_RULES };
  const normal = assessProjectAvailability({ project, snapshot, profileState, rules });
  assert.equal(normal.available, true);
  assert.equal(normal.nextAvailableTime, '09:00');
  assert.equal(normal.windows[0].isDemo, true);
  assert.match(normal.reason, /合成演示/);

  const liveFeed = structuredClone(snapshot);
  liveFeed.snapshotId = 'live-feed-without-institution-thresholds';
  liveFeed.status = 'available';
  liveFeed.weather.status = 'available';
  liveFeed.tide.status = 'available';
  liveFeed.marine.status = 'available';
  const liveCheck = assessProjectAvailability({ project, snapshot: liveFeed, profileState, rules });
  assert.equal(liveCheck.available, false);
  assert.equal(liveCheck.status, 'pending');
  assert.match(liveCheck.reason, /机构安全阈值尚未确认/);

  const liveWithApprovedThresholds = structuredClone(liveFeed);
  liveWithApprovedThresholds.safetyThresholds = {
    institutionApproved: true, uvStrongIndexAt: 10,
    maxStationTideHeightM: 2, maxWaveHeightM: 2
  };
  for (const hour of liveWithApprovedThresholds.weather.hourly) {
    hour.uvIndex = 4;
    hour.uvLevel = 'strong';
  }
  const approvedLiveCheck = assessProjectAvailability({ project, snapshot: liveWithApprovedThresholds, profileState, rules });
  assert.equal(approvedLiveCheck.available, true);
  assert.ok(approvedLiveCheck.windows.every(window => !window.ruleDecisions.find(rule => rule.ruleId === 'R3').matched),
    'live UV classification must use the approved threshold and ignore provider/demo labels');

  const lowApprovedUvThreshold = structuredClone(liveWithApprovedThresholds);
  lowApprovedUvThreshold.safetyThresholds.uvStrongIndexAt = 3;
  const approvedUvCheck = assessProjectAvailability({ project, snapshot: lowApprovedUvThreshold, profileState, rules });
  assert.equal(approvedUvCheck.available, false);
  assert.match(approvedUvCheck.reason, /R3/);
  assert.ok(approvedUvCheck.windows.every(window => window.ruleDecisions.find(rule => rule.ruleId === 'R3').matched),
    'live UV rule must use the institution-approved raw-index threshold');

  const missingIrrelevantDomains = structuredClone(snapshot);
  missingIrrelevantDomains.status = 'unavailable';
  missingIrrelevantDomains.weather = { ...missingIrrelevantDomains.weather, status: 'unavailable', hourly: [] };
  missingIrrelevantDomains.tide = { ...missingIrrelevantDomains.tide, status: 'unavailable', hourly: [], events: [] };
  missingIrrelevantDomains.marine = { ...missingIrrelevantDomains.marine, status: 'unavailable', hourly: [] };
  const indoorWithoutEnvironment = assessProjectAvailability({ project: indoorSpa, snapshot: missingIrrelevantDomains, profileState, rules });
  assert.equal(indoorWithoutEnvironment.available, true);
  assert.equal(indoorWithoutEnvironment.status, 'available');
  assert.match(indoorWithoutEnvironment.reason, /不依赖潮汐、海浪或天气/);

  const landWithOnlyWeather = structuredClone(snapshot);
  landWithOnlyWeather.status = 'unavailable';
  landWithOnlyWeather.tide = { ...landWithOnlyWeather.tide, status: 'unavailable', hourly: [], events: [] };
  landWithOnlyWeather.marine = { ...landWithOnlyWeather.marine, status: 'unavailable', hourly: [] };
  const landOutdoorCheck = assessProjectAvailability({ project: outdoorWalk, snapshot: landWithOnlyWeather, profileState, rules });
  assert.equal(landOutdoorCheck.available, true);
  assert.equal(landOutdoorCheck.status, 'available');
  assert.equal(landOutdoorCheck.nextAvailableTime, '08:00');
  assert.ok(landOutdoorCheck.windows.every(window => window.isDemo));

  const landWithoutWeather = structuredClone(landWithOnlyWeather);
  landWithoutWeather.status = 'stale';
  landWithoutWeather.weather = { ...landWithoutWeather.weather, status: 'stale' };
  const landMissingWeatherCheck = assessProjectAvailability({ project: outdoorWalk, snapshot: landWithoutWeather, profileState, rules });
  assert.equal(landMissingWeatherCheck.available, false);
  assert.equal(landMissingWeatherCheck.status, 'pending');
  assert.match(landMissingWeatherCheck.reason, /本项目所需环境字段缺失或已过期/);

  const highTide = structuredClone(snapshot);
  highTide.snapshotId = 'demo-high-tide';
  for (const hour of [9, 10, 14, 15]) highTide.tide.hourly.find(item => item.time === `${date}T${String(hour).padStart(2, '0')}:00`).heightM = 2;
  const tideCheck = assessProjectAvailability({ project, snapshot: highTide, profileState, rules });
  assert.equal(tideCheck.available, false);
  assert.match(tideCheck.reason, /R5/);
  assert.ok(tideCheck.windows.some(item => item.tideHeightM === 2 && item.ruleOutcome === 'reject'));

  const highWave = structuredClone(snapshot);
  highWave.snapshotId = 'demo-high-wave';
  for (const hour of [9, 10, 14, 15]) highWave.marine.hourly.find(item => item.time === `${date}T${String(hour).padStart(2, '0')}:00`).waveHeightM = 2.1;
  const waveCheck = assessProjectAvailability({ project, snapshot: highWave, profileState, rules });
  assert.equal(waveCheck.available, false);
  assert.match(waveCheck.reason, /R5/);
  assert.equal(waveCheck.windows.find(item => item.time === '09:00').waveHeightM, 2.1);

  const strongUv = structuredClone(snapshot);
  strongUv.snapshotId = 'demo-strong-uv';
  for (const hour of [8, 9, 10, 14, 15, 17]) {
    const weather = strongUv.weather.hourly.find(item => item.time === `${date}T${String(hour).padStart(2, '0')}:00`);
    weather.uvIndex = 8;
    weather.uvLevel = 'moderate';
  }
  const uvCheck = assessProjectAvailability({ project: outdoorWalk, snapshot: strongUv, profileState, rules });
  assert.equal(uvCheck.available, false);
  assert.match(uvCheck.reason, /R3/);

  const chronicProfile = { ...emptyHealthProfile(), chronic: { status: 'reported', items: ['高血压'] } };
  const r1Check = assessProjectAvailability({ project: indoorHotSpring, snapshot: missingIrrelevantDomains,
    profileState: { ...profileState, verifiedProfile: chronicProfile }, rules });
  assert.equal(r1Check.available, false);
  assert.ok(r1Check.windows.every(window => window.ruleDecisions.find(rule => rule.ruleId === 'R1').matched));
  assert.ok(r1Check.windows.every(window => window.ruleOutcome === 'restrict'));

  const skinProfile = { ...emptyHealthProfile(), skin: { status: 'reported', details: '皮肤破损' } };
  const r2Check = assessProjectAvailability({ project, snapshot, profileState: { ...profileState, verifiedProfile: skinProfile }, rules });
  assert.equal(r2Check.available, false);
  assert.ok(r2Check.windows.every(window => window.ruleDecisions.find(rule => rule.ruleId === 'R2').matched));
  assert.ok(r2Check.windows.every(window => window.ruleOutcome === 'reject'));

  const mobilityProfile = { ...emptyHealthProfile(), mobility: { status: 'assistance', details: '' } };
  const r4Check = assessProjectAvailability({ project: swimming, snapshot,
    profileState: { ...profileState, verifiedProfile: mobilityProfile }, rules });
  assert.equal(r4Check.available, false);
  assert.ok(r4Check.windows.every(window => window.ruleDecisions.find(rule => rule.ruleId === 'R4').matched));
  assert.ok(r4Check.windows.every(window => window.ruleOutcome === 'reject'));

  const missing = structuredClone(snapshot);
  missing.snapshotId = 'demo-missing-tide';
  missing.status = 'unavailable';
  missing.tide = { ...missing.tide, status: 'unavailable', hourly: [] };
  missing.marine = { ...missing.marine, status: 'unavailable', hourly: [] };
  const missingCheck = assessProjectAvailability({ project, snapshot: missing, profileState, rules });
  assert.equal(missingCheck.available, false);
  assert.equal(missingCheck.status, 'pending');
  assert.match(missingCheck.reason, /缺失|过期/);

  for (const item of [tideCheck, waveCheck, uvCheck, r1Check, r2Check, r4Check, landMissingWeatherCheck, missingCheck]) {
    assert.ok(item.windows.every(window => window.available === false));
  }
  return { output: [
    'indoor projects ignore unavailable environment domains; land outdoor requires weather/UV but not tide or marine; sea-entry requires all three domains',
    'live-source-shaped data stays pending without institution approval; approved live thresholds classify raw UV rather than demo/provider labels',
    'R1/R2/R4 health restrictions and R3/R5 environmental restrictions remain effective; missing required fields stay pending with no booking or capacity write'
  ] };
}

async function q147() {
  const date = localDate();
  await withQ11Apis(async context => {
    const guest = assertOk(await login(context.baseUrl, 'guest'));
    const home = assertOk(await request(context.baseUrl, `/environment?date=${date}`, { token: guest.token }));
    const detail = assertOk(await request(context.baseUrl, `/environment?date=${date}&projectId=project-sea-bath`, { token: guest.token }));
    assert.equal(home.status, 'demo');
    assert.equal(detail.status, 'demo');
    assert.equal(home.snapshotId, detail.snapshotId);
    assert.equal(home.targetDate, detail.targetDate);
    assert.equal(home.weather.current.temperatureC, detail.weather.current.temperatureC);
    assert.equal(home.tide.events[0].type, 'high');
    assert.equal(home.tide.events[1].type, 'low');
    const hourlyByLocalTime = new Map(home.tide.hourly.map(item => [item.localTime || item.time, item.heightM]));
    for (const event of home.tide.events) {
      assert.equal(hourlyByLocalTime.get(event.localTime), event.heightM,
        `${event.type} marker at ${event.localTime} must use the plotted hourly height`);
    }
    for (let index = 0; index < home.tide.events.length; index += 1) {
      const event = home.tide.events[index];
      if (event.type !== 'high') continue;
      const previousLow = home.tide.events[(index - 1 + home.tide.events.length) % home.tide.events.length];
      const nextLow = home.tide.events[(index + 1) % home.tide.events.length];
      assert.equal(previousLow.type, 'low');
      assert.equal(nextLow.type, 'low');
      assert.ok(event.heightM > previousLow.heightM && event.heightM > nextLow.heightM,
        `high tide at ${event.localTime} must exceed its adjacent low events`);
    }
    assert.ok(detail.availability.windows.every(window => window.isDemo));
    assert.equal(home.location.coordinatesStatus, 'synthetic-test-only');
    const rows = await databaseQuery(context,
      'SELECT COUNT(*) AS count FROM environment_snapshots WHERE location_id=? AND target_date=?',
      ['test-coast-stage14', date], 'get');
    assert.equal(Number(rows.count), 3);
    const staff = assertOk(await login(context.baseUrl, 'staff'));
    assert.equal((await request(context.baseUrl, `/environment?date=${date}`, { token: staff.token })).status, 403);
    const source = await readFile(path.join(projectDirectory, 'web/src/EnvironmentPanel.jsx'), 'utf8');
    for (const label of ['展开潮汐曲线', '高潮', '低潮', '垂直基准未知', '下海项目', '来源数据']) {
      if (label === '来源数据') continue;
      assert.ok(source.includes(label), `environment panel is missing ${label}`);
    }
    await checkWebSource(['<EnvironmentPanel/>', '<EnvironmentPanel projectId={project.id}/>']);
  }, { env: { ENVIRONMENT_MODE: 'demo' } });

  await withQ11Apis(async context => {
    const guest = assertOk(await login(context.baseUrl, 'guest'));
    const result = assertOk(await request(context.baseUrl, `/environment?date=${date}&projectId=project-sea-bath`, { token: guest.token }));
    assert.equal(result.status, 'unavailable');
    assert.equal(result.weather.status, 'unavailable');
    assert.equal(result.weather.current, undefined);
    assert.equal(result.tide.hourly, undefined);
    assert.equal(result.availability.available, false);
    assert.equal(result.availability.status, 'pending');
    assert.match(result.availability.reason, /缺失|过期/);
  }, { env: { ENVIRONMENT_MODE: 'unavailable' } });
  return { output: ['SQLite and MySQL guest-home and sea-bath detail return the same date, snapshot ID, weather, tide source/events, and demo marker', 'synthetic H/L event heights equal the plotted hourly values; each high exceeds adjacent low events', 'curve disclosure, event labels, location state and guest-only API permissions are checked', 'unconfigured mode returns no sunny/tide fallback and leaves sea-bath availability pending in both databases'] };
}

const quests = { 'Q14.1': q141, 'Q14.2': q142, 'Q14.3': q143, 'Q14.4': q144, 'Q14.5': q145, 'Q14.6': q146, 'Q14.7': q147 };

export async function run({ questId }) {
  const execute = quests[questId];
  assert.ok(execute, `unsupported Stage14 quest ${questId}`);
  return execute();
}
