import assert from 'node:assert/strict';
import test from 'node:test';
import { liveEnvironmentConfig } from '../../server/src/environment-config.js';
import { fetchOpenMeteoMarine, fetchOpenMeteoWeather, fetchQWeatherTide } from '../../server/src/environment-providers.js';

const representativeConfig = {
  ENVIRONMENT_LOCATION_ID: 'dalian-etdz-region-representative',
  ENVIRONMENT_LOCATION_NAME: '大连经济技术开发区地区代表点（非机构精确地址）',
  ENVIRONMENT_LATITUDE: '39.052585',
  ENVIRONMENT_LONGITUDE: '121.787513',
  ENVIRONMENT_TIME_ZONE: 'Asia/Shanghai',
  ENVIRONMENT_COORDINATES_STATUS: 'region-representative',
  ENVIRONMENT_LOCATION_SOURCE: 'https://www.wikidata.org/wiki/Q1000487#P625',
  ENVIRONMENT_INSTITUTION_LOCATION_CONFIGURED: '0'
};

test('region representative coordinates enable weather and marine while missing QWeather fields keep tide blocked', () => {
  const config = liveEnvironmentConfig(representativeConfig);
  assert.equal(config.location.id, 'dalian-etdz-region-representative');
  assert.equal(config.location.coordinatesStatus, 'region-representative');
  assert.equal(config.location.institutionLocationConfigured, false);
  assert.equal(config.location.locationSource, representativeConfig.ENVIRONMENT_LOCATION_SOURCE);
  assert.deepEqual(config.missingByDomain.weather, []);
  assert.deepEqual(config.missingByDomain.marine, []);
  assert.deepEqual(config.missingByDomain.tide, ['QWEATHER_TIDE_STATION_ID', 'QWEATHER_API_HOST', 'QWEATHER_API_KEY']);
  assert.deepEqual(config.missing, config.missingByDomain.tide);
});

test('Open-Meteo weather and marine providers return live-shaped data from one bounded request each', async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(new URL(url));
    if (calls.length === 1) return new Response(JSON.stringify({ latitude: 39.0625, longitude: 121.8125,
      timezone: 'Asia/Shanghai',
      current: { time: '2026-10-10T12:00', temperature_2m: 19, wind_speed_10m: 8 },
      hourly_units: { temperature_2m: '°C', wind_speed_10m: 'km/h' },
      hourly: { time: ['2026-10-10T12:00'], temperature_2m: [19], wind_speed_10m: [8], uv_index: [2] } }), { status: 200 });
    return new Response(JSON.stringify({ latitude: 39.0625, longitude: 121.8125,
      timezone: 'Asia/Shanghai',
      hourly_units: { wave_height: 'm', sea_level_height_msl: 'm' },
      hourly: { time: ['2026-10-10T12:00'], wave_height: [0.6], sea_level_height_msl: [0.2] } }), { status: 200 });
  };
  const weather = await fetchOpenMeteoWeather({ latitude: 39.052585, longitude: 121.787513,
    date: '2026-10-10', timeZone: 'Asia/Shanghai', fetchImpl });
  const marine = await fetchOpenMeteoMarine({ latitude: 39.052585, longitude: 121.787513,
    date: '2026-10-10', timeZone: 'Asia/Shanghai', fetchImpl });
  assert.equal(weather.status, 'available');
  assert.equal(weather.hourly.length, 1);
  assert.deepEqual(weather.providerCoordinates, { latitude: 39.0625, longitude: 121.8125,
    coordinateSystem: 'WGS84', meaning: 'provider-grid-cell-center' });
  assert.equal(marine.status, 'available');
  assert.equal(marine.hourly[0].waveHeightM, 0.6);
  assert.deepEqual(marine.providerCoordinates, weather.providerCoordinates);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].searchParams.get('latitude'), '39.052585');
  assert.equal(calls[1].searchParams.get('longitude'), '121.787513');
});

test('QWeather tide does not call a provider without an authorized station ID', async () => {
  let calls = 0;
  await assert.rejects(fetchQWeatherTide({ stationId: '', date: '2026-10-10', apiHost: '', apiKey: '',
    fetchImpl: async () => { calls += 1; throw new Error('provider must not be called'); } }),
  error => error.code === 'TIDE_STATION_REQUIRED');
  assert.equal(calls, 0);
});
