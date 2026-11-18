import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseManifest, sha256 } from '../src/manifest.mjs';
import { DistributionStore, readVerificationLog } from '../src/piece-store.mjs';

function manifest(overrides = {}) {
  const raw = Buffer.from('AAAAABBBBBCCCCC');
  const pieceLength = 8;
  return parseManifest({
    manifestId: 'tour-1',
    pieceLength,
    pieces: [sha256(raw.subarray(0, 8)), sha256(raw.subarray(8))],
    files: [
      { path: 'hall-a/intro.txt', offset: 0, length: 5 },
      { path: 'hall-b/intro.txt', offset: 5, length: 5 },
      { path: 'hall-c/intro.txt', offset: 10, length: 5 },
    ],
    authorizedFiles: ['hall-a/intro.txt', 'hall-b/intro.txt'],
    ...overrides,
  });
}

async function freshStore(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pieces-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, encodeURIComponent('tour-1'));
  const store = await DistributionStore.open(root, manifest());
  return { directory, root, store };
}

test('损坏片被拒绝且不落盘，验证记录保留实际摘要', async t => {
  const { store, root } = await freshStore(t);
  const good = Buffer.from('AAAAABBB');
  const bad = Buffer.from(good); bad[0] ^= 0xff;
  const rejected = await store.savePiece(0, bad, { relayId: 'relay-a' });
  assert.equal(rejected.accepted, false);
  assert.deepEqual(await readdir(join(root, 'pieces')), []);
  const accepted = await store.savePiece(0, good, { relayId: 'relay-b' });
  assert.equal(accepted.accepted, true);
  const events = await readVerificationLog(root);
  assert.ok(events.some(e => e.kind === 'piece-rejected' && e.reason === '摘要校验失败' && e.observed && e.relayId === 'relay-a'));
  assert.ok(events.some(e => e.kind === 'piece-verified' && e.relayId === 'relay-b'));
});

test('迟到回包不会覆盖已确认的正确片，只记复用', async t => {
  const { store, root } = await freshStore(t);
  const good = Buffer.from('AAAAABBB');
  await store.savePiece(0, good, { relayId: 'relay-b' });
  const another = Buffer.from(good); another[7] ^= 1;
  const late = await store.withPieceLock(0, () => store.savePiece(0, another, { relayId: 'relay-late' }));
  assert.equal(late.duplicate, true);
  const onDisk = await readFile(join(root, 'pieces', '0'));
  assert.deepEqual(onDisk, good);
  const events = await readVerificationLog(root);
  assert.ok(events.some(e => e.kind === 'piece-duplicate' && e.relayId === 'relay-late'));
  assert.ok(!events.some(e => e.kind === 'piece-rejected' && e.relayId === 'relay-late'));
});

test('重启后逐片复核：损坏片隔离、已登记文件重新验证', async t => {
  const { root } = await freshStore(t);
  const m = manifest();
  let store = await DistributionStore.open(root, m);
  await store.savePiece(0, Buffer.from('AAAAABBB'), { relayId: 'relay-b' });
  await store.savePiece(1, Buffer.from('BBCCCCC'), { relayId: 'relay-b' });
  await store.completeFile('hall-b/intro.txt');
  assert.deepEqual(store.snapshot().completedFiles, ['hall-b/intro.txt']);

  // 人为破坏磁盘上的 piece1，模拟重启后核对
  const piecePath = join(root, 'pieces', '1');
  const tampered = await readFile(piecePath); tampered[0] ^= 1;
  await writeFile(piecePath, tampered);

  store = await DistributionStore.open(root, m);
  assert.equal(store.hasPiece(0), true);
  assert.equal(store.hasPiece(1), false);
  assert.deepEqual(store.snapshot().completedFiles, []); // 依赖坏片的文件登记被撤销
  const events = await readVerificationLog(root);
  assert.ok(events.some(e => e.kind === 'quarantine' && e.piece === 1));
  assert.ok(events.some(e => e.kind === 'file-reset'));
});

test('片库与不同清单版本不兼容，禁止打开', async t => {
  const { root } = await freshStore(t);
  const other = manifest({ manifestId: 'tour-2' });
  await assert.rejects(() => DistributionStore.open(root, other), /清单版本不一致/);
});

test('完成文件只登记被选择的文件，未选文件不产生任何接收记录', async t => {
  const { store, root } = await freshStore(t);
  await store.savePiece(0, Buffer.from('AAAAABBB'), { relayId: 'relay-b' });
  await store.savePiece(1, Buffer.from('BBCCCCC'), { relayId: 'relay-b' });
  const result = await store.completeFile('hall-a/intro.txt');
  assert.equal(result.sha256, sha256(Buffer.from('AAAAA')));
  assert.deepEqual(store.snapshot().completedFiles, ['hall-a/intro.txt']);
  const output = await readFile(join(root, 'files', 'hall-a', 'intro.txt'));
  assert.equal(output.toString(), 'AAAAA');
  const events = await readVerificationLog(root);
  assert.ok(!events.some(e => e.kind === 'file-completed' && e.file !== 'hall-a/intro.txt'));
  await assert.rejects(() => store.completeFile('../escape.txt'), /路径不安全/);
});
