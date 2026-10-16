// G44：键排序的确定性 JSON 序列化，供幂等键哈希使用；此前在 assistant.js 与
// assistant-actions.js 各有一份相同实现。
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
