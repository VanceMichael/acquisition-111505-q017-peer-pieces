# 合作来源约定

## 资料边界

/distribution 返回 manifestId、pieceLength、pieces 的 SHA256、files(path,length,offset) 和 authorizedFiles。逻辑包按文件顺序连续，末片可短。/peers 返回中继及其 manifestId/availablePieces；GET /piece/{index} 回应 x-manifest-id。中继请求只允许 manifestId 授权范围相交的片，片按清单整片验证后才可切出文件区间。摘要是内容身份，path 仍是资料归属。

## 本地服务

来源和收件端是两个独立 HTTP 监听器。来源 `/health` 报告运行状态，`/__state` 返回当前情景；仅本地使用的 `POST /__control` 可改变来源情景，不属于收件端的业务 API。具体情景字段在 `provider/scenario.mjs` 的 `initialState` 中定义，切换只影响后续来源响应，不会改写已有收件。探查入口为 `/distribution`，请求相对链接必须以实际来源地址解释。

## 已有归档约定

人工入口只接收人工确认过的结构化对象，并不验证自动来源完整性。`Archive.accept(source, identity, data, raw)` 把原始字节按摘要保存，并为同一来源与身份保留不同版本。`source` 和 `identity` 的选择必须与业务对象对应，正文摘要只用于原文复用，不代表两份业务记录相同。`src/transport.mjs` 仅提供一次请求，不包含自动分页、协议解释或领域恢复策略。

## 自动领取约定

收件端的自动领取（`src/acquisition.mjs`）是上述协议的接收方实现，约束如下：

- 只向显式配置的来源地址及其 `/peers` 公布的相对链接发请求，相对链接以来源地址为基准解释；不做公网发现、主动做种或清单外下载。
- 选择集合必须是清单 `authorizedFiles` 的子集；所需片由所选文件的 offset/length 与片几何求交得到，边界片整片领取并按 `pieces` 的 SHA256 整片验证，验证通过后才切出文件区间，禁止按文件大小直接截断。
- 中继的 `manifestId` 与回包 `x-manifest-id` 必须与当前清单一致；不一致的中继在候选阶段剔除或在回包阶段拒绝，不同分发版本的片永不混拼。
- 每个清单版本使用独立片库目录；损坏片、旧包回包只写验证记录不写片库，来源失败按中继切换并保留实际观测摘要与失败原因。
- 重启后逐片复核磁盘内容与已登记文件；迟到回包不得覆盖已确认的正确片，未选择的文件不得出现在完成登记中。

