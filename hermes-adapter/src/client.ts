/**
 * Hermes 的 HTTP 客户端。
 *
 * 只碰 `api_server` 的两组接口：运行（`/v1/runs`）与运行事件流。这一层不依赖 DSH，
 * 因此可以脱离运行时单独验证；错误一律翻成 {@link HermesError}，把状态码与 Hermes 的
 * 错误码原样带给上层，由上层决定重试与呈现。
 * @module @chatdsh/hermes-adapter/client
 */

import type { ApprovalChoice, ChatRunEvent } from '@chatdsh/core-contracts';

/** 一次调用的操作名，用于错误定位与遥测属性。 */
export type HermesOperation = 'create-run' | 'stream' | 'approval' | 'steer' | 'stop' | 'health';

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

  constructor(operation: HermesOperation, message: string, options: { status?: number; code?: string } = {}) {
    super(message);
    this.name = 'HermesError';
    this.operation = operation;
    this.status = options.status;
    this.code = options.code ?? 'hermes-error';
  }
}

/** 审批选项到 Hermes 取值的映射。 */
const CHOICE: Readonly<Record<string, string>> = {
  'allowed-once': 'once',
  'allowed-session': 'session',
  'allowed-always': 'always',
  rejected: 'deny',
};

/** 从响应体里取错误码；取不到时用状态码兜底。 */
async function errorCodeOf(response: Response): Promise<string> {
  const text = await response.text();
  if (text === '') return `http-${response.status}`;
  const parsed = JSON.parse(text) as { error?: unknown };
  return typeof parsed.error === 'string' ? parsed.error : `http-${response.status}`;
}

/**
 * 把一条 Hermes 的 SSE 数据翻译成契约事件。
 *
 * Hermes 的数据形状是 `{ event, run_id, seq, ... }`，事件名在 `event` 字段里；旧版
 * 兼容形状把事件名放在 `type`。两种都认，字段名按事件名区分：
 * `message.delta` 与 `output.delta` 都算文本增量，`run.completed` 带 `output` 与 `usage`。
 */
function translate(runId: string, payload: Record<string, unknown>): ChatRunEvent | undefined {
  const name = typeof payload.event === 'string' ? payload.event : typeof payload.type === 'string' ? payload.type : '';
  switch (name) {
    case 'message.delta':
    case 'output.delta':
    case 'text':
      return typeof payload.delta === 'string'
        ? { type: 'text', text: payload.delta }
        : typeof payload.text === 'string'
          ? { type: 'text', text: payload.text }
          : undefined;
    case 'reasoning.available':
    case 'reasoning':
      return typeof payload.text === 'string' ? { type: 'reasoning', text: payload.text } : undefined;
    case 'tool.call':
    case 'tool_call':
      return typeof payload.call_id === 'string' && typeof payload.name === 'string'
        ? { type: 'tool-call', callId: payload.call_id, name: payload.name }
        : undefined;
    case 'approval.request':
    case 'approval.requested': {
      if (typeof payload.request_id !== 'string') return undefined;
      const choices = Array.isArray(payload.choices) ? payload.choices.filter((item): item is ApprovalChoice => typeof item === 'string') : [];
      return {
        type: 'approval-request',
        runId,
        requestId: payload.request_id,
        title: typeof payload.title === 'string' ? payload.title : '',
        choices,
      };
    }
    case 'run.completed':
    case 'finish': {
      const interrupted = payload.interrupted === true;
      const reason = payload.reason;
      const allowed = interrupted || reason === 'cancelled' ? 'cancelled' : reason === 'error' ? 'error' : 'stop';
      return { type: 'finish', reason: allowed };
    }
    case 'run.failed':
    case 'error':
      return {
        type: 'error',
        code: 'unsupported',
        detail: typeof payload.code === 'string' ? payload.code : undefined,
      };
    default:
      return undefined;
  }
}

/** 一次运行的句柄。 */
export interface HermesRunHandle {
  readonly runId: string;
}

/**
 * Hermes 客户端。
 *
 * 所有方法在非 2xx 时抛 {@link HermesError}，`status` 与 `code` 原样保留。
 */
export class HermesClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(private readonly config: HermesConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    const key = config.apiKeyEnv === undefined ? undefined : process.env[config.apiKeyEnv];
    this.headers = key === undefined
      ? { 'Content-Type': 'application/json' }
      : { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
  }

  /** 发起一次运行。 */
  async createRun(sessionId: string, text: string): Promise<HermesRunHandle> {
    const response = await this.request('create-run', '/v1/runs', {
      method: 'POST',
      // Hermes 的 /v1/runs 要求 input 字段；写 message 会得到 400 invalid_request_error。
      body: JSON.stringify({ session_id: sessionId, input: text }),
      headers: { ...this.headers, 'X-Hermes-Session-Id': sessionId },
    });
    const payload = (await response.json()) as { run_id?: unknown };
    if (typeof payload.run_id !== 'string') throw new HermesError('create-run', 'Hermes 没有返回 run_id');
    return { runId: payload.run_id };
  }

  /** 读取一次运行的事件流，逐条翻译成契约事件。 */
  async *streamEvents(runId: string): AsyncIterable<ChatRunEvent> {
    const response = await this.request('stream', `/v1/runs/${encodeURIComponent(runId)}/events`, {
      method: 'GET',
      headers: { ...this.headers, Accept: 'text/event-stream' },
    });
    if (response.body === null) throw new HermesError('stream', 'Hermes 的事件流没有响应体');
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary = buffer.indexOf('\n');
      while (boundary >= 0) {
        const line = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 1);
        if (line.startsWith('data: ')) {
          const event = translate(runId, JSON.parse(line.slice(6)) as Record<string, unknown>);
          if (event !== undefined) yield event;
        }
        boundary = buffer.indexOf('\n');
      }
    }
  }

  /** 回答一次审批请求。 */
  async respondApproval(runId: string, requestId: string, choice: ApprovalChoice): Promise<void> {
    await this.request('approval', `/v1/runs/${encodeURIComponent(runId)}/approval`, {
      method: 'POST',
      body: JSON.stringify({ request_id: requestId, choice: CHOICE[choice] ?? 'deny' }),
    });
  }

  /** 中途干预。 */
  async steer(runId: string, text: string): Promise<void> {
    await this.request('steer', `/v1/runs/${encodeURIComponent(runId)}/steer`, {
      method: 'POST',
      body: JSON.stringify({ message: text }),
    });
  }

  /** 终止一次运行。 */
  async stop(runId: string): Promise<void> {
    await this.request('stop', `/v1/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST' });
  }

  /** 探活；网络失败返回 false，非 2xx 也返回 false。 */
  async probe(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        headers: this.headers,
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async request(operation: HermesOperation, path: string, init: RequestInit): Promise<Response> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...this.headers, ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });
    if (!response.ok) {
      const code = await errorCodeOf(response);
      throw new HermesError(operation, `Hermes ${operation} 返回 ${response.status}：${code}`, { status: response.status, code });
    }
    return response;
  }
}

/**
 * 建立客户端。
 * @param config - 地址、凭据环境变量名与两个超时。
 * @returns 客户端。
 */
export function createHermesClient(config: HermesConfig): HermesClient {
  return new HermesClient(config);
}
