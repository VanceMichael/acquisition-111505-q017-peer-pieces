export const initialState = () => ({ name: '授权资料中继', revision: 1 });

import { createHash } from 'node:crypto';
const raw = Buffer.from('AAAAABBBBBCCCCC'); const pieceLength = 8;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function handle({ url, state, json, bytes }) {
  const manifestId = `tour-${state.revision}`;
  if (url.pathname === '/distribution') { json(200, { manifestId, pieceLength, pieces: [hash(raw.subarray(0, 8)), hash(raw.subarray(8))],
    files: [{ path: 'hall-a/intro.txt', offset: 0, length: 5 }, { path: 'hall-b/intro.txt', offset: 5, length: 5 }, { path: 'hall-c/intro.txt', offset: 10, length: 5 }], authorizedFiles: ['hall-a/intro.txt'] }); return true; }
  if (url.pathname === '/peers') { json(200, [{ id: 'relay-a', href: '/relay/a', manifestId: state.stale ? 'tour-0' : manifestId, availablePieces: [0, 1] }, { id: 'relay-b', href: '/relay/b', manifestId, availablePieces: [0, 1] }]); return true; }
  if (/^\/relay\/[ab]\/piece\/\d+$/.test(url.pathname)) {
    const index = Number(url.pathname.split('/').at(-1)); if (index !== 0) { json(403, { error: '该片不与获准文件相交' }); return true; }
    let content = Buffer.from(raw.subarray(index * pieceLength, (index + 1) * pieceLength)); if (state.corrupt && url.pathname.includes('/a/')) content[0] ^= 1;
    bytes(200, content, 'application/octet-stream', { 'x-manifest-id': state.stale && url.pathname.includes('/a/') ? 'tour-0' : manifestId }); return true;
  }
  return false;
}
