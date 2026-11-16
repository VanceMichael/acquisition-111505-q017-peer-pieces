// 仅提供一次 HTTP 请求的薄封装：不做分页、协议解释或重试，恢复策略由上层引擎负责。
export async function request(url, options = {}) {
  const { timeout = 5000, ...fetchOptions } = options;
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeout), ...fetchOptions });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: Object.fromEntries(response.headers), bytes };
}
export function decodeJson(reply) {
  if (reply.status < 200 || reply.status > 299) throw new Error(`来源返回 ${reply.status}`);
  return JSON.parse(reply.bytes.toString('utf8'));
}
