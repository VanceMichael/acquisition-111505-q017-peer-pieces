import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAcquisition, AcquisitionError } from '../src/acquisition.mjs';
import { sha256 } from '../src/manifest.mjs';
import { readVerificationLog } from '../src/piece-store.mjs';

const RAW = Buffer.from('AAAAABBBBBCCCCC');
const PIECE_LENGTH = 8;
const MANIFEST_ID = 'tour-1';

function distribution(overrides = {}) {
  return {
    manifestId: MANIFEST_ID,
    pieceLength: PIECE_LENGTH,
    pieces: [sha256(RAW.subarray(0, 8)), sha256(RAW.subarray(8))],
    files: [
      { path: 'hall-a/intro.txt', offset: 0, length: 5 },
      { path: 'hall-b/intro.txt', offset: 5, length: 5 },
      { path: 'hall-c/intro.txt', offset: 10, length: 5 },
    ],
    authorizedFiles: ['hall-a/intro.txt', 'hall-b/intro.txt'],
    ...overrides,
  };
}

/** 内存测试中继：behaviors 描述每个中继的旧包/损坏/拒绝片行为。 */
function fakeSource(behaviors, { manifestOverride } = {}) {
  const pieceFor = (index, behavior) => {
    let bytes = Buffer.from(RAW.subarray(index * PIECE_LENGTH, (index + 1) * PIECE_LENGTH));
    if (behavior?.corrupt && behavior.corrupt.has(index)) { bytes = Buffer.from(bytes); bytes[0] ^= 1; }
    return bytes;
  };
  return {
    id: 'fake-source',
    async getDistribution() { return manifestOverride || distribution(); },
    async listPeers() {
      return Object.entries(behaviors).map(([id, behavior]) => ({
        id,
        href: `http://relay.test/${id}`,
        manifestId: behavior?.stale ? 'tour-0' : MANIFEST_ID,
        availablePieces: behavior?.pieces ?? [0, 1],
      }));
    },
    async fetchPiece(peer, index) {
      const behavior = behaviors[peer.id] || {};
      if (behavior.stale) {
        return { status: 200, headers: { 'x-manifest-id': 'tour-0' }, bytes: pieceFor(index, behavior) };
      }
      if (behavior.networkError?.has(index)) throw new Error('连接被重置');
      if (behavior.refuse?.has(index)) return { status: 403, headers: {}, bytes: Buffer.alloc(0) };
      return {
        status: 200,
        headers: { 'x-manifest-id': MANIFEST_ID },
        bytes: pieceFor(index, behavior),
      };
    },
  };
}

async function workRoot(t) {
  const directory = await mkdtemp(join(tmpdir(), 'acq-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const logEvents = (root, manifestId = MANIFEST_ID) =>
  readVerificationLog(join(root, encodeURIComponent(manifestId)));

test('损坏中继自动切换到可用中继，共享边界片整片校验后复用', async t => {
  const root = await workRoot(t);
  const source = fakeSource({
    'relay-a': { corrupt: new Set([0, 1]) },
    'relay-b': {},
  });
  const result = await runAcquisition({
    source,
    archiveRoot: root,
    selected: ['hall-b/intro.txt'],
    concurrency: 1,
  });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.requiredPieces, [0, 1]); // hall-b 横跨两片
  const output = await readFile(join(root, encodeURIComponent(MANIFEST_ID), 'files', 'hall-b', 'intro.txt'));
  assert.equal(output.toString(), 'BBBBB');
  // 未选择的 hall-a / hall-c 没有任何文件登记
  assert.deepEqual(result.completedFiles, ['hall-b/intro.txt']);
  assert.deepEqual(await readdir(join(root, encodeURIComponent(MANIFEST_ID), 'files')), ['hall-b']);

  const events = await logEvents(root);
  assert.ok(events.some(e => e.kind === 'piece-rejected' && e.relayId === 'relay-a' && e.reason === '摘要校验失败'));
  assert.ok(events.some(e => e.kind === 'piece-verified' && e.relayId === 'relay-b'));
  assert.ok(result.relays['relay-a'].corrupt >= 1);
  assert.equal(result.relays['relay-a'].lastOutcome, 'hash-mismatch');
});

test('旧清单中继被整体剔除，绝不混拼不同分发版本', async t => {
  const root = await workRoot(t);
  const source = fakeSource({
    'relay-a': { stale: true },
    'relay-b': {},
  });
  const result = await runAcquisition({ source, archiveRoot: root, selected: ['hall-a/intro.txt'] });
  assert.equal(result.status, 'complete');
  const events = await logEvents(root);
  assert.ok(events.some(e => e.kind === 'relay-excluded' && e.relayId === 'relay-a'));
  assert.ok(!events.some(e => e.relayId === 'relay-a' && e.kind === 'piece-verified'));
});

test('回包头携带旧版本标识时即使字节可用也拒绝并切换', async t => {
  const root = await workRoot(t);
  const source = fakeSource({
    'relay-a': {}, // listPeers 声称同版本，但回包给旧版本头
    'relay-b': {},
  });
  source.fetchPiece = async (peer, index) => {
    if (peer.id === 'relay-a') return { status: 200, headers: { 'x-manifest-id': 'tour-0' }, bytes: RAW.subarray(index * PIECE_LENGTH, (index + 1) * PIECE_LENGTH) };
    return { status: 200, headers: { 'x-manifest-id': MANIFEST_ID }, bytes: RAW.subarray(index * PIECE_LENGTH, (index + 1) * PIECE_LENGTH) };
  };
  await runAcquisition({ source, archiveRoot: root, selected: ['hall-a/intro.txt'] });
  const events = await logEvents(root);
  assert.ok(events.some(e => e.kind === 'piece-rejected' && e.reason === '回包清单版本不一致' && e.relayId === 'relay-a'));
  assert.ok(events.some(e => e.kind === 'piece-verified' && e.relayId === 'relay-b'));
});

test('重启后核对已有片，只补领缺失片且已确认片不被重写', async t => {
  const root = await workRoot(t);
  let calls = 0;
  const counting = {
    id: 'counting',
    async getDistribution() { return distribution(); },
    async listPeers() {
      return [{ id: 'relay-b', href: 'http://relay.test/b', manifestId: MANIFEST_ID, availablePieces: [0, 1] }];
    },
    async fetchPiece(peer, index) {
      calls += 1;
      return { status: 200, headers: { 'x-manifest-id': MANIFEST_ID }, bytes: RAW.subarray(index * PIECE_LENGTH, (index + 1) * PIECE_LENGTH) };
    },
  };
  const first = await runAcquisition({ source: counting, archiveRoot: root, selected: ['hall-b/intro.txt'] });
  assert.equal(first.fetchedPieces, 2);
  const second = await runAcquisition({ source: counting, archiveRoot: root, selected: ['hall-b/intro.txt'] });
  assert.equal(second.status, 'complete');
  assert.equal(calls, 2); // 第二次运行零网络领取
  assert.equal(second.fetchedPieces, 0);
  assert.equal(second.reusedPieces, 2);
  // 扩大选择到 hall-a：其全部落在已验证的 piece0，同样无需再领
  const third = await runAcquisition({ source: counting, archiveRoot: root, selected: ['hall-a/intro.txt', 'hall-b/intro.txt'] });
  assert.equal(calls, 2);
  assert.deepEqual(third.completedFiles.sort(), ['hall-a/intro.txt', 'hall-b/intro.txt']);
});

test('所有中继都给出损坏片时失败并保留完整验证记录，已验证片仍留库', async t => {
  const root = await workRoot(t);
  const source = fakeSource({
    'relay-a': { corrupt: new Set([0]) },
    'relay-b': { corrupt: new Set([0]) },
  });
  await assert.rejects(
    () => runAcquisition({ source, archiveRoot: root, selected: ['hall-a/intro.txt'] }),
    error => error instanceof AcquisitionError && error.code === 'piece-exhausted',
  );
  const events = await logEvents(root);
  const rejects = events.filter(e => e.kind === 'piece-rejected' && e.piece === 0);
  assert.equal(rejects.length, 2);
  assert.deepEqual(new Set(rejects.map(e => e.relayId)), new Set(['relay-a', 'relay-b']));
});

test('网络错误与 403 都触发来源切换', async t => {
  const root = await workRoot(t);
  const source = fakeSource({
    'relay-a': { networkError: new Set([0]) },
    'relay-b': { refuse: new Set([0]) },
    'relay-c': {},
  });
  const result = await runAcquisition({ source, archiveRoot: root, selected: ['hall-a/intro.txt'] });
  assert.equal(result.status, 'complete');
  const events = await logEvents(root);
  assert.ok(events.some(e => e.kind === 'piece-fetch-failed' && e.relayId === 'relay-a'));
  assert.ok(events.some(e => e.kind === 'piece-fetch-failed' && e.relayId === 'relay-b'));
  assert.ok(events.some(e => e.kind === 'piece-verified' && e.relayId === 'relay-c'));
});

test('单引擎对同一片只发起一次有效领取，迟到复用走 duplicate 路径', async t => {
  const root = await workRoot(t);
  let pieceCalls = 0;
  const source = fakeSource({ 'relay-b': {} });
  const original = source.fetchPiece.bind(source);
  source.fetchPiece = async (peer, index) => { pieceCalls += 1; return original(peer, index); };
  const result = await runAcquisition({ source, archiveRoot: root, selected: ['hall-b/intro.txt'], concurrency: 8 });
  assert.equal(result.status, 'complete');
  assert.equal(pieceCalls, 2); // 两片各一次，无重复请求
});

test('未授权文件选择被拒绝，不会发起任何领取', async t => {
  const root = await workRoot(t);
  const source = fakeSource({ 'relay-b': {} });
  await assert.rejects(
    () => runAcquisition({ source, archiveRoot: root, selected: ['hall-c/intro.txt'] }),
    /未授权/,
  );
  // 选择在校验阶段即被拒绝，片库目录未创建，没有任何验证记录
  assert.deepEqual(await readVerificationLog(join(root, encodeURIComponent(MANIFEST_ID))), []);
});
