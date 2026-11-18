import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, rm } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { sha256, carveFileSlice, filePieceRange, safeRelativePath } from './manifest.mjs';

/**
 * 单一清单版本的本地片库。目录布局：
 *   pieces/<index>            已通过整片 SHA256 校验的片（按索引命名，天然只保留一个正确版本）
 *   files/<path>              已完成并复核的本馆文件
 *   state.json                已验证片、已登记文件与中继观察记录
 *   verification.log          只追加的实际验证记录
 * 不同 manifestId 使用不同目录，版本之间绝不共用片或状态。
 */
export class DistributionStore {
  constructor(root, manifest) {
    this.root = root;
    this.manifest = manifest;
    this.pieceDir = join(root, 'pieces');
    this.fileDir = join(root, 'files');
    this.statePath = join(root, 'state.json');
    this.logPath = join(root, 'verification.log');
    this.state = {
      manifestId: manifest.manifestId,
      pieceLength: manifest.pieceLength,
      totalLength: manifest.totalLength,
      verifiedPieces: {},
      selectedFiles: {},
      relays: {},
      startedAt: new Date().toISOString(),
      updatedAt: null,
    };
    this.locks = new Map();
    this.tail = Promise.resolve();
  }

  #enqueue(operation) {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }

  async #atomic(target, bytes) {
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, bytes);
    try { await rename(temporary, target); }
    catch (error) { await rm(temporary, { force: true }); throw error; }
  }

  #persist() {
    this.state.updatedAt = new Date().toISOString();
    return this.#atomic(this.statePath, Buffer.from(JSON.stringify(this.state, null, 2)));
  }

  /** 只追加一行验证记录；内部调用时禁止再入队，否则会与外层任务自死锁。 */
  async #appendLog(event) {
    const line = JSON.stringify({ at: new Date().toISOString(), manifestId: this.manifest.manifestId, ...event }) + '\n';
    await writeFile(this.logPath, line, { flag: 'a' });
  }

  /** 打开（或重新打开）某清单版本的片库，并对磁盘上的已有内容做重启核对。 */
  static async open(root, manifest) {
    const store = new DistributionStore(root, manifest);
    await mkdir(store.pieceDir, { recursive: true });
    await mkdir(store.fileDir, { recursive: true });
    await writeFile(store.logPath, '', { flag: 'a' });

    let saved = null;
    try { saved = JSON.parse(await readFile(store.statePath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (saved) {
      if (saved.manifestId !== manifest.manifestId) {
        throw new Error(`片库清单版本不一致：目录属于 ${saved.manifestId}，当前清单为 ${manifest.manifestId}`);
      }
      store.state.verifiedPieces = saved.verifiedPieces && typeof saved.verifiedPieces === 'object' ? saved.verifiedPieces : {};
      store.state.selectedFiles = saved.selectedFiles && typeof saved.selectedFiles === 'object' ? saved.selectedFiles : {};
      store.state.relays = saved.relays && typeof saved.relays === 'object' ? saved.relays : {};
      store.state.startedAt = saved.startedAt || store.state.startedAt;
    }

    // 逐片重读、重算摘要：磁盘片与清单摘要不符即隔离，绝不带病继续。
    const onDisk = new Set((await readdir(store.pieceDir)).map(Number));
    for (const index of [...onDisk].sort((a, b) => a - b)) {
      const target = join(store.pieceDir, String(index));
      if (!Number.isInteger(index) || index < 0 || index >= manifest.pieces.length) {
        await rm(target, { force: true });
        await store.logEvent({ kind: 'quarantine', reason: '片索引超出清单范围', piece: index });
        continue;
      }
      const bytes = await readFile(target);
      const digest = sha256(bytes);
      if (digest !== manifest.pieces[index]) {
        await rm(target, { force: true });
        delete store.state.verifiedPieces[index];
        await store.logEvent({ kind: 'quarantine', reason: '重启复核摘要不符', piece: index, observed: digest, expected: manifest.pieces[index] });
        continue;
      }
      store.state.verifiedPieces[index] = {
        sha256: digest,
        length: bytes.length,
        confirmedAt: store.state.verifiedPieces[index]?.confirmedAt || new Date().toISOString(),
        relayId: store.state.verifiedPieces[index]?.relayId ?? null,
      };
    }
    // 状态里登记过但磁盘已不存在的片同样视为未验证。
    for (const index of Object.keys(store.state.verifiedPieces)) {
      if (!onDisk.has(Number(index))) delete store.state.verifiedPieces[index];
    }

    // 复核已登记文件：只承认完全由已验证片重新拼出且摘要一致的文件。
    for (const path of Object.keys(store.state.selectedFiles)) {
      const record = store.state.selectedFiles[path];
      const entry = manifest.files.find(item => item.path === path);
      let intact = false;
      if (entry && safeRelativePath(path)) {
        try {
          const [first, last] = filePieceRange(manifest, entry);
          let expected = true;
          for (let index = first; index <= last; index += 1) if (!store.hasPiece(index)) expected = false;
          if (expected) {
            const slices = [];
            for (let index = first; index <= last; index += 1) {
              slices.push(carveFileSlice(manifest, entry, index, await store.readPiece(index)));
            }
            const assembled = Buffer.concat(slices);
            if (assembled.length === entry.length && sha256(assembled) === record.sha256) intact = true;
          }
        } catch { intact = false; }
      }
      if (!intact) {
        delete store.state.selectedFiles[path];
        await store.logEvent({ kind: 'file-reset', reason: '重启复核未通过', file: path });
      }
    }
    await store.#persist();
    return store;
  }

  /** 同一片并发/迟到回包在此串行化，已确认正确片永不被覆盖。 */
  withPieceLock(index, operation) {
    const existing = this.locks.get(index);
    if (existing) return existing.then(previous => previous ?? this.acceptance(index));
    const promise = (async () => {
      try { return await operation(); }
      finally { this.locks.delete(index); }
    })();
    this.locks.set(index, promise);
    return promise;
  }

  acceptance(index) {
    const record = this.state.verifiedPieces[index];
    return record ? { accepted: true, duplicate: true, sha256: record.sha256 } : null;
  }

  hasPiece(index) {
    return Boolean(this.state.verifiedPieces[index]);
  }

  readPiece(index) {
    if (!this.hasPiece(index)) return null;
    return readFile(join(this.pieceDir, String(index)));
  }

  /**
   * 保存一个来源回包。整片摘要通过才落盘；失败只追加验证记录，不写任何片。
   * 返回 { accepted, duplicate, sha256?, reason? }。
   */
  savePiece(index, bytes, context = {}) {
    return this.#enqueue(async () => {
      const { relayId, sourceManifestId } = context;
      if (!Number.isInteger(index) || index < 0 || index >= this.manifest.pieces.length) {
        await this.#appendLog({ kind: 'piece-rejected', reason: '片索引越界', piece: index, relayId, sourceManifestId });
        return { accepted: false, reason: '片索引越界' };
      }
      const previous = this.state.verifiedPieces[index];
      if (previous) {
        // 迟到回包：已确认的正确片不受影响，只记录复用，绝不重写。
        await this.#appendLog({ kind: 'piece-duplicate', piece: index, relayId, sourceManifestId, sha256: previous.sha256 });
        return { accepted: true, duplicate: true, sha256: previous.sha256 };
      }
      const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      const expectedLength = index === this.manifest.pieces.length - 1
        ? this.manifest.totalLength - index * this.manifest.pieceLength
        : this.manifest.pieceLength;
      if (buffer.length !== expectedLength) {
        await this.#appendLog({ kind: 'piece-rejected', reason: '片长度不符', piece: index, relayId, sourceManifestId, expectedLength, observedLength: buffer.length });
        return { accepted: false, reason: '片长度不符' };
      }
      const digest = sha256(buffer);
      if (digest !== this.manifest.pieces[index]) {
        await this.#appendLog({ kind: 'piece-rejected', reason: '摘要校验失败', piece: index, relayId, sourceManifestId, observed: digest, expected: this.manifest.pieces[index] });
        return { accepted: false, reason: '摘要校验失败' };
      }
      await this.#atomic(join(this.pieceDir, String(index)), buffer);
      this.state.verifiedPieces[index] = { sha256: digest, length: buffer.length, confirmedAt: new Date().toISOString(), relayId: relayId || null };
      await this.#appendLog({ kind: 'piece-verified', piece: index, relayId, sourceManifestId, sha256: digest, length: buffer.length });
      await this.#persist();
      return { accepted: true, duplicate: false, sha256: digest };
    });
  }

  /** 由已验证片组装本馆文件；只登记选中的文件，未选文件不会出现在任何接收记录里。 */
  completeFile(path) {
    return this.#enqueue(async () => {
      if (!safeRelativePath(path)) throw new Error(`文件路径不安全：${path}`);
      const entry = this.manifest.files.find(item => item.path === path);
      if (!entry) throw new Error(`清单中没有文件 ${path}`);
      const known = this.state.selectedFiles[path];
      if (known) return { path, sha256: known.sha256, duplicate: true };
      const [first, last] = filePieceRange(this.manifest, entry);
      const slices = [];
      for (let index = first; index <= last; index += 1) {
        const piece = await this.readPiece(index);
        if (!piece) throw new Error(`片 ${index} 未验证，无法完成 ${path}`);
        slices.push(carveFileSlice(this.manifest, entry, index, piece));
      }
      const output = Buffer.concat(slices);
      if (output.length !== entry.length) throw new Error(`组装长度与清单不符：${path}`);
      const digest = sha256(output);
      const target = join(this.fileDir, path);
      await mkdir(posix.dirname(target), { recursive: true });
      await this.#atomic(target, output);
      this.state.selectedFiles[path] = { sha256: digest, length: output.length, completedAt: new Date().toISOString() };
      await this.#appendLog({ kind: 'file-completed', file: path, sha256: digest, length: output.length });
      await this.#persist();
      return { path, sha256: digest, duplicate: false };
    });
  }

  noteRelay(relayId, patch) {
    return this.#enqueue(async () => {
      const current = this.state.relays[relayId] || { attempts: 0, failures: 0, corrupt: 0, stale: 0, lastError: null, lastOutcome: null, updatedAt: null };
      const next = {
        attempts: current.attempts + (patch.attempt ? 1 : 0),
        failures: current.failures + (patch.failure ? 1 : 0),
        corrupt: current.corrupt + (patch.corrupt ? 1 : 0),
        stale: current.stale + (patch.stale ? 1 : 0),
        lastError: patch.error ?? current.lastError,
        lastOutcome: patch.outcome || current.lastOutcome,
        updatedAt: new Date().toISOString(),
      };
      this.state.relays[relayId] = next;
      await this.#appendLog({ kind: 'relay-note', relayId, ...patch, at: next.updatedAt });
      await this.#persist();
      return next;
    });
  }

  logEvent(event) {
    return this.#enqueue(async () => {
      const line = JSON.stringify({ at: new Date().toISOString(), manifestId: this.manifest.manifestId, ...event }) + '\n';
      await writeFile(this.logPath, line, { flag: 'a' });
    });
  }

  snapshot() {
    return {
      manifestId: this.state.manifestId,
      verifiedPieceCount: Object.keys(this.state.verifiedPieces).length,
      totalPieces: this.manifest.pieces.length,
      verifiedPieces: Object.keys(this.state.verifiedPieces).map(Number).sort((a, b) => a - b),
      completedFiles: Object.keys(this.state.selectedFiles).sort(),
      selectedFiles: structuredClone(this.state.selectedFiles),
      relays: structuredClone(this.state.relays),
      updatedAt: this.state.updatedAt,
    };
  }
}

export async function readVerificationLog(root, { limit } = {}) {
  let text;
  try { text = await readFile(join(root, 'verification.log'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const events = text.split('\n').filter(Boolean).map(line => JSON.parse(line));
  return Number.isInteger(limit) && limit > 0 ? events.slice(-limit) : events;
}
