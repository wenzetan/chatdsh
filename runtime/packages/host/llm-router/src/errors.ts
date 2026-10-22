/**
 * 上游失败的分类。
 *
 * 非 2xx 的响应内容原样交给调用方：状态码、`content-type` 与响应体原文字段都保留，
 * 用户看到的是上游给出的拒绝说明。这里只额外给一个稳定错误码，供重试策略与遥测分支：
 * 额度与余额耗尽归为 `QUOTA`，401 与 403 归为 `AUTH`，5xx 归为 `UPSTREAM`，其余 4xx
 * 归为 `INVALID_REQUEST`，网络失败归为 `TRANSPORT`。
 * @module @chatdsh/host-llm-router/errors
 */

import { LlmError, QUOTA_EXCEEDED_CODE } from '@chatdsh/adapter';

/** 失败时带回的事实。 */
export interface UpstreamFailureInput {
  /** HTTP 状态；网络失败时缺省。 */
  readonly status?: number;
  /** 上游错误体里给出的错误码，只用于分类。 */
  readonly upstreamCode?: string;
  /** 上游响应体的原文；网络失败时缺省。 */
  readonly body?: string;
  /** 上游响应的 `content-type`。 */
  readonly contentType?: string;
  /** 底层原因。 */
  readonly cause?: unknown;
}

/** 上游返回的错误。正文与响应头保留，调用方可直接展示给用户。 */
export class LlmUpstreamError extends LlmError {
  /** 上游 HTTP 状态；网络失败时缺省。 */
  readonly status: number | undefined;

  /** 上游响应体的原文。 */
  readonly body: string | undefined;

  /** 上游响应的 `content-type`。 */
  readonly contentType: string | undefined;

  /** 上游错误体里给出的错误码。 */
  readonly upstreamCode: string | undefined;

  constructor(code: string, input: UpstreamFailureInput) {
    const message = input.body === undefined
      ? `模型网关不可达`
      : `模型网关返回 HTTP ${String(input.status ?? 0)}：${input.body}`;
    super(message, code, input.status === undefined ? { cause: input.cause } : { status: input.status, cause: input.cause });
    this.name = 'LlmUpstreamError';
    this.status = input.status;
    this.body = input.body;
    this.contentType = input.contentType;
    this.upstreamCode = input.upstreamCode;
  }
}

/**
 * 按状态码与错误码给一次上游失败分类。
 * @param input - 状态、上游错误码与响应原文。
 * @returns 可抛出的异常。
 */
export function mapUpstreamFailure(input: UpstreamFailureInput): LlmUpstreamError {
  const status = input.status ?? 0;
  const upstream = input.upstreamCode ?? '';
  if (status === 402 || status === 429 || /quota|balance|insufficient|credit/i.test(upstream)) {
    return new LlmUpstreamError(QUOTA_EXCEEDED_CODE, input);
  }
  if (status === 401 || status === 403) return new LlmUpstreamError('AUTH', input);
  if (status >= 500) return new LlmUpstreamError('UPSTREAM', input);
  if (status === 0) return new LlmUpstreamError('TRANSPORT', input);
  return new LlmUpstreamError('INVALID_REQUEST', input);
}
