/**
 * Hermes 的完整历史运行桥接。
 *
 * 一次运行同时要求四件事：请求携带完整历史、事件即时到达、审批按 `run_id/request_id`
 * 精确关联、停止真正终止同一个运行。执行前先读 `/v1/capabilities`，缺任一能力就拒绝，
 * 不创建运行；受理结果未知时抛出的错误带 `acceptanceUnknown`，调用方不得转交其他执行体。
 * @module @chatdsh/hermes-adapter/history-run
 */

import { HermesCapabilityError, HermesError, type HermesConfig } from './errors.ts';
import { HermesHttp } from './http.ts';
import { historyDigestOf, type HistoryMessage } from './history.ts';
import { streamRunEvents, type HistoryRunEvent } from './run-stream.ts';
import type { ApprovalChoice } from '@chatdsh/core-contracts';

/** 桥接配置。 */
export interface HermesHistoryRunConfig extends HermesConfig {
  /** 停止确认等待上限，单位毫秒；超时报告未确认。 */
  readonly stopConfirmMs?: number;
  /** 停止确认的轮询间隔，单位毫秒。 */
  readonly stopPollMs?: number;
}

/** 完整历史运行必须具备的能力。 */
export const REQUIRED_HISTORY_RUN_FEATURES = [
  'run_submission',
  'run_events_sse',
  'approval_events',
  'run_approval_response',
  'run_stop',
  'run_status',
] as const;

/** 能力响应里用到的部分。 */
export interface HermesCapabilities {
  /** 服务端声明的默认模型。 */
  readonly model?: string;
  /** 能力开关。 */
  readonly features: Readonly<Record<string, unknown>>;
}

/** 发起一次完整历史运行。 */
export interface HistoryRunRequest {
  /** DSH 会话标识。 */
  readonly sessionId: string;
  /** 业务操作标识，作为 Hermes 的幂等键。 */
  readonly operationId: string;
  /** 完整消息序列，最后一条为本次用户输入。 */
  readonly messages: readonly HistoryMessage[];
  /** 稳定 system 文本。 */
  readonly system: string;
  /** 历史指纹。 */
  readonly historyDigest: string;
  /** 请求的模型标识。 */
  readonly model?: string;
  /** 权限上下文；桥接把它作为请求头传给受维护网关。 */
  readonly permissionContext?: string;
}

/** 运行受理结果。 */
export interface HistoryRunAdmission {
  /** 运行标识。 */
  readonly runId: string;
  /** 服务端受理状态。 */
  readonly status: string;
  /** 是否为幂等键重放。 */
  readonly replayed: boolean;
  /** 执行前确认的能力。 */
  readonly capabilities: HermesCapabilities;
}

/** 运行状态取值。 */
export const RUN_STATES = [
  'queued',
  'started',
  'running',
  'waiting_for_approval',
  'stopping',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
] as const;

/** 运行状态。 */
export type HermesRunState = (typeof RUN_STATES)[number];

/** 终态取值。 */
const TERMINAL_STATES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

/** 查询到的运行状态。 */
export interface RunStatusSnapshot {
  readonly runId: string;
  readonly status: HermesRunState;
  readonly terminal: boolean;
  readonly lastEvent?: string;
  readonly output?: string;
  readonly error?: string;
  readonly interrupted?: boolean;
  readonly partial?: boolean;
  readonly approval?: {
    readonly requestId: string;
    readonly title: string;
    readonly choices: readonly string[];
  };
}

/** 审批应答结果。 */
export type ApprovalAnswer =
  | { readonly outcome: 'accepted'; readonly requestId: string; readonly choice: string; readonly resolved: number }
  | { readonly outcome: 'stale'; readonly code: string };

/** 取消结果。 */
export interface CancelOutcome {
  /** confirmed 表示已经取得终态；unconfirmed 表示 2 秒内没有确认。 */
  readonly state: 'confirmed' | 'unconfirmed';
  /** 最后一次查询到的状态。 */
  readonly status: RunStatusSnapshot;
  /** 未确认时的错误码。 */
  readonly code?: string;
}

/** 审批选项取值的合法性检查。 */
const CHOICES: ReadonlySet<string> = new Set(['once', 'session', 'always', 'deny']);

/** 已失效的审批错误码：Hermes 侧已经解决，不重试。 */
const STALE_APPROVAL_CODES: ReadonlySet<string> = new Set(['approval_not_pending', 'approval_not_active']);

/** 文本取值。 */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 睡眠。 */
function sleep(ms: number): Promise<void> {
  return new Promise((settle) => setTimeout(settle, ms));
}

/**
 * 解析运行状态载荷。
 * @param payload - `GET /v1/runs/{run_id}` 的响应体。
 * @returns 状态快照。
 */
export function parseRunStatus(payload: Record<string, unknown>): RunStatusSnapshot {
  const runId = textOf(payload.run_id);
  const status = textOf(payload.status);
  if (runId === '') throw new HermesError('run-status', 'Hermes 运行状态缺少 run_id', { code: 'invalid-run-status' });
  if (!(RUN_STATES as readonly string[]).includes(status)) {
    throw new HermesError('run-status', `Hermes 返回了未知运行状态：${status}`, { code: 'unknown-run-status' });
  }
  const approvalPayload = payload.approval;
  const approval = approvalPayload !== null && typeof approvalPayload === 'object'
    ? {
      requestId: textOf((approvalPayload as Record<string, unknown>).request_id),
      title: textOf((approvalPayload as Record<string, unknown>).description)
        || textOf((approvalPayload as Record<string, unknown>).command),
      choices: Array.isArray((approvalPayload as Record<string, unknown>).choices)
        ? ((approvalPayload as Record<string, unknown>).choices as unknown[]).filter((item): item is string => typeof item === 'string')
        : [],
    }
    : undefined;
  const output = textOf(payload.output);
  const error = textOf(payload.error);
  const lastEvent = textOf(payload.last_event);
  return {
    runId,
    status: status as HermesRunState,
    terminal: TERMINAL_STATES.has(status),
    ...(lastEvent === '' ? {} : { lastEvent }),
    ...(output === '' ? {} : { output }),
    ...(error === '' ? {} : { error }),
    ...(payload.interrupted === true ? { interrupted: true } : {}),
    ...(payload.partial === true ? { partial: true } : {}),
    ...(approval === undefined ? {} : { approval }),
  };
}

/**
 * 把消息序列拆成新输入与历史。
 * @param messages - 完整消息序列，最后一条为用户输入。
 * @returns 新输入与之前的历史。
 */
function splitMessages(messages: readonly HistoryMessage[]): { input: string; history: readonly HistoryMessage[] } {
  const last = messages.at(-1);
  if (last === undefined) throw new Error('完整历史不能为空：至少需要本次用户输入');
  if (last.role !== 'user') throw new Error(`完整历史的最后一条必须是 user，收到 ${last.role}`);
  if (last.text.trim() === '') throw new Error('本次用户输入不能为空');
  return { input: last.text, history: messages.slice(0, -1) };
}

/** 完整历史运行桥接。 */
export class HermesHistoryRunBridge {
  private readonly http: HermesHttp;

  constructor(private readonly config: HermesHistoryRunConfig) {
    this.http = new HermesHttp(config);
  }

  /** 读取服务端能力。 */
  async capabilities(): Promise<HermesCapabilities> {
    const response = await this.http.request('capabilities', '/v1/capabilities', { method: 'GET' });
    const payload = (await response.json()) as { model?: unknown; features?: unknown };
    const features = payload.features;
    if (features === null || typeof features !== 'object') {
      throw new HermesError('capabilities', 'Hermes 能力响应缺少 features', { code: 'invalid-capabilities' });
    }
    return {
      ...(typeof payload.model === 'string' ? { model: payload.model } : {}),
      features: features as Readonly<Record<string, unknown>>,
    };
  }

  /**
   * 确认完整历史运行所需的能力。
   * @returns 已确认的能力。
   * @throws {HermesCapabilityError} 缺任一能力。
   */
  async requireCapabilities(): Promise<HermesCapabilities> {
    const capabilities = await this.capabilities();
    const missing = REQUIRED_HISTORY_RUN_FEATURES.filter((feature) => capabilities.features[feature] !== true);
    if (missing.length > 0) {
      throw new HermesCapabilityError('capabilities', missing, '适配器在执行前拒绝启动运行。');
    }
    return capabilities;
  }

  /**
   * 发起一次携带完整历史的运行。
   * @param request - 会话、操作标识、完整消息与指纹。
   * @returns 受理结果。
   */
  async startHistoryRun(request: HistoryRunRequest): Promise<HistoryRunAdmission> {
    if (request.sessionId.trim() === '') throw new Error('会话标识不能为空');
    if (!/^[\x21-\x7e]{1,255}$/.test(request.operationId)) {
      throw new Error('操作标识必须是 1 到 255 个可见 ASCII 字符，用作 Hermes 幂等键');
    }
    if (request.historyDigest !== historyDigestOf(request.system, request.messages)) {
      throw new Error('历史指纹与携带的消息不一致');
    }
    const capabilities = await this.requireCapabilities();
    const { input, history } = splitMessages(request.messages);
    const body = {
      input,
      // 会话标识只在请求自己携带历史时给出：一旦提供会话标识而没有历史，Hermes 会加载
      // 它自己存的会话历史，请求方提供的完整历史就不再是唯一来源。
      ...(history.length === 0 ? {} : { session_id: request.sessionId }),
      ...(history.length === 0 ? {} : { conversation_history: history.map((message) => ({ role: message.role, content: message.text })) }),
      ...(request.system === '' ? {} : { instructions: request.system }),
      ...(request.model === undefined ? {} : { model: request.model }),
    };
    const headers: Record<string, string> = {
      'Idempotency-Key': request.operationId,
      'X-ChatDSH-History-Digest': request.historyDigest,
      'X-ChatDSH-History-Mode': 'full',
    };
    if (request.permissionContext !== undefined) headers['X-ChatDSH-Permission-Context'] = request.permissionContext;
    const response = await this.http.request('create-run', '/v1/runs', {
      method: 'POST',
      body: JSON.stringify(body),
      headers,
    });
    const payload = (await response.json()) as { run_id?: unknown; status?: unknown; replayed?: unknown };
    if (typeof payload.run_id !== 'string') {
      throw new HermesError('create-run', 'Hermes 没有返回 run_id', { code: 'invalid-admission' });
    }
    return {
      runId: payload.run_id,
      status: typeof payload.status === 'string' ? payload.status : 'started',
      replayed: payload.replayed === true,
      capabilities,
    };
  }

  /**
   * 读取一次运行的事件流。
   * @param runId - 运行标识。
   * @param options - 续读序号与取消信号。
   * @returns 规范化事件序列。
   */
  async *streamRun(
    runId: string,
    options: { readonly lastEventId?: string; readonly signal?: AbortSignal } = {},
  ): AsyncIterable<HistoryRunEvent> {
    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    if (options.lastEventId !== undefined) headers['Last-Event-ID'] = options.lastEventId;
    const response = await this.http.openStream('stream', `/v1/runs/${encodeURIComponent(runId)}/events`, {
      method: 'GET',
      headers,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (response.body === null) throw new HermesError('stream', 'Hermes 的事件流没有响应体', { code: 'missing-body' });
    yield* streamRunEvents(response.body, {
      runId,
      ...(options.lastEventId === undefined ? {} : { lastEventId: options.lastEventId }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  /**
   * 查询一次运行的状态。
   * @param runId - 运行标识。
   * @returns 状态快照。
   */
  async getRun(runId: string): Promise<RunStatusSnapshot> {
    const response = await this.http.request('run-status', `/v1/runs/${encodeURIComponent(runId)}`, { method: 'GET' });
    return parseRunStatus((await response.json()) as Record<string, unknown>);
  }

  /**
   * 回答一次审批。
   * @param runId - 运行标识。
   * @param requestId - 审批请求标识。
   * @param choice - 契约里的审批选项。
   * @returns 接受或已失效。
   */
  async answerApproval(runId: string, requestId: string, choice: ApprovalChoice): Promise<ApprovalAnswer> {
    if (requestId.trim() === '') throw new Error('审批请求标识不能为空');
    if (!CHOICES.has(choice)) throw new Error(`未知的审批选项：${choice}`);
    const value = choice;
    try {
      const response = await this.http.request('approval', `/v1/runs/${encodeURIComponent(runId)}/approval`, {
        method: 'POST',
        body: JSON.stringify({ request_id: requestId, choice: value }),
      });
      const payload = (await response.json()) as { request_id?: unknown; choice?: unknown; resolved?: unknown };
      return {
        outcome: 'accepted',
        requestId: textOf(payload.request_id) || requestId,
        choice: textOf(payload.choice) || value,
        resolved: typeof payload.resolved === 'number' ? payload.resolved : 0,
      };
    } catch (error) {
      if (error instanceof HermesError && error.status === 409 && STALE_APPROVAL_CODES.has(error.code)) {
        return { outcome: 'stale', code: error.code };
      }
      throw error;
    }
  }

  /**
   * 取消一次运行并等待确认。
   *
   * 先查询状态：已终态直接确认。否则发出停止请求，在确认上限内轮询到终态；上限内没有
   * 终态时返回未确认，调用方继续查询，不得宣称已经停止。
   * @param runId - 运行标识。
   * @param options - 确认上限与轮询间隔。
   * @returns 确认或未确认。
   */
  async cancelRun(
    runId: string,
    options: { readonly confirmMs?: number; readonly pollMs?: number } = {},
  ): Promise<CancelOutcome> {
    const confirmMs = options.confirmMs ?? this.config.stopConfirmMs ?? 2000;
    const pollMs = options.pollMs ?? this.config.stopPollMs ?? 100;
    const before = await this.getRun(runId);
    if (before.terminal) return { state: 'confirmed', status: before };
    try {
      await this.http.request('stop', `/v1/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST' });
    } catch (error) {
      if (error instanceof HermesError && (error.status === 409 || error.status === 404)) {
        const status = await this.getRun(runId);
        return status.terminal
          ? { state: 'confirmed', status }
          : { state: 'unconfirmed', status, code: error.code };
      }
      throw error;
    }
    const deadline = Date.now() + confirmMs;
    let status = await this.getRun(runId);
    while (!status.terminal && Date.now() < deadline) {
      await sleep(pollMs);
      status = await this.getRun(runId);
    }
    return status.terminal
      ? { state: 'confirmed', status }
      : { state: 'unconfirmed', status, code: 'stop-unconfirmed' };
  }

  /** 探活；可达且能力可读时为 ok。 */
  async health(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    try {
      const capabilities = await this.capabilities();
      const missing = REQUIRED_HISTORY_RUN_FEATURES.filter((feature) => capabilities.features[feature] !== true);
      return missing.length === 0
        ? { ok: true }
        : { ok: false, detail: `missing:${missing.join(',')}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : 'unreachable' };
    }
  }
}

/**
 * 建立完整历史运行桥接。
 * @param config - 地址、凭据环境变量名与超时。
 * @returns 桥接。
 */
export function createHermesHistoryRunBridge(config: HermesHistoryRunConfig): HermesHistoryRunBridge {
  return new HermesHistoryRunBridge(config);
}
