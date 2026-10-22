/**
 * 上游失败的映射。
 *
 * 控制平面用 HTTP 状态码与错误体表达拒绝，运行时侧只按状态码与错误码分支，不解析消息
 * 文本。额度与余额耗尽归并成 `QUOTA`；其余 4xx 归为 `AUTH` 或 `INVALID_REQUEST`；
 * 5xx 与网络错误归为 `TRANSPORT` 与 `UPSTREAM`。每个失败的 `code` 进入遥测的
 * `error.code`。
 * @module @chatdsh/host-llm-router/errors
 */

import { LlmError, QUOTA_EXCEEDED_CODE } from '@chatdsh/adapter';

/** 失败时带回的事实。 */
export interface UpstreamFailureInput {
  /** HTTP 状态；网络失败时缺省。 */
  readonly status?: number;
  /** 上游错误体里给出的错误码。 */
  readonly upstreamCode?: string;
  /** 简短说明，只放状态与错误码，不放请求体与模型输出。 */
  readonly detail: string;
  /** 底层原因。 */
  readonly cause?: unknown;
}

/** 上游返回的错误。 */
export class LlmUpstreamError extends LlmError {
  /** 上游 HTTP 状态；网络失败时缺省。 */
  readonly status: number | undefined;

  constructor(code: string, input: UpstreamFailureInput) {
    super(input.detail, code, input.status === undefined ? { cause: input.cause } : { status: input.status, cause: input.cause });
    this.name = 'LlmUpstreamError';
    this.status = input.status;
  }
}

/**
 * 把一次上游失败映射成带稳定错误码的异常。
 * @param input - 状态、上游错误码与说明。
 * @returns 可抛出的异常。
 */
export function mapUpstreamFailure(input: UpstreamFailureInput): LlmUpstreamError {
  const status = input.status ?? 0;
  const upstream = input.upstreamCode ?? '';
  if (status === 402 || status === 429 || /quota|balance|insufficient|credit/i.test(upstream)) {
    return new LlmUpstreamError(QUOTA_EXCEEDED_CODE, { ...input, detail: `模型网关拒绝：额度不足（HTTP ${status}）` });
  }
  if (status === 401 || status === 403) {
    return new LlmUpstreamError('AUTH', { ...input, detail: `模型网关拒绝：凭据无效（HTTP ${status}）` });
  }
  if (status >= 500) {
    return new LlmUpstreamError('UPSTREAM', { ...input, detail: `模型网关失败（HTTP ${status}）` });
  }
  if (status === 0) {
    return new LlmUpstreamError('TRANSPORT', { ...input, detail: '模型网关不可达' });
  }
  return new LlmUpstreamError('INVALID_REQUEST', { ...input, detail: `模型网关拒绝请求（HTTP ${status}）` });
}
