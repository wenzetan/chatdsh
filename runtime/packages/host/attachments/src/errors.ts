/**
 * 附件操作的错误码。
 *
 * 错误码同时用于遥测聚合与界面分支，集中定义在这里；业务代码在出错位置就地抛出，
 * 不做降级处理后继续执行。
 * @module @chatdsh/host-attachments/errors
 */

/** 附件可以抛出的错误码。 */
export const ATTACHMENT_ERROR_CODES = {
  /** 请求字段缺失或不合法。 */
  requestInvalid: 'request-invalid',
  /** 文件名带路径分隔符、控制字符或超出长度。 */
  nameInvalid: 'attachment-name-invalid',
  /** 字节数超过部署上限。 */
  tooLarge: 'attachment-too-large',
  /** 媒体类型不在允许范围内。 */
  typeRejected: 'attachment-type-rejected',
  /** 同一会话的附件数量超过上限。 */
  countExceeded: 'attachment-count-exceeded',
  /** 附件标识不存在。 */
  notFound: 'attachment-not-found',
  /** 内容文件读取失败或没有读取权限。 */
  readFailed: 'attachment-read-failed',
  /** 内容摘要与元数据不一致。 */
  contentCorrupt: 'attachment-content-corrupt',
  /** 制品库没有挂载，附件无法登记到制品库。 */
  storeUnavailable: 'attachment-store-unavailable',
  /** 内容文件写入失败。 */
  writeFailed: 'attachment-write-failed',
} as const;

/** 错误码取值。 */
export type AttachmentErrorCode = (typeof ATTACHMENT_ERROR_CODES)[keyof typeof ATTACHMENT_ERROR_CODES];

/** 带错误码的附件异常。 */
export class AttachmentError extends Error {
  /** 稳定的错误码，写入遥测的 `error.code`。 */
  readonly code: AttachmentErrorCode;

  /**
   * @param code - 稳定错误码。
   * @param message - 面向调用方的说明。
   */
  constructor(code: AttachmentErrorCode, message: string) {
    super(message);
    this.name = 'AttachmentError';
    this.code = code;
  }
}
