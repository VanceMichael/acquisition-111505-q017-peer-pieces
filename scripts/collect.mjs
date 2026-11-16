import { Archive } from '../src/archive.mjs';
import { Receiver } from '../src/receiver.mjs';
import { createHttpSource } from '../src/source-client.mjs';
import {
  AuthorizationError, ManifestValidationError, PieceUnavailableError,
  SourceUnavailableError, VersionMismatchError,
} from '../src/errors.mjs';

// 一次性领取：按清单选文件、向已配置中继领片并退出；不做公网发现或做种。
// 用法：node scripts/collect.mjs [来源地址] [文件路径...]
const sourceUrl = process.argv[2] || process.env.SOURCE_URL || 'http://127.0.0.1:4200';
const files = process.argv.slice(3);
const archiveDirectory = process.env.ARCHIVE_DIR || '.local/archive';

const archive = await new Archive(archiveDirectory).initialize();
const source = createHttpSource(sourceUrl, { timeout: Number(process.env.SOURCE_TIMEOUT || 5000) });
const receiver = new Receiver(source, archive, `${archiveDirectory}/collections`, {
  concurrency: Number(process.env.FETCH_CONCURRENCY || 4),
  timeout: Number(process.env.PIECE_TIMEOUT || 10000),
  cooldownMs: Number(process.env.PEER_COOLDOWN_MS || 5000),
});

try {
  const summary = await receiver.collect(files.length ? { files } : {});
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  const known = [AuthorizationError, ManifestValidationError, PieceUnavailableError, SourceUnavailableError, VersionMismatchError].some(type => error instanceof type);
  console.error(JSON.stringify({ error: error.message, type: error.name, missing: error.missing ?? null }));
  process.exitCode = known ? 2 : 1;
}
