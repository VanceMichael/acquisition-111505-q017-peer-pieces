import { createHash } from 'node:crypto';
import { ManifestValidationError, AuthorizationError } from './errors.mjs';

export const hashBuffer = bytes => createHash('sha256').update(bytes).digest('hex');

// 清单的规范序列化：字段顺序固定，作为整包内容身份，防止“同 manifestId 不同清单”的混拼。
export function canonicalManifest(manifest) {
  const files = manifest.files.map(file => ({ path: file.path, offset: file.offset, length: file.length, sha256: file.sha256 ?? null }));
  const canonical = {
    manifestId: manifest.manifestId,
    pieceLength: manifest.pieceLength,
    pieces: manifest.pieces,
    files,
    authorizedFiles: [...manifest.authorizedFiles].sort(),
  };
  return JSON.stringify(canonical);
}

export function computeManifestHash(manifest) {
  return hashBuffer(Buffer.from(canonicalManifest(manifest), 'utf8'));
}

// 校验来源清单的内在一致性；来源身份（manifestId/摘要）是内容寻址，path 仍代表资料归属。
export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new ManifestValidationError('清单必须是对象');
  if (typeof manifest.manifestId !== 'string' || !manifest.manifestId) throw new ManifestValidationError('缺少 manifestId');
  if (!Number.isInteger(manifest.pieceLength) || manifest.pieceLength <= 0) throw new ManifestValidationError('pieceLength 必须是正整数');
  if (!Array.isArray(manifest.pieces) || manifest.pieces.length === 0 || manifest.pieces.some(hash => typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash))) {
    throw new ManifestValidationError('pieces 必须是非空的 SHA256 摘要数组');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new ManifestValidationError('files 必须是非空数组');
  let offset = 0;
  for (const [index, file] of manifest.files.entries()) {
    if (!file || typeof file.path !== 'string' || !file.path) throw new ManifestValidationError(`第 ${index} 个文件缺少 path`);
    if (!Number.isInteger(file.length) || file.length < 0) throw new ManifestValidationError(`文件 ${file.path} 的 length 非法`);
    if (file.offset !== offset) throw new ManifestValidationError(`文件 ${file.path} 的 offset 与连续布局不一致`);
    if (file.sha256 !== undefined && (typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256))) {
      throw new ManifestValidationError(`文件 ${file.path} 的 sha256 不是 64 位十六进制`);
    }
    offset += file.length;
  }
  if (!Array.isArray(manifest.authorizedFiles) || manifest.authorizedFiles.some(path => typeof path !== 'string')) {
    throw new ManifestValidationError('authorizedFiles 必须是字符串数组');
  }
  const totalLength = offset;
  const expectedPieces = totalLength === 0 ? 1 : Math.ceil(totalLength / manifest.pieceLength);
  if (manifest.pieces.length !== expectedPieces) throw new ManifestValidationError('pieces 数量与文件总长度不符');
  const known = new Set(manifest.files.map(file => file.path));
  for (const path of manifest.authorizedFiles) if (!known.has(path)) throw new ManifestValidationError(`授权文件 ${path} 不在清单中`);
  return true;
}

export function pieceCount(manifest) {
  return manifest.pieces.length;
}

// 逻辑包中第 index 片覆盖的 [start, end) 字节区间；末片允许短于 pieceLength。
export function pieceRange(manifest, index) {
  const totalLength = manifest.files.reduce((sum, file) => sum + file.length, 0);
  const start = index * manifest.pieceLength;
  if (index < 0 || index >= pieceCount(manifest) || start >= totalLength) return null;
  return { start, end: Math.min(start + manifest.pieceLength, totalLength) };
}

// 计算选择文件集合实际需要的分片：边界片按整片领取与校验，未选文件不参与登记。
export function requiredPiecesForSelection(manifest, selectedPaths) {
  const selected = new Set(selectedPaths);
  const needed = new Set();
  for (const file of manifest.files) {
    if (!selected.has(file.path)) continue;
    const first = Math.floor(file.offset / manifest.pieceLength);
    const last = Math.floor((file.offset + file.length - 1) / manifest.pieceLength);
    for (let index = first; index <= last; index += 1) needed.add(index);
  }
  return [...needed].sort((a, b) => a - b);
}

export function normalizeSelection(manifest, selectedPaths) {
  const known = new Set(manifest.files.map(file => file.path));
  const authorized = new Set(manifest.authorizedFiles);
  for (const path of selectedPaths) {
    if (typeof path !== 'string' || !known.has(path)) throw new ManifestValidationError(`选择的文件 ${String(path)} 不在清单中`);
    if (!authorized.has(path)) throw new AuthorizationError(`文件 ${path} 不在本馆授权范围内`);
  }
  const unique = [...new Set(selectedPaths)];
  if (unique.length === 0) throw new ManifestValidationError('至少选择一个文件');
  return unique;
}

// 从已校验的整片字节中切出某文件的区间；只允许切本馆选中的文件。
export function extractFileBytes(manifest, file, pieceBytes) {
  const output = Buffer.allocUnsafe(file.length);
  const first = Math.floor(file.offset / manifest.pieceLength);
  const last = Math.floor((file.offset + file.length - 1) / manifest.pieceLength);
  let written = 0;
  for (let index = first; index <= last; index += 1) {
    const piece = pieceBytes.get(index);
    if (!piece) throw new ManifestValidationError(`缺少已校验分片 ${index}`);
    const range = pieceRange(manifest, index);
    const sliceStart = Math.max(file.offset, range.start) - range.start;
    const sliceEnd = Math.min(file.offset + file.length, range.end) - range.start;
    piece.subarray(sliceStart, sliceEnd).copy(output, written);
    written += sliceEnd - sliceStart;
  }
  if (written !== file.length) throw new ManifestValidationError(`文件 ${file.path} 重组长度不一致`);
  return output;
}
