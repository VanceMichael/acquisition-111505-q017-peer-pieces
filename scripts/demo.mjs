import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createIntake } from '../src/server.mjs';
import { createProvider } from '../provider/server.mjs';

const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const intake = await createIntake(directory);
const provider = createProvider();
const post = (base, path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
try {
  intake.listen(0, '127.0.0.1'); provider.listen(0, '127.0.0.1');
  await Promise.all([once(intake, 'listening'), once(provider, 'listening')]);
  const base = `http://127.0.0.1:${intake.address().port}`;
  const source = `http://127.0.0.1:${provider.address().port}`;

  const sample = JSON.parse(await readFile(new URL('../fixtures/manual.json', import.meta.url), 'utf8'));
  const manual = await post(base, '/api/manual', sample);
  console.log(JSON.stringify({ 人工收件: await manual.json() }));

  // 自动领取：按清单授权选择文件，跨文件边界片整片校验后切出本馆文件。
  const first = await post(base, '/api/collect', { source });
  const firstBody = await first.json();
  console.log(JSON.stringify({ 首次自动领取: { 状态: first.status, 清单: firstBody.manifestId, 选择: firstBody.selection, 新领片: firstBody.fetched, 完成文件: firstBody.completedFiles.map(file => file.path) } }));

  // 重启语义：再次领取只核对已有片与已完成文件，不向任何中继请求分片。
  const second = await post(base, '/api/collect', { source });
  const secondBody = await second.json();
  console.log(JSON.stringify({ 再次领取核对: { 状态: second.status, 复用片: secondBody.reused, 新领片: secondBody.fetched, 已核对: secondBody.alreadyVerified } }));

  // 故障情景：来源切到旧包且片损坏，收件端拒绝旧版本并切换中继，验证过程写入日志。
  await fetch(source + '/__control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stale: true, corrupt: true }) });
  const freshDirectory = await mkdtemp(join(tmpdir(), 'intake-demo-fault-'));
  const faultIntake = await createIntake(freshDirectory);
  faultIntake.listen(0, '127.0.0.1');
  await once(faultIntake, 'listening');
  const faultBase = `http://127.0.0.1:${faultIntake.address().port}`;
  const fault = await post(faultBase, '/api/collect', { source });
  const faultBody = await fault.json();
  console.log(JSON.stringify({ 故障切换: { 状态: fault.status, 旧版本拒绝: faultBody.staleRefusals, 完成文件: faultBody.completedFiles.map(file => file.path), 验证日志: faultBody.verificationLog } }));
  faultIntake.closeAllConnections();
  await new Promise(resolve => faultIntake.close(resolve));
  await rm(freshDirectory, { recursive: true, force: true });

  console.log(JSON.stringify({ 全部登记: (await (await fetch(base + '/api/records')).json()).map(record => ({ 来源: record.source, 身份: record.identity, 版本数: record.versions.length })) }));
} finally {
  intake.closeAllConnections(); provider.closeAllConnections();
  await Promise.all([new Promise(resolve => intake.close(resolve)), new Promise(resolve => provider.close(resolve))]);
  await rm(directory, { recursive: true, force: true });
}
