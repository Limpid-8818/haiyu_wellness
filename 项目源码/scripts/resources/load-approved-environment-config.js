import fs from 'node:fs';
import readline from 'node:readline';

const APPROVED_ENV_PATH = '/Users/wangshanchong/Codes/haiyu_wellness/项目源码/.env';
const ALLOWED_KEYS = new Set([
  'ENVIRONMENT_LOCATION_ID', 'ENVIRONMENT_LOCATION_NAME', 'ENVIRONMENT_LATITUDE',
  'ENVIRONMENT_LONGITUDE', 'ENVIRONMENT_TIME_ZONE', 'ENVIRONMENT_COORDINATES_STATUS',
  'ENVIRONMENT_LOCATION_SOURCE', 'ENVIRONMENT_INSTITUTION_LOCATION_CONFIGURED',
  'QWEATHER_TIDE_STATION_ID', 'QWEATHER_API_HOST', 'QWEATHER_API_KEY',
  'OPEN_METEO_WEATHER_BASE_URL', 'OPEN_METEO_MARINE_BASE_URL'
]);

function parseValue(raw) {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1)
    .replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"');
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value.replace(/\s+#.*$/, '').trim();
}

export async function loadApprovedEnvironmentConfig({ env = process.env } = {}) {
  const values = {};
  const sourceByKey = {};
  let fileStatus = 'unavailable';
  let fileError = null;
  try {
    const linkStat = fs.lstatSync(APPROVED_ENV_PATH);
    const stat = fs.statSync(APPROVED_ENV_PATH);
    if (!linkStat.isFile() || linkStat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0) {
      throw new Error('approved environment file permissions or type are invalid');
    }
    const lines = readline.createInterface({ input: fs.createReadStream(APPROVED_ENV_PATH, { encoding: 'utf8' }), crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
        if (!match || !ALLOWED_KEYS.has(match[1])) continue;
        const value = parseValue(match[2]);
        if (!value) continue;
        values[match[1]] = value;
        sourceByKey[match[1]] = 'approved-file';
      }
    } finally { lines.close(); }
    fileStatus = 'read';
  } catch (error) {
    fileError = error?.code === 'ENOENT' ? 'not-found' : 'not-readable-or-permissions-invalid';
  }
  for (const key of ALLOWED_KEYS) {
    const value = typeof env[key] === 'string' ? env[key].trim() : '';
    if (!value) continue;
    values[key] = value;
    sourceByKey[key] = 'approved-process-environment';
  }
  return { env: values, sourceByKey, file: { path: APPROVED_ENV_PATH, status: fileStatus, error: fileError },
    configuredKeys: [...ALLOWED_KEYS].filter(key => Boolean(values[key])).sort(),
    missingVariables: [...ALLOWED_KEYS].filter(key => !values[key]).sort(),
    credentialValuesRecorded: false };
}
