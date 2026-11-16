import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createIntake } from '../src/server.mjs';
import { createProvider } from '../provider/server.mjs';
import { createHttpSource } from '../src/source-client.mjs';
import { Archive } from '../src/archive.mjs';
import { Receiver } from '../src/receiver.mjs';
import { buildManifest } from './helpers.mjs';

async function listen(service) {
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  return `http://127.0.0.1:${service.address().port}`;
}
const shutdown = async (...services) => {
  for (const service of services) service.closeAllConnections();
  await Promise.all(services.map(service => new Promise(resolve => service.close(resolve))));
};

test('真实 HTTP 来源：按授权选择领取并切出跨边界文件', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'http-collect-'));
  const intake = await createIntake(directory);
  const provider = createProvider();
  context.after(async () => { await shutdown(intake, provider); await rm(directory, { recursive: true, force: true }); });
  const base = await listen(intake);
  const source = await listen(provider);

  const response = await fetch(base + '/api/collect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source }),
  });
  assert.equal(response.status, 201);
  const summary = await response.json();
  assert.equal(summary.manifestId, 'tour-1');
  assert.deepEqual(summary.selection, ['hall-a/intro.txt']);
  const output = await readFile(join(directory, 'collections', 'tour-1', 'output', 'hall-a/intro.txt'));
  assert.equal(output.toString(), 'AAAAA');

  // 自动收件进入同一归档体系，身份为 manifest+path，与人工来源分开
  const records = await (await fetch(base + '/api/records')).json();
  const auto = records.find(record => record.identity?.manifest === 'tour-1');
  assert.equal(auto.identity.path, 'hall-a/intro.txt');
  assert.equal(auto.versions[0].data.sha256, createHash('sha256').update(output).digest('hex'));
  assert.ok(records.every(record => record.identity.manifest !== undefined || record.identity.path !== undefined));

  const collections = await (await fetch(base + '/api/collections')).json();
  assert.deepEqual(collections.collections, ['tour-1']);
  assert.equal((await fetch(base + '/health')).status, 200);
});

test('真实来源的损坏与旧包情景：切换中继并记录验证', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'http-collect-'));
  const intake = await createIntake(directory);
  const provider = createProvider();
  context.after(async () => { await shutdown(intake, provider); await rm(directory, { recursive: true, force: true }); });
  const base = await listen(intake);
  const source = await listen(provider);
  await fetch(source + '/__control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stale: true, corrupt: true }) });

  const response = await fetch(base + '/api/collect', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source }),
  });
  assert.equal(response.status, 201);
  const summary = await response.json();
  // relay-a 版本旧且片损坏：被版本过滤/哈希拒绝后由 relay-b 完成
  assert.ok(summary.staleRefusals >= 1 || summary.hashFailures >= 1);
  assert.equal(summary.completedFiles[0].path, 'hall-a/intro.txt');
});

test('来源不可达返回 502 且不产生登记', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'http-collect-'));
  const intake = await createIntake(directory);
  context.after(async () => { await shutdown(intake); await rm(directory, { recursive: true, force: true }); });
  const base = await listen(intake);
  const response = await fetch(base + '/api/collect', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'http://127.0.0.1:9' }),
  });
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.ok(['SourceUnavailableError', 'PieceUnavailableError'].includes(body.type));
  assert.deepEqual(await (await fetch(base + '/api/records')).json(), []);
});

test('本地多文件授权源：403 授权边界外的片不会被绕过', async context => {
  const { manifest, raw } = buildManifest({
    pieceLength: 8,
    files: [
      { path: 'hall-a/intro.txt', bytes: Buffer.from('AAAAABBBBB') },
      { path: 'hall-b/intro.txt', bytes: Buffer.from('CCCCCddddd') },
    ],
  });
  // 来源只授权 hall-a：片 0 相交可发，片 1 完全位于授权外时拒绝
  manifest.authorizedFiles = ['hall-a/intro.txt'];
  const authorizedPiece = 0;
  const sourceService = createServer((incoming, outgoing) => {
    const url = new URL(incoming.url, 'http://localhost');
    const sendJson = payload => { outgoing.writeHead(200, { 'content-type': 'application/json' }); outgoing.end(JSON.stringify(payload)); };
    if (url.pathname === '/distribution') return sendJson(manifest);
    if (url.pathname === '/peers') return sendJson([
      { id: 'relay-a', href: '/relay/a', manifestId: manifest.manifestId, availablePieces: [0, 1] },
    ]);
    const match = url.pathname.match(/^\/relay\/a\/piece\/(\d+)$/);
    if (match) {
      const index = Number(match[1]);
      if (index !== authorizedPiece) { outgoing.writeHead(403, { 'content-type': 'application/json' }); return outgoing.end(JSON.stringify({ error: '不与获准文件相交' })); }
      const start = index * manifest.pieceLength;
      outgoing.writeHead(200, { 'content-type': 'application/octet-stream', 'x-manifest-id': manifest.manifestId });
      return outgoing.end(raw.subarray(start, Math.min(start + manifest.pieceLength, raw.length)));
    }
    outgoing.writeHead(404); outgoing.end();
  });
  const directory = await mkdtemp(join(tmpdir(), 'http-collect-'));
  context.after(async () => { sourceService.closeAllConnections(); await new Promise(resolve => sourceService.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const source = await listen(sourceService);

  const archive = await new Archive(join(directory, 'archive')).initialize();
  const receiver = new Receiver(createHttpSource(source, { timeout: 2000 }), archive, join(directory, 'collections'), { concurrency: 1, timeout: 2000, cooldownMs: 10 });
  // hall-a 长度 10 需要片 0、1；片 1 被授权拦截 -> 明确失败，而不是拿半截内容冒充完成
  await assert.rejects(receiver.collect({ files: ['hall-a/intro.txt'] }), /无法从任何中继验证通过/);
});

test('相同来源与选择的并发任务返回 409', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'http-collect-'));
  const intake = await createIntake(directory);
  const provider = createProvider();
  context.after(async () => { await shutdown(intake, provider); await rm(directory, { recursive: true, force: true }); });
  const base = await listen(intake);
  const source = await listen(provider);
  const body = JSON.stringify({ source });
  const [first, second] = await Promise.all([
    fetch(base + '/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body }),
    fetch(base + '/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body }),
  ]);
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [201, 409]);
});
