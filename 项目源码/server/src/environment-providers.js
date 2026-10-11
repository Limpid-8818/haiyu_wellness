import { ENVIRONMENT_DEMO_RULES, ENVIRONMENT_SOURCES } from './environment-config.js';
import crypto from 'node:crypto';
import { reserveEnvironmentProviderRequest, STAGE27_R4_ENV_LIMITS } from '../../scripts/resources/stage27-r4-budget-accounts.js';

export class EnvironmentProviderError extends Error {
  constructor(code, message, { statusCode = null } = {}) {
    super(message);
    this.name = 'EnvironmentProviderError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function validDate(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
    && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
}

function validCoordinates(latitude, longitude) {
  const hasValue = value => (typeof value === 'number' && Number.isFinite(value))
    || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)));
  return hasValue(latitude) && Number(latitude) >= -90 && Number(latitude) <= 90
    && hasValue(longitude) && Number(longitude) >= -180 && Number(longitude) <= 180;
}

function providerGridCoordinates(body) {
  const latitude = numberOrNull(body?.latitude);
  const longitude = numberOrNull(body?.longitude);
  if (!validCoordinates(latitude, longitude)) return null;
  return { latitude, longitude, coordinateSystem: 'WGS84', meaning: 'provider-grid-cell-center' };
}

function parseLocalHour(time) {
  const match = String(time ?? '').match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  return match ? `${match[1]}T${match[2]}` : null;
}

function localDateTimeAsUtcMilliseconds(value) {
  const match = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/u);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = '0', fraction = '0'] = match;
  const milliseconds = Number(fraction.padEnd(3, '0'));
  const instant = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), milliseconds);
  const roundTrip = new Date(instant).toISOString();
  const expectedPrefix = `${year}-${month}-${day}T${hour}:${minute}:${second.padStart(2, '0')}`;
  return roundTrip.startsWith(expectedPrefix) ? instant : null;
}

function timeZoneOffsetSecondsForLocalTime(value, timeZone) {
  const wallTime = localDateTimeAsUtcMilliseconds(value);
  if (!Number.isFinite(wallTime) || typeof timeZone !== 'string' || !timeZone.trim()) return null;
  let candidate = wallTime;
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const parts = Object.fromEntries(formatter.formatToParts(new Date(candidate))
        .filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
      const wallAtCandidate = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
      const offsetSeconds = Math.round((wallAtCandidate - Math.floor(candidate / 1000) * 1000) / 1000);
      const adjusted = wallTime - offsetSeconds * 1000;
      if (adjusted === candidate) return offsetSeconds;
      candidate = adjusted;
    }
    const parts = Object.fromEntries(formatter.formatToParts(new Date(candidate))
      .filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
    const wallAtCandidate = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    return Math.round((wallAtCandidate - Math.floor(candidate / 1000) * 1000) / 1000);
  } catch {
    return null;
  }
}

function providerUtcOffsetSeconds(value, { timeZone, utcOffsetSeconds } = {}) {
  if (!value || /(?:[zZ]|[+-]\d{2}(?::?\d{2})?)$/u.test(String(value).trim())) {
    const explicitOffset = Number(utcOffsetSeconds);
    return utcOffsetSeconds !== null && utcOffsetSeconds !== undefined && utcOffsetSeconds !== ''
      && Number.isInteger(explicitOffset) && Math.abs(explicitOffset) <= 14 * 60 * 60 ? explicitOffset : null;
  }
  const hasSuppliedOffset = utcOffsetSeconds !== null && utcOffsetSeconds !== undefined && utcOffsetSeconds !== '';
  const suppliedOffset = hasSuppliedOffset ? Number(utcOffsetSeconds) : Number.NaN;
  return hasSuppliedOffset && Number.isInteger(suppliedOffset) && Math.abs(suppliedOffset) <= 14 * 60 * 60
    ? suppliedOffset : timeZoneOffsetSecondsForLocalTime(value, timeZone);
}

function normalizeProviderInstant(value, { timeZone, utcOffsetSeconds } = {}) {
  if (!value) return null;
  const text = String(value).trim();
  if (/(?:[zZ]|[+-]\d{2}(?::?\d{2})?)$/u.test(text)) {
    const explicit = new Date(text);
    return Number.isFinite(explicit.getTime()) ? explicit.toISOString() : null;
  }
  const wallTime = localDateTimeAsUtcMilliseconds(text);
  if (!Number.isFinite(wallTime)) return null;
  const offsetSeconds = providerUtcOffsetSeconds(text, { timeZone, utcOffsetSeconds });
  if (!Number.isInteger(offsetSeconds) || Math.abs(offsetSeconds) > 14 * 60 * 60) {
    throw new EnvironmentProviderError('ENVIRONMENT_TIMESTAMP_OFFSET_MISSING', '天气观测时间没有可核实的时区偏移');
  }
  return new Date(wallTime - offsetSeconds * 1000).toISOString();
}

function uvLevel(index) {
  if (index === null) return 'unknown';
  return index >= ENVIRONMENT_DEMO_RULES.uvStrongIndexAt ? 'strong' : 'moderate';
}

async function requestJson(url, { fetchImpl = fetch, headers = {}, timeoutMs = 8000, provider = 'environment', validatePayload } = {}) {
  const effectiveTimeoutMs = Math.min(Number(timeoutMs) || 8000, STAGE27_R4_ENV_LIMITS.requestTimeoutMs);
  const budget = await reserveEnvironmentProviderRequest({ filePath: process.env.ENVIRONMENT_PROVIDER_BUDGET_LEDGER_PATH,
    taskId: process.env.CODEX_TASK_ID, baselineUsed: Number(process.env.ENVIRONMENT_PROVIDER_BUDGET_BASELINE || 0), provider });
  let outcome = 'failed';
  try {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(effectiveTimeoutMs) });
    if (!response.ok) throw new EnvironmentProviderError('ENVIRONMENT_PROVIDER_HTTP_ERROR', `环境服务返回 HTTP ${response.status}`, { statusCode: response.status });
    let payload;
    try { payload = await response.json(); }
    catch { throw new EnvironmentProviderError('ENVIRONMENT_PROVIDER_INVALID_JSON', '环境服务响应不是有效 JSON'); }
    if (typeof validatePayload === 'function') validatePayload(payload);
    outcome = 'success';
    return payload;
  } catch (error) {
    if (error instanceof EnvironmentProviderError) throw error;
    throw new EnvironmentProviderError('ENVIRONMENT_PROVIDER_UNAVAILABLE', '环境服务连接失败', { statusCode: null });
  } finally {
    if (budget) budget.finish(outcome);
  }
}

function checkErrorCode(payload) {
  const code = String(payload?.code ?? '');
  if (code && code !== '200' && code !== '0') {
    throw new EnvironmentProviderError('ENVIRONMENT_PROVIDER_REJECTED', `环境服务返回状态 ${code}`);
  }
}

export async function fetchOpenMeteoWeather({
  latitude, longitude, date, timeZone = 'Asia/Shanghai',
  baseUrl = ENVIRONMENT_SOURCES.weather.baseUrl, fetchImpl = fetch, clock = () => new Date()
}) {
  if (!validCoordinates(latitude, longitude)) throw new EnvironmentProviderError('ENVIRONMENT_LOCATION_INVALID', '天气查询坐标无效');
  if (!validDate(date)) throw new EnvironmentProviderError('ENVIRONMENT_DATE_INVALID', '天气查询日期必须是 YYYY-MM-DD');
  const url = new URL(baseUrl);
  url.searchParams.set('latitude', String(Number(latitude)));
  url.searchParams.set('longitude', String(Number(longitude)));
  url.searchParams.set('hourly', 'temperature_2m,wind_speed_10m,uv_index');
  url.searchParams.set('current', 'temperature_2m,wind_speed_10m');
  url.searchParams.set('temperature_unit', 'celsius');
  url.searchParams.set('wind_speed_unit', 'kmh');
  url.searchParams.set('timezone', timeZone);
  url.searchParams.set('forecast_days', '16');
  const body = await requestJson(url, { fetchImpl, provider: 'open-meteo-weather' });
  const times = Array.isArray(body?.hourly?.time) ? body.hourly.time : [];
  const values = (key, i) => Array.isArray(body?.hourly?.[key]) ? numberOrNull(body.hourly[key][i]) : null;
  const hourly = times.filter(time => String(time).startsWith(`${date}T`)).map(time => {
    const index = times.indexOf(time);
    const uvIndex = values('uv_index', index);
    return {
      time: parseLocalHour(time),
      temperatureC: values('temperature_2m', index),
      windSpeedKmh: values('wind_speed_10m', index),
      uvIndex,
      // Provider UV is raw data. Safety classification belongs to the
      // availability evaluator, which can use an approved institution limit.
      uvLevel: 'unknown'
    };
  }).filter(item => item.time);
  const current = body?.current || {};
  const currentTime = parseLocalHour(current.time);
  const currentHourKey = currentTime ? `${currentTime.slice(0, 13)}:00` : null;
  const currentHour = hourly.find(item => item.time === currentHourKey) || hourly[0] || null;
  const retrievedAt = clock().toISOString();
  const timezone = body.timezone || timeZone;
  const utcOffsetSeconds = providerUtcOffsetSeconds(current.time, { timeZone: timezone, utcOffsetSeconds: body.utc_offset_seconds });
  return {
    status: 'available',
    sourceName: ENVIRONMENT_SOURCES.weather.name,
    sourceUrl: ENVIRONMENT_SOURCES.weather.url,
    providerCoordinates: providerGridCoordinates(body),
    retrievedAt,
    observedAt: normalizeProviderInstant(current.time, { timeZone: timezone, utcOffsetSeconds: body.utc_offset_seconds }),
    observedLocalTime: current.time || null,
    forecastStart: hourly[0]?.time || null,
    forecastEnd: hourly.at(-1)?.time || null,
    timezone,
    utcOffsetSeconds,
    units: { temperature: body.hourly_units?.temperature_2m || '°C', windSpeed: body.hourly_units?.wind_speed_10m || 'km/h', uvIndex: 'index' },
    current: currentHour ? {
      time: currentHour.time,
      temperatureC: numberOrNull(current.temperature_2m) ?? currentHour.temperatureC,
      windSpeedKmh: numberOrNull(current.wind_speed_10m) ?? currentHour.windSpeedKmh,
      uvIndex: currentHour.uvIndex,
      uvLevel: currentHour.uvLevel
    } : null,
    hourly
  };
}

function normalizedApiHost(apiHost, baseUrl) {
  if (baseUrl) return new URL(baseUrl);
  const host = String(apiHost ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/$/, '');
  if (!host) throw new EnvironmentProviderError('QWEATHER_API_HOST_REQUIRED', '缺少账号专属 QWeather API Host');
  if (host.includes('/') || /(^|\.)api\.qweather\.com$/i.test(host) || /(^|\.)devapi\.qweather\.com$/i.test(host)) {
    throw new EnvironmentProviderError('QWEATHER_API_HOST_INVALID', '必须使用账号专属 QWeather API Host，不能使用共享旧域名');
  }
  return new URL(`https://${host}/v7/ocean/tide`);
}

export async function fetchQWeatherTide({
  stationId, date, apiHost, apiKey = '', baseUrl, fetchImpl = fetch, clock = () => new Date()
}) {
  if (typeof stationId !== 'string' || !stationId.trim()) {
    throw new EnvironmentProviderError('TIDE_STATION_REQUIRED', '缺少潮汐站 LocationID，未发送请求');
  }
  if (!validDate(date)) throw new EnvironmentProviderError('ENVIRONMENT_DATE_INVALID', '潮汐查询日期必须是 YYYY-MM-DD');
  const url = normalizedApiHost(apiHost, baseUrl);
  url.searchParams.set('location', stationId.trim());
  url.searchParams.set('date', date.replaceAll('-', ''));
  const headers = apiKey ? { 'X-QW-Api-Key': apiKey } : {};
  const body = await requestJson(url, { fetchImpl, headers, provider: 'qweather-tide', validatePayload: checkErrorCode });
  const toEvent = item => ({
    time: item?.fxTime || null,
    localTime: parseLocalHour(item?.fxTime),
    heightM: numberOrNull(item?.height),
    type: item?.type === 'H' ? 'high' : item?.type === 'L' ? 'low' : 'unknown'
  });
  const hourly = (Array.isArray(body.tideHourly) ? body.tideHourly : []).map(item => ({
    time: item?.fxTime || null,
    localTime: parseLocalHour(item?.fxTime),
    heightM: numberOrNull(item?.height)
  })).filter(item => item.time);
  return {
    status: 'available',
    sourceName: ENVIRONMENT_SOURCES.tide.name,
    sourceUrl: ENVIRONMENT_SOURCES.tide.url,
    stationId: stationId.trim(),
    targetDate: date,
    updatedAt: body.updateTime || clock().toISOString(),
    retrievedAt: clock().toISOString(),
    unit: 'm',
    verticalDatum: null,
    verticalDatumStatus: 'unknown-not-specified-by-provider-contract',
    events: (Array.isArray(body.tideTable) ? body.tideTable : []).map(toEvent),
    hourly
  };
}

export async function fetchOpenMeteoMarine({
  latitude, longitude, date, timeZone = 'Asia/Shanghai',
  baseUrl = ENVIRONMENT_SOURCES.marine.baseUrl, fetchImpl = fetch, clock = () => new Date()
}) {
  if (!validCoordinates(latitude, longitude)) throw new EnvironmentProviderError('ENVIRONMENT_LOCATION_INVALID', '海况查询坐标无效');
  if (!validDate(date)) throw new EnvironmentProviderError('ENVIRONMENT_DATE_INVALID', '海况查询日期必须是 YYYY-MM-DD');
  const url = new URL(baseUrl);
  url.searchParams.set('latitude', String(Number(latitude)));
  url.searchParams.set('longitude', String(Number(longitude)));
  url.searchParams.set('hourly', 'wave_height,sea_level_height_msl');
  url.searchParams.set('length_unit', 'metric');
  url.searchParams.set('timezone', timeZone);
  url.searchParams.set('forecast_days', '8');
  const body = await requestJson(url, { fetchImpl, provider: 'open-meteo-marine' });
  const times = Array.isArray(body?.hourly?.time) ? body.hourly.time : [];
  const hourly = times.filter(time => String(time).startsWith(`${date}T`)).map(time => {
    const index = times.indexOf(time);
    return {
      time: parseLocalHour(time),
      waveHeightM: numberOrNull(body?.hourly?.wave_height?.[index]),
      modelSeaLevelHeightMsl: numberOrNull(body?.hourly?.sea_level_height_msl?.[index])
    };
  }).filter(item => item.time);
  const waveValuesComplete = hourly.length > 0 && hourly.every(item => Number.isFinite(item.waveHeightM));
  const seaLevelValuesComplete = hourly.length > 0 && hourly.every(item => Number.isFinite(item.modelSeaLevelHeightMsl));
  return {
    status: 'available',
    sourceName: ENVIRONMENT_SOURCES.marine.name,
    sourceUrl: ENVIRONMENT_SOURCES.marine.url,
    providerCoordinates: providerGridCoordinates(body),
    providerResponseHash: crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    retrievedAt: clock().toISOString(),
    timezone: body.timezone || timeZone,
    units: { waveHeight: body.hourly_units?.wave_height || 'm', modelSeaLevel: body.hourly_units?.sea_level_height_msl || 'm' },
    seaLevelReference: 'global mean sea level; modeled sea level includes tides and other sea-level changes; not an official local tide-station observation',
    variableStatus: { waveHeight: waveValuesComplete ? 'available' : 'unavailable',
      modeledSeaLevelIncludingTides: seaLevelValuesComplete ? 'available' : 'unavailable' },
    modeledSeaLevelUnavailableReason: seaLevelValuesComplete ? null
      : 'Open-Meteo sea_level_height_msl data is missing, null, non-numeric, or absent for part of the requested date.',
    hourly
  };
}

export function alignMarineAndTide(marineHourly = [], tideHourly = []) {
  const tideByTime = new Map(tideHourly.map(item => [item.localTime || parseLocalHour(item.time), item.heightM]));
  return marineHourly.map(item => ({
    time: item.time,
    waveHeightM: numberOrNull(item.waveHeightM),
    modelSeaLevelHeightMsl: numberOrNull(item.modelSeaLevelHeightMsl),
    tideHeightM: tideByTime.has(item.time) ? numberOrNull(tideByTime.get(item.time)) : null,
    tideDatum: tideByTime.has(item.time) ? 'unknown' : null
  }));
}

export function makeDemoEnvironment(date, retrievedAt = new Date().toISOString(), location = null) {
  const hourlyTimes = Array.from({ length: 24 }, (_, hour) => `${date}T${String(hour).padStart(2, '0')}:00`);
  const weatherHourly = hourlyTimes.map((time, hour) => {
    const uvIndex = hour >= 10 && hour <= 14 ? 4 : hour >= 8 && hour <= 16 ? 2 : 0;
    return { time, temperatureC: Number((18 + Math.sin((hour / 24) * Math.PI * 2) * 4).toFixed(1)), windSpeedKmh: 8, uvIndex, uvLevel: uvLevel(uvIndex) };
  });
  const tideAnchors = [
    { hour: -3, heightM: 0.4 },
    { hour: 3, heightM: 1.25 },
    { hour: 9, heightM: 0.35 },
    { hour: 15, heightM: 1.4 },
    { hour: 21, heightM: 0.4 },
    { hour: 27, heightM: 1.25 }
  ];
  const tideHeights = hourlyTimes.map((time, hour) => {
    const tideHour = hour < 3 ? hour + 24 : hour;
    const anchorIndex = tideAnchors.findIndex((anchor, index) => index < tideAnchors.length - 1
      && tideHour >= anchor.hour && tideHour <= tideAnchors[index + 1].hour);
    const from = tideAnchors[anchorIndex];
    const to = tideAnchors[anchorIndex + 1];
    const progress = (tideHour - from.hour) / (to.hour - from.hour);
    const eased = (1 - Math.cos(progress * Math.PI)) / 2;
    const heightM = Number((from.heightM + (to.heightM - from.heightM) * eased).toFixed(2));
    return { time, localTime: time, heightM };
  });
  const tideEvents = [
    { hour: 3, type: 'high' }, { hour: 9, type: 'low' },
    { hour: 15, type: 'high' }, { hour: 21, type: 'low' }
  ].map(event => {
    const localTime = `${date}T${String(event.hour).padStart(2, '0')}:00`;
    return {
      time: `${date}T${String(event.hour).padStart(2, '0')}:00+08:00`,
      localTime,
      heightM: tideHeights.find(item => item.localTime === localTime).heightM,
      type: event.type
    };
  });
  const marineHourly = hourlyTimes.map((time, hour) => ({ time, waveHeightM: hour === 13 ? 0.7 : 0.5, modelSeaLevelHeightMsl: Number((0.9 + hour * 0.01).toFixed(2)) }));
  const demoSource = '本地合成测试夹具（非实时）';
  const demoUrl = '';
  return {
    weather: {
      status: 'demo', sourceName: demoSource, sourceUrl: demoUrl, retrievedAt, observedAt: null,
      forecastStart: weatherHourly[0].time, forecastEnd: weatherHourly.at(-1).time,
      timezone: location?.timeZone || 'Asia/Shanghai', units: { temperature: '°C', windSpeed: 'km/h', uvIndex: 'index' },
      current: weatherHourly[12], hourly: weatherHourly
    },
    tide: {
      status: 'demo', sourceName: demoSource, sourceUrl: demoUrl,
      stationId: location?.tideStationId || 'TEST_ONLY_NOT_A_REAL_STATION', targetDate: date,
      updatedAt: retrievedAt, retrievedAt, unit: 'm', verticalDatum: null,
      verticalDatumStatus: 'unknown-test-fixture',
      events: tideEvents,
      hourly: tideHeights
    },
    marine: {
      status: 'demo', sourceName: demoSource, sourceUrl: demoUrl, retrievedAt,
      timezone: location?.timeZone || 'Asia/Shanghai',
      units: { waveHeight: 'm', modelSeaLevel: 'm' },
      seaLevelReference: '合成海平面参考值；与站点潮位分开，不参与潮高判定',
      hourly: marineHourly
    }
  };
}

export { parseLocalHour, validDate };
