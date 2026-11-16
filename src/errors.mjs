// 自动领取流程的领域错误：HTTP 层按类型映射状态码，便于切换来源与审计。
export class ManifestValidationError extends Error {
  constructor(message) { super(message); this.name = 'ManifestValidationError'; }
}
export class VersionMismatchError extends Error {
  constructor(message) { super(message); this.name = 'VersionMismatchError'; }
}
export class SourceUnavailableError extends Error {
  constructor(message) { super(message); this.name = 'SourceUnavailableError'; }
}
export class PieceUnavailableError extends Error {
  constructor(message, missing) { super(message); this.name = 'PieceUnavailableError'; this.missing = missing; }
}
export class AuthorizationError extends Error {
  constructor(message) { super(message); this.name = 'AuthorizationError'; }
}
