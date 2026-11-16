import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalManifest, computeManifestHash, extractFileBytes, pieceRange,
  requiredPiecesForSelection, validateManifest,
} from '../src/manifest.mjs';
import { buildManifest, sampleSpecs } from './helpers.mjs';
import { ManifestValidationError } from '../src/errors.mjs';

const { manifest, raw } = buildManifest({ manifestId: 'tour-1', pieceLength: 8, files: sampleSpecs() });

test('清单几何：跨文件边界片与末片短片', () => {
  validateManifest(manifest);
  assert.deepEqual(pieceRange(manifest, 0), { start: 0, end: 8 });
  assert.deepEqual(pieceRange(manifest, 3), { start: 24, end: 29 }); // 末片只有 5 字节
  assert.equal(pieceRange(manifest, 99), null);
  // hall-a 长度 10：独占片 0，与 hall-b 共享片 1
  assert.deepEqual(requiredPiecesForSelection(manifest, ['hall-a/intro.txt']), [0, 1]);
  // hall-b 只需要片 1、2，hall-c 需要片 2、3：相邻选择共享边界片
  assert.deepEqual(requiredPiecesForSelection(manifest, ['hall-b/intro.txt']), [1, 2]);
  assert.deepEqual(requiredPiecesForSelection(manifest, ['hall-b/intro.txt', 'hall-c/intro.txt']), [1, 2, 3]);
});

test('按整片校验后再切文件区间，按字节大小截取不会破坏摘要', () => {
  const pieces = new Map();
  for (let index = 0; index < manifest.pieces.length; index += 1) {
    const range = pieceRange(manifest, index);
    pieces.set(index, raw.subarray(range.start, range.end));
  }
  const fileA = manifest.files[0];
  const bytes = extractFileBytes(manifest, fileA, pieces);
  assert.equal(bytes.toString(), 'AAAAABBBBB');
  assert.equal(bytes.length, fileA.length);
});

test('规范摘要对字段顺序不敏感，但对内容变化敏感', () => {
  const reordered = structuredClone(manifest);
  reordered.authorizedFiles = [...manifest.authorizedFiles].reverse();
  assert.equal(computeManifestHash(reordered), computeManifestHash(manifest));
  const changed = structuredClone(manifest);
  changed.files[0].length += 1;
  assert.notEqual(computeManifestHash(changed), computeManifestHash(manifest));
  assert.ok(canonicalManifest(manifest).includes('"manifestId"'));
});

test('清单内在一致性被严格校验', () => {
  const bad = structuredClone(manifest);
  bad.pieces = bad.pieces.slice(0, -1);
  assert.throws(() => validateManifest(bad), ManifestValidationError);
  const gap = structuredClone(manifest);
  gap.files[1] = { ...gap.files[1], offset: gap.files[1].offset + 1 };
  assert.throws(() => validateManifest(gap), /连续布局/);
});
