# 自动分片领取设计

本文描述收件端自动来源接入的内部架构。来源侧协议（`/distribution`、`/peers`、`/piece/{index}`、`x-manifest-id`、授权相交 403）仍以 `docs/source-contract.md` 为准。

## 模块边界

- `src/manifest.mjs`：纯函数领域层。清单内在一致性校验、规范序列化与整包摘要、分片几何（`pieceRange`）、选择文件到所需分片的映射（`requiredPiecesForSelection`）、从已校验整片切文件区间（`extractFileBytes`）、版本同异判断（`assertSameManifest`）。
- `src/source-client.mjs`：HTTP 来源客户端，暴露 `getDistribution()/getPeers()/getPiece(peer,index)`。只连接显式配置的 http/https 地址，相对链接按来源基址解释，不跟随重定向，网络错误包装为 `SourceUnavailableError`。测试中的 `FakeSource` 实现同一接口以注入旧包、损坏片、延迟与错误码。
- `src/collection-store.mjs`：单个分发的持久化。所有读写经同一串行 Promise 链，文件写入采用“临时文件 + fsync + rename”，崩溃只可能保留上一个完整状态。
- `src/receiver.mjs`：领取编排引擎，不绑定 HTTP，可被服务接口或 CLI 复用。
- `src/errors.mjs`：领域错误类型，HTTP 层据此映射状态码。

## 分片与选择

逻辑包是文件顺序拼接的单一字节流，片边界与文件边界无关。文件 `f` 占据 `[offset, offset+length)`，其所需分片为 `floor(offset/pieceLength)` 到 `floor((offset+length-1)/pieceLength)` 的并集；多文件选择对该并集去重，因此相邻文件共享的边界片只领取、只校验一次。末片允许短于 `pieceLength`。任何文件字节都只能从“摘要已通过”的整片中切出，禁止按文件长度截断片。

## 领取与故障切换

1. 拉取并校验清单，计算规范摘要；在分发目录锁定清单，版本不符直接失败。
2. 规范化选择（必须存在且在 `authorizedFiles` 内），加载状态并对磁盘片逐一重算摘要完成重启核对。
3. 仅当存在缺失片时拉取 `/peers`；按 `manifestId` 过滤掉旧版本中继并记录 `peer_refused`。
4. 工作队列按并发度消费缺失片；单片在登记持有该片的中继间顺序尝试，中继优先级参考历史失败数与 id，保证确定性。
5. 每个响应先核对 `x-manifest-id`，再对整片计算 SHA256 与清单摘要比对：旧版本记 `stale_refused`，损坏记 `hash_mismatch` 并让中继进入冷却，随后切换候选。所有候选轮次用尽仍失败的片进入 `PieceUnavailableError`，任务失败且不登记任何文件。
6. 验证通过的片以 `<index>-<sha256>` 内容寻址落盘；已存在同摘要文件时复用而不覆盖。

## 迟到回包

单次取片由 `Promise.race` 竞速超时计时器与实际请求。超时即视为本次失败并切换来源；原请求若之后 resolve，其结果只写入一条 `late_reply_discarded` 日志，不参与哈希、不落盘。已确认片的写入路径只接受与清单摘要匹配的字节，因此迟到数据无法改写既有正确片。计时器在请求正常结束时清理并 `unref`，不会拖住进程退出。

## 持久化与重启

`state.json` 记录选择、每片的摘要/长度/来源/验证时间、已完成文件、各中继尝试计数与累计计数器。重启后：清单锁先核对规范摘要；磁盘片全部重算摘要，不符者重命名为 `.quarantined` 并从已校验集合剔除，随后作为缺失片重新领取；输出文件若存在且长度、摘要与完成记录一致则记 `file_reconfirmed`，否则用已校验片重组。汇总中的计数取本次运行相对运行开始快照的增量，避免与历史累计混淆。

## 安全边界

- 只访问调用方显式配置的来源，不实现任何公网发现、DHT、做种或上传。
- 输出路径经规范化校验，拒绝绝对路径与 `..` 越界，文件只能写入本分发的 `output/`。
- 不同 `manifestId` 使用不同分发目录；同目录的清单锁与规范摘要比较阻止版本混拼。
- 自动来源的归档身份固定为来源 `auto-relay` 与业务身份 `{manifest, path}`，与 `manual` 来源在同一归档体系内分桶，不会互相覆盖或混淆。
