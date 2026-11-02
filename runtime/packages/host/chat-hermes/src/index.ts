/**
 * Hermes 承载聊天时的宿主插件。
 *
 * 每次发送都从 DSH 权威历史读出完整消息，随运行一起交给 Hermes；运行事件即时到达，
 * 审批请求一到达就写入会话并取得耐久屏障，取消沿同一 `run_id` 传播并等待终态。
 * 写入按会话串行、按业务标识幂等，宿主重启后同一操作标识不会产生第二条回复。
 *
 * 外部写入走存储层的写句柄：会话必须已经存在，写句柄被活动 Agent 持有时直接失败，
 * 不降级到另一条路径。
 * @module @chatdsh/host-chat-hermes
 */

import { randomUUID } from 'node:crypto';
import { Remote, schema as z, sessionPersistenceOf, telemetryOf, TypertRemoteService, type Context, type SessionId } from '@chatdsh/adapter';
import { APPROVAL_CHOICES, type ApprovalChoice } from '@chatdsh/core-contracts';
import {
  createHermesHistoryRunBridge,
  HermesCapabilityError,
  HermesError,
  historyDigestOf,
  type CancelOutcome,
  type HermesHistoryRunConfig,
  type HistoryEventLike,
  type HistoryMessage,
  type RunStatusSnapshot,
} from '@chatdsh/hermes-adapter';
import {
  approvalDecisionBatch,
  approvalRequestBatch,
  HERMES_RUN_RECORD_TYPE,
  runRecordBatch,
  turnCloseBatch,
  turnOpenBatch,
  type RunRecordState,
  type TurnCloseKind,
} from './batches.ts';
import { readSessionHistory } from './history-source.ts';
import { SessionWriter } from './writer.ts';

export { approvalPluginEvent, planReplyBatch, translateRun } from './translate.ts';
export type { ChatSessionEvent, ReplyPlan, TranslateInput, TranslateResult } from './translate.ts';
export { HERMES_RUN_RECORD_TYPE } from './batches.ts';
export type { RunRecordState, TurnCloseKind } from './batches.ts';

/** 插件名。 */
export const name = 'chatdsh-chat-hermes';

/** 服务名，同时是 Remote 命名空间。 */
export const SERVICE_NAME = 'chatdshHermesChat';

/** 配置。 */
export interface ChatHermesConfig {
  /** Hermes `api_server` 的根地址。 */
  readonly baseUrl: string;
  /** 凭据所在的环境变量名。 */
  readonly apiKeyEnv?: string;
  /** 单次请求超时。 */
  readonly requestTimeoutMs: number;
  /** 审批等待上限。 */
  readonly approvalTimeoutMs: number;
  /** 写进助手消息的模型标签。 */
  readonly modelLabel: string;
  /** 请求 Hermes 使用的模型；留空使用服务端默认。 */
  readonly model?: string;
  /** 历史分页读取条数。 */
  readonly historyPageSize: number;
  /** 停止确认上限，单位毫秒。 */
  readonly stopConfirmMs: number;
}

/** 配置 schema。 */
export const Config: z<ChatHermesConfig> = z.object({
  baseUrl: z.string().default('http://127.0.0.1:50011'),
  apiKeyEnv: z.string(),
  requestTimeoutMs: z.number().default(120_000),
  approvalTimeoutMs: z.number().default(300_000),
  modelLabel: z.string().default('hermes-0.21.7'),
  model: z.string(),
  historyPageSize: z.number().default(200),
  stopConfirmMs: z.number().default(2000),
});

/** 模型元数据。 */
interface ModelMetadata {
  readonly provider?: string;
  readonly model?: string;
  readonly source: string;
}

/** 一次发送的结果。 */
export interface SendResult {
  /** Hermes 的运行标识。 */
  readonly runId: string;
  /** 本次真正写入的事件条数。 */
  readonly appended: number;
  /** 助手回复的可见文本。 */
  readonly assistantText: string;
  /** 本次运行里出现的审批请求标识。 */
  readonly approvals: readonly string[];
  /** 完整历史指纹。 */
  readonly historyDigest: string;
  /** 历史读取页数。 */
  readonly historyPages: number;
  /** 表面上的第一条用户文本。 */
  readonly firstUser: string;
  /** 损失声明。 */
  readonly loss: readonly { readonly code: string; readonly count: number }[];
  /** 历史里观察到的模型元数据。 */
  readonly model: ModelMetadata;
  /** 确定终态。 */
  readonly terminal: TurnCloseKind;
  /** 是否为同操作标识的续跑。 */
  readonly replayed: boolean;
}

/** 运行记录。 */
interface RunRecord {
  readonly runId: string;
  readonly operationId: string;
  readonly state: RunRecordState;
  readonly turn: number;
  readonly historyDigest: string;
  readonly historyPages: number;
  readonly model: ModelMetadata;
  readonly firstUser: string;
  readonly loss: readonly { readonly code: string; readonly count: number }[];
  readonly approvals: readonly string[];
  readonly assistantText: string;
}

/** span 的最小形状。 */
interface SpanLike {
  setAttribute(key: string, value: string | number | boolean): void;
}

/** 遥测面的最小形状，与宿主平面统一客户端的同名方法一致。 */
interface ChatTelemetry {
  runSpan<T>(
    name: string,
    attributes: Readonly<Record<string, string | number | boolean>>,
    fn: (span: SpanLike) => Promise<T>,
  ): Promise<T>;
  event(name: string, attributes?: Readonly<Record<string, string | number | boolean>>): void;
  counter(name: string, options?: { readonly description?: string }): {
    add(value: number, attributes?: Readonly<Record<string, string | number | boolean>>): void;
  };
}

/** 运行记录的事件类型名。 */
const RUN_RECORD = HERMES_RUN_RECORD_TYPE;

/** 运行记录的状态取值。 */
const RUN_RECORD_STATES: ReadonlySet<string> = new Set(['accepted', 'completed', 'failed', 'cancelled', 'interrupted']);

/** 取插件记录载荷。 */
function dataOf(event: HistoryEventLike): Record<string, unknown> {
  const data = event.data;
  return data !== null && typeof data === 'object' ? data as Record<string, unknown> : {};
}

/** 取字符串字段。 */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 取记录里的损失声明。 */
function lossOf(value: unknown): readonly { readonly code: string; readonly count: number }[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is { code?: unknown; count?: unknown } => item !== null && typeof item === 'object')
    .map((item) => ({ code: textOf(item.code), count: typeof item.count === 'number' ? item.count : 0 }));
}

/** 把一条运行记录事件解析成运行记录。 */
function runRecordOf(event: HistoryEventLike): RunRecord | undefined {
  if (event.type !== RUN_RECORD) return undefined;
  const data = dataOf(event);
  const runId = textOf(data.runId);
  const operationId = textOf(data.operationId);
  const state = textOf(data.state);
  if (runId === '' || operationId === '' || !RUN_RECORD_STATES.has(state)) return undefined;
  const model = data.model !== null && typeof data.model === 'object' ? data.model as Record<string, unknown> : {};
  return {
    runId,
    operationId,
    state: state as RunRecordState,
    turn: typeof data.turn === 'number' ? data.turn : 1,
    historyDigest: textOf(data.historyDigest),
    historyPages: typeof data.historyPages === 'number' ? data.historyPages : 0,
    model: {
      ...(typeof model.provider === 'string' ? { provider: model.provider } : {}),
      ...(typeof model.model === 'string' ? { model: model.model } : {}),
      source: textOf(model.source) || 'none',
    },
    firstUser: textOf(data.firstUser),
    loss: lossOf(data.loss),
    approvals: Array.isArray(data.approvals) ? data.approvals.filter((item): item is string => typeof item === 'string') : [],
    assistantText: textOf(data.assistantText),
  };
}

/** 按操作标识找最近一条运行记录。 */
function findRunRecord(events: readonly HistoryEventLike[], operationId: string): RunRecord | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined) continue;
    const record = runRecordOf(event);
    if (record !== undefined && record.operationId === operationId) return record;
  }
  return undefined;
}

/** 计算下一个回合号。 */
function nextTurn(events: readonly HistoryEventLike[]): number {
  let turn = 0;
  for (const event of events) {
    if (event.type !== 'turn/start') continue;
    const value = dataOf(event).turn;
    if (typeof value === 'number' && value > turn) turn = value;
  }
  return turn + 1;
}

/** 审批选项是否合法。 */
function approvalChoiceOf(value: string): ApprovalChoice | undefined {
  return (APPROVAL_CHOICES as readonly string[]).includes(value) ? value as ApprovalChoice : undefined;
}

/** 终态映射。 */
function closeKindOf(status: string): TurnCloseKind {
  switch (status) {
    case 'cancelled': return 'cancelled';
    case 'interrupted': return 'interrupted';
    case 'failed': return 'failed';
    default: return 'completed';
  }
}

/** 运行状态里的终态文本。 */
function assistantTextOfStatus(status: RunStatusSnapshot): string {
  return status.output ?? '';
}

/**
 * Hermes 聊天服务。
 *
 * 依赖会话注册表与会话持久化；会话不存在时直接抛出，不替调用方创建没有归属的会话。
 */
export class ChatdshHermesChatService extends TypertRemoteService {
  /** 配置 schema，供加载器校验。 */
  static readonly Config = Config;

  /** 依赖：会话注册表用于确认会话存在，持久化用于取写句柄。 */
  static inject = ['sessions', 'sessionPersistence'];

  private readonly bridge: ReturnType<typeof createHermesHistoryRunBridge>;
  private readonly writer: SessionWriter;
  private readonly activeRuns = new Set<string>();

  constructor(ctx: Context, private readonly config: ChatHermesConfig) {
    super(ctx, SERVICE_NAME);
    const adapterConfig: HermesHistoryRunConfig = {
      baseUrl: config.baseUrl,
      ...(config.apiKeyEnv === undefined ? {} : { apiKeyEnv: config.apiKeyEnv }),
      requestTimeoutMs: config.requestTimeoutMs,
      approvalTimeoutMs: config.approvalTimeoutMs,
      stopConfirmMs: config.stopConfirmMs,
    };
    this.bridge = createHermesHistoryRunBridge(adapterConfig);
    this.writer = new SessionWriter(ctx);
  }

  /** 探活与能力确认。 */
  @Remote('health')
  async health(): Promise<{ ok: boolean; detail?: string }> {
    return this.bridge.health();
  }

  /**
   * 向一个已有会话发送一条聊天消息，把 Hermes 的回复代写回会话。
   * @param sessionId - 目标会话。
   * @param text - 用户输入。
   * @param operationId - 业务操作标识；同一标识重试不会产生第二条回复。
   * @returns 运行标识、终态与写入结果。
   */
  @Remote('send')
  async send(sessionId: string, text: string, operationId?: string): Promise<SendResult> {
    const telemetry = telemetryOf<ChatTelemetry>(this.ctx);
    const body = (span?: SpanLike): Promise<SendResult> => this.sendOnce(sessionId, text, operationId, span);
    if (telemetry === undefined) return body();
    return telemetry.runSpan('chatdsh.chat.hermes.run', { 'session.id': sessionId }, body);
  }

  /**
   * 查询一次运行的状态。
   * @param runId - Hermes 的运行标识。
   * @returns 可轮询的状态。
   */
  @Remote('getRun')
  async getRun(runId: string): Promise<RunStatusSnapshot> {
    return this.bridge.getRun(runId);
  }

  /**
   * 取消一次运行并等待确认。
   * @param sessionId - 目标会话。
   * @param runId - Hermes 的运行标识。
   * @returns 确认或未确认，未确认表示不能宣称已经停止。
   */
  @Remote('cancelRun')
  async cancelRun(sessionId: string, runId: string): Promise<CancelOutcome> {
    const telemetry = telemetryOf<ChatTelemetry>(this.ctx);
    const cancel = async (span?: SpanLike): Promise<CancelOutcome> => {
      const outcome = await this.bridge.cancelRun(runId);
      if (outcome.state === 'confirmed') {
        if (!this.activeRuns.has(runId)) await this.finishFromStatus(sessionId, runId, outcome.status);
        span?.setAttribute('outcome', 'confirmed');
        telemetry?.counter('chatdsh_chat_hermes_runs_total', { description: 'Hermes 承载的聊天运行数' })
          .add(1, { outcome: 'cancelled' });
        return outcome;
      }
      span?.setAttribute('outcome', 'unconfirmed');
      telemetry?.event('chatdsh.chat.hermes.run.failed', {
        'error.type': 'HermesCancelError',
        'error.code': outcome.code ?? 'stop-unconfirmed',
      });
      telemetry?.counter('chatdsh_chat_hermes_runs_total', { description: 'Hermes 承载的聊天运行数' })
        .add(1, { outcome: 'cancel-unconfirmed' });
      return outcome;
    };
    if (telemetry === undefined) return cancel();
    return telemetry.runSpan('chatdsh.chat.hermes.run', { 'session.id': sessionId }, cancel);
  }

  /** 一次发送的主体：历史、受理、事件写入与终态。 */
  private sendOnce(sessionId: string, text: string, operationId: string | undefined, span: SpanLike | undefined): Promise<SendResult> {
    const telemetry = telemetryOf<ChatTelemetry>(this.ctx);
    return this.writer.serialize(`run:${sessionId}`, async () => {
      try {
        const result = await this.runOnce(sessionId, text, operationId);
        span?.setAttribute('outcome', result.terminal);
        telemetry?.counter('chatdsh_chat_hermes_runs_total', { description: 'Hermes 承载的聊天运行数' })
          .add(1, { outcome: result.terminal });
        return result;
      } catch (error) {
        const rejected = error instanceof HermesCapabilityError;
        const unknown = error instanceof HermesError && error.acceptanceUnknown;
        const outcome = rejected ? 'rejected' : unknown ? 'unconfirmed' : 'failed';
        span?.setAttribute('outcome', outcome);
        telemetry?.event('chatdsh.chat.hermes.run.failed', {
          'error.type': error instanceof Error ? error.name : 'Unknown',
          'error.code': error instanceof HermesError ? error.code : 'chat-hermes-failed',
        });
        telemetry?.counter('chatdsh_chat_hermes_runs_total', { description: 'Hermes 承载的聊天运行数' })
          .add(1, { outcome });
        throw error;
      }
    });
  }

  /** 执行一次完整历史运行。 */
  private async runOnce(sessionId: string, text: string, operationId: string | undefined): Promise<SendResult> {
    const stored = await sessionPersistenceOf(this.ctx).stat(sessionId as SessionId);
    if (stored === undefined) throw new Error(`会话不存在：${sessionId}`);
    if (text.trim() === '') throw new Error('消息不能为空');

    const events = await this.writer.read(sessionId);
    const effectiveOperationId = operationId ?? `chatdsh-${randomUUID()}`;
    const prior = findRunRecord(events, effectiveOperationId);
    if (prior !== undefined && prior.state !== 'accepted') {
      return {
        runId: prior.runId,
        appended: 0,
        assistantText: prior.assistantText,
        approvals: prior.approvals,
        historyDigest: prior.historyDigest,
        historyPages: prior.historyPages,
        firstUser: prior.firstUser,
        loss: prior.loss,
        model: prior.model,
        terminal: closeKindOf(prior.state),
        replayed: true,
      };
    }

    let runId: string;
    let turn: number;
    let digest: string;
    let pages: number;
    let model: ModelMetadata;
    let firstUser: string;
    let loss: readonly { readonly code: string; readonly count: number }[];
    let replayed = false;
    if (prior !== undefined) {
      runId = prior.runId;
      turn = prior.turn;
      digest = prior.historyDigest;
      pages = prior.historyPages;
      model = prior.model;
      firstUser = prior.firstUser;
      loss = prior.loss;
      replayed = true;
    } else {
      const loaded = await readSessionHistory(this.ctx, sessionId, {
        pageSize: this.config.historyPageSize,
        configuredModel: { provider: 'hermes', model: this.config.modelLabel },
      });
      const messages: HistoryMessage[] = [...loaded.snapshot.messages, { role: 'user', text }];
      digest = historyDigestOf(loaded.snapshot.system, messages);
      pages = loaded.snapshot.pages;
      model = loaded.snapshot.model;
      firstUser = loaded.snapshot.firstUser;
      loss = loaded.snapshot.loss;
      turn = nextTurn(events);
      const admission = await this.bridge.startHistoryRun({
        sessionId,
        operationId: effectiveOperationId,
        messages,
        system: loaded.snapshot.system,
        historyDigest: digest,
        ...(this.config.model === undefined || this.config.model === '' ? {} : { model: this.config.model }),
      });
      runId = admission.runId;
      replayed = admission.replayed;
      await this.writer.append(sessionId, runRecordBatch({
        runId,
        sessionId,
        operationId: effectiveOperationId,
        state: 'accepted',
        turn,
        historyDigest: digest,
        historyPages: pages,
        model,
        firstUser,
        loss,
      }));
    }

    this.activeRuns.add(runId);
    await this.writer.append(sessionId, turnOpenBatch({ runId, turn, step: 1, userText: text }));
    const approvals: string[] = [...(prior?.approvals ?? [])];
    let assistantText = prior?.assistantText ?? '';
    let terminal: TurnCloseKind = 'failed';
    let lastEvent = 'accepted';
    try {
      for await (const event of this.bridge.streamRun(runId)) {
        lastEvent = event.type;
        switch (event.type) {
          case 'text.delta':
            assistantText += event.text;
            break;
          case 'approval.asked': {
            const choices = event.approval.choices
              .map((item) => approvalChoiceOf(item))
              .filter((item): item is ApprovalChoice => item !== undefined);
            await this.writer.append(sessionId, approvalRequestBatch({
              runId,
              requestId: event.approval.requestId,
              title: event.approval.title,
              ...(event.approval.command === undefined ? {} : { detail: event.approval.command }),
              choices: choices.length === 0 ? ['once', 'deny'] : choices,
              expiresAt: Date.now() + this.config.approvalTimeoutMs,
            }));
            approvals.push(event.approval.requestId);
            break;
          }
          case 'approval.decided': {
            const choice = approvalChoiceOf(event.choice);
            if (choice === undefined) throw new HermesError('stream', `Hermes 返回了未知审批选项：${event.choice}`, { code: 'invalid-approval-choice' });
            await this.writer.append(sessionId, approvalDecisionBatch({
              runId,
              requestId: event.requestId,
              choice,
              answeredBy: 'hermes',
              stale: false,
            }));
            break;
          }
          case 'run.completed':
            terminal = 'completed';
            if (event.output !== '') assistantText = event.output;
            break;
          case 'run.failed':
            terminal = 'failed';
            break;
          case 'run.cancelled':
            terminal = 'cancelled';
            break;
          case 'run.interrupted':
            terminal = 'interrupted';
            break;
          default:
            break;
        }
      }
    } catch (error) {
      this.activeRuns.delete(runId);
      await this.writeTerminal(sessionId, runId, effectiveOperationId, turn, assistantText, 'failed', 'stream-failed', {
        digest,
        pages,
        model,
        firstUser,
        loss,
        approvals,
      });
      throw error;
    }
    this.activeRuns.delete(runId);
    const close = await this.writer.append(sessionId, turnCloseBatch({
      runId,
      turn,
      step: 1,
      assistantText,
      kind: terminal,
      provider: 'hermes',
      model: this.config.modelLabel,
    }));
    const record = await this.writer.append(sessionId, runRecordBatch({
      runId,
      sessionId,
      operationId: effectiveOperationId,
      state: terminal as RunRecordState,
      turn,
      historyDigest: digest,
      historyPages: pages,
      model,
      firstUser,
      loss,
      approvals,
      assistantText,
      lastEvent,
    }));
    return {
      runId,
      appended: close.appended + record.appended,
      assistantText,
      approvals,
      historyDigest: digest,
      historyPages: pages,
      firstUser,
      loss,
      model,
      terminal,
      replayed,
    };
  }

  /** 流失败时写收尾与失败记录。 */
  private async writeTerminal(
    sessionId: string,
    runId: string,
    operationId: string,
    turn: number,
    assistantText: string,
    kind: TurnCloseKind,
    lastEvent: string,
    summary: {
      readonly digest: string;
      readonly pages: number;
      readonly model: ModelMetadata;
      readonly firstUser: string;
      readonly loss: readonly { readonly code: string; readonly count: number }[];
      readonly approvals: readonly string[];
    },
  ): Promise<void> {
    await this.writer.append(sessionId, turnCloseBatch({
      runId,
      turn,
      step: 1,
      assistantText,
      kind,
      provider: 'hermes',
      model: this.config.modelLabel,
    }));
    await this.writer.append(sessionId, runRecordBatch({
      runId,
      sessionId,
      operationId,
      state: kind as RunRecordState,
      turn,
      historyDigest: summary.digest,
      historyPages: summary.pages,
      model: summary.model,
      firstUser: summary.firstUser,
      loss: summary.loss,
      approvals: summary.approvals,
      assistantText,
      lastEvent,
    }));
  }

  /** 没有活动流时，按查询到的终态补齐会话收尾。 */
  private async finishFromStatus(sessionId: string, runId: string, status: RunStatusSnapshot): Promise<void> {
    const events = await this.writer.read(sessionId);
    const record = events
      .map((event) => runRecordOf(event))
      .filter((item): item is RunRecord => item !== undefined && item.runId === runId)
      .at(-1);
    if (record === undefined) throw new Error(`找不到运行记录：${runId}`);
    await this.writer.append(sessionId, turnCloseBatch({
      runId,
      turn: record.turn,
      step: 1,
      assistantText: assistantTextOfStatus(status),
      kind: closeKindOf(status.status),
      provider: 'hermes',
      model: this.config.modelLabel,
    }));
    await this.writer.append(sessionId, runRecordBatch({
      runId,
      sessionId,
      operationId: record.operationId,
      state: closeKindOf(status.status) as RunRecordState,
      turn: record.turn,
      historyDigest: record.historyDigest,
      historyPages: record.historyPages,
      model: record.model,
      firstUser: record.firstUser,
      loss: record.loss,
      approvals: record.approvals,
      assistantText: assistantTextOfStatus(status),
      lastEvent: status.lastEvent ?? 'run-status',
    }));
  }

  /**
   * 回答一次 Hermes 审批。
   * @param sessionId - 目标会话。
   * @param runId - Hermes 的运行标识。
   * @param requestId - 审批请求标识。
   * @param choice - 审批选项。
   * @param decidedBy - 作出决定的客户端标识。
   */
  @Remote('answerApproval')
  async answerApproval(
    sessionId: string,
    runId: string,
    requestId: string,
    choice: ApprovalChoice,
    decidedBy = 'client',
  ): Promise<{ accepted: boolean; outcome: 'accepted' | 'stale' }> {
    const telemetry = telemetryOf<ChatTelemetry>(this.ctx);
    const relay = async (_span?: SpanLike): Promise<{ accepted: boolean; outcome: 'accepted' | 'stale' }> => {
      try {
        const answer = await this.bridge.answerApproval(runId, requestId, choice);
        const stale = answer.outcome === 'stale';
        await this.writer.append(sessionId, approvalDecisionBatch({
          runId,
          requestId,
          choice,
          answeredBy: decidedBy,
          stale,
        }));
        telemetry?.event('chatdsh.chat.hermes.approval.relayed', { outcome: answer.outcome });
        telemetry?.counter('chatdsh_chat_hermes_approvals_total', { description: 'Hermes 审批应答数' })
          .add(1, { outcome: answer.outcome });
        return { accepted: answer.outcome === 'accepted', outcome: answer.outcome };
      } catch (error) {
        telemetry?.event('chatdsh.chat.hermes.approval.relayed', {
          outcome: 'failed',
          'error.code': error instanceof HermesError ? error.code : 'approval-relay-failed',
        });
        telemetry?.counter('chatdsh_chat_hermes_approvals_total', { description: 'Hermes 审批应答数' })
          .add(1, { outcome: 'failed' });
        throw error;
      }
    };
    if (telemetry === undefined) return relay();
    return telemetry.runSpan('chatdsh.chat.hermes.approval', { 'rpc.method': 'answerApproval' }, relay);
  }
}

/** 注册服务。 */
export function apply(ctx: Context, config: ChatHermesConfig): void {
  ctx.plugin(ChatdshHermesChatService, config);
}
