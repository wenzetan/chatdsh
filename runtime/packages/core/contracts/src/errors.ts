/**
 * 跨组件的错误码。
 *
 * 错误码同时是遥测的 `error.code` 取值，因此每个码都要能在 OpenObserve 里按码聚合。
 * 命名规则是小写连字符，按域分段，例如 `telemetry-disabled`、`device-offline`。
 * @module @chatdsh/core-contracts/errors
 */

/** 全部错误码。 */
export const CHATDSH_ERROR_CODES = {
  /** 遥测被关闭，自检端点拒绝执行。 */
  telemetryDisabled: 'telemetry-disabled',
  /** 额度不足，模型调用被拒绝，禁止进入可恢复失败的重试路径。 */
  quotaExceeded: 'quota-exceeded',
  /** 目标设备离线，请求不被排队也不回退到宿主机执行。 */
  deviceOffline: 'device-offline',
  /** 会话所属设备与请求路由不一致。 */
  deviceMismatch: 'device-mismatch',
  /** 会话不存在或已被软删除。 */
  sessionNotFound: 'session-not-found',
  /** 分享令牌无效、已过期或已撤销。 */
  shareUnavailable: 'share-unavailable',
  /** 工作区归属判定失败。 */
  workspaceForbidden: 'workspace-forbidden',
  /** 会话副本落后于权威日志，导入前需要用户确认。 */
  replicaBehind: 'replica-behind',
  /** 聊天后端不可达。 */
  chatBackendUnreachable: 'chat-backend-unreachable',
  /** 记忆后端不可达，写入进入本地待写队列。 */
  memoryBackendUnreachable: 'memory-backend-unreachable',
  /** 连接器凭据缺失或已失效。 */
  connectorCredentialMissing: 'connector-credential-missing',
  /** 扩展包声明的权限或版本不满足安装要求。 */
  extensionRejected: 'extension-rejected',
  /** 应用会话缺失或已过期。 */
  authRequired: 'auth-required',
  /** 桌面控制能力在该节点不可用。 */
  computerUseUnavailable: 'computer-use-unavailable',
  /** 桌面控制注册位已被占用，需要重启宿主进程。 */
  computerUseBusy: 'computer-use-busy',
  /** 动作可能已下发，重试前必须重新读取状态。 */
  actionMayHaveLanded: 'action-may-have-landed',
} as const;

/** 错误码取值。 */
export type ChatdshErrorCode = (typeof CHATDSH_ERROR_CODES)[keyof typeof CHATDSH_ERROR_CODES];

/** 带错误码的异常。业务侧用它在错误位置就地抛出，不做事后猜测。 */
export class ChatdshError extends Error {
  /** 稳定的错误码，写入遥测的 `error.code`。 */
  readonly code: ChatdshErrorCode;
  /** 附加说明字段，只放枚举值、标识与计数，不放原文。 */
  readonly details: Readonly<Record<string, string | number | boolean>>;

  constructor(code: ChatdshErrorCode, message: string, details: Record<string, string | number | boolean> = {}) {
    super(message);
    this.name = 'ChatdshError';
    this.code = code;
    this.details = details;
  }
}
