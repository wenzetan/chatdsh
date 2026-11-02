/**
 * 发送时的后端选择。
 *
 * 每次发送按当前配置选一次执行体：聊天取 `dsh` 时交给 DSH 执行；取 `hermes` 时在发送
 * 准备阶段做一次可达判断，受理前明确不可达就把这一轮交给同一会话的 DSH 承载，并记下
 * 执行来源与「后续每轮交给 Hermes 必须携带完整历史」这项要求。受理状态不确定时只查询
 * 原操作，绝不把同一轮交给另一执行体重放。
 *
 * 回合一旦发出就固定选择：活动回合里的再次发送沿用同一个判断，配置改变只影响新回合；
 * 这里不重启会话，也不建立任何定时器。
 * @module @chatdsh/gateway/backends/router
 */

import type { ChatdshTelemetry } from '@chatdsh/core-contracts';
import { BackendDiagnostics, type HistoryMode, type SendJudgment } from './diagnostics.ts';
import { memoryEnabled, requiresHermes, type BackendSelection } from './policy.ts';

/** 交给 DSH 执行的请求。 */
export interface DshDispatchRequest {
  /** 会话标识。 */
  readonly sessionId: string;
  /** 回合号。 */
  readonly turn: number;
  /** 用户输入。 */
  readonly text: string;
  /** 实际执行体。 */
  readonly executionSource: 'dsh' | 'dsh-fallback';
  /** 会话的完整历史桥接方式。 */
  readonly historyMode: HistoryMode;
  /** 后续交给 Hermes 的运行是否必须携带完整历史。 */
  readonly historyBridgeRequired: boolean;
  /** 采用 DSH 承载的原因码。 */
  readonly reason?: string;
  /** 本回合记忆能力是否可用。 */
  readonly memoryEnabled: boolean;
}

/** DSH 执行结果。 */
export interface DshDispatchResult {
  /** 是否已受理。 */
  readonly accepted: boolean;
  /** 不受理时的原因码。 */
  readonly detail?: string;
}

/** DSH 执行端口，由运行时侧的会话执行实现。 */
export interface DshExecutionPort {
  /** 把一轮交给 DSH 执行。 */
  dispatch(request: DshDispatchRequest): Promise<DshDispatchResult>;
}

/** 一条历史消息。 */
export interface DispatchHistoryMessage {
  /** 角色。 */
  readonly role: 'user' | 'assistant';
  /** 文本。 */
  readonly text: string;
}

/** 完整历史。 */
export interface DispatchHistory {
  /** 业务操作标识，同时是 Hermes 的幂等键。 */
  readonly operationId: string;
  /** 完整消息序列，最后一条为本次输入。 */
  readonly messages: readonly DispatchHistoryMessage[];
  /** 稳定 system 文本。 */
  readonly system: string;
  /** 历史指纹。 */
  readonly historyDigest: string;
  /** 请求的模型。 */
  readonly model?: string;
}

/** 发起一次完整历史运行。 */
export interface HermesHistoryRequest {
  /** 会话标识。 */
  readonly sessionId: string;
  /** 业务操作标识。 */
  readonly operationId: string;
  /** 完整消息序列。 */
  readonly messages: readonly DispatchHistoryMessage[];
  /** 稳定 system 文本。 */
  readonly system: string;
  /** 历史指纹。 */
  readonly historyDigest: string;
  /** 请求的模型。 */
  readonly model?: string;
}

/** 受理结果。 */
export interface HermesAdmission {
  /** 运行标识。 */
  readonly runId: string;
  /** 服务端受理状态。 */
  readonly status: string;
  /** 是否为幂等键重放。 */
  readonly replayed: boolean;
}

/** 运行状态。 */
export interface HermesRunStatus {
  /** 运行标识。 */
  readonly runId: string;
  /** 状态取值。 */
  readonly status: string;
  /** 是否到达终态。 */
  readonly terminal: boolean;
  /** 最后一次事件类型。 */
  readonly lastEvent?: string;
}

/**
 * Hermes 聊天端口，由 SYS05 的完整历史运行桥接实现。
 *
 * 三个方法的名字与语义沿用桥接：`requireCapabilities` 是可执行前的能力门禁，
 * `startHistoryRun` 携带完整历史并以操作标识做幂等键，`getRun` 查询原运行状态。
 */
export interface HermesChatPort {
  /** 确认完整历史运行所需能力；缺能力时抛出。 */
  requireCapabilities(): Promise<unknown>;
  /** 发起一次运行。 */
  startHistoryRun(request: HermesHistoryRequest): Promise<HermesAdmission>;
  /** 查询运行状态。 */
  getRun(runId: string): Promise<HermesRunStatus>;
}

/** 依赖托管的最小读面。 */
export interface HermesReadinessPort {
  /** 确保依赖可用。 */
  ensureReady(): Promise<{ readonly ready: boolean; readonly reason?: string }>;
}

/** 一次发送的输入。 */
export interface BackendDispatchInput {
  /** 会话标识。 */
  readonly sessionId: string;
  /** 回合号。 */
  readonly turn: number;
  /** 用户输入。 */
  readonly text: string;
  /** 聊天取 hermes 时必须给出的完整历史。 */
  readonly history?: DispatchHistory;
}

/** 采用 DSH 承载的原因码。 */
export type DispatchReason =
  | 'unconfigured'
  | 'unreachable'
  | 'start-failed'
  | 'exited'
  | 'acceptance-unknown'
  | 'query-unreachable'
  | 'running'
  | 'resolved'
  | 'capability-missing'
  | 'dsh-rejected'
  | 'replayed';

/** 选择失败。 */
export type BackendDispatchErrorCode = 'history-required' | 'capability-missing' | 'admission-rejected' | 'turn-mismatch' | 'dsh-rejected' | 'not-unconfirmed';

/** 一次发送无法完成。 */
export class BackendDispatchError extends Error {
  /** 失败码。 */
  readonly code: BackendDispatchErrorCode;

  constructor(code: BackendDispatchErrorCode, message: string) {
    super(message);
    this.name = 'BackendDispatchError';
    this.code = code;
  }
}

/** 构造输入。 */
export interface BackendRouterOptions {
  /** 当前生效的配置。 */
  readonly settings: { current(): BackendSelection };
  /** 遥测出口。 */
  readonly telemetry: ChatdshTelemetry;
  /** DSH 执行端口。 */
  readonly dsh: DshExecutionPort;
  /** Hermes 聊天端口；未装配时缺省。 */
  readonly hermes?: HermesChatPort;
  /** 依赖托管器；外部地址模式下同样可用，只是不启停进程。 */
  readonly supervisor?: HermesReadinessPort;
  /** 诊断记录；缺省时自建一个。 */
  readonly diagnostics?: BackendDiagnostics;
  /** 完整历史桥接方式变化时的回调，用于持久化到会话元数据。 */
  readonly onHistoryMode?: (sessionId: string, mode: HistoryMode) => void;
}

/** 已固定的选择。 */
interface PinnedTurn {
  readonly turn: number;
  readonly judgment: SendJudgment;
  readonly request: HermesHistoryRequest | undefined;
}

/** 探活结果。 */
interface ProbeResult {
  /** 依赖名。 */
  readonly dependency: 'hermes';
  /** 是否可达。 */
  readonly reachable: boolean;
  /** 能力是否齐全。 */
  readonly capabilities: boolean;
}

/** 取错误码。 */
function codeOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}

/** 受理结果是否未知。 */
function acceptanceUnknown(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as { acceptanceUnknown?: unknown }).acceptanceUnknown === true;
}

/** 是否为确定未受理的不可达。 */
function certainUnreachable(error: unknown): boolean {
  return codeOf(error) === 'unreachable';
}

/** 是否为能力缺失。 */
function capabilityMissing(error: unknown): boolean {
  return codeOf(error) === 'capability-missing';
}

/** 取错误名。 */
function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

/**
 * 发送时的后端选择器。
 */
export class BackendRouter {
  private readonly telemetry: ChatdshTelemetry;
  private readonly active = new Map<string, PinnedTurn>();
  private readonly historyModes = new Map<string, HistoryMode>();
  private readonly diagnostics: BackendDiagnostics;

  constructor(private readonly options: BackendRouterOptions) {
    this.telemetry = options.telemetry;
    this.diagnostics = options.diagnostics ?? new BackendDiagnostics();
  }

  /** 诊断记录，供状态端点读出最近一次发送的实际判断。 */
  record(): BackendDiagnostics {
    return this.diagnostics;
  }

  /** 某个会话当前的完整历史桥接方式。 */
  historyModeOf(sessionId: string): HistoryMode {
    return this.historyModes.get(sessionId) ?? 'dsh';
  }

  /** 某个会话当前固定的选择。 */
  pinnedOf(sessionId: string): SendJudgment | undefined {
    return this.active.get(sessionId)?.judgment;
  }

  /**
   * 结束一个回合，释放它的固定选择。
   *
   * 配置在下一次发送时重新读取，因此新回合采用新配置；进行中的会话不需要重启。
   * @param sessionId - 会话标识。
   * @param turn - 回合号。
   * @returns 是否释放了固定选择。
   */
  endTurn(sessionId: string, turn: number): boolean {
    const pinned = this.active.get(sessionId);
    if (pinned === undefined || pinned.turn !== turn) return false;
    this.active.delete(sessionId);
    return true;
  }

  /**
   * 为一次发送选择执行体并执行到受理为止。
   * @param input - 会话、回合、输入与完整历史。
   * @returns 本次的实际判断。
   */
  async dispatch(input: BackendDispatchInput): Promise<SendJudgment> {
    const pinned = this.active.get(input.sessionId);
    if (pinned !== undefined) {
      if (pinned.turn !== input.turn) {
        throw new BackendDispatchError(
          'turn-mismatch',
          `会话 ${input.sessionId} 的活动回合是 ${pinned.turn}，收到 ${input.turn}；新回合同样按当前配置选择`,
        );
      }
      if (pinned.judgment.outcome === 'unconfirmed') return this.resolveUnconfirmed(input.sessionId);
      const judgment: SendJudgment = { ...pinned.judgment, pinned: true };
      this.diagnostics.record(judgment);
      return judgment;
    }
    const selection = this.options.settings.current();
    if (!requiresHermes(selection.chatBackend)) {
      return this.dispatchDsh(input, selection, 'dsh', {
        historyBridgeRequired: false,
        memoryEnabled: memoryEnabled(selection.memoryBackend),
      });
    }
    return this.dispatchHermes(input, selection);
  }

  /**
   * 查询一个受理状态不确定的回合。
   *
   * 用同一个操作标识再次提交，Hermes 的幂等键会给出原运行，再按运行标识查询状态；
   * 查询不到就保持不确定，绝不把这一轮交给 DSH。
   * @param sessionId - 会话标识。
   * @returns 更新之后的判断。
   */
  async resolveUnconfirmed(sessionId: string): Promise<SendJudgment> {
    const pinned = this.active.get(sessionId);
    if (pinned === undefined) {
      throw new BackendDispatchError('not-unconfirmed', `会话 ${sessionId} 没有待查询的发送`);
    }
    if (pinned.judgment.outcome !== 'unconfirmed') {
      return { ...pinned.judgment, pinned: true };
    }
    if (pinned.request === undefined || this.options.hermes === undefined) {
      return { ...pinned.judgment, pinned: true };
    }
    const port = this.options.hermes;
    const request = pinned.request;
    return this.telemetry.runSpan('chatdsh.runtime.chat.dispatch', { 'chat.backend': 'hermes' }, async (span) => {
      try {
        const admission = await port.startHistoryRun(request);
        const status = await port.getRun(admission.runId);
        const judgment: SendJudgment = {
          ...pinned.judgment,
          outcome: status.terminal ? 'hermes-accepted' : 'unconfirmed',
          runId: admission.runId,
          runStatus: status.status,
          reason: status.terminal ? 'resolved' : 'running',
          pinned: true,
        };
        this.active.set(sessionId, { turn: pinned.turn, judgment, request });
        span.setAttribute('outcome', status.terminal ? 'resolved' : 'querying');
        this.diagnostics.record(judgment);
        return judgment;
      } catch (error) {
        const code = codeOf(error);
        if (code === '') throw error;
        const judgment: SendJudgment = {
          ...pinned.judgment,
          reason: acceptanceUnknown(error) ? 'acceptance-unknown' : 'query-unreachable',
          pinned: true,
        };
        this.active.set(sessionId, { turn: pinned.turn, judgment, request });
        span.setAttribute('outcome', 'query-failed');
        this.diagnostics.record(judgment);
        return judgment;
      }
    });
  }

  /** Hermes 承载的一轮。 */
  private async dispatchHermes(input: BackendDispatchInput, selection: BackendSelection): Promise<SendJudgment> {
    const history = input.history;
    if (history === undefined) {
      throw new BackendDispatchError('history-required', '聊天后端取 hermes 时每次发送都要给出完整历史');
    }
    const memory = memoryEnabled(selection.memoryBackend);
    if (this.options.supervisor !== undefined) {
      const readiness = await this.options.supervisor.ensureReady();
      if (!readiness.ready) {
        return this.degrade(input, selection, reasonOf(readiness.reason), memory);
      }
    }
    if (this.options.hermes === undefined) {
      return this.degrade(input, selection, 'unconfigured', memory);
    }
    const port = this.options.hermes;
    const probe = await this.probe();
    if (!probe.reachable) {
      return this.degrade(input, selection, 'unreachable', memory, probe);
    }
    if (!probe.capabilities) {
      return this.reject(input, selection, probe, 'capability-missing', 'HermesCapabilityError');
    }
    const request: HermesHistoryRequest = {
      sessionId: input.sessionId,
      operationId: history.operationId,
      messages: history.messages,
      system: history.system,
      historyDigest: history.historyDigest,
      ...(history.model === undefined ? {} : { model: history.model }),
    };
    return this.telemetry.runSpan('chatdsh.runtime.chat.dispatch', { 'chat.backend': 'hermes' }, async (span) => {
      try {
        const admission = await port.startHistoryRun(request);
        const judgment: SendJudgment = {
          sessionId: input.sessionId,
          turn: input.turn,
          revision: selection.revision,
          chatBackend: selection.chatBackend,
          memoryBackend: selection.memoryBackend,
          executionSource: 'hermes',
          outcome: 'hermes-accepted',
          historyMode: 'full',
          historyBridgeRequired: true,
          memoryEnabled: memory,
          runId: admission.runId,
          runStatus: admission.status,
          ...(admission.replayed ? { reason: 'replayed' } : {}),
          probe,
          at: Date.now(),
          pinned: false,
        };
        this.markFullHistory(input.sessionId);
        this.active.set(input.sessionId, { turn: input.turn, judgment, request });
        span.setAttribute('outcome', 'hermes');
        this.telemetry.counter('chatdsh_chat_hermes_runs_total', { description: 'Hermes 承载的聊天运行数' })
          .add(1, { outcome: 'accepted' });
        this.diagnostics.record(judgment);
        return judgment;
      } catch (error) {
        if (acceptanceUnknown(error)) return this.unconfirmed(input, selection, probe, request);
        if (certainUnreachable(error)) {
          span.setAttribute('outcome', 'degraded-dsh');
          return this.degrade(input, selection, 'unreachable', memory, probe);
        }
        span.setAttribute('outcome', 'rejected');
        this.telemetry.event('chatdsh.chat.hermes.run.failed', {
          'error.type': nameOf(error),
          'error.code': codeOf(error) || 'admission-rejected',
        });
        this.telemetry.counter('chatdsh_chat_hermes_runs_total', { description: 'Hermes 承载的聊天运行数' })
          .add(1, { outcome: 'rejected' });
        throw error;
      }
    });
  }

  /** 受理状态不确定：固定为 Hermes，随即查询原操作。 */
  private async unconfirmed(
    input: BackendDispatchInput,
    selection: BackendSelection,
    probe: ProbeResult,
    request: HermesHistoryRequest,
  ): Promise<SendJudgment> {
    const judgment: SendJudgment = {
      sessionId: input.sessionId,
      turn: input.turn,
      revision: selection.revision,
      chatBackend: selection.chatBackend,
      memoryBackend: selection.memoryBackend,
      executionSource: 'hermes',
      outcome: 'unconfirmed',
      historyMode: 'full',
      historyBridgeRequired: true,
      memoryEnabled: memoryEnabled(selection.memoryBackend),
      reason: 'acceptance-unknown',
      probe,
      at: Date.now(),
      pinned: false,
    };
    this.markFullHistory(input.sessionId);
    this.active.set(input.sessionId, { turn: input.turn, judgment, request });
    this.telemetry.event('chatdsh.chat.hermes.run.failed', {
      'error.type': 'HermesAcceptanceUnknown',
      'error.code': 'acceptance-unknown',
    });
    this.telemetry.counter('chatdsh_chat_hermes_runs_total', { description: 'Hermes 承载的聊天运行数' })
      .add(1, { outcome: 'unconfirmed' });
    this.diagnostics.record(judgment);
    return this.resolveUnconfirmed(input.sessionId);
  }

  /** 受理前明确不可达：同一会话交给 DSH 承载。 */
  private async degrade(
    input: BackendDispatchInput,
    selection: BackendSelection,
    reason: DispatchReason,
    memory: boolean,
    probe?: ProbeResult,
  ): Promise<SendJudgment> {
    const memoryHermes = selection.memoryBackend === 'hermes';
    this.markFullHistory(input.sessionId);
    this.telemetry.event('chatdsh.chat.hermes.run.failed', {
      'error.type': reason === 'unconfigured' ? 'HermesUnconfigured' : 'HermesUnreachable',
      'error.code': reason,
    });
    this.telemetry.counter('chatdsh_chat_hermes_runs_total', { description: 'Hermes 承载的聊天运行数' })
      .add(1, { outcome: 'degraded-dsh' });
    if (memoryHermes) {
      this.telemetry.event('chatdsh.memory.degraded', {
        operation: 'backend-select',
        reason: 'hermes-unreachable',
        'error.type': 'HermesUnreachable',
      });
    }
    return this.dispatchDsh(input, selection, 'dsh-fallback', {
      historyBridgeRequired: true,
      memoryEnabled: memory && !memoryHermes,
      reason,
      ...(probe === undefined ? {} : { probe }),
    });
  }

  /** 能力不齐：执行前拒绝，不创建运行。 */
  private async reject(
    input: BackendDispatchInput,
    selection: BackendSelection,
    probe: ProbeResult,
    reason: DispatchReason,
    errorType: string,
  ): Promise<SendJudgment> {
    const judgment: SendJudgment = {
      sessionId: input.sessionId,
      turn: input.turn,
      revision: selection.revision,
      chatBackend: selection.chatBackend,
      memoryBackend: selection.memoryBackend,
      executionSource: 'hermes',
      outcome: 'rejected',
      historyMode: 'full',
      historyBridgeRequired: true,
      memoryEnabled: memoryEnabled(selection.memoryBackend),
      reason,
      probe,
      at: Date.now(),
      pinned: false,
    };
    this.telemetry.event('chatdsh.chat.hermes.run.failed', {
      'error.type': errorType,
      'error.code': reason,
    });
    this.telemetry.counter('chatdsh_chat_hermes_runs_total', { description: 'Hermes 承载的聊天运行数' })
      .add(1, { outcome: 'rejected' });
    this.diagnostics.record(judgment);
    throw new BackendDispatchError('capability-missing', 'Hermes 缺少完整历史运行所需能力，执行前拒绝');
  }

  /** 交给 DSH 承载的一轮。 */
  private async dispatchDsh(
    input: BackendDispatchInput,
    selection: BackendSelection,
    executionSource: 'dsh' | 'dsh-fallback',
    detail: {
      readonly historyBridgeRequired: boolean;
      readonly memoryEnabled: boolean;
      readonly reason?: DispatchReason;
      readonly probe?: ProbeResult;
    },
  ): Promise<SendJudgment> {
    const outcome = executionSource === 'dsh' ? 'dsh' : 'degraded-dsh';
    return this.telemetry.runSpan('chatdsh.runtime.chat.dispatch', {
      'chat.backend': executionSource === 'dsh' ? 'dsh' : 'hermes',
    }, async (span) => {
      const historyMode = this.historyModeOf(input.sessionId);
      const result = await this.options.dsh.dispatch({
        sessionId: input.sessionId,
        turn: input.turn,
        text: input.text,
        executionSource,
        historyMode,
        historyBridgeRequired: detail.historyBridgeRequired,
        memoryEnabled: detail.memoryEnabled,
        ...(detail.reason === undefined ? {} : { reason: detail.reason }),
      });
      if (!result.accepted) {
        span.setAttribute('outcome', 'rejected');
        throw new BackendDispatchError('dsh-rejected', `DSH 没有受理这一轮：${result.detail ?? '未给出原因'}`);
      }
      const judgment: SendJudgment = {
        sessionId: input.sessionId,
        turn: input.turn,
        revision: selection.revision,
        chatBackend: selection.chatBackend,
        memoryBackend: selection.memoryBackend,
        executionSource,
        outcome,
        historyMode,
        historyBridgeRequired: detail.historyBridgeRequired,
        memoryEnabled: detail.memoryEnabled,
        ...(detail.reason === undefined ? {} : { reason: detail.reason }),
        ...(detail.probe === undefined ? {} : { probe: detail.probe }),
        at: Date.now(),
        pinned: false,
      };
      this.active.set(input.sessionId, { turn: input.turn, judgment, request: undefined });
      span.setAttribute('outcome', outcome);
      this.diagnostics.record(judgment);
      return judgment;
    });
  }

  /** 发送准备阶段的一次可达与能力判断。 */
  private async probe(): Promise<ProbeResult> {
    const port = this.options.hermes;
    if (port === undefined) return { dependency: 'hermes', reachable: false, capabilities: false };
    return this.telemetry.runSpan('chatdsh.dependency.probe', { dependency: 'hermes' }, async (span) => {
      try {
        await port.requireCapabilities();
        span.setAttribute('outcome', 'ok');
        return { dependency: 'hermes', reachable: true, capabilities: true };
      } catch (error) {
        const code = codeOf(error);
        if (code === '') throw error;
        const missing = capabilityMissing(error);
        span.setAttribute('outcome', missing ? 'capability-missing' : 'unreachable');
        this.telemetry.counter('chatdsh_dependency_probe_failures_total', { description: '探活失败' })
          .add(1, { dependency: 'hermes' });
        return { dependency: 'hermes', reachable: missing, capabilities: false };
      }
    });
  }

  /** 记下会话的完整历史桥接方式。 */
  private markFullHistory(sessionId: string): void {
    if (this.historyModes.get(sessionId) === 'full') return;
    this.historyModes.set(sessionId, 'full');
    this.options.onHistoryMode?.(sessionId, 'full');
  }
}

/** 就绪原因转成降级原因码。 */
function reasonOf(reason: string | undefined): DispatchReason {
  switch (reason) {
    case 'unconfigured': return 'unconfigured';
    case 'start-failed': return 'start-failed';
    case 'exited': return 'exited';
    default: return 'unreachable';
  }
}

/**
 * 建立一个发送时的后端选择器。
 * @param options - 配置、遥测、执行端口与可选托管器。
 * @returns 选择器。
 */
export function createBackendRouter(options: BackendRouterOptions): BackendRouter {
  return new BackendRouter(options);
}
