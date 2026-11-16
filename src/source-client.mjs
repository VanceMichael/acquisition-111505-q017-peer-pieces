import { request } from './transport.mjs';
import { SourceUnavailableError, VersionMismatchError } from './errors.mjs';

// 只对接已配置的本地/授权 HTTP 来源，不做任何公网发现或未授权下载。
// 接口形态同时被内存假来源实现，收件引擎只依赖这三个方法，便于单元测试与故障注入。
export function createHttpSource(baseUrl, options = {}) {
  let base;
  try { base = new URL(baseUrl); }
  catch { throw new SourceUnavailableError(`来源地址无效：${baseUrl}`); }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new SourceUnavailableError('仅允许 http/https 来源');
  const timeout = options.timeout ?? 5000;

  const resolve = href => new URL(href, base);
  const call = async operation => {
    try { return await operation(); }
    catch (error) {
      if (error instanceof VersionMismatchError) throw error;
      throw new SourceUnavailableError(`来源请求失败：${error.message}`);
    }
  };

  return {
    kind: 'http',
    base: base.toString(),
    getDistribution() {
      return call(async () => {
        const reply = await request(resolve('/distribution'), { timeout });
        if (reply.status !== 200) throw new SourceUnavailableError(`/distribution 返回 ${reply.status}`);
        try { return JSON.parse(reply.bytes.toString('utf8')); }
        catch { throw new SourceUnavailableError('/distribution 不是有效 JSON'); }
      });
    },
    getPeers() {
      return call(async () => {
        const reply = await request(resolve('/peers'), { timeout });
        if (reply.status !== 200) throw new SourceUnavailableError(`/peers 返回 ${reply.status}`);
        try {
          const peers = JSON.parse(reply.bytes.toString('utf8'));
          if (!Array.isArray(peers)) throw new Error();
          return peers;
        } catch { throw new SourceUnavailableError('/peers 不是有效数组'); }
      });
    },
    // 按清单整片领取；来源侧负责授权相交校验，收件端仍核对版本头并按摘要整片验证。
    getPiece(peer, index) {
      return call(async () => {
        const href = peer.href.endsWith('/') ? `${peer.href}piece/${index}` : `${peer.href}/piece/${index}`;
        const reply = await request(resolve(href), { timeout });
        if (reply.status === 403 || reply.status === 404) {
          return { ok: false, status: reply.status, reason: `中继 ${peer.id} 不提供片 ${index}（${reply.status}）`, bytes: null, manifestId: null };
        }
        if (reply.status !== 200) {
          return { ok: false, status: reply.status, reason: `中继 ${peer.id} 返回 ${reply.status}`, bytes: null, manifestId: null };
        }
        const headerId = reply.headers['x-manifest-id'] ?? null;
        if (headerId && peer.manifestId && headerId !== peer.manifestId) {
          throw new VersionMismatchError(`中继 ${peer.id} 响应头版本 ${headerId} 与其登记版本 ${peer.manifestId} 不一致`);
        }
        return { ok: true, status: 200, bytes: reply.bytes, manifestId: headerId };
      });
    },
  };
}
