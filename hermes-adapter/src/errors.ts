/**
 * Hermes 适配器的错误形状与配置。
 *
 * 适配器只翻译协议，不决定重试。所有失败都带操作名、HTTP 状态与 Hermes 的错误码，
 * 上层据此区分限流、审批已失效与「受理结果未知」。最后一种单独标记，因为调用方
 * 既不能当作失败重放，也不能当作成功。
 * @module @chatdsh/hermes-adapter/errors
 */

/** 一次调用的操作名，用于错误定位与遥测属性。 */
export type HermesOperation =
  | 'capabilities'
  | 'create-run'
  | 'run-status'
  | 'stream'
  | 'approval'
  | 'steer'
  | 'stop'
  | 'health';

/** 适配器配置。 */
export interface HermesConfig {
  /** Hermes `api_server` 的根地址，例如 `http://127.0.0.1:8642`。 */
  readonly baseUrl: string;
  /** 凭据所在的环境变量名；凭据不从配置值读取。 */
  readonly apiKeyEnv?: string;
  /** 单次请求的超时。 */
  readonly requestTimeoutMs: number;
  /** 审批等待上限，与 Hermes 的 `approvals.timeout` 对齐。 */
  readonly approvalTimeoutMs: number;
}

/** Hermes 侧的一次调用失败。 */
export class HermesError extends Error {
  /** 失败的操作。 */
  readonly operation: HermesOperation;
  /** HTTP 状态码；网络失败时缺省。 */
  readonly status: number | undefined;
  /** Hermes 返回的错误码，例如 `approval_not_pending`、`rate_limited`。 */
  readonly code: string;
  /** 受理结果未知：请求可能已在 Hermes 侧开始执行。 */
  readonly acceptanceUnknown: boolean;

  constructor(
    operation: HermesOperation,
    message: string,
    options: { status?: number; code?: string; acceptanceUnknown?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'HermesError';
    this.operation = operation;
    this.status = options.status;
    this.code = options.code ?? 'hermes-error';
    this.acceptanceUnknown = options.acceptanceUnknown === true;
  }
}

/** Hermes 没有同时提供完整历史运行所需的能力。 */
export class HermesCapabilityError extends HermesError {
  /** 缺失的能力名，按检查顺序。 */
  readonly missing: readonly string[];

  constructor(operation: HermesOperation, missing: readonly string[], detail: string) {
    super(operation, `Hermes 缺少完整历史运行所需的能力：${missing.join('、')}。${detail}`, {
      code: 'capability-missing',
    });
    this.name = 'HermesCapabilityError';
    this.missing = [...missing];
  }
}
