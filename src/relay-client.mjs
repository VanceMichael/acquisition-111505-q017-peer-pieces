import { request, decodeJson } from './transport.mjs';

export class PeerSourceError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'PeerSourceError';
    this.code = code;
  }
}

/**
 * 基于 docs/source-contract.md 的本地授权中继 HTTP 来源。
 * 只访问显式配置的来源地址及其公布的相对链接，不做任何公网发现或主动做种。
 */
export function createHttpPeerSource(sourceBase, { timeout = 5000, headers = {} } = {}) {
  const base = sourceBase.endsWith('/') ? sourceBase.slice(0, -1) : sourceBase;
  const authHeaders = { ...headers };

  async function getJson(path) {
    const reply = await request(base + path, { headers: authHeaders, signal: AbortSignal.timeout(timeout) });
    if (reply.status < 200 || reply.status > 299) {
      throw new PeerSourceError(`来源 ${path} 返回 ${reply.status}`, 'http-status');
    }
    try { return decodeJson(reply); }
    catch (error) { throw new PeerSourceError(`来源 ${path} 响应不是合法 JSON：${error.message}`, 'bad-payload'); }
  }

  return {
    id: base,
    async getDistribution() {
      return getJson('/distribution');
    },
    async listPeers() {
      const payload = await getJson('/peers');
      if (!Array.isArray(payload)) throw new PeerSourceError('/peers 应返回中继数组', 'bad-payload');
      return payload.map((entry, index) => {
        if (!entry || typeof entry !== 'object' || typeof entry.href !== 'string') {
          throw new PeerSourceError(`第 ${index} 个中继条目缺少 href`, 'bad-payload');
        }
        const href = new URL(entry.href, base + '/').href;
        return {
          id: String(entry.id || `relay-${index}`),
          href,
          manifestId: typeof entry.manifestId === 'string' ? entry.manifestId : null,
          availablePieces: Array.isArray(entry.availablePieces) ? entry.availablePieces.filter(Number.isInteger) : [],
        };
      });
    },
    /** 返回 { status, headers, bytes }；由领取引擎决定版本与摘要是否可接受。 */
    async fetchPiece(peer, index) {
      const url = `${peer.href.replace(/\/$/, '')}/piece/${index}`;
      const reply = await request(url, { headers: authHeaders, signal: AbortSignal.timeout(timeout) });
      return { status: reply.status, headers: reply.headers, bytes: reply.bytes, url };
    },
  };
}
