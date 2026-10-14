export const DEMO_ENVIRONMENT_LOCATION = Object.freeze({
  id: 'test-coast-stage14',
  name: '测试地点（合成坐标，非机构地址）',
  latitude: 0,
  longitude: 0,
  coordinatesStatus: 'synthetic-test-only',
  tideStationId: 'TEST_ONLY_NOT_A_REAL_STATION',
  timeZone: 'Asia/Shanghai',
  institutionLocationConfigured: false
});

export const ENVIRONMENT_SOURCES = Object.freeze({
  weather: {
    name: 'Open-Meteo Weather Forecast API',
    url: 'https://open-meteo.com/en/docs',
    baseUrl: 'https://api.open-meteo.com/v1/forecast'
  },
  tide: {
    name: 'Open-Meteo Marine API · 含潮汐的模式海面高度（预测）',
    url: 'https://open-meteo.com/en/docs/marine-weather-api'
  },
  marine: {
    name: 'Open-Meteo Marine API',
    url: 'https://open-meteo.com/en/docs/marine-weather-api',
    baseUrl: 'https://marine-api.open-meteo.com/v1/marine'
  }
});

export const DALIAN_ETDZ_REGION_REPRESENTATIVE = Object.freeze({
  id: 'dalian-etdz-region-representative',
  name: '大连经济技术开发区地区代表点（非机构精确地址）',
  latitude: 39.052585,
  longitude: 121.787513,
  timeZone: 'Asia/Shanghai',
  coordinatesStatus: 'region-representative',
  locationSource: 'https://www.wikidata.org/wiki/Q1000487#P625',
  institutionLocationConfigured: false
});

export const ENVIRONMENT_DEMO_RULES = Object.freeze({
  id: 'stage14-demo-v1',
  maxWaveHeightM: 1.8,
  maxStationTideHeightM: 1.7,
  uvStrongIndexAt: 6,
  note: '演示阈值，仅用于验证数据流和限制分支；不是机构、临床、海事或航海安全标准。'
});

export function getEnvironmentMode(env = process.env) {
  if (env.ENVIRONMENT_MODE === 'demo') return 'demo';
  if (env.ENVIRONMENT_MODE === 'live' && env.ENVIRONMENT_LIVE === '1') return 'live';
  return 'unavailable';
}

export function liveEnvironmentConfig(env = process.env) {
  const required = [
    'ENVIRONMENT_LOCATION_ID', 'ENVIRONMENT_LOCATION_NAME', 'ENVIRONMENT_LATITUDE',
    'ENVIRONMENT_LONGITUDE', 'ENVIRONMENT_TIME_ZONE'
  ];
  const tideProvider = String(env.ENVIRONMENT_TIDE_PROVIDER || 'open-meteo').trim().toLowerCase();
  if (tideProvider === 'qweather') required.push('QWEATHER_TIDE_STATION_ID', 'QWEATHER_API_HOST', 'QWEATHER_API_KEY');
  const missing = required.filter(key => !String(env[key] ?? '').trim());
  if (!['open-meteo', 'qweather'].includes(tideProvider)) missing.push('ENVIRONMENT_TIDE_PROVIDER (open-meteo or qweather)');
  const latitude = Number(env.ENVIRONMENT_LATITUDE);
  const longitude = Number(env.ENVIRONMENT_LONGITUDE);
  const coordinatePresent = key => typeof env[key] === 'number' || (typeof env[key] === 'string' && env[key].trim() !== '');
  let validTimeZone = false;
  try { if (env.ENVIRONMENT_TIME_ZONE) { new Intl.DateTimeFormat('en-CA', { timeZone: env.ENVIRONMENT_TIME_ZONE }); validTimeZone = true; } } catch {}
  if (env.ENVIRONMENT_TIME_ZONE && !validTimeZone) missing.push('ENVIRONMENT_TIME_ZONE (invalid time zone)');
  if (env.ENVIRONMENT_LATITUDE && (!Number.isFinite(latitude) || latitude < -90 || latitude > 90)) missing.push('ENVIRONMENT_LATITUDE (must be -90..90)');
  if (env.ENVIRONMENT_LONGITUDE && (!Number.isFinite(longitude) || longitude < -180 || longitude > 180)) missing.push('ENVIRONMENT_LONGITUDE (must be -180..180)');
  const coordinatesStatus = env.ENVIRONMENT_COORDINATES_STATUS === 'region-representative'
    ? 'region-representative' : 'institution-configured';
  const institutionLocationConfigured = coordinatesStatus === 'institution-configured'
    && env.ENVIRONMENT_INSTITUTION_LOCATION_CONFIGURED !== '0';
  const locationReady = Boolean(env.ENVIRONMENT_LOCATION_ID && env.ENVIRONMENT_LOCATION_NAME
    && validTimeZone && coordinatePresent('ENVIRONMENT_LATITUDE') && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
    && coordinatePresent('ENVIRONMENT_LONGITUDE') && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180);
  const missingLocation = ['ENVIRONMENT_LOCATION_ID', 'ENVIRONMENT_LOCATION_NAME', 'ENVIRONMENT_TIME_ZONE']
    .filter(key => !String(env[key] ?? '').trim());
  if (!coordinatePresent('ENVIRONMENT_LATITUDE') || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) missingLocation.push('ENVIRONMENT_LATITUDE');
  if (!coordinatePresent('ENVIRONMENT_LONGITUDE') || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) missingLocation.push('ENVIRONMENT_LONGITUDE');
  if (!validTimeZone) missingLocation.push('ENVIRONMENT_TIME_ZONE');
  const missingByDomain = {
    weather: locationReady ? [] : missingLocation,
    tide: tideProvider === 'qweather'
      ? ['QWEATHER_TIDE_STATION_ID', 'QWEATHER_API_HOST', 'QWEATHER_API_KEY'].filter(key => !String(env[key] ?? '').trim())
      : locationReady ? [] : missingLocation,
    marine: locationReady ? [] : missingLocation
  };
  return {
    missing,
    missingByDomain,
    location: locationReady ? {
      id: env.ENVIRONMENT_LOCATION_ID,
      name: env.ENVIRONMENT_LOCATION_NAME,
      latitude,
      longitude,
      coordinatesStatus,
      locationSource: env.ENVIRONMENT_LOCATION_SOURCE || null,
      tideStationId: String(env.QWEATHER_TIDE_STATION_ID || '').trim() || null,
      timeZone: env.ENVIRONMENT_TIME_ZONE,
      institutionLocationConfigured
    } : null,
    apiHost: String(env.QWEATHER_API_HOST || '').trim() || null,
    apiKey: String(env.QWEATHER_API_KEY || '').trim() || null,
    tideProvider,
    weatherBaseUrl: env.OPEN_METEO_WEATHER_BASE_URL || ENVIRONMENT_SOURCES.weather.baseUrl,
    marineBaseUrl: env.OPEN_METEO_MARINE_BASE_URL || ENVIRONMENT_SOURCES.marine.baseUrl
  };
}
