import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { Archive } from './archive.mjs';
import { receiveManual } from './intake.mjs';
import { CollectService } from './collect-service.mjs';

async function readJsonBody(incoming, limit = 1048576) {
  const chunks = [];
  let length = 0;
  for await (const chunk of incoming) {
    length += chunk.length;
    if (length > limit) return { error: { status: 413, message: '请求体过大' } };
    chunks.push(chunk);
  }
  if (chunks.length === 0) return { value: {} };
  try { return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }; }
  catch { return { error: { status: 400, message: 'JSON 无效' } }; }
}

export async function createIntake(directory, options = {}) {
  const archive = await new Archive(directory).initialize();
  const collector = new CollectService(directory, {
    sourceUrl: options.sourceUrl ?? process.env.SOURCE_URL ?? null,
    peerSourceFactory: options.peerSourceFactory,
    timeout: options.timeout,
    headers: options.headers,
  });
  return createServer(async (incoming, outgoing) => {
    const reply = (status, body) => { outgoing.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); outgoing.end(JSON.stringify(body)); };
    try {
      const url = new URL(incoming.url, 'http://localhost');
      if (incoming.method === 'GET' && url.pathname === '/health') {
        return reply(200, { status: 'ok', acquisition: 'selective-piece', running: collector.isRunning() });
      }
      if (incoming.method === 'GET' && url.pathname === '/api/records') return reply(200, await archive.list());
      if (incoming.method === 'GET' && url.pathname === '/api/collect/status') return reply(200, await collector.status());
      if (incoming.method === 'GET' && url.pathname === '/api/collect/records') {
        const manifestId = url.searchParams.get('manifestId');
        const limitParam = Number(url.searchParams.get('limit') || 200);
        const limit = Number.isInteger(limitParam) && limitParam > 0 ? limitParam : 200;
        return reply(200, await collector.records({ manifestId, limit }));
      }
      if (incoming.method === 'POST' && url.pathname === '/api/collect') {
        const parsed = await readJsonBody(incoming);
        if (parsed.error) return reply(parsed.error.status, { error: parsed.error.message });
        const payload = parsed.value;
        if (collector.isRunning()) return reply(409, { error: '已有领取任务在进行中' });
        const selected = payload.selected === undefined ? undefined : payload.selected;
        if (selected !== undefined && (!Array.isArray(selected) || selected.some(item => typeof item !== 'string'))) {
          return reply(422, { error: 'selected 必须是文件路径字符串数组' });
        }
        const concurrency = payload.concurrency === undefined ? 4 : payload.concurrency;
        if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) return reply(422, { error: 'concurrency 必须是 1..32 的整数' });
        const run = collector.start({ selected, concurrency });
        const outcome = await run;
        return reply(outcome.status === 'complete' ? 202 : 502, outcome);
      }
      if (incoming.method === 'POST' && url.pathname === '/api/manual') {
        const parsed = await readJsonBody(incoming);
        if (parsed.error) return reply(parsed.error.status, { error: parsed.error.message });
        try { return reply(201, await receiveManual(archive, parsed.value)); } catch (error) { return reply(422, { error: error.message }); }
      }
      return reply(404, { error: '路径不存在' });
    } catch (error) { return reply(500, { error: error.message }); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = await createIntake(process.env.ARCHIVE_DIR || '.local/archive');
  service.listen(Number(process.env.PORT || 3200), '0.0.0.0', () => console.log('收件服务已就绪'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => service.close(() => process.exit(0)));
}
