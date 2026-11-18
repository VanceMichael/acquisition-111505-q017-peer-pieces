import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createProvider } from '../provider/server.mjs';
import { createIntake } from '../src/server.mjs';
import { createHttpPeerSource } from '../src/relay-client.mjs';

async function withStack(t) {
  const directory = await mkdtemp(join(tmpdir(), 'collect-'));
  const provider = createProvider();
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const sourceBase = `http://127.0.0.1:${provider.address().port}`;
  const intake = await createIntake(directory, { peerSourceFactory: () => createHttpPeerSource(sourceBase) });
  intake.listen(0, '127.0.0.1');
  await once(intake, 'listening');
  t.after(async () => {
    provider.closeAllConnections(); intake.closeAllConnections();
    await Promise.all([new Promise(resolve => provider.close(resolve)), new Promise(resolve => intake.close(resolve))]);
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${intake.address().port}`;
  const control = value => fetch(sourceBase + '/__control', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
  });
  return { base, sourceBase, control, directory };
}

test('端到端：按授权清单只领取本馆文件，共享片切开后未选文件不登记', async t => {
  const { base } = await withStack(t);
  const response = await fetch(base + '/api/collect', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ selected: ['hall-a/intro.txt'] }),
  });
  assert.equal(response.status, 202);
  const outcome = await response.json();
  assert.equal(outcome.status, 'complete');
  assert.deepEqual(outcome.result.completedFiles, ['hall-a/intro.txt']);
  assert.deepEqual(outcome.result.requiredPieces, [0]);

  const manifest = await (await fetch(base + '/api/collect/records?manifestId=tour-1')).json();
  const kinds = manifest.events.map(e => e.kind);
  assert.ok(kinds.includes('piece-verified'));
  assert.ok(kinds.includes('file-completed'));
  // 没有任何未选文件的完成登记
  assert.ok(!manifest.events.some(e => e.kind === 'file-completed' && e.file !== 'hall-a/intro.txt'));
});

test('端到端：旧包与损坏片情景下自动切换中继并留下验证记录', async t => {
  const { base, control } = await withStack(t);
  await control({ stale: true, corrupt: true });
  const response = await fetch(base + '/api/collect', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ selected: ['hall-a/intro.txt'] }),
  });
  assert.equal(response.status, 202);
  const outcome = await response.json();
  assert.equal(outcome.status, 'complete');
  const manifest = await (await fetch(base + '/api/collect/records?manifestId=tour-1')).json();
  assert.ok(manifest.events.some(e => e.kind === 'relay-excluded' && e.relayId === 'relay-a'));
  assert.ok(manifest.events.some(e => e.kind === 'piece-verified' && e.relayId === 'relay-b'));
  assert.ok(!manifest.events.some(e => e.relayId === 'relay-a' && e.kind === 'piece-verified'));
});

test('端到端：重启收件端后核对片库，重复领取零网络且状态可查', async t => {
  const stack = await withStack(t);
  const first = await fetch(stack.base + '/api/collect', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ selected: ['hall-a/intro.txt'] }),
  });
  assert.equal(first.status, 202);

  // 用同一归档目录重新创建收件端，模拟进程重启
  const restarted = await createIntake(stack.directory, { peerSourceFactory: () => createHttpPeerSource(stack.sourceBase) });
  restarted.listen(0, '127.0.0.1');
  await once(restarted, 'listening');
  t.after(() => new Promise(resolve => restarted.close(resolve)));
  const base2 = `http://127.0.0.1:${restarted.address().port}`;

  const again = await fetch(base2 + '/api/collect', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ selected: ['hall-a/intro.txt'] }),
  });
  const outcome = await again.json();
  assert.equal(outcome.status, 'complete');
  assert.equal(outcome.result.fetchedPieces, 0);
  assert.equal(outcome.result.reusedPieces, 1);

  const output = await readFile(join(stack.directory, 'distributions', encodeURIComponent('tour-1'), 'files', 'hall-a', 'intro.txt'));
  assert.equal(output.toString(), 'AAAAA');
  const status = await (await fetch(base2 + '/api/collect/status')).json();
  assert.equal(status.running, false);
  assert.equal(status.lastRun.status, 'complete');
});

test('端到端：已有领取任务在途时返回 409', async t => {
  // 用一个永不返回的来源工厂卡住第一次领取
  const directory = await mkdtemp(join(tmpdir(), 'collect-409-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const intake = await createIntake(directory, {
    peerSourceFactory: () => ({
      id: 'slow',
      async getDistribution() { await gate; throw new Error('不应到达'); },
      async listPeers() { return []; },
      async fetchPiece() { throw new Error('不应到达'); },
    }),
  });
  intake.listen(0, '127.0.0.1');
  await once(intake, 'listening');
  t.after(async () => { release(); intake.closeAllConnections(); await new Promise(resolve => intake.close(resolve)); });
  const base = `http://127.0.0.1:${intake.address().port}`;
  const first = fetch(base + '/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await once(intake, 'request'); // 确保请求已进入处理
  const conflict = await fetch(base + '/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, '已有领取任务在进行中');
  release();
  await first;
});
