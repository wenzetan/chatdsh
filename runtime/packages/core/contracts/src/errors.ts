/**
 * 跨组件的错误码。
 *
 * 错误码同时是遥测的 `error.code` 取值，因此每个码都要能在 OpenObserve 里按码聚合。
 * 命名规则是小写连字符，按域分段，例如 `telemetry-disabled`、`device-offline`。
 * 全部错误码在本文件集中定义，其他契约文件只引用这里的取值与校验器。
 * @module @chatdsh/core-contracts/errors
 */

import { z } from 'zod';

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

  /** 请求字段缺失、类型不符或超出产品限制。 */
  requestInvalid: 'request-invalid',
  /** 内部服务或存储故障，响应不暴露异常原文。 */
  internalError: 'internal-error',
  /** 写入携带的 revision 落后于服务端保存的版本，禁止覆盖另一客户端修改。 */
  revisionConflict: 'revision-conflict',
  /** 同一操作标识携带了不同的请求摘要。 */
  operationDigestMismatch: 'operation-digest-mismatch',
  /** 写入结果尚未确认，必须先查询实际结果再决定。 */
  writeUnconfirmed: 'write-unconfirmed',
  /** 操作标识不存在或已过期。 */
  operationNotFound: 'operation-not-found',
  /** 分页游标无法解码或已失效。 */
  cursorInvalid: 'cursor-invalid',
  /** 请求频率超过限流阈值。 */
  rateLimited: 'rate-limited',
  /** 当前访问会话缺少该动作需要的权限。 */
  permissionDenied: 'permission-denied',
  /** 目标对象不存在。 */
  objectNotFound: 'object-not-found',
  /** 目标对象已被处理，重复提交不再生效。 */
  alreadyHandled: 'already-handled',
  /** 对象或凭据已过期。 */
  expired: 'expired',
  /** 请求体或上传内容超过配额。 */
  payloadTooLarge: 'payload-too-large',

  /** 密码、通行密钥、一次性验证码或恢复码校验失败。 */
  authInvalid: 'auth-invalid',
  /** 连续失败后访问进入锁定期。 */
  authLocked: 'auth-locked',
  /** 认证尝试被限流。 */
  authRateLimited: 'auth-rate-limited',
  /** 敏感动作需要再次认证。 */
  reauthRequired: 'reauth-required',
  /** TOTP 验证码不正确或时间片已被使用。 */
  totpInvalid: 'totp-invalid',
  /** 通行密钥断言被拒绝。 */
  passkeyRejected: 'passkey-rejected',
  /** 恢复码无效或已被消费。 */
  recoveryCodeInvalid: 'recovery-code-invalid',
  /** 该动作会移除最后一种可用的验证方式，禁止执行。 */
  lastFactorRequired: 'last-factor-required',
  /** 请求来源与固定的同源地址不符。 */
  originRejected: 'origin-rejected',
  /** CSRF 令牌缺失或不匹配。 */
  csrfRejected: 'csrf-rejected',
  /** 访问会话已被撤销或已到期。 */
  accessSessionRevoked: 'access-session-revoked',
  /** 一次性连接票据已过期。 */
  ticketExpired: 'ticket-expired',

  /** 设备不在登记范围内。 */
  deviceUnknown: 'device-unknown',
  /** 节点令牌或手机令牌已被撤销。 */
  deviceTokenRevoked: 'device-token-revoked',
  /** 配对码不正确。 */
  pairingCodeInvalid: 'pairing-code-invalid',
  /** 配对码已过期或被消费。 */
  pairingCodeExpired: 'pairing-code-expired',
  /** 配对尝试被限流。 */
  pairingRateLimited: 'pairing-rate-limited',
  /** 设备角色不允许该动作。 */
  deviceRoleMismatch: 'device-role-mismatch',

  /** 推送端点已失效，订阅需要重新确认。 */
  pushEndpointGone: 'push-endpoint-gone',
  /** 浏览器或系统拒绝通知权限。 */
  pushPermissionDenied: 'push-permission-denied',
  /** 当前载体不支持系统通知或 Web Push。 */
  pushUnsupported: 'push-unsupported',
  /** 通知记录不存在或不属于当前访问客户端。 */
  notificationRejected: 'notification-rejected',

  /** bank 标识未在配置里登记。 */
  memoryBankUnknown: 'memory-bank-unknown',
  /** 召回令牌上限超出产品与服务端范围。 */
  memoryLimitOutOfRange: 'memory-limit-out-of-range',
  /** 记忆组标识不存在。 */
  memoryGroupUnknown: 'memory-group-unknown',
  /** 召回超过超时时间，当前回合继续执行。 */
  memoryRecallTimeout: 'memory-recall-timeout',

  /** 导出格式与源内容能力不匹配。 */
  exportFormatUnsupported: 'export-format-unsupported',
  /** 导出并发额度已满。 */
  exportBusy: 'export-busy',
  /** 下载地址已失效，需要重新生成。 */
  exportExpired: 'export-expired',
  /** 导出内容超过配额。 */
  exportTooLarge: 'export-too-large',
  /** 附件内容已丢失。 */
  attachmentMissing: 'attachment-missing',
  /** 附件只在源设备上可用。 */
  attachmentNeedsSourceDevice: 'attachment-needs-source-device',

  /** 设置区段不存在。 */
  settingsUnknownSection: 'settings-unknown-section',
  /** 设置字段在当前位置只读。 */
  settingsReadonly: 'settings-readonly',
  /** 设置作用范围与携带的设备不一致。 */
  settingsScopeMismatch: 'settings-scope-mismatch',
  /** 命名空间不在跨设备同步白名单内。 */
  namespaceNotWhitelisted: 'namespace-not-whitelisted',

  /** 导航消息被内容端拒绝。 */
  navigationRejected: 'navigation-rejected',
  /** 导航在等待时限内没有收到确认。 */
  navigationTimeout: 'navigation-timeout',
  /** 消息 schema 校验失败。 */
  messageSchemaInvalid: 'message-schema-invalid',
  /** 消息来源与握手登记的对端不符。 */
  messageSourceMismatch: 'message-source-mismatch',
  /** 内容端尚未完成握手，导航消息暂不接收。 */
  navigationNotReady: 'navigation-not-ready',

  /** 审批决定缺少工具调用标识或状态版本。 */
  approvalMissingCorrelation: 'approval-missing-correlation',
  /** 审批已被另一客户端处理。 */
  approvalAlreadyDecided: 'approval-already-decided',
  /** 审批卡片已失效。 */
  approvalExpired: 'approval-expired',
  /** 请求的审批选项不在实际策略能力内。 */
  approvalChoiceUnsupported: 'approval-choice-unsupported',
  /** 提问应答缺少问题标识或状态版本。 */
  questionMissingCorrelation: 'question-missing-correlation',
  /** 提问卡片已失效。 */
  questionExpired: 'question-expired',
  /** 提问应答与问题 schema 不符。 */
  questionInvalid: 'question-invalid',
  /** 停止请求未被宿主确认。 */
  stopUnconfirmed: 'stop-unconfirmed',

  /** 历史版本不可改写。 */
  artifactVersionImmutable: 'artifact-version-immutable',
  /** 制品版本不存在。 */
  artifactVersionUnknown: 'artifact-version-unknown',

  /** 自动化签名校验失败。 */
  webhookSignatureInvalid: 'webhook-signature-invalid',
  /** 自动化引用的密钥环境变量缺失。 */
  automationSecretMissing: 'automation-secret-missing',
  /** 自动化投递结果尚未确认。 */
  automationDeliveryUnconfirmed: 'automation-delivery-unconfirmed',

  /** 同一副本序号写入了不同内容摘要。 */
  replicaContentConflict: 'replica-content-conflict',
  /** 副本不存在或尚未建立。 */
  replicaUnavailable: 'replica-unavailable',
  /** 副本读取不完整。 */
  replicaReadIncomplete: 'replica-read-incomplete',
  /** 对象被有效分享或导入引用，删除需要逐项确认。 */
  objectInUse: 'object-in-use',
  /** 软删除记录已过保留期，无法恢复。 */
  restoreExpired: 'restore-expired',
  /** 同一范围已有清理任务在执行。 */
  cleanupInProgress: 'cleanup-in-progress',
  /** 副本保留周期超出允许范围。 */
  replicaRetentionInvalid: 'replica-retention-invalid',

  /** 分享内容范围不合法。 */
  shareScopeInvalid: 'share-scope-invalid',
} as const;

/** 错误码取值。 */
export type ChatdshErrorCode = (typeof CHATDSH_ERROR_CODES)[keyof typeof CHATDSH_ERROR_CODES];

/** 全部错误码的数组形式，供校验器与清单遍历使用。 */
export const CHATDSH_ERROR_CODE_VALUES: readonly ChatdshErrorCode[] = Object.values(CHATDSH_ERROR_CODES);

/** 错误码校验器。未登记的取值直接抛出。 */
export const chatdshErrorCodeSchema = z.enum(CHATDSH_ERROR_CODE_VALUES);

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
