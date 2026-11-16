import { hashBuffer } from '../src/manifest.mjs';

// 合成一份跨文件分片清单：文件按顺序连续排布，末片可短，可选附带文件级摘要。
export function buildManifest({ manifestId = 'tour-1', pieceLength = 8, files: specs, withFileHash = true }) {
  let offset = 0;
  const files = specs.map(spec => {
    const entry = { path: spec.path, offset, length: spec.bytes.length };
    if (withFileHash) entry.sha256 = hashBuffer(spec.bytes);
    offset += spec.bytes.length;
    return entry;
  });
  const total = Buffer.concat(specs.map(spec => spec.bytes));
  const pieces = [];
  for (let start = 0; start < total.length; start += pieceLength) {
    pieces.push(hashBuffer(total.subarray(start, start + pieceLength)));
  }
  return {
    manifest: { manifestId, pieceLength, pieces, files, authorizedFiles: files.map(file => file.path) },
    raw: total,
  };
}

// 内存假来源：与 HttpSource 同形（getDistribution/getPeers/getPiece），用于确定性故障注入。
export class FakeSource {
  constructor(manifest, raw, options = {}) {
    this.manifest = manifest;
    this.raw = raw;
    this.options = options;
    this.peerOverrides = options.peerOverrides ?? {};
    this.calls = [];
  }

  async getDistribution() {
    if (this.options.distributionError) throw this.options.distributionError;
    return structuredClone(this.manifest);
  }

  async getPeers() {
    const peers = this.options.peers ?? [
      { id: 'relay-a', href: '/relay/a', manifestId: this.manifest.manifestId, availablePieces: this.manifest.pieces.map((_, index) => index) },
      { id: 'relay-b', href: '/relay/b', manifestId: this.manifest.manifestId, availablePieces: this.manifest.pieces.map((_, index) => index) },
    ];
    return structuredClone(peers);
  }

  #pieceBytes(index) {
    const start = index * this.manifest.pieceLength;
    return Buffer.from(this.raw.subarray(start, Math.min(start + this.manifest.pieceLength, this.raw.length)));
  }

  async getPiece(peer, index) {
    this.calls.push({ peer: peer.id, index, at: Date.now() });
    const override = this.peerOverrides[peer.id]?.[index];
    if (override?.delay) await new Promise(resolve => setTimeout(resolve, override.delay));
    if (override?.error) throw override.error;
    if (override?.status) {
      return { ok: false, status: override.status, reason: `注入故障 ${override.status}`, bytes: null, manifestId: null };
    }
    if (override?.stale) {
      const bytes = this.#pieceBytes(index);
      return { ok: true, status: 200, bytes, manifestId: `${this.manifest.manifestId}-old` };
    }
    if (override?.corrupt) {
      const bytes = this.#pieceBytes(index);
      bytes[0] = bytes[0] ^ 0xff;
      return { ok: true, status: 200, bytes, manifestId: this.manifest.manifestId };
    }
    if (override?.truncate) {
      const bytes = this.#pieceBytes(index).subarray(0, Math.max(0, this.#pieceBytes(index).length - 1));
      return { ok: true, status: 200, bytes, manifestId: this.manifest.manifestId };
    }
    return { ok: true, status: 200, bytes: this.#pieceBytes(index), manifestId: this.manifest.manifestId };
  }
}

export const sampleSpecs = () => ([
  { path: 'hall-a/intro.txt', bytes: Buffer.from('AAAAABBBBB') },
  { path: 'hall-b/intro.txt', bytes: Buffer.from('CCCCCddddd') },
  { path: 'hall-c/intro.txt', bytes: Buffer.from('eeeeeFFFF') },
]);
