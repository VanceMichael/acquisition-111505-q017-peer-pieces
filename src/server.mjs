import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Archive } from './archive.mjs';
import { receiveManual } from './intake.mjs';
import { Receiver } from './receiver.mjs';
import { createHttpSource } from './source-client.mjs';
import {
  AuthorizationError, ManifestValidationError, PieceUnavailableError,
  SourceUnavailableError, VersionMismatchError,
} from './errors.mjs';

const errorStatus = error => {
  if (error instanceof AuthorizationError) return 403;
  if (error instanceof ManifestValidationError) return 422;
  if (error instanceof VersionMismatchError) return 409;
  if (error instanceof SourceUnavailableError) return 502;
  if (error instanceof PieceUnavailableError) return 502;
  return 500;
};

export async function createIntake(directory) {
  const archive = await new Archive(directory).initialize();
  const activeJobs = new Map();

  const runCollection = async (payload, sourceUrl) => {
    const source = createHttpSource(sourceUrl, { timeout: Number(process.env.SOURCE_TIMEOUT || 5000) });
    const receiver = new Receiver(source, archive, join(directory, 'collections'), {
      concurrency: Number(process.env.FETCH_CONCURRENCY || 4),
      timeout: Number(process.env.PIECE_TIMEOUT || 10000),
      cooldownMs: Number(process.env.PEER_COOLDOWN_MS || 5000),
    });
    return receiver.collect(payload && payload.files ? { files: payload.files } : {});
  };

  return createServer(async (incoming, outgoing) => {
    const reply = (status, body) => { outgoing.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); outgoing.end(JSON.stringify(body)); };
    try {
      if (incoming.method === 'GET' && incoming.url === '/health') return reply(200, { status: 'ok', acquisition: ['manual', 'auto-relay'] });
      if (incoming.method === 'GET' && incoming.url === '/api/records') return reply(200, await archive.list());
      if (incoming.method === 'GET' && incoming.url === '/api/collections') {
        let names = [];
        try { names = (await readdir(join(directory, 'collections'), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        return reply(200, { collections: names, activeJobs: [...activeJobs.keys()] });
      }
      if (incoming.method === 'POST' && incoming.url === '/api/collect') {
        const chunks = []; let length = 0;
        for await (const chunk of incoming) { length += chunk.length; if (length > 1048576) return reply(413, { error: '请求体过大' }); chunks.push(chunk); }
        let payload = {};
        if (chunks.length > 0) {
          try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { return reply(400, { error: 'JSON 无效' }); }
        }
        const sourceUrl = payload.source ?? process.env.SOURCE_URL ?? 'http://127.0.0.1:4200';
        let parsed;
        try { parsed = new URL(sourceUrl); }
        catch { return reply(422, { error: `来源地址无效：${sourceUrl}` }); }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return reply(422, { error: '仅允许 http/https 来源' });
        if (payload.files !== undefined && !Array.isArray(payload.files)) return reply(422, { error: 'files 必须是路径数组' });
        const jobKey = `${parsed.origin}#${JSON.stringify(payload.files ?? [])}`;
        if (activeJobs.has(jobKey)) return reply(409, { error: '同一来源与选择的领取任务正在进行', jobKey });
        const job = runCollection(payload, sourceUrl)
          .then(summary => ({ ok: true, summary }), error => ({ ok: false, error }))
          .finally(() => activeJobs.delete(jobKey));
        activeJobs.set(jobKey, true);
        const outcome = await job;
        if (outcome.ok) return reply(201, outcome.summary);
        return reply(errorStatus(outcome.error), { error: outcome.error.message, type: outcome.error.name, missing: outcome.error.missing });
      }
      if (incoming.method === 'POST' && incoming.url === '/api/manual') {
        const chunks = []; let length = 0;
        for await (const chunk of incoming) { length += chunk.length; if (length > 1048576) return reply(413, { error: '单份人工收件过大' }); chunks.push(chunk); }
        let payload; try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return reply(400, { error: 'JSON 无效' }); }
        try { return reply(201, await receiveManual(archive, payload)); } catch (error) { return reply(422, { error: error.message }); }
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
