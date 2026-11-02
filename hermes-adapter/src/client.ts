/**
 * Hermes 的 HTTP 客户端。
 *
 * 只碰 `api_server` 的两组接口：运行（`/v1/runs`）与运行事件流。这一层不依赖 DSH，
 * 因此可以脱离运行时单独验证；错误一律翻成 {@link HermesError}，把状态码与 Hermes 的
 * 错误码原样带给上层，由上层决定重试与呈现。这是旧版聊天后端用的简化接口；完整历史、
 * 精确审批与取消确认走 {@link createHermesHistoryRunBridge}。
 * @module @chatdsh/hermes-adapter/client
 */

import type { ApprovalChoice, ChatRunEvent } from '@chatdsh/core-contracts';
import { HermesError, type HermesConfig } from './errors.ts';
import { HermesHttp } from './http.ts';
import { readRunFrames, type RunFrame } from './run-stream.ts';

export { HermesCapabilityError, HermesError } from './errors.ts';
export type { HermesConfig, HermesOperation } from './errors.ts';

/** 审批选项到 Hermes 取值的映射；同时接受旧版契约的四个别名。 */
const CHOICE: Readonly<Record<string, string>> = {
  once: 'once',
  session: 'session',
  always: 'always',
  deny: 'deny',
  'allowed-once': 'once',
  'allowed-session': 'session',
  'allowed-always': 'always',
  rejected: 'deny',
};

/**
 * 把一帧事件翻译成契约事件；旧版接口只认文本、推理、工具调用、审批与终态。
 * @param runId - 运行标识。
 * @param frame - 已解析的一帧。
 * @returns 契约事件；无关事件返回 `undefined`。
 */
function translateLegacy(runId: string, frame: RunFrame): ChatRunEvent | undefined {
  const payload = frame.payload;
  switch (frame.type) {
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
      const choices = Array.isArray(payload.choices)
        ? payload.choices.filter((item): item is ApprovalChoice => typeof item === 'string')
        : [];
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
    case 'run.cancelled':
    case 'run.interrupted':
      return { type: 'finish', reason: 'cancelled' };
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
  private readonly http: HermesHttp;

  constructor(config: HermesConfig) {
    this.http = new HermesHttp(config);
  }

  /** 发起一次运行。 */
  async createRun(sessionId: string, text: string): Promise<HermesRunHandle> {
    const response = await this.http.request('create-run', '/v1/runs', {
      method: 'POST',
      // Hermes 的 /v1/runs 要求 input 字段；写 message 会得到 400 invalid_request_error。
      body: JSON.stringify({ session_id: sessionId, input: text }),
      headers: { 'X-Hermes-Session-Id': sessionId },
    });
    const payload = (await response.json()) as { run_id?: unknown };
    if (typeof payload.run_id !== 'string') throw new HermesError('create-run', 'Hermes 没有返回 run_id');
    return { runId: payload.run_id };
  }

  /** 读取一次运行的事件流，逐条翻译成契约事件。 */
  async *streamEvents(runId: string): AsyncIterable<ChatRunEvent> {
    const response = await this.http.openStream('stream', `/v1/runs/${encodeURIComponent(runId)}/events`, {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
    });
    if (response.body === null) throw new HermesError('stream', 'Hermes 的事件流没有响应体');
    for await (const frame of readRunFrames(response.body, { runId })) {
      const event = translateLegacy(runId, frame);
      if (event !== undefined) yield event;
    }
  }

  /** 回答一次审批请求。 */
  async respondApproval(runId: string, requestId: string, choice: ApprovalChoice): Promise<void> {
    await this.http.request('approval', `/v1/runs/${encodeURIComponent(runId)}/approval`, {
      method: 'POST',
      body: JSON.stringify({ request_id: requestId, choice: CHOICE[choice] ?? 'deny' }),
    });
  }

  /** 中途干预。 */
  async steer(runId: string, text: string): Promise<void> {
    await this.http.request('steer', `/v1/runs/${encodeURIComponent(runId)}/steer`, {
      method: 'POST',
      body: JSON.stringify({ message: text }),
    });
  }

  /** 终止一次运行。 */
  async stop(runId: string): Promise<void> {
    await this.http.request('stop', `/v1/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST' });
  }

  /** 探活；不可达或非 2xx 返回 false。 */
  async probe(): Promise<boolean> {
    try {
      const response = await this.http.request('health', '/health', { method: 'GET' });
      return response.ok;
    } catch {
      return false;
    }
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
