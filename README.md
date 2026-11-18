# 协作分发包的跨文件分片选择性领取

这是面向资料接收人员的 Node.js 服务。提供人工收件、原始字节保管、业务身份版本记录和收件查询；同时实现按清单的**选择性分片自动领取**：各馆只领取自己负责展厅的文件，横跨两个文件的共享边界片按整片校验后切开复用，未选中的文件不会被登记为已接收。本地来源独立提供合作方交互环境。不包含公网发现、做种或任何未授权下载。

## 环境

支持 Node.js 22.22.1 及以上的 22.x 补丁版本；项目 Dockerfile 仍固定原有镜像摘要以保证可复现，正式 Linux 基线另外在 Node.js 22.23.4 验证。运行期没有第三方包及公网数据依赖。`npm ci --ignore-scripts --no-audit --no-fund` 安装锁定环境，`npm run build` 检查所有模块语法，`npm test` 验证归档、清单几何、片库恢复、领取引擎与 HTTP 入口及来源行为。来源材料均为本地合成的业务样本，没有真实账号、个人材料或访问外部站点的要求。

`npm start` 同时启动收件服务 3200 和来源 4200；可分别通过 `PORT`、`SOURCE_PORT` 修改端口。`ARCHIVE_DIR` 指定收件目录，默认 `.local/archive`；自动领取的来源地址由 `SOURCE_URL` 指定，默认指向同机的本地来源。`npm run demo` 使用临时目录和系统分配端口展示选择性领取、损坏切换、旧包剔除与重启核对，结束即清理，通常只需数秒。

## 自动领取

`POST /api/collect` 启动一次领取任务，请求体为 `{ "selected": ["hall-a/intro.txt"], "concurrency": 4 }`；`selected` 缺省时取清单 `authorizedFiles` 全集，任何不在授权范围内的路径直接拒绝。同一时间只允许一个领取任务，重复请求返回 409。`GET /api/collect/status` 查询任务状态，`GET /api/collect/records?manifestId=...` 读取该清单版本的只追加验证记录。

领取流程：

1. 拉取 `/distribution` 清单并校验几何（文件连续排布、片数与总长度一致、摘要为 SHA256）。
2. 由选中文件的全局 offset/length 计算所需片索引；横跨已选与未选文件的边界片整片领取、整片校验，组装时只切出属于本馆文件的字节区间。
3. 拉取 `/peers`，只保留 `manifestId` 与当前清单一致的中继；旧包中继整体剔除并留痕，回包 `x-manifest-id` 不符同样拒绝，绝不混拼不同分发版本。
4. 每片按失败计数排序选择中继，网络错误、非 2xx、长度不符或摘要失败都自动切换下一个来源；所有来源均失败时该片标记未完成并返回 `piece-exhausted`，已验证片与全部验证记录保留。
5. 片齐后组装文件，仅登记被选择的文件；未选文件不产生任何接收记录。

## 持久化与重启

每个清单版本在 `ARCHIVE_DIR/distributions/<encodeURIComponent(manifestId)>/` 下独立存放：`pieces/<index>` 为已通过整片 SHA256 校验的片（按索引命名，只保留一个正确版本）、`files/<path>` 为组装并复核过的本馆文件、`state.json` 为已验证片/已登记文件/中继观察、`verification.log` 为只追加的实际验证记录（含观测摘要、期望摘要、中继标识与失败原因）。

重新打开片库时逐片重读重算摘要，不符即隔离；已登记文件必须能由当前已验证片重新拼出且摘要一致，否则撤销登记。迟到回包在片锁内裁决：已确认的正确片永不被覆盖，只追加一条复用记录。重复领取时所需片全部在库则零网络返回。

## 接口与目录

`POST /api/manual` 接收 `fixtures/manual.json` 同形的业务对象，`GET /api/records` 查询全部人工收件版本，`GET /health` 检查进程（含是否有领取任务在途）。人工记录身份字段为 manifest, path。同一身份与相同原文重复提交复用版本，内容变化保留旧版本；不同来源不能混淆。归档目录有按摘要保存的 blobs 和按业务身份保存的 receipts，自动领取与人工收件分目录存放、互不污染。

`src/` 为收件与传输：`manifest.mjs` 清单几何与校验、`piece-store.mjs` 持久化片库与重启核对、`relay-client.mjs` 中继 HTTP 客户端、`acquisition.mjs` 领取引擎、`collect-service.mjs` 任务封装；`provider/` 为独立来源服务，`fixtures/` 保留来源字节与人工记录，`test/` 验证现有行为。协议范围与局部身份约定见 `docs/source-contract.md`。
