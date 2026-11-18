import { createHash } from 'node:crypto';

export const sha256 = bytes => createHash('sha256').update(Buffer.from(bytes)).digest('hex');

/** 校验来源清单并返回带有归一化字段的只读视图；几何或摘要字段不合法直接拒绝。 */
export function parseManifest(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('清单必须是对象');
  const { manifestId, pieceLength, pieces, files, authorizedFiles } = payload;
  if (typeof manifestId !== 'string' || !manifestId) throw new Error('清单缺少 manifestId');
  if (!Number.isInteger(pieceLength) || pieceLength <= 0) throw new Error('清单 pieceLength 非法');
  if (!Array.isArray(pieces) || pieces.length === 0 || pieces.some(item => typeof item !== 'string' || !/^[0-9a-f]{64}$/.test(item))) {
    throw new Error('清单 pieces 必须是 SHA256 十六进制摘要数组');
  }
  if (!Array.isArray(files) || files.length === 0) throw new Error('清单缺少 files');
  const normalizedFiles = files.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`第 ${index} 个文件条目非法`);
    const { path, offset, length } = entry;
    if (typeof path !== 'string' || !path) throw new Error(`第 ${index} 个文件缺少 path`);
    if (!Number.isInteger(offset) || offset < 0) throw new Error(`文件 ${path} 的 offset 非法`);
    if (!Number.isInteger(length) || length <= 0) throw new Error(`文件 ${path} 的 length 非法`);
    return { path, offset, length };
  });
  // 文件按全局逻辑流顺序连续排布，offset 是权威几何，不接受重叠或空洞。
  let cursor = 0;
  for (const entry of normalizedFiles) {
    if (entry.offset !== cursor) throw new Error(`文件 ${entry.path} 的 offset 与连续排布不一致`);
    cursor += entry.length;
  }
  const totalLength = cursor;
  if (pieces.length !== Math.ceil(totalLength / pieceLength)) throw new Error('分片数量与总长度不一致');
  const lastLength = totalLength - (pieces.length - 1) * pieceLength;
  if (lastLength <= 0 || lastLength > pieceLength) throw new Error('末片长度非法');
  const authorized = Array.isArray(authorizedFiles) ? authorizedFiles : [];
  if (authorized.some(path => !normalizedFiles.some(entry => entry.path === path))) {
    throw new Error('授权文件包含清单中不存在的路径');
  }
  const byPath = new Map(normalizedFiles.map(entry => [entry.path, entry]));
  return Object.freeze({
    manifestId,
    pieceLength,
    totalLength,
    pieces: Object.freeze(pieces.slice()),
    files: Object.freeze(normalizedFiles),
    authorizedFiles: Object.freeze(authorized.slice()),
    file(path) {
      const entry = byPath.get(path);
      if (!entry) throw new Error(`清单中没有文件 ${path}`);
      return entry;
    },
  });
}

/** 只允许清单授权范围内的路径，重复选择自动去重。 */
export function normalizeSelection(manifest, selected) {
  const wanted = Array.isArray(selected) ? selected : [selected];
  const result = [];
  for (const path of wanted) {
    if (typeof path !== 'string' || !path) throw new Error('选择的文件路径必须是非空字符串');
    if (!manifest.authorizedFiles.includes(path)) throw new Error(`未授权的文件：${path}`);
    if (!result.includes(path)) result.push(path);
  }
  return result;
}

export function filePieceRange(manifest, entry) {
  const first = Math.floor(entry.offset / manifest.pieceLength);
  const last = Math.floor((entry.offset + entry.length - 1) / manifest.pieceLength);
  return [first, last];
}

/** 选中文件需要领取的片索引（含横跨已选/未选文件的共享边界片）。 */
export function requiredPieces(manifest, selectedPaths) {
  const indices = new Set();
  for (const path of selectedPaths) {
    const [first, last] = filePieceRange(manifest, manifest.file(path));
    for (let index = first; index <= last; index += 1) indices.add(index);
  }
  return [...indices].sort((a, b) => a - b);
}

export function pieceLengthAt(manifest, index) {
  if (index < 0 || index >= manifest.pieces.length) throw new Error(`片索引越界：${index}`);
  if (index === manifest.pieces.length - 1) {
    return manifest.totalLength - index * manifest.pieceLength;
  }
  return manifest.pieceLength;
}

/** 从已整片校验的缓存中切出该片属于目标文件的字节区间。 */
export function carveFileSlice(manifest, entry, index, piece) {
  const pieceStart = index * manifest.pieceLength;
  const start = Math.max(pieceStart, entry.offset);
  const end = Math.min(pieceStart + piece.length, entry.offset + entry.length);
  return piece.subarray(start - pieceStart, end - pieceStart);
}

/** 按片顺序拼出完整文件；任何一片缺失都会失败，调用方需先确认片已齐。 */
export function assembleFile(manifest, entry, readPiece) {
  const [first, last] = filePieceRange(manifest, entry);
  const slices = [];
  for (let index = first; index <= last; index += 1) {
    const piece = readPiece(index);
    if (!piece) throw new Error(`片 ${index} 尚未验证，无法组装 ${entry.path}`);
    slices.push(carveFileSlice(manifest, entry, index, piece));
  }
  return Buffer.concat(slices);
}

/** 防止 path 逃逸出目标目录；path 始终按 POSIX 相对路径解释。 */
export function safeRelativePath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.startsWith('/') || path.includes('\\') || path.includes(':')) return false;
  const segments = path.split('/');
  if (segments.some(part => part === '' || part === '.' || part === '..')) return false;
  return true;
}
