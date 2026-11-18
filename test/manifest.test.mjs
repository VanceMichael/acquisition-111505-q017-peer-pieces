import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseManifest, normalizeSelection, requiredPieces, filePieceRange,
  pieceLengthAt, carveFileSlice, assembleFile, safeRelativePath, sha256,
} from '../src/manifest.mjs';

function buildManifest() {
  // 逻辑流 15 字节，片长 8：piece0 = 0..7，piece1 = 8..14（末片 7 字节）
  const raw = Buffer.from('AAAAABBBBBCCCCC');
  const pieceLength = 8;
  return {
    manifest: parseManifest({
      manifestId: 'tour-1',
      pieceLength,
      pieces: [sha256(raw.subarray(0, 8)), sha256(raw.subarray(8))],
      files: [
        { path: 'hall-a/intro.txt', offset: 0, length: 5 },
        { path: 'hall-b/intro.txt', offset: 5, length: 5 },
        { path: 'hall-c/intro.txt', offset: 10, length: 5 },
      ],
      authorizedFiles: ['hall-a/intro.txt', 'hall-b/intro.txt'],
    }),
    raw,
  };
}

test('清单几何：授权文件的必需片包含横跨两文件的共享边界片', () => {
  const { manifest } = buildManifest();
  // hall-a 占据全局 0..4，仅与 piece0 相交
  assert.deepEqual(requiredPieces(manifest, ['hall-a/intro.txt']), [0]);
  // hall-b 占据 5..9，横跨 piece0 与 piece1，两片都必须领取
  assert.deepEqual(requiredPieces(manifest, ['hall-b/intro.txt']), [0, 1]);
  assert.deepEqual(filePieceRange(manifest, manifest.file('hall-b/intro.txt')), [0, 1]);
  assert.equal(pieceLengthAt(manifest, 0), 8);
  assert.equal(pieceLengthAt(manifest, 1), 7);
});

test('整片校验后只切出属于本馆文件的字节区间', () => {
  const { manifest, raw } = buildManifest();
  const piece0 = raw.subarray(0, 8);
  const piece1 = raw.subarray(8);
  const sliceA = carveFileSlice(manifest, manifest.file('hall-a/intro.txt'), 0, piece0);
  assert.equal(sliceA.toString(), 'AAAAA');
  // 同一片被 hall-b 复用时只取其自己的区间
  const sliceB0 = carveFileSlice(manifest, manifest.file('hall-b/intro.txt'), 0, piece0);
  assert.equal(sliceB0.toString(), 'BBB');
  const sliceB1 = carveFileSlice(manifest, manifest.file('hall-b/intro.txt'), 1, piece1);
  assert.equal(sliceB1.toString(), 'BB');
  const assembled = assembleFile(manifest, manifest.file('hall-b/intro.txt'), index => index === 0 ? piece0 : piece1);
  assert.equal(assembled.toString(), 'BBBBB');
});

test('选择集合：未授权文件被拒绝，重复选择去重，空选择交给引擎层拒绝', () => {
  const { manifest } = buildManifest();
  assert.deepEqual(normalizeSelection(manifest, ['hall-a/intro.txt', 'hall-a/intro.txt']), ['hall-a/intro.txt']);
  assert.throws(() => normalizeSelection(manifest, ['hall-c/intro.txt']), /未授权/);
  assert.deepEqual(normalizeSelection(manifest, []), []);
  assert.throws(() => normalizeSelection(manifest, ['']), /非空字符串/);
});

test('清单校验：几何不连续、摘要格式错误、片数不符都被拒绝', () => {
  const base = buildManifest().manifest;
  assert.throws(() => parseManifest({ ...base, pieces: ['not-a-hash'] }), /SHA256/);
  assert.throws(() => parseManifest({
    ...base,
    files: [{ path: 'x', offset: 0, length: 5 }, { path: 'y', offset: 9, length: 5 }],
  }), /连续排布/);
  assert.throws(() => parseManifest({ ...base, pieces: base.pieces.slice(0, 1) }), /分片数量/);
  assert.throws(() => parseManifest({ ...base, authorizedFiles: ['missing.txt'] }), /授权文件/);
});

test('路径安全检查拦截目录逃逸', () => {
  for (const bad of ['../escape', '/abs/path', 'a/../b', 'a//b', 'a/./b', 'win\\x', 'C:a']) assert.equal(safeRelativePath(bad), false);
  for (const good of ['hall-a/intro.txt', 'plain.txt', 'a/b/c.txt']) assert.equal(safeRelativePath(good), true);
});
