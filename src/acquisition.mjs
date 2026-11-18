import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseManifest, normalizeSelection, requiredPieces, pieceLengthAt } from './manifest.mjs';
import { DistributionStore } from './piece-store.mjs';

export class AcquisitionError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'AcquisitionError';
    this.code = code;
    this.details = details;
  }
}

const throwIfAborted = signal => {
  if (signal?.aborted) {
    const error = new Error('领取已中断');
    error.name = 'AbortError';
    throw error;
  }
};

/**
 * 按清单选择性领取本馆文件。
 * 选项：
 *   source        PeerSource（HTTP 或测试替身），必须
 *   archiveRoot   片库根目录，必须
 *   selected      本馆负责展厅的文件路径数组，缺省取清单授权全集
 *   concurrency   同时在途的片请求，默认 4
 *   signal        中断信号
 */
export async function runAcquisition({ source, archiveRoot, selected, concurrency = 4, signal } = {}) {
  if (!source || typeof source.getDistribution !== 'function') throw new AcquisitionError('缺少中继来源', 'bad-source');
  if (!archiveRoot) throw new AcquisitionError('缺少片库目录', 'bad-config');

  const rawManifest = await source.getDistribution();
  const manifest = parseManifest(rawManifest);
  const chosen = normalizeSelection(manifest, selected ?? manifest.authorizedFiles);
  if (chosen.length === 0) throw new AcquisitionError('没有可领取的授权文件', 'empty-selection');

  const root = join(archiveRoot, encodeURIComponent(manifest.manifestId));
  await mkdir(root, { recursive: true });
  const store = await DistributionStore.open(root, manifest);

  const wanted = requiredPieces(manifest, chosen);
  const startedSummary = store.snapshot();

  // 已完成文件直接复用；所需片全部在库则无需任何网络领取（重启恢复路径）。
  const pendingFiles = chosen.filter(path => !store.state.selectedFiles[path]);
  const missingPieces = wanted.filter(index => !store.hasPiece(index));
  if (pendingFiles.length === 0) {
    return {
      status: 'complete',
      manifestId: manifest.manifestId,
      selected: chosen,
      requiredPieces: wanted,
      verifiedPieces: store.snapshot().verifiedPieces,
      completedFiles: store.snapshot().completedFiles,
      fetchedPieces: 0,
      reusedPieces: wanted.length,
      relays: store.snapshot().relays,
      note: '本馆文件此前已确认完成，未发起任何领取',
    };
  }

  // 只与同版本中继合作；旧包中继在此剔除并留痕，绝不混拼不同分发版本。
  const allPeers = await source.listPeers();
  const eligible = [];
  for (const peer of allPeers) {
    if (peer.manifestId && peer.manifestId !== manifest.manifestId) {
      await store.logEvent({ kind: 'relay-excluded', reason: '清单版本不一致', relayId: peer.id, sourceManifestId: peer.manifestId });
      await store.noteRelay(peer.id, { stale: true, outcome: 'excluded-stale', error: `manifestId=${peer.manifestId}` });
      continue;
    }
    eligible.push(peer);
  }
  if (eligible.length === 0) throw new AcquisitionError('没有清单版本一致的可用中继', 'no-eligible-peer', { manifestId: manifest.manifestId });

  const failures = new Map();
  const failureCount = peer => failures.get(peer.id) || 0;
  const candidatesFor = index => eligible
    .filter(peer => peer.availablePieces.includes(index))
    .sort((a, b) => failureCount(a) - failureCount(b) || a.id.localeCompare(b.id));

  const fetchOnePiece = async index => {
    throwIfAborted(signal);
    // 并发/重启场景下可能已被其他在途请求确认，先看锁内最新结论。
    const already = store.acceptance(index);
    if (already) return { index, ...already };

    const candidates = candidatesFor(index);
    if (candidates.length === 0) {
      await store.logEvent({ kind: 'piece-unavailable', reason: '没有中继持有该片', piece: index });
      throw new AcquisitionError(`片 ${index} 没有可用中继`, 'no-peer-for-piece', { piece: index });
    }

    let lastError = null;
    for (const peer of candidates) {
      throwIfAborted(signal);
      await store.noteRelay(peer.id, { attempt: true, outcome: 'piece-requested' });
      let reply;
      try {
        reply = await source.fetchPiece(peer, index, { signal });
      } catch (error) {
        lastError = error;
        failures.set(peer.id, failureCount(peer) + 1);
        await store.noteRelay(peer.id, { failure: true, outcome: 'request-error', error: error.message });
        await store.logEvent({ kind: 'piece-fetch-failed', piece: index, relayId: peer.id, reason: error.message });
        continue; // 切换下一个来源
      }

      if (reply.status < 200 || reply.status > 299) {
        lastError = new Error(`HTTP ${reply.status}`);
        failures.set(peer.id, failureCount(peer) + 1);
        await store.noteRelay(peer.id, { failure: true, outcome: `http-${reply.status}`, error: `piece ${index} -> ${reply.status}` });
        await store.logEvent({ kind: 'piece-fetch-failed', piece: index, relayId: peer.id, reason: `HTTP ${reply.status}` });
        continue;
      }

      // 回包头版本必须与当前清单一致；头缺失或不符都不允许进入摘要校验。
      const headerManifest = reply.headers?.['x-manifest-id'] ?? null;
      if (headerManifest && headerManifest !== manifest.manifestId) {
        failures.set(peer.id, failureCount(peer) + 1);
        await store.noteRelay(peer.id, { stale: true, failure: true, outcome: 'stale-response', error: `x-manifest-id=${headerManifest}` });
        await store.logEvent({ kind: 'piece-rejected', reason: '回包清单版本不一致', piece: index, relayId: peer.id, sourceManifestId: headerManifest });
        continue;
      }

      if (reply.bytes.length !== pieceLengthAt(manifest, index)) {
        failures.set(peer.id, failureCount(peer) + 1);
        await store.noteRelay(peer.id, { failure: true, corrupt: true, outcome: 'bad-length', error: `piece ${index}` });
      }

      // 迟到/并发回包在片锁内裁决：已确认正确片不会被覆盖。
      const verdict = await store.withPieceLock(index, () =>
        store.savePiece(index, reply.bytes, { relayId: peer.id, sourceManifestId: headerManifest }));
      if (verdict.accepted) {
        await store.noteRelay(peer.id, { outcome: verdict.duplicate ? 'piece-reused' : 'piece-served' });
        return { index, ...verdict };
      }
      failures.set(peer.id, failureCount(peer) + 1);
      await store.noteRelay(peer.id, { failure: true, corrupt: true, outcome: 'hash-mismatch', error: verdict.reason });
      lastError = new Error(verdict.reason);
    }
    throw new AcquisitionError(`片 ${index} 在所有可用中继处均未通过验证`, 'piece-exhausted', { piece: index, lastError: lastError?.message });
  };

  // 有界并发池；单片失败不丢弃其他片的进度，已验证片全部留库留痕。
  const queue = missingPieces.slice();
  const fetched = [];
  const workers = Array.from({ length: Math.min(concurrency, queue.length || 1) }, async () => {
    while (queue.length) {
      const index = queue.shift();
      const result = await fetchOnePiece(index);
      if (!result.duplicate) fetched.push(index);
    }
  });
  const outcomes = await Promise.allSettled(workers);
  const failure = outcomes.find(item => item.status === 'rejected');
  if (failure) {
    await store.logEvent({ kind: 'acquisition-incomplete', reason: failure.reason?.name === 'AbortError' ? '领取已中断' : (failure.reason?.message || String(failure.reason)) });
    if (failure.reason?.name === 'AbortError') throw failure.reason;
    throw failure.reason instanceof AcquisitionError
      ? failure.reason
      : new AcquisitionError(failure.reason?.message || '领取失败', 'acquisition-failed');
  }

  // 片齐后才组装并登记本馆文件；未选择的文件永远不会被登记为已接收。
  const completed = [];
  for (const path of pendingFiles) {
    const result = await store.completeFile(path);
    completed.push(result);
  }

  const snapshot = store.snapshot();
  await store.logEvent({
    kind: 'acquisition-complete',
    selected: chosen,
    requiredPieces: wanted,
    fetchedPieces: fetched.sort((a, b) => a - b),
    reusedFromStore: wanted.length - missingPieces.length,
    completedFiles: completed.map(item => item.path),
  });
  return {
    status: 'complete',
    manifestId: manifest.manifestId,
    selected: chosen,
    requiredPieces: wanted,
    verifiedPieces: snapshot.verifiedPieces,
    completedFiles: snapshot.completedFiles,
    fetchedPieces: fetched.length,
    reusedPieces: wanted.length - fetched.length,
    relays: snapshot.relays,
    previousVerifiedPieceCount: startedSummary.verifiedPieceCount,
  };
}
