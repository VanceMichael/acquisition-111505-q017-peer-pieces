import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createProvider } from '../provider/server.mjs';
async function withSource(context) {
  const service = createProvider(); service.listen(0, '127.0.0.1'); await once(service, 'listening');
  context.after(async () => { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); });
  const base = `http://127.0.0.1:${service.address().port}`;
  const control = value => fetch(base + '/__control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const post = (path, value) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  return { base, control, post };
}

test('授权文件只占共享分片一部分而分片有完整摘要', async context => {
  const { base } = await withSource(context); const manifest = await (await fetch(base + '/distribution')).json(); const raw = Buffer.from(await (await fetch(base + '/relay/b/piece/0')).arrayBuffer());
  assert.equal(raw.length, 8); assert.equal(manifest.files[0].length, 5); assert.equal(raw.subarray(0, 5).toString(), 'AAAAA');
  const { createHash } = await import('node:crypto'); assert.equal(createHash('sha256').update(raw).digest('hex'), manifest.pieces[0]);
  assert.equal((await fetch(base + '/relay/b/piece/1')).status, 403);
});
test('旧清单与损坏中继独立可观察', async context => {
  const { base, control } = await withSource(context); await control({ stale: true, corrupt: true });
  const bad = await fetch(base + '/relay/a/piece/0'); const good = await fetch(base + '/relay/b/piece/0'); assert.equal(bad.headers.get('x-manifest-id'), 'tour-0'); assert.notEqual(await bad.text(), await good.text());
});
