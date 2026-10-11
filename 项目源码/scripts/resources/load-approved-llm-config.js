import fs from 'node:fs';
import readline from 'node:readline';

const APPROVED_ENV_PATH = '/Users/wangshanchong/Codes/haiyu_wellness/项目源码/.env';
const ALLOWED_KEYS = new Set(['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL']);

function parseValue(raw) {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"');
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value.replace(/\s+#.*$/, '').trim();
}

export async function loadApprovedLlmConfig() {
  let stat;
  try { stat = fs.statSync(APPROVED_ENV_PATH); }
  catch { return { configured: false, error: '配置文件不可读' }; }
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) return { configured: false, error: '配置文件权限不符合要求' };
  const values = {};
  const lines = readline.createInterface({ input: fs.createReadStream(APPROVED_ENV_PATH, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!match || !ALLOWED_KEYS.has(match[1])) continue;
      values[match[1]] = parseValue(match[2]);
    }
  } catch {
    return { configured: false, error: '配置文件读取失败' };
  }
  const configured = Boolean(values.LLM_BASE_URL && values.LLM_API_KEY && values.LLM_MODEL);
  return configured ? { configured: true, env: values } : { configured: false, error: '必要模型配置缺失' };
}
