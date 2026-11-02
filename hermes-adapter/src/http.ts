/**
 * Hermes 的 HTTP 传输层。
 *
 * 只负责地址拼接、凭据头、超时与错误翻译。`/v1/runs` 的受理请求额外区分「确定未受理」
 * 与「受理结果未知」：连接被拒绝表示请求没有到达 Hermes，超时或连接中断则可能已经受理，
 * 后者不允许调用方换执行体重放。
 * @module @chatdsh/hermes-adapter/http
 */

import { HermesError, type HermesConfig, type HermesOperation } from './errors.ts';

/** 受理结果可能未知的操作。 */
const ACCEPTANCE_RISK: ReadonlySet<HermesOperation> = new Set(['create-run']);

/** 请求选项。 */
export interface HermesRequestInit extends RequestInit {
  /** 本次请求的超时；缺省取配置值。 */
  readonly timeoutMs?: number;
}

/** 从响应体里取错误码；空体用状态码兜底。 */
async function errorCodeOf(response: Response): Promise<string> {
  const text = await response.text();
  if (text === '') return `http-${response.status}`;
  const parsed = JSON.parse(text) as { error?: unknown };
  return typeof parsed.error === 'string' ? parsed.error : `http-${response.status}`;
}

/** 连接被拒绝一类的确定失败。 */
function refused(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown } }).cause;
  const code = typeof cause?.code === 'string' ? cause.code : '';
  return code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH';
}

/** 传输层。 */
export class HermesHttp {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(private readonly config: HermesConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    const key = config.apiKeyEnv === undefined ? undefined : process.env[config.apiKeyEnv];
    this.headers = key === undefined
      ? { 'Content-Type': 'application/json' }
      : { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
  }

  /** 发一次请求；非 2xx 抛 {@link HermesError}。 */
  async request(operation: HermesOperation, path: string, init: HermesRequestInit = {}): Promise<Response> {
    const timeout = AbortSignal.timeout(init.timeoutMs ?? this.config.requestTimeoutMs);
    const signal = init.signal === undefined || init.signal === null
      ? timeout
      : AbortSignal.any([init.signal, timeout]);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...this.headers, ...(init.headers as Record<string, string> | undefined) },
        signal,
      });
    } catch (error) {
      const certain = refused(error);
      const acceptanceUnknown = ACCEPTANCE_RISK.has(operation) && !certain;
      throw new HermesError(operation, `Hermes ${operation} 请求失败：${error instanceof Error ? error.message : String(error)}`, {
        code: acceptanceUnknown ? 'acceptance-unknown' : certain ? 'unreachable' : 'transport-failed',
        acceptanceUnknown,
        cause: error,
      });
    }
    if (!response.ok) {
      const code = await errorCodeOf(response);
      throw new HermesError(operation, `Hermes ${operation} 返回 ${response.status}：${code}`, {
        status: response.status,
        code,
      });
    }
    return response;
  }

  /**
   * 打开一条长连接流。
   *
   * 长连接不施加请求超时：事件之间的保活由服务端负责，取消只由调用方的信号触发。
   * @param operation - 操作名。
   * @param path - 相对路径。
   * @param init - 请求选项，`signal` 为唯一的中断来源。
   * @returns 成功的响应。
   */
  async openStream(operation: HermesOperation, path: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...this.headers, ...(init.headers as Record<string, string> | undefined) },
      });
    } catch (error) {
      throw new HermesError(operation, `Hermes ${operation} 连接失败：${error instanceof Error ? error.message : String(error)}`, {
        code: 'stream-open-failed',
        cause: error,
      });
    }
    if (!response.ok) {
      const code = await errorCodeOf(response);
      throw new HermesError(operation, `Hermes ${operation} 返回 ${response.status}：${code}`, {
        status: response.status,
        code,
      });
    }
    return response;
  }

  /** 凭据头，供流式请求复用。 */
  authHeaders(): Record<string, string> {
    return { ...this.headers };
  }

  /** 根地址，供流式请求拼接。 */
  root(): string {
    return this.baseUrl;
  }
}
