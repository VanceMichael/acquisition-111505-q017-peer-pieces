import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { computeManifestHash } from './manifest.mjs';
import { VersionMismatchError } from './errors.mjs';

const safeName = value => value.replace(/[^A-Za-z0-9._-]+/g, '_');

// 一次分发的本地状态：清单锁、内容寻址的已校验片、JSON 状态与 NDJSON 验证日志。
// 所有写入都经同一串行队列与临时文件 rename，崩溃后只会留下旧的完整状态，不会出现半写文件。
export class CollectionStore {
  constructor(rootDirectory, manifestId) {
    this.directory = join(rootDirectory, safeName(manifestId));
    this.manifestPath = join(this.directory, 'manifest.json');
    this.statePath = join(this.directory, 'state.json');
    this.journalPath = join(this.directory, 'verification.log');
    this.piecesDirectory = join(this.directory, 'pieces');
    this.outputDirectory = join(this.directory, 'output');
    this.ioChain = Promise.resolve();
  }

  #serialize(operation) {
    const result = this.ioChain.then(operation);
    this.ioChain = result.catch(() => {});
    return result;
  }

  async #atomic(path, bytes) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx');
    try { await file.writeFile(bytes); await file.sync(); }
    finally { await file.close(); }
    try { await rename(temporary, path); }
    catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  }

  async initialize() {
    await mkdir(this.piecesDirectory, { recursive: true });
    await mkdir(this.outputDirectory, { recursive: true });
    return this;
  }

  async #loadJson(path, fallback) {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return fallback;
      throw error;
    }
  }

  // 首次运行锁定清单；重启或来源版本漂移时核对规范摘要，拒绝混拼不同分发版本。
  async lockManifest(manifest) {
    return this.#serialize(async () => {
      const stored = await this.#loadJson(this.manifestPath, null);
      if (stored) {
        if (stored.manifestId !== manifest.manifestId || computeManifestHash(stored) !== computeManifestHash(manifest)) {
          throw new VersionMismatchError('该状态目录已锁定其他分发版本，拒绝混用');
        }
        return { manifest: stored, created: false };
      }
      await this.#atomic(this.manifestPath, Buffer.from(JSON.stringify(manifest)));
      return { manifest, created: true };
    });
  }

  async readManifest() {
    return this.#loadJson(this.manifestPath, null);
  }

  async loadState() {
    const fallback = { manifestHash: null, selection: [], verifiedPieces: {}, completedFiles: {}, attempts: {}, counters: { fetched: 0, reused: 0, hashFailures: 0, staleRefusals: 0, sourceFailures: 0 } };
    return this.#loadJson(this.statePath, fallback);
  }

  async saveState(state) {
    return this.#serialize(() => this.#atomic(this.statePath, Buffer.from(JSON.stringify(state, null, 2))));
  }

  async journal(event) {
    const line = JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n';
    return this.#serialize(async () => writeFile(this.journalPath, line, { flag: 'a' }));
  }

  piecePath(index, sha256) {
    return join(this.piecesDirectory, `${String(index).padStart(6, '0')}-${sha256}`);
  }

  // 已确认正确的片按摘要落盘；迟到回包对应的片若已存在则不会覆盖。
  async saveVerifiedPiece(index, bytes, sha256) {
    return this.#serialize(async () => {
      const target = this.piecePath(index, sha256);
      let exists = false;
      try { await readFile(target); exists = true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!exists) await this.#atomic(target, bytes);
      return { path: target, reused: exists };
    });
  }

  async listPieceFiles() {
    const names = (await readdir(this.piecesDirectory)).filter(name => name.endsWith('.tmp') === false).sort();
    return names.map(name => {
      const match = name.match(/^(\d+)-([0-9a-f]{64})$/);
      return match ? { index: Number(match[1]), sha256: match[2], path: join(this.piecesDirectory, name) } : null;
    }).filter(Boolean);
  }

  async readPiece(index) {
    const entries = (await this.listPieceFiles()).filter(entry => entry.index === index);
    if (entries.length === 0) return null;
    return { ...entries[0], bytes: await readFile(entries[0].path) };
  }

  // 隔离损坏片：重命名保留证据，不再被当作可复用的已校验片。
  async quarantinePiece(entry) {
    const target = `${entry.path}.quarantined`;
    return this.#serialize(() => rename(entry.path, target));
  }

  outputPath(filePath) {
    return join(this.outputDirectory, filePath);
  }

  async writeOutput(relativePath, bytes) {
    const target = this.outputPath(relativePath);
    return this.#serialize(async () => {
      await mkdir(join(target, '..'), { recursive: true });
      await this.#atomic(target, bytes);
    });
  }
}
