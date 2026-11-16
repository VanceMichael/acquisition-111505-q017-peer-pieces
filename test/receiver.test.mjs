import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { Archive } from '../src/archive.mjs';
import { Receiver } from '../src/receiver.mjs';
import { CollectionStore } from '../src/collection-store.mjs';
import { PieceUnavailableError, VersionMismatchError, AuthorizationError } from '../src/errors.mjs';
import { buildManifest, FakeSource, sampleSpecs } from './helpers.mjs';

async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), 'receiver-'));
  const archive = await new Archive(join(directory, 'archive')).initialize();
  const root = join(directory, 'collections');
  return { directory, archive, root, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

const readJournal = async root => {
  const dir = (await readdir(root))[0];
  return readFileSync(join(root, dir, 'verification.log'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
};
const readState = async root => {
  const dir = (await readdir(root))[0];
  return JSON.parse(await readFile(join(root, dir, 'state.json'), 'utf8'));
};

test('跨文件边界片整片校验后切分，未选文件不会被登记接收', async context => {
  const { manifest, raw } = buildManifest({ pieceLength: 8, files: sampleSpecs() });
  const env = await workspace(); context.after(env.cleanup);
  const source = new FakeSource(manifest, raw);
  const receiver = new Receiver(source, env.archive, env.root, { concurrency: 1, cooldownMs: 10 });

  const summary = await receiver.collect({ files: ['hall-a/intro.txt'] });
  assert.deepEqual(summary.neededPieces, [0, 1]);
  const output = await readFile(join(summary.outputDirectory, 'hall-a/intro.txt'));
  assert.equal(output.toString(), 'AAAAABBBBB');
  // 未选中的 hall-b/hall-c 没有输出目录条目，也没有自动收件登记
  assert.rejects(readFile(join(summary.outputDirectory, 'hall-b/intro.txt')), /ENOENT/);
  const receipts = await env.archive.list();
  const auto = receipts.filter(record => record.versions.some(version => version.data?.path));
  assert.equal(auto.length, 1);
  assert.equal(auto[0].identity.path, 'hall-a/intro.txt');
  assert.equal(auto[0].identity.manifest, 'tour-1');
});

test('损坏片切换来源成功，保留逐次验证记录', async context => {
  const { manifest, raw } = buildManifest({ pieceLength: 8, files: sampleSpecs() });
  const env = await workspace(); context.after(env.cleanup);
  const source = new FakeSource(manifest, raw, {
    peers: [
      { id: 'relay-a', href: '/relay/a', manifestId: 'tour-1', availablePieces: [0, 1, 2, 3] },
      { id: 'relay-b', href: '/relay/b', manifestId: 'tour-1', availablePieces: [0, 1, 2, 3] },
    ],
    peerOverrides: { 'relay-a': { 0: { corrupt: true }, 1: { corrupt: true } } },
  });
  const receiver = new Receiver(source, env.archive, env.root, { concurrency: 1, cooldownMs: 50 });
  const summary = await receiver.collect({ files: ['hall-a/intro.txt'] });

  // relay-a 在片 0 哈希失败后进入冷却，片 1 直接切换到 relay-b：故障被记录且不影响完成
  assert.ok(summary.hashFailures >= 1);
  assert.equal(summary.fetched, 2);
  const journal = await readJournal(env.root);
  assert.ok(journal.some(event => event.event === 'hash_mismatch' && event.peer === 'relay-a' && event.index === 0));
  assert.ok(journal.filter(event => event.event === 'piece_verified' && event.peer === 'relay-b').length >= 1);
  const state = await readState(env.root);
  assert.equal(state.verifiedPieces[0].via, 'relay-b');
});

test('旧清单版本的中继被拒绝，绝不混拼分发版本', async context => {
  const { manifest, raw } = buildManifest({ pieceLength: 8, files: sampleSpecs() });
  const env = await workspace(); context.after(env.cleanup);
  const source = new FakeSource(manifest, raw, {
    peers: [
      { id: 'relay-old', href: '/relay/old', manifestId: 'tour-0', availablePieces: [0, 1] },
      { id: 'relay-b', href: '/relay/b', manifestId: 'tour-1', availablePieces: [0, 1, 2, 3] },
    ],
    peerOverrides: { 'relay-old': { 0: { stale: true } } },
  });
  const receiver = new Receiver(source, env.archive, env.root, { concurrency: 1, cooldownMs: 10 });
  const summary = await receiver.collect({ files: ['hall-a/intro.txt'] });
  assert.equal(summary.staleRefusals, 1);
  assert.ok(summary.refusedPeers.some(peer => peer.peer === 'relay-old'));
  const journal = await readJournal(env.root);
  assert.ok(journal.some(event => event.event === 'peer_refused' && event.peer === 'relay-old'));
});

test('所有中继都给出损坏片时失败并保留完整验证轨迹', async context => {
  const { manifest, raw } = buildManifest({ pieceLength: 8, files: sampleSpecs() });
  const env = await workspace(); context.after(env.cleanup);
  const source = new FakeSource(manifest, raw, {
    peerOverrides: {
      'relay-a': { 0: { corrupt: true }, 1: { corrupt: true } },
      'relay-b': { 0: { corrupt: true }, 1: { corrupt: true } },
    },
  });
  const receiver = new Receiver(source, env.archive, env.root, { concurrency: 1, cooldownMs: 1 });
  await assert.rejects(receiver.collect({ files: ['hall-a/intro.txt'] }), error => {
    assert.ok(error instanceof PieceUnavailableError);
    assert.deepEqual([...error.missing].sort(), [0, 1]);
    return true;
  });
  const journal = await readJournal(env.root);
  assert.ok(journal.some(event => event.event === 'collect_incomplete'));
  assert.ok(journal.filter(event => event.event === 'hash_mismatch').length >= 2);
  // 失败不产生文件登记
  assert.deepEqual(await env.archive.list(), []);
});

test('重启后复用已校验片与已完成文件，不重新领取', async context => {
  const { manifest, raw } = buildManifest({ pieceLength: 8, files: sampleSpecs() });
  const env = await workspace(); context.after(env.cleanup);
  const source = new FakeSource(manifest, raw);
  const first = new Receiver(source, env.archive, env.root, { concurrency: 1, cooldownMs: 10 });
  const summary1 = await first.collect({ files: ['hall-a/intro.txt'] });
  assert.equal(summary1.fetched, 2);

  const source2 = new FakeSource(manifest, raw);
  const second = new Receiver(source2, env.archive, env.root, { concurrency: 1, cooldownMs: 10 });
  const summary2 = await second.collect({ files: ['hall-a/intro.txt'] });
  assert.deepEqual(summary2.alreadyVerified, [0, 1]);
  assert.equal(summary2.fetched, 0);
  assert.equal(source2.calls.length, 0); // 清单探查之外没有任何分片请求
  const state = await readState(env.root);
  assert.equal(state.completedFiles['hall-a/intro.txt'].sha256, summary1.completedFiles[0].sha256);
});

test('迟到回包不会覆盖已确认的正确片', async context => {
  const { manifest, raw } = buildManifest({ pieceLength: 8, files: sampleSpecs() });
  const env = await workspace(); context.after(env.cleanup);
  // relay-a 慢到超时（id 排序靠前会先被尝试）；relay-b 立即返回正确片
  const source = new FakeSource(manifest, raw, {
    peers: [
      { id: 'relay-a-slow', href: '/relay/a', manifestId: 'tour-1', availablePieces: [0, 1, 2, 3] },
      { id: 'relay-b-fast', href: '/relay/b', manifestId: 'tour-1', availablePieces: [0, 1, 2, 3] },
    ],
    peerOverrides: { 'relay-a-slow': { 0: { delay: 80 }, 1: { delay: 80 } } },
  });
  const receiver = new Receiver(source, env.archive, env.root, { concurrency: 1, timeout: 25, cooldownMs: 1 });
  const summary = await receiver.collect({ files: ['hall-a/intro.txt'] });
  const state = await readState(env.root);
  assert.equal(state.verifiedPieces[0].via, 'relay-b-fast');
  await new Promise(resolve => setTimeout(resolve, 120)); // 等待迟到回包落地后被丢弃
  const journal = await readJournal(env.root);
  assert.ok(journal.some(event => event.event === 'late_reply_discarded' && event.peer === 'relay-a-slow'));
  const stateAfter = await readState(env.root);
  assert.equal(stateAfter.verifiedPieces[0].via, 'relay-b-fast'); // 未被迟到回包改写
  assert.equal((await readFile(join(summary.outputDirectory, 'hall-a/intro.txt'))).toString(), 'AAAAABBBBB');
});

test('状态目录锁定不同分发版本时直接拒绝', async context => {
  const { manifest, raw } = buildManifest({ manifestId: 'tour-1', pieceLength: 8, files: sampleSpecs() });
  const env = await workspace(); context.after(env.cleanup);
  const receiver1 = new Receiver(new FakeSource(manifest, raw), env.archive, env.root, { concurrency: 1 });
  await receiver1.collect({ files: ['hall-a/intro.txt'] });

  // 同一锁定目录收到不同 manifestId 的清单：规范摘要核对拒绝混拼
  const other = buildManifest({ manifestId: 'tour-2', pieceLength: 8, files: sampleSpecs().map(spec => ({ ...spec, bytes: Buffer.concat([spec.bytes, Buffer.from('X')]) })) });
  const lockedStore = new CollectionStore(env.root, 'tour-1');
  await lockedStore.initialize();
  await assert.rejects(lockedStore.lockManifest(other.manifest), VersionMismatchError);

  // 端到端：不同版本落在各自隔离目录，tour-2 无法读取 tour-1 的任何分片
  const receiver2 = new Receiver(new FakeSource(other.manifest, other.raw), env.archive, env.root, { concurrency: 1 });
  const summary2 = await receiver2.collect({ files: ['hall-a/intro.txt'] });
  assert.equal(summary2.manifestId, 'tour-2');
  assert.deepEqual(summary2.recoveredPieces, []);
});

test('同 manifestId 但内容不同的清单按规范摘要拦截', async context => {
  const { manifest, raw } = buildManifest({ manifestId: 'tour-1', pieceLength: 8, files: sampleSpecs() });
  const env = await workspace(); context.after(env.cleanup);
  await new Receiver(new FakeSource(manifest, raw), env.archive, env.root, { concurrency: 1 }).collect({ files: ['hall-a/intro.txt'] });
  const tampered = structuredClone(manifest);
  tampered.pieces[0] = 'a'.repeat(64);
  await assert.rejects(new Receiver(new FakeSource(tampered, raw), env.archive, env.root, { concurrency: 1 }).collect({}), VersionMismatchError);
});

test('片长度异常被拒绝并切换来源，按文件大小截断无法蒙混', async context => {
  const { manifest, raw } = buildManifest({ pieceLength: 8, files: sampleSpecs() });
  const env = await workspace(); context.after(env.cleanup);
  const source = new FakeSource(manifest, raw, {
    peerOverrides: { 'relay-a': { 0: { truncate: true } } },
  });
  const receiver = new Receiver(source, env.archive, env.root, { concurrency: 1, cooldownMs: 10 });
  const summary = await receiver.collect({ files: ['hall-a/intro.txt'] });
  assert.equal(summary.sourceFailures, 1);
  assert.equal(summary.fetched, 2);
  const journal = await readJournal(env.root);
  assert.ok(journal.some(event => event.event === 'piece_length_mismatch' && event.peer === 'relay-a'));
  const output = await readFile(join(summary.outputDirectory, 'hall-a/intro.txt'));
  assert.equal(output.toString(), 'AAAAABBBBB'); // 由 relay-b 的完整片重组，未被截断
});

test('选择非授权文件被拒绝', async context => {
  const { manifest, raw } = buildManifest({ pieceLength: 8, files: sampleSpecs() });
  manifest.authorizedFiles = ['hall-a/intro.txt'];
  const env = await workspace(); context.after(env.cleanup);
  const receiver = new Receiver(new FakeSource(manifest, raw), env.archive, env.root, { concurrency: 1 });
  await assert.rejects(receiver.collect({ files: ['hall-b/intro.txt'] }), AuthorizationError);
});

test('磁盘片被篡改后重启会隔离并重新领取', async context => {
  const { manifest, raw } = buildManifest({ pieceLength: 8, files: sampleSpecs() });
  const env = await workspace(); context.after(env.cleanup);
  await new Receiver(new FakeSource(manifest, raw), env.archive, env.root, { concurrency: 1 }).collect({ files: ['hall-a/intro.txt'] });
  const dir = (await readdir(env.root))[0];
  const pieceFiles = await readdir(join(env.root, dir, 'pieces'));
  const target = join(env.root, dir, 'pieces', pieceFiles[0]);
  const corrupted = await readFile(target);
  corrupted[0] ^= 0x01;
  await import('node:fs/promises').then(fs => fs.writeFile(target, corrupted));

  const receiver = new Receiver(new FakeSource(manifest, raw), env.archive, env.root, { concurrency: 1 });
  const summary = await receiver.collect({ files: ['hall-a/intro.txt'] });
  assert.ok(summary.quarantinedPieces.includes(0));
  assert.equal(summary.fetched, 1);
  const journal = await readJournal(env.root);
  assert.ok(journal.some(event => event.event === 'piece_quarantined' && event.index === 0));
});
