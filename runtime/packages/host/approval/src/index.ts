/**
 * 审批投影。
 *
 * 会话日志里的 `approval/asked` 与 `approval/decided` 是审计事件，配对使用同一个标识。
 * 这里把它们折叠成一份可查询的状态：还有哪些审批在等回答、最近一次的结果是什么。投影随
 * 会话一起落盘，重启后按日志重放，客户端因此能看到与会话一致的进度。
 * @module @chatdsh/host-approval
 */

import {
  APPROVAL_EVENTS,
  Remote,
  schema as sz,
  sessionProjectionsOf,
  sessionsOf,
  TypertRemoteService,
  type Context,
  type SessionId,
} from '@chatdsh/adapter';
// 引入投影注册表与审批事件的类型声明（模块增强必须指向真实包名）。
import type {} from '@deepseek-ai/dsh-session-projection';
import type {} from '@deepseek-ai/dsh-user-approval';
import { z } from 'zod';
import type { ApprovalsState, ApprovalEvent, PendingApproval } from './types.ts';
import { applyApprovalEvent, correlationKeyOf } from './types.ts';

export type { ApprovalsState, ApprovalEvent, PendingApproval } from './types.ts';
export { applyApprovalEvent, correlationKeyOf } from './types.ts';

/** 配置。 */
export interface ApprovalConfig {
  /** 是否接管审批请求；关闭时把请求交给下一个应答器，内置界面照常工作。 */
  takeOver: boolean;
  /** 等待客户端作答的上限，超时按不可用处理（fail closed）。 */
  answerTimeoutMs: number;
}

/** 配置 schema。 */
export const Config: sz<ApprovalConfig> = sz.object({
  takeOver: sz.boolean().default(false),
  // 下限一秒：更短的值让 setTimeout 立即触发，审批还没等到客户端作答就已经超时。
  answerTimeoutMs: sz.number().min(1000).default(300_000),
});

/** 决策取值。 */
export const OUTCOMES = ['allowed-once', 'rejected', 'cancelled', 'unavailable'] as const;

/** 一种决策。 */
export type ApprovalOutcome = typeof OUTCOMES[number];

/** 插件名。 */
export const name = 'chatdsh-approval';

/** 投影键。 */
export const PROJECTION_KEY = 'chatdshApprovals';

/** 初始状态：没有审批。 */
export const INITIAL_STATE: ApprovalsState = { pending: [], askedCount: 0 };

/** 状态的校验形状，供投影注册表使用。 */
const STATE_SCHEMA = z.object({
  pending: z.array(z.object({
    id: z.string(),
    callId: z.string().optional(),
    toolName: z.string(),
    reason: z.string().optional(),
    askedAt: z.number(),
  })),
  askedCount: z.number(),
  lastOutcome: z.string().optional(),
  lastAt: z.number().optional(),
});

/** 事件形状与折叠规则在 types.ts 里，与投影状态的定义放在一起。 */

/** 服务名，同时是 Remote 命名空间。 */
export const SERVICE_NAME = 'chatdshApprovals';

/**
 * 审批投影服务。
 *
 * 它只读会话投影，不参与审批判定：判定仍由审批应答链完成，这里回答的是「有没有在等、
 * 上一次结果是什么」。
 */
export class ChatdshApprovalService extends TypertRemoteService {
  static inject = ['sessionProjections', 'sessions'];

  /** 正在等待客户端作答的请求，键是关联键。 */
  private readonly waiting = new Map<string, (outcome: ApprovalOutcome) => void>();

  /** 配置 schema，供加载器校验。 */
  static readonly Config = Config;

  constructor(ctx: Context, private readonly config: ApprovalConfig) {
    super(ctx, SERVICE_NAME);
  }

  /** 注册投影。 */
  async [TypertRemoteService.init](): Promise<void> {
    sessionProjectionsOf(this.ctx).register({
      key: PROJECTION_KEY,
      stateVersion: 1,
      stateSchema: STATE_SCHEMA,
      init: () => INITIAL_STATE,
      apply: (state, event) => applyApprovalEvent(state, event as unknown as ApprovalEvent),
      // 视图与状态同形：客户端拿到的就是折叠后的结果。
      wire: {
        viewSchema: STATE_SCHEMA,
        view: (state: ApprovalsState) => state,
      },
    });

    // 应答器：接管模式下把请求挂起，等客户端通过 `answer` 交代结果；超时按不可用处理。
    this.ctx.on(APPROVAL_EVENTS.request, async (request, next) => {
      if (!this.config.takeOver) return next();
      return this.awaitAnswer(request);
    });
  }

  /**
   * 挂起一个请求，等客户端作答或超时。
   *
   * 关联键取 `callId`。请求与审计事件之间没有共享的 `id`：`approval/asked` 的
   * `id` 由审批服务在提出问题时生成，请求方看不到它。`callId` 是上游明确保证
   * 的稳定关联点。没有 `callId` 的请求无法与审计事件配对，因此不进入等待表，
   * 直接按不可用处理——这与上游「没有应答器即失败关闭」的语义一致。
   */
  private async awaitAnswer(request: { callId?: unknown }): Promise<ApprovalOutcome> {
    const key = correlationKeyOf(request);
    if (key === undefined) return 'unavailable';
    return new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(key);
        resolve('unavailable');
      }, this.config.answerTimeoutMs);
      this.waiting.set(key, (outcome) => {
        clearTimeout(timer);
        this.waiting.delete(key);
        resolve(outcome);
      });
    });
  }

  /**
   * 读一个会话的审批状态。
   *
   * 投影的折叠是按会话驱动的，事件本身不带会话标识，因此状态要从投影注册表的
   * 读面取，而不是从事件里找会话标识。读面按需物化：重启后恢复的会话也会
   * 在第一次读取时折叠出来。
   */
  private stateOf(sessionId: string): ApprovalsState | undefined {
    const session = sessionsOf(this.ctx).get(sessionId as SessionId);
    if (session === undefined) return undefined;
    return sessionProjectionsOf(this.ctx).stateOf(session, PROJECTION_KEY);
  }

  /** 交代一条审批的结果。 */
  @Remote('answer')
  answer(id: string, outcome: string): boolean {
    const resolve = this.waiting.get(id);
    if (resolve === undefined) return false;
    if (!OUTCOMES.includes(outcome as ApprovalOutcome)) throw new Error(`未知的审批结果：${outcome}`);
    // 等待表由 awaitAnswer 的包装函数清理：交出结果时删除条目并清掉超时定时器。
    resolve(outcome as ApprovalOutcome);
    return true;
  }

  /** 列出正在等待客户端作答的审批关联键。 */
  @Remote('waiting')
  waitingIds(): string[] {
    return [...this.waiting.keys()];
  }

  /** 列出全部会话里待处理的审批。 */
  @Remote('pending')
  pending(): PendingApproval[] {
    return sessionsOf(this.ctx).list()
      .flatMap((session) => {
        const state = sessionProjectionsOf(this.ctx).stateOf(session, PROJECTION_KEY);
        return state === undefined ? [] : state.pending;
      });
  }

  /** 读取一个会话的审批统计。 */
  @Remote('stats')
  stats(sessionId: string): ApprovalsState {
    return this.stateOf(sessionId) ?? INITIAL_STATE;
  }
}

export { ChatdshApprovalService as default };
