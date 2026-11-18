import { join } from 'node:path';
import { runAcquisition } from './acquisition.mjs';
import { createHttpPeerSource } from './relay-client.mjs';
import { readVerificationLog } from './piece-store.mjs';

/**
 * 收件端的自动领取服务：一次只允许一个领取任务，状态与验证记录可查询。
 * 来源地址必须显式配置，不包含任何公网发现或做种行为。
 */
export class CollectService {
  constructor(archiveDirectory, { sourceUrl, peerSourceFactory, timeout, headers } = {}) {
    this.archiveDirectory = archiveDirectory;
    this.distributionRoot = join(archiveDirectory, 'distributions');
    this.sourceUrl = sourceUrl;
    this.peerSourceFactory = peerSourceFactory || (() => {
      if (!sourceUrl) throw new Error('未配置来源地址 SOURCE_URL');
      return createHttpPeerSource(sourceUrl, { timeout, headers });
    });
    this.active = null;
  }

  isRunning() {
    return this.active !== null;
  }

  start({ selected, concurrency, signal } = {}) {
    if (this.active) {
      const error = new Error('已有领取任务在进行中');
      error.code = 'ACTIVE_RUN';
      throw error;
    }
    const source = this.peerSourceFactory();
    const run = runAcquisition({
      source,
      archiveRoot: this.distributionRoot,
      selected,
      concurrency,
      signal,
    });
    const tracked = (async () => {
      let outcome;
      try {
        const result = await run;
        outcome = { status: 'complete', startedAt: tracked.startedAt, finishedAt: new Date().toISOString(), result };
      } catch (error) {
        outcome = { status: 'failed', startedAt: tracked.startedAt, finishedAt: new Date().toISOString(), error: { name: error.name, code: error.code, message: error.message, details: error.details } };
      } finally {
        this.active = null;
        this.lastRun = outcome;
      }
      return outcome;
    })();
    tracked.startedAt = new Date().toISOString();
    this.active = tracked;
    return tracked;
  }

  async status() {
    if (this.active) return { running: true, startedAt: this.active.startedAt };
    return { running: false, lastRun: this.lastRun || null };
  }

  async records({ manifestId, limit = 200 } = {}) {
    if (!manifestId) return { manifestId: null, events: [] };
    const root = join(this.distributionRoot, encodeURIComponent(manifestId));
    const events = await readVerificationLog(root, { limit });
    return { manifestId, events };
  }
}
