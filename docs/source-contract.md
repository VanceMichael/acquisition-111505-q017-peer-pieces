# 合作来源约定

## 资料边界

/distribution 返回 manifestId、pieceLength、pieces 的 SHA256、files(path,length,offset) 和 authorizedFiles。逻辑包按文件顺序连续，末片可短。/peers 返回中继及其 manifestId/availablePieces；GET /piece/{index} 回应 x-manifest-id。中继请求只允许 manifestId 授权范围相交的片，片按清单整片验证后才可切出文件区间。摘要是内容身份，path 仍是资料归属。

## 本地服务

来源和收件端是两个独立 HTTP 监听器。来源 `/health` 报告运行状态，`/__state` 返回当前情景；仅本地使用的 `POST /__control` 可改变来源情景，不属于收件端的业务 API。具体情景字段在 `provider/scenario.mjs` 的 `initialState` 中定义，切换只影响后续来源响应，不会改写已有收件。探查入口为 `/distribution`，请求相对链接必须以实际来源地址解释。

## 已有归档约定

人工入口只接收人工确认过的结构化对象，并不验证自动来源完整性。`Archive.accept(source, identity, data, raw)` 把原始字节按摘要保存，并为同一来源与身份保留不同版本。`source` 和 `identity` 的选择必须与业务对象对应，正文摘要只用于原文复用，不代表两份业务记录相同。`src/transport.mjs` 仅提供一次请求，不包含自动分页、协议解释或领域恢复策略。
