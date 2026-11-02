/**
 * 部署子系统的错误形状。
 *
 * 每个失败分支在抛出位置就地给出稳定错误码、错误类型与 HTTP 状态，调用方不再事后猜测
 * 拒绝原因；错误码同时作为遥测的 `error.code` 取值，可以按码聚合。
 * @module @chatdsh/core-deployment/errors
 */

/** 拒绝来源的分类，写进遥测的 `error.type`。 */
export type DeploymentErrorType =
  | 'bind'
  | 'tls'
  | 'origin'
  | 'host'
  | 'proxy'
  | 'identity'
  | 'upgrade'
  | 'runtime'
  | 'bundle'
  | 'capability'
  | 'config';

/** 部署校验失败。 */
export class DeploymentError extends Error {
  /** 稳定错误码，小写连字符，按域分段。 */
  readonly code: string;
  /** 拒绝来源分类。 */
  readonly errorType: DeploymentErrorType;
  /** 回给客户端的 HTTP 状态码；启动阶段的错误没有响应，取 500。 */
  readonly status: number;

  constructor(code: string, errorType: DeploymentErrorType, status: number, message: string) {
    super(message);
    this.name = 'DeploymentError';
    this.code = code;
    this.errorType = errorType;
    this.status = status;
  }
}

/** 拒绝分支的判定结果：状态码、拒绝来源分类与稳定错误码。 */
export interface GuardRejection {
  readonly allowed: false;
  readonly status: number;
  readonly errorType: DeploymentErrorType;
  readonly errorCode: string;
}

/** 请求的来源分类，用于遥测的 `source` 属性与同源判定。 */
export type GuardSource = 'local' | 'proxy' | 'direct';
