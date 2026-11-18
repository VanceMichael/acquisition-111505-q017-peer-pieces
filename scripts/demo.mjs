import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createIntake } from '../src/server.mjs';
import { createProvider } from '../provider/server.mjs';

// 演示用内存来源：与 docs/source-contract.md 同形，可切换损坏/旧包情景，且授权 hall-a、hall-b 两个展厅。
const RAW = Buffer.from('AAAAABBBBBCCCCC');
const PIECE_LENGTH = 8;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const MANIFEST_ID = 'tour-1';
function demoDistribution() {
  return {
    manifestId: MANIFEST_ID, pieceLength: PIECE_LENGTH,
    pieces: [hash(RAW.subarray(0, 8)), hash(RAW.subarray(8))],
    files: [
      { path: 'hall-a/intro.txt', offset: 0, length: 5 },
      { path: 'hall-b/intro.txt', offset: 5, length: 5 },
      { path: 'hall-c/intro.txt', offset: 10, length: 5 },
    ],
    authorizedFiles: ['hall-a/intro.txt', 'hall-b/intro.txt'],
  };
}
function demoPeerSource(scenario) {
  return {
    id: 'demo-source',
    async getDistribution() { return demoDistribution(); },
    async listPeers() {
      return [
        { id: 'relay-a', href: 'http://demo.local/relay/a', manifestId: scenario.stale ? 'tour-0' : MANIFEST_ID, availablePieces: [0, 1] },
        { id: 'relay-b', href: 'http://demo.local/relay/b', manifestId: MANIFEST_ID, availablePieces: [0, 1] },
      ];
    },
    async fetchPiece(peer, index) {
      const end = Math.min((index + 1) * PIECE_LENGTH, RAW.length);
      let bytes = Buffer.from(RAW.subarray(index * PIECE_LENGTH, end));
      if (scenario.corrupt && peer.id === 'relay-a') { bytes = Buffer.from(bytes); bytes[0] ^= 1; }
      const headerManifest = scenario.stale && peer.id === 'relay-a' ? 'tour-0' : MANIFEST_ID;
      return { status: 200, headers: { 'x-manifest-id': headerManifest }, bytes };
    },
  };
}

const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
let intake;
try {
  // 真实本地来源只用于展示探针形态；自动领取走下面的内存来源。
  const provider = createProvider();
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const probe = await (await fetch(`http://127.0.0.1:${provider.address().port}/distribution`)).json();
  console.log(JSON.stringify({ 来源探针: probe.manifestId, 授权文件: probe.authorizedFiles }));
  provider.closeAllConnections();
  await new Promise(resolve => provider.close(resolve));

  const scenario = { stale: false, corrupt: false };
  intake = await createIntake(directory, { peerSourceFactory: () => demoPeerSource(scenario) });
  intake.listen(0, '127.0.0.1');
  await once(intake, 'listening');
  const base = `http://127.0.0.1:${intake.address().port}`;

  // 情景一：本馆只领取自己负责的 hall-a 展厅文件（共享片按整片验证后只切自己的区间）
  const first = await fetch(base + '/api/collect', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ selected: ['hall-a/intro.txt'] }),
  });
  const firstBody = await first.json();
  console.log(JSON.stringify({ 首次领取: firstBody.status, 完成文件: firstBody.result.completedFiles, 所需片: firstBody.result.requiredPieces, 新领片: firstBody.result.fetchedPieces }));

  // 情景二：中继 A 给出损坏片，领取横跨两片的 hall-b 时自动切换到中继 B
  scenario.corrupt = true;
  const second = await fetch(base + '/api/collect', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ selected: ['hall-b/intro.txt'] }),
  });
  const secondBody = await second.json();
  console.log(JSON.stringify({ 损坏切换: secondBody.status, 完成文件: secondBody.result.completedFiles, 共享片复用: secondBody.result.reusedPieces, 新领片: secondBody.result.fetchedPieces }));

  // 情景三：中继 A 换成旧分发版本；全新归档的收件端在 /peers 阶段即剔除它
  scenario.corrupt = false; scenario.stale = true;
  const staleDirectory = await mkdtemp(join(tmpdir(), 'intake-stale-'));
  const staleIntake = await createIntake(staleDirectory, { peerSourceFactory: () => demoPeerSource(scenario) });
  staleIntake.listen(0, '127.0.0.1');
  await once(staleIntake, 'listening');
  try {
    const staleBase = `http://127.0.0.1:${staleIntake.address().port}`;
    const staleRun = await fetch(staleBase + '/api/collect', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selected: ['hall-a/intro.txt'] }),
    });
    const staleBody = await staleRun.json();
    const staleRecords = await (await fetch(staleBase + '/api/collect/records?manifestId=tour-1')).json();
    console.log(JSON.stringify({ 旧包剔除: staleBody.status, 完成文件: staleBody.result.completedFiles, 剔除留痕: staleRecords.events.some(e => e.kind === 'relay-excluded' && e.relayId === 'relay-a') }));
  } finally {
    staleIntake.closeAllConnections();
    await new Promise(resolve => staleIntake.close(resolve));
    await rm(staleDirectory, { recursive: true, force: true });
  }

  // 验证记录：损坏拒绝、成功来源、完成登记全部留痕
  const records = await (await fetch(base + '/api/collect/records?manifestId=tour-1')).json();
  const tally = records.events.reduce((acc, event) => { acc[event.kind] = (acc[event.kind] || 0) + 1; return acc; }, {});
  console.log(JSON.stringify({ 验证记录分类: tally }));

  // 情景四：重启后核对片库，零网络重复领取，迟到回包不会覆盖已确认片
  scenario.stale = false;
  const again = await fetch(base + '/api/collect', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ selected: ['hall-a/intro.txt', 'hall-b/intro.txt'] }),
  });
  const againBody = await again.json();
  console.log(JSON.stringify({ 重启核对: againBody.status, 新领片: againBody.result.fetchedPieces, 复用片: againBody.result.reusedPieces, 完成文件: againBody.result.completedFiles }));

  const sample = JSON.parse(await readFile(new URL('../fixtures/manual.json', import.meta.url), 'utf8'));
  const accepted = await fetch(base + '/api/manual', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sample) });
  console.log(JSON.stringify({ 人工收件仍可用: accepted.status }));
  console.log(JSON.stringify({ 已存人工记录: (await (await fetch(base + '/api/records')).json()).length }));
} finally {
  if (intake) {
    intake.closeAllConnections();
    await new Promise(resolve => intake.close(resolve));
  }
  await rm(directory, { recursive: true, force: true });
}
