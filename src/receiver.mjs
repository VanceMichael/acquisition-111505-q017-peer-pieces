import { normalize } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { CollectionStore } from './collection-store.mjs';
import {
  computeManifestHash, extractFileBytes, hashBuffer, normalizeSelection,
  pieceCount, pieceRange, requiredPiecesForSelection, validateManifest,
} from './manifest.mjs';
import { PieceUnavailableError, SourceUnavailableError, VersionMismatchError, AuthorizationError } from './errors.mjs';

// 防止路径穿越：输出只能落在本分发的 output 目录之内。
function assertSafeRelativePath(filePath) {
  if (filePath.includes('\0')) throw new AuthorizationError(`文件路径非法：${filePath}`);
  const normalized = normalize(filePath);
  if (normalized.startsWith('/') || normalized.startsWith('..') || normalized === '..' || normalized.split('/').includes('..')) {
    throw new AuthorizationError(`文件路径越界：${filePath}`);
  }
  return normalized;
}

function sameSelection(a, b) {
  return a.length === b.length && [...a].sort().every((path, index) => path === [...b].sort()[index]);
}

// 引擎只依赖来源客户端的三个方法，可对接真实 HTTP 中继或内存假来源（测试故障注入）。
export class Receiver {
  constructor(source, archive, rootDirectory, options = {}) {
    this.source = source;
    this.archive = archive;
    this.rootDirectory = rootDirectory;
    this.concurrency = options.concurrency ?? 4;
    this.timeout = options.timeout ?? 10000;
    this.cooldownMs = options.cooldownMs ?? 5000;
  }

  async #loadManifest() {
    const manifest = await this.source.getDistribution();
    validateManifest(manifest);
    return manifest;
  }

  #filterPeers(peers, manifest) {
    const usable = [];
    const refused = [];
    for (const peer of peers ?? []) {
      if (!peer || typeof peer.id !== 'string' || typeof peer.href !== 'string' || !Array.isArray(peer.availablePieces)) {
        refused.push({ peer: peer?.id ?? '(未知)', reason: '中继描述结构不完整' });
        continue;
      }
      if (peer.manifestId !== manifest.manifestId) {
        refused.push({ peer: peer.id, reason: `清单版本不符（${peer.manifestId}），拒绝混用` });
        continue;
      }
      usable.push({ ...peer, availablePieces: new Set(peer.availablePieces) });
    }
    return { usable, refused };
  }

  // 单分片顺序尝试可用中继；每个失败都写入验证日志，形成实际验证记录。
  async #acquirePiece(manifest, peers, index, store, state, cooledUntil) {
    const candidates = peers
      .filter(peer => peer.availablePieces.has(index))
      .sort((a, b) => (state.attempts[b.id]?.failures ?? 0) - (state.attempts[a.id]?.failures ?? 0) || a.id.localeCompare(b.id));
    if (candidates.length === 0) {
      await store.journal({ event: 'piece_unavailable', index, reason: '没有中继登记该片' });
      return false;
    }
    const expectedHash = manifest.pieces[index];
    for (const peer of candidates) {
      if ((cooledUntil.get(peer.id) ?? 0) > Date.now()) {
        await store.journal({ event: 'peer_cooldown', index, peer: peer.id });
        continue;
      }
      state.attempts[peer.id] ??= { failures: 0, hashFailures: 0, staleRefusals: 0, success: 0 };
      try {
        const result = await this.#fetchWithLateGuard(peer, index, store);
        if (!result.ok) {
          state.attempts[peer.id].failures += 1;
          state.counters.sourceFailures += 1;
          await store.journal({ event: 'piece_failed', index, peer: peer.id, status: result.status, reason: result.reason });
          continue;
        }
        if (result.manifestId && result.manifestId !== manifest.manifestId) {
          state.attempts[peer.id].staleRefusals += 1;
          state.attempts[peer.id].failures += 1;
          state.counters.staleRefusals += 1;
          await store.journal({ event: 'stale_refused', index, peer: peer.id, expected: manifest.manifestId, observed: result.manifestId });
          continue;
        }
        const observedHash = hashBuffer(result.bytes);
        const range = pieceRange(manifest, index);
        const expectedLength = range.end - range.start;
        if (result.bytes.length !== expectedLength) {
          state.attempts[peer.id].failures += 1;
          state.counters.sourceFailures += 1;
          await store.journal({ event: 'piece_length_mismatch', index, peer: peer.id, expected: expectedLength, observed: result.bytes.length });
          continue;
        }
        if (observedHash !== expectedHash) {
          state.attempts[peer.id].hashFailures += 1;
          state.attempts[peer.id].failures += 1;
          state.counters.hashFailures += 1;
          await store.journal({ event: 'hash_mismatch', index, peer: peer.id, expected: expectedHash, observed: observedHash, bytes: result.bytes.length });
          // 连续给出损坏片的中继进入冷却，本批剩余分片优先切换到其他来源。
          if (state.attempts[peer.id].hashFailures >= 1) cooledUntil.set(peer.id, Date.now() + this.cooldownMs);
          continue;
        }
        const saved = await store.saveVerifiedPiece(index, result.bytes, observedHash);
        state.verifiedPieces[index] = { sha256: observedHash, length: result.bytes.length, via: peer.id, verifiedAt: new Date().toISOString() };
        state.attempts[peer.id].success += 1;
        state.counters.fetched += 1;
        if (saved.reused) state.counters.reused += 1;
        await store.saveState(state);
        await store.journal({ event: 'piece_verified', index, peer: peer.id, sha256: observedHash, reused: saved.reused });
        return true;
      } catch (error) {
        if (error instanceof VersionMismatchError) throw error;
        state.attempts[peer.id].failures += 1;
        state.counters.sourceFailures += 1;
        await store.journal({ event: 'peer_error', index, peer: peer.id, error: error.name, message: error.message });
      }
    }
    return false;
  }

  // 超时后返回的迟到回包会被显式丢弃并记录，绝不写入也不覆盖已确认的正确片。
  async #fetchWithLateGuard(peer, index, store) {
    let timer;
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => resolve({ ok: false, status: 0, reason: `中继 ${peer.id} 片 ${index} 请求超时，迟到回包将被丢弃`, bytes: null, manifestId: null, late: true }), this.timeout);
      timer.unref();
    });
    const work = this.source.getPiece(peer, index)
      .then(result => { clearTimeout(timer); return result; })
      .catch(error => { clearTimeout(timer); throw error; });
    const result = await Promise.race([work, timeout]);
    if (result.late) {
      work.then(reply => store.journal({ event: 'late_reply_discarded', index, peer: peer.id, status: reply?.status ?? null }), () => {});
      return result;
    }
    return result;
  }

  async #reconcileStoredPieces(manifest, store, state) {
    const entries = await store.listPieceFiles();
    const recovered = [];
    const quarantined = [];
    for (const entry of entries) {
      const expected = manifest.pieces[entry.index];
      if (!expected) {
        quarantined.push(entry);
        await store.quarantinePiece(entry);
        await store.journal({ event: 'piece_quarantined', index: entry.index, sha256: entry.sha256, reason: '超出当前清单范围' });
        continue;
      }
      // 重启核对：无论状态文件是否记得该片，都重算磁盘内容摘要，文件名与内容任一不符即隔离。
      const bytes = await readFile(entry.path);
      const actualHash = hashBuffer(bytes);
      if (entry.sha256 !== expected || actualHash !== expected) {
        quarantined.push(entry);
        await store.quarantinePiece(entry);
        await store.journal({ event: 'piece_quarantined', index: entry.index, sha256: entry.sha256, reason: actualHash !== expected ? '磁盘内容与清单摘要不符' : '文件名摘要与清单不符' });
        delete state.verifiedPieces[entry.index];
        continue;
      }
      state.verifiedPieces[entry.index] = {
        sha256: expected,
        length: bytes.length,
        via: state.verifiedPieces[entry.index]?.via ?? 'restart-recovery',
        verifiedAt: new Date().toISOString(),
      };
      recovered.push(entry.index);
    }
    return { recovered, quarantined };
  }

  async #assembleFiles(manifest, store, state, selectedPaths) {
    const pieceBytes = new Map();
    for (const index of requiredPiecesForSelection(manifest, selectedPaths)) {
      const piece = await store.readPiece(index);
      if (!piece) throw new PieceUnavailableError(`缺少已校验分片 ${index}`, [index]);
      pieceBytes.set(index, piece.bytes);
    }
    const completed = [];
    for (const filePath of selectedPaths) {
      const safePath = assertSafeRelativePath(filePath);
      const file = manifest.files.find(item => item.path === filePath);
      const prior = state.completedFiles[filePath];
      // 重启核对：输出文件已存在且与完成记录摘要一致时，确认状态而非重新搬运。
      if (prior?.sha256) {
        try {
          const existing = await readFile(store.outputPath(safePath));
          if (existing.length === file.length && hashBuffer(existing) === prior.sha256) {
            await store.journal({ event: 'file_reconfirmed', path: filePath, sha256: prior.sha256, length: file.length });
            completed.push({ path: filePath, length: file.length, sha256: prior.sha256, completedAt: prior.completedAt, reused: true });
            continue;
          }
          await store.journal({ event: 'output_rebuilt', path: filePath, reason: '输出缺失或摘要不符，按已校验片重组' });
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          await store.journal({ event: 'output_rebuilt', path: filePath, reason: '输出文件不存在，按已校验片重组' });
        }
      }
      const output = extractFileBytes(manifest, file, pieceBytes);
      const fileHash = hashBuffer(output);
      if (file.sha256 && file.sha256 !== fileHash) {
        await store.journal({ event: 'file_hash_mismatch', path: filePath, expected: file.sha256, observed: fileHash });
        throw new PieceUnavailableError(`文件 ${filePath} 重组摘要与清单不符`, []);
      }
      await store.writeOutput(safePath, output);
      const record = { path: filePath, length: file.length, sha256: fileHash, completedAt: new Date().toISOString() };
      const wasComplete = prior?.sha256 === fileHash;
      state.completedFiles[filePath] = record;
      // 人工归档体系保留自动收件的业务身份（manifest, path），不同来源不会混淆。
      await this.archive.accept('auto-relay', { manifest: manifest.manifestId, path: filePath }, record, output);
      await store.journal({ event: wasComplete ? 'file_reconfirmed' : 'file_completed', path: filePath, sha256: fileHash, length: file.length });
      completed.push({ ...record, reused: wasComplete });
    }
    await store.saveState(state);
    return completed;
  }

  async collect(request = {}) {
    const manifest = await this.#loadManifest();
    const store = await new CollectionStore(this.rootDirectory, manifest.manifestId).initialize();
    await store.lockManifest(manifest);
    const manifestHash = computeManifestHash(manifest);

    let state = await store.loadState();
    if (state.manifestHash && state.manifestHash !== manifestHash) throw new VersionMismatchError('持久状态与当前清单规范摘要不一致');
    state.manifestHash = manifestHash;
    state.counters ??= { fetched: 0, reused: 0, hashFailures: 0, staleRefusals: 0, sourceFailures: 0 };
    state.attempts ??= {};
    // 计数器跨运行累积；快照基线，汇总只报告本次运行的增量。
    const baseline = structuredClone(state.counters);

    const requestedSelection = request.files ?? manifest.authorizedFiles;
    const selectedPaths = normalizeSelection(manifest, requestedSelection);
    if (state.selection.length > 0 && !sameSelection(state.selection, selectedPaths)) {
      await store.journal({ event: 'selection_updated', previous: state.selection, current: selectedPaths });
    }
    state.selection = selectedPaths;
    await store.saveState(state);

    await store.journal({ event: 'collect_started', manifestId: manifest.manifestId, manifestHash, selection: selectedPaths });

    const reconciliation = await this.#reconcileStoredPieces(manifest, store, state);
    await store.saveState(state);

    const needed = requiredPiecesForSelection(manifest, selectedPaths);
    const alreadyVerified = needed.filter(index => state.verifiedPieces[index]);
    const missing = needed.filter(index => !state.verifiedPieces[index]);

    let peers = [];
    const refusedPeers = [];
    if (missing.length > 0) {
      let peersPayload;
      try { peersPayload = await this.source.getPeers(); }
      catch (error) { throw new SourceUnavailableError(`无法获取中继列表：${error.message}`); }
      const filtered = this.#filterPeers(peersPayload, manifest);
      peers = filtered.usable;
      refusedPeers.push(...filtered.refused);
      for (const refusal of filtered.refused) {
        state.counters.staleRefusals += 1;
        await store.journal({ event: 'peer_refused', ...refusal });
      }
      await store.saveState(state);
      if (peers.length === 0) throw new SourceUnavailableError('没有与当前清单版本一致的可用中继');
    }

    const cooledUntil = new Map();
    const queue = missing.map(index => ({ index, rounds: 0 }));
    const maxRounds = Math.max(2, peers.length);
    const workers = Array.from({ length: Math.min(this.concurrency, Math.max(1, queue.length)) }, async () => {
      while (queue.length > 0) {
        const job = queue.shift();
        const ok = await this.#acquirePiece(manifest, peers, job.index, store, state, cooledUntil);
        if (!ok) {
          job.rounds += 1;
          if (job.rounds < maxRounds) queue.push(job); // 本轮候选失败：冷却后由下一轮切换来源重试
          else await store.journal({ event: 'piece_given_up', index: job.index, rounds: job.rounds });
        }
      }
    });
    await Promise.all(workers);

    const stillMissing = needed.filter(index => !state.verifiedPieces[index]);
    if (stillMissing.length > 0) {
      await store.journal({ event: 'collect_incomplete', missing: stillMissing });
      throw new PieceUnavailableError(`分片 ${stillMissing.join(', ')} 无法从任何中继验证通过`, stillMissing);
    }

    // 已确认的文件不会被重复搬运：重组摘要与完成记录一致时只做再确认，迟到回包无法改写其摘要。
    await mkdir(store.outputDirectory, { recursive: true });
    const completed = await this.#assembleFiles(manifest, store, state, selectedPaths);

    const summary = {
      manifestId: manifest.manifestId,
      manifestHash,
      selection: selectedPaths,
      totalPieces: pieceCount(manifest),
      neededPieces: needed,
      alreadyVerified,
      fetched: state.counters.fetched - baseline.fetched,
      reused: state.counters.reused - baseline.reused + alreadyVerified.length,
      hashFailures: state.counters.hashFailures - baseline.hashFailures,
      staleRefusals: state.counters.staleRefusals - baseline.staleRefusals,
      sourceFailures: state.counters.sourceFailures - baseline.sourceFailures,
      refusedPeers,
      recoveredPieces: reconciliation.recovered,
      quarantinedPieces: reconciliation.quarantined.map(entry => entry.index),
      completedFiles: completed,
      verificationLog: store.journalPath,
      outputDirectory: store.outputDirectory,
    };
    await store.journal({ event: 'collect_finished', manifestId: manifest.manifestId, files: completed.map(file => file.path) });
    return summary;
  }
}
