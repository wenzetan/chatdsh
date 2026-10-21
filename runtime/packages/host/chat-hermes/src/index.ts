/**
 * Hermes 承载聊天时的宿主插件。
 *
 * 它把 `hermes-adapter` 的聊天后端接到 DSH 的会话日志上：一次 `send` 发起一个 Hermes
 * 运行，收集事件流，按 hermes-integration.md 第五节的形状代写回会话；审批请求写成
 * `plugin:` 记录，应答通过同一个服务回传 Hermes。
 *
 * 外部写入走存储层的写句柄：会话必须已经存在并且当前没有其他写者。写句柄是单写者
 * 所有权，冲突时直接抛出，由调用方退避重试，不在插件里静默降级到另一条路径。
 * @module @chatdsh/host-chat-hermes
 */

import { Remote, schema as z, sessionPersistenceOf, sessionsOf, telemetryOf, TypertRemoteService, type Context, type SessionId } from '@chatdsh/adapter';
import type { ApprovalChoice, ChatRunEvent } from '@chatdsh/core-contracts';
import { createHermesChatBackend, HermesError, type HermesConfig } from '@chatdsh/hermes-adapter';
import { planReplyBatch } from './translate.ts';

export { approvalPluginEvent, planReplyBatch, translateRun } from './translate.ts';
export type { ChatSessionEvent, ReplyPlan, TranslateInput, TranslateResult } from './translate.ts';

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
}

/** 配置 schema。 */
export const Config: z<ChatHermesConfig> = z.object({
  baseUrl: z.string().default('http://127.0.0.1:50011'),
  apiKeyEnv: z.string(),
  requestTimeoutMs: z.number().default(120_000),
  approvalTimeoutMs: z.number().default(300_000),
  modelLabel: z.string().default('hermes-0.21.7'),
});

/** 一次发送的结果。 */
export interface SendResult {
  /** Hermes 的运行标识。 */
  readonly runId: string;
  /** 写进会话的事件条数。 */
  readonly appended: number;
  /** 助手回复的可见文本。 */
  readonly assistantText: string;
  /** 本次运行里出现的审批请求标识。 */
  readonly approvals: readonly string[];
}

/** 用到的遥测面。 */
interface ChatTelemetry {
  runSpan<T>(name: string, attributes: Record<string, unknown>, body: (span: { setAttribute(key: string, value: unknown): void; end(): void }) => Promise<T>): Promise<T>;
  event(name: string, attributes?: Record<string, unknown>): void;
  counter(name: string, options?: { description: string }): { add(delta: number, attributes?: Record<string, unknown>): void };
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

  private readonly backend: ReturnType<typeof createHermesChatBackend>;

  constructor(ctx: Context, private readonly config: ChatHermesConfig) {
    super(ctx, SERVICE_NAME);
    const adapterConfig: HermesConfig = {
      baseUrl: config.baseUrl,
      ...(config.apiKeyEnv === undefined ? {} : { apiKeyEnv: config.apiKeyEnv }),
      requestTimeoutMs: config.requestTimeoutMs,
      approvalTimeoutMs: config.approvalTimeoutMs,
    };
    this.backend = createHermesChatBackend(adapterConfig);
  }

  /** 探活。 */
  @Remote('health')
  async health(): Promise<{ ok: boolean; detail?: string }> {
    return this.backend.health({});
  }

  /**
   * 向一个已有会话发送一条聊天消息，把 Hermes 的回复代写回会话。
   * @param sessionId - 目标会话。
   * @param text - 用户输入。
   * @returns 运行标识与写入结果。
   */
  @Remote('send')
  async send(sessionId: string, text: string): Promise<SendResult> {
    // 渠道会话可能没有活动 Agent：存在性以会话注册表或持久化存储任一为准。
    const liveSession = sessionsOf(this.ctx).get(sessionId as SessionId);
    if (liveSession === undefined) {
      const stored = await sessionPersistenceOf(this.ctx).stat(sessionId as SessionId);
      if (stored === undefined) throw new Error(`会话不存在：${sessionId}`);
    }
    if (text.trim() === '') throw new Error('消息不能为空');

    const telemetry = telemetryOf<ChatTelemetry>(this.ctx);
    const run = async (span?: { setAttribute(key: string, value: unknown): void; end(): void }): Promise<SendResult> => {
      try {
        const handle = await this.backend.createRun({ sessionId, text }, {});
        const collected: ChatRunEvent[] = [];
        for await (const event of this.backend.streamEvents(handle.runId, {})) {
          collected.push(event);
        }

        // 活体会话优先走 Session.append：它的写句柄由 agent 生命周期持有，外部再开
        // 写句柄会以 SessionAlreadyOwnedError 拒绝。没有活体会话时才走存储写句柄。
        const live = sessionsOf(this.ctx).get(sessionId as SessionId);
        let firstSeq: number;
        let existingEvents: readonly { readonly type: string; readonly data: unknown }[];
        if (live !== undefined) {
          firstSeq = live.seq;
          existingEvents = live.snapshotEvents();
        } else {
          const handleWrite = await sessionPersistenceOf(this.ctx).open(sessionId as SessionId, 'write');
          try {
            const existing = await handleWrite.read();
            firstSeq = existing.events.length;
            existingEvents = existing.events as unknown as readonly { readonly type: string; readonly data: unknown }[];
            const lastTurn = existingEvents.reduce((max, event) => {
              if (event.type === 'turn/start' && typeof (event.data as { turn?: number }).turn === 'number') return Math.max(max, (event.data as { turn: number }).turn);
              return max;
            }, 0);
            const plan = planReplyBatch({
              runId: handle.runId,
              firstSeq,
              turn: lastTurn + 1,
              step: 1,
              userText: text,
              provider: 'hermes',
              model: this.config.modelLabel,
              events: collected,
            });
            await handleWrite.append(plan.batch as never);
            await handleWrite.flush();
            span?.setAttribute('outcome', 'ok');
            telemetry?.counter('chatdsh_chat_hermes_runs_total', { description: 'Hermes 承载的聊天运行数' })
              .add(1, { outcome: 'ok' });
            return {
              runId: handle.runId,
              appended: plan.batch.length,
              assistantText: plan.assistantText,
              approvals: plan.approvals,
            };
          } finally {
            await handleWrite.close();
          }
        }

        const lastTurn = existingEvents.reduce((max, event) => {
          if (event.type === 'turn/start' && typeof (event.data as { turn?: number }).turn === 'number') return Math.max(max, (event.data as { turn: number }).turn);
          return max;
        }, 0);
        const plan = planReplyBatch({
          runId: handle.runId,
          firstSeq,
          turn: lastTurn + 1,
          step: 1,
          userText: text,
          provider: 'hermes',
          model: this.config.modelLabel,
          events: collected,
        });
        for (const event of plan.batch) {
          if (event.surfaceOp === 'append') {
            (live as unknown as { append(type: string, data: unknown, intent: { surfaceOp: 'append' }): unknown }).append(event.type, event.data, { surfaceOp: 'append' });
          } else {
            (live as unknown as { append(type: string, data: unknown): unknown }).append(event.type, event.data);
          }
        }
        await sessionsOf(this.ctx).flush(live);
        span?.setAttribute('outcome', 'ok');
        telemetry?.counter('chatdsh_chat_hermes_runs_total', { description: 'Hermes 承载的聊天运行数' })
          .add(1, { outcome: 'ok' });
        return {
          runId: handle.runId,
          appended: plan.batch.length,
          assistantText: plan.assistantText,
          approvals: plan.approvals,
        };
      } catch (error) {
        span?.setAttribute('outcome', 'failed');
        telemetry?.event('chatdsh.chat.hermes.run.failed', {
          'error.type': error instanceof Error ? error.name : 'Unknown',
          'error.code': error instanceof HermesError ? error.code : 'chat-hermes-failed',
        });
        telemetry?.counter('chatdsh_chat_hermes_runs_total', { description: 'Hermes 承载的聊天运行数' })
          .add(1, { outcome: 'failed' });
        throw error;
      }
    };

    if (telemetry === undefined) return run();
    return telemetry.runSpan('chatdsh.chat.hermes.run', { 'session.id': sessionId }, run);
  }

  /**
   * 回答一次 Hermes 审批。
   * @param runId - Hermes 的运行标识。
   * @param requestId - 审批请求标识。
   * @param choice - 契约里的审批选项。
   */
  @Remote('answerApproval')
  async answerApproval(runId: string, requestId: string, choice: ApprovalChoice): Promise<{ accepted: boolean }> {
    const telemetry = telemetryOf<ChatTelemetry>(this.ctx);
    const relay = async (span?: { setAttribute(key: string, value: unknown): void; end(): void }): Promise<{ accepted: boolean }> => {
      try {
        await this.backend.respondApproval(runId, requestId, choice, {});
        span?.setAttribute('outcome', 'accepted');
        telemetry?.event('chatdsh.chat.hermes.approval.relayed', { outcome: 'accepted' });
        telemetry?.counter('chatdsh_chat_hermes_approvals_total', { description: 'Hermes 审批应答数' })
          .add(1, { outcome: 'accepted' });
        return { accepted: true };
      } catch (error) {
        // 409 表示 Hermes 侧已解决；按已失效落定，不重试。
        const stale = error instanceof HermesError && error.status === 409;
        span?.setAttribute('outcome', stale ? 'stale' : 'failed');
        telemetry?.event('chatdsh.chat.hermes.approval.relayed', {
          outcome: stale ? 'stale' : 'failed',
          'error.code': error instanceof HermesError ? error.code : 'approval-relay-failed',
        });
        telemetry?.counter('chatdsh_chat_hermes_approvals_total', { description: 'Hermes 审批应答数' })
          .add(1, { outcome: stale ? 'stale' : 'failed' });
        return { accepted: false };
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
