# 协作分发包的跨文件分片选择性领取

这是面向资料接收人员（各馆）的 Node.js 服务。它在保留人工收件的同时，实现了自动分片领取：按来源清单选择本馆负责展厅的文件，只向已配置的授权中继领取所需分片，整片通过 SHA256 校验后才切出文件区间，并把每次验证结果（含失败与切换）写入审计日志。不包含公网发现、做种或任何未授权下载。

## 环境

支持 Node.js 22.22.1 及以上的 22.x 补丁版本；项目 Dockerfile 仍固定原有镜像摘要以保证可复现，正式 Linux 基线另外在 Node.js 22.23.4 验证。运行期没有第三方包及公网数据依赖。`npm ci --ignore-scripts --no-audit --no-fund` 安装锁定环境，`npm run build` 检查所有模块语法，`npm test` 验证清单几何、归档、自动领取引擎与 HTTP 入口。来源材料均为本地合成的业务样本，没有真实账号、个人材料或访问外部站点的要求。

`npm start` 同时启动收件服务 3200 和来源 4200；可分别通过 `PORT`、`SOURCE_PORT` 修改端口。`ARCHIVE_DIR` 指定收件目录，默认 `.local/archive`。`npm run demo` 使用临时目录和系统分配端口，端到端演示人工收件、首次自动领取、重启核对复用与故障中继切换，结束即清理。

## 自动领取如何工作

- **按清单选文件**：`GET /distribution` 返回 `manifestId、pieceLength、pieces(SHA256)、files(path,offset,length[,sha256])、authorizedFiles`。收件端先校验清单内在一致性，并计算规范摘要（字段顺序无关）作为整包内容身份。
- **跨文件边界片整片处理**：逻辑包按文件顺序连续、末片可短。某文件需要的分片按其字节区间求出，即使横跨两个文件也按**整片领取、整片校验**，再从已校验片中切出本馆文件的字节区间——不会按文件大小截断分片而破坏摘要。未选中的文件不会被切出，也不会登记为本馆已接收。
- **只领取授权范围**：默认选择清单的 `authorizedFiles`，也可显式给出 `files`；非授权或不存在的路径直接拒绝。来源侧对不与授权文件相交的片返回 403，收件端把该失败计入验证记录。
- **故障切换与留痕**：`GET /peers` 返回中继及其 `manifestId/availablePieces`。与当前清单版本不一致的中继（旧包）在选择阶段即排除；同版本但返回损坏片的中继在整片哈希校验时被拒绝并进入冷却，引擎自动切换其他中继。每次尝试、哈希不符、旧版本拒绝、超时迟到回包丢弃、隔离与完成都以 NDJSON 追加写入 `verification.log`。
- **禁止混拼版本**：每个分发以 `manifestId` 独立成目录并锁定其规范摘要；同 `manifestId` 但内容不同、或同目录出现其他 `manifestId` 的清单都会触发 `VersionMismatchError`，绝不把不同分发版本的分片拼在一起。
- **重启核对**：已校验分片按内容摘要落盘。重启后对磁盘上每个片重算摘要核对，损坏或不符的片重命名为 `.quarantined` 隔离并重新领取；已完成且摘要匹配的输出文件只做再确认，不重复搬运。超时后才到达的迟到回包会被丢弃并记录，不能覆盖已确认的正确片。

## 接口与目录

- `POST /api/collect`：请求体 `{ "source": "http://127.0.0.1:4200", "files": ["hall-a/intro.txt"] }`。`source` 可省略，回退到 `SOURCE_URL` 环境变量再到默认本地来源；`files` 省略时使用清单的 `authorizedFiles`。成功返回 201 与领取汇总（新领片、复用片、哈希失败数、旧版本拒绝数、完成文件、验证日志路径等）。相同来源与选择的并发任务返回 409；来源不可达返回 502；授权问题 403；版本冲突 409；清单非法 422。
- `POST /api/manual` 接收 `fixtures/manual.json` 同形的业务对象；`GET /api/records` 查询全部收件版本（人工与自动来源分开，自动来源标识为 `auto-relay`，身份字段仍为 manifest、path）；`GET /api/collections` 列出本地分发目录与进行中的任务；`GET /health` 检查进程。
- 一次性命令行：`npm run collect -- [来源地址] [文件路径...]`（不带文件时领取全部授权文件），适合脚本化与容器内单次领取，失败时以非零退出码结束。

归档根目录（默认 `.local/archive`）下：`blobs/` 与 `receipts/` 保存按摘要的原始字节与业务身份版本；`collections/<manifestId>/` 保存 `manifest.json`（清单锁）、`state.json`（已校验片、完成文件、计数器）、`pieces/`（内容寻址的已校验片与 `.quarantined` 隔离件）、`output/`（重组出的本馆文件）和 `verification.log`（验证审计流）。所有状态写入都经临时文件原子 rename。

`src/` 为收件与传输（`manifest.mjs` 清单几何与摘要、`source-client.mjs` 来源客户端、`collection-store.mjs` 持久化、`receiver.mjs` 领取引擎、`server.mjs` HTTP 入口），`provider/` 为独立来源服务，`fixtures/` 保留来源字节与人工记录，`test/` 验证现有与新增行为。协议范围与局部身份约定见 `docs/source-contract.md`，自动领取的内部设计见 `docs/collection-design.md`。
