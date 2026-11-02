/**
 * 审批、提问与计划接管的宿主服务。
 *
 * 三件事都从「宿主侧有一个正在等的调用方」出发：审批登记在运行时的审批应答链上，提问登记在
 * 用户提问服务的应答链上，计划审阅是提问的一种意图。客户端提交的决定、答案与计划意见都在
 * 这里落到等待者身上，等待者因此继续执行或按拒绝结束；只改界面状态的做法在这里没有位置。
 *
 * 会话日志里的 `approval/asked` 与 `approval/decided` 是审计事件，折叠成投影供客户端读到与
 * 会话一致的进度。运行期台账（{@link ApprovalDesk}）承担状态版本、竞争、超时与失效说明。
 * @module @chatdsh/host-approval
 */

import { randomUUID } from 'node:crypto';
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
import type {} from '@deepseek-ai/dsh-user-questions';
import { z } from 'zod';
import {
  decisionRequestSchema,
  planDraftRequestSchema,
  planSubmitRequestSchema,
  questionAnswerRequestSchema,
  questionSkipRequestSchema,
  takeoverRequestSchema,
  type DecisionResult,
  type PlanDraftResult,
  type QuestionResult,
  type TakeoverResult,
} from './contracts.ts';
import { ApprovalDesk } from './decisions.ts';
import { QuestionDesk } from './questions.ts';
import { TakeoverDesk } from './takeovers.ts';
import { approvalTelemetryOf, recordDecision, runWaitSpan, type ApprovalKind } from './telemetry.ts';
import type { ApprovalEvent, ApprovalsState } from './types.ts';
import { applyApprovalEvent, correlationKeyOf } from './types.ts';
import {
  INVALID_REASON_TEXT,
  type ApprovalDeviceGroup,
  type ApprovalStats,
  type PendingOverview,
  type PolicyRecord,
  type QuestionView,
} from './types.ts';

export type { ApprovalsState, ApprovalEvent, PendingApproval } from './types.ts';
export { applyApprovalEvent, correlationKeyOf } from './types.ts';

export type { ApprovalOutcome } from './decisions.ts';
export type { ApprovalCardView, ApprovalStats, DecisionRecord, PendingOverview, PolicyRecord, QuestionView } from './types.ts';
export {
  DECISION_CHOICES,
  CHOICE_TEXT,
  type DecisionChoice,
  type DecisionRequest,
  type DecisionResult,
  type PlanDraftResult,
  type QuestionResult,
  type TakeoverResult,
} from './contracts.ts';
export { ApprovalDesk, groupCards } from './decisions.ts';
export { QuestionDesk, validateAnswers, type QuestionItemWire } from './questions.ts';
export { TakeoverDesk } from './takeovers.ts';

/** 配置。 */
export interface ApprovalConfig {
  /** 是否接管审批与提问请求；关闭时把请求交给下一个应答器，内置界面照常工作。 */
  takeOver: boolean;
  /** 等待客户端作答的上限，超时按不可用处理（fail closed）。 */
  answerTimeoutMs: number;
  /** 提问卡片的等待上限，超时按失效处理。 */
  questionTimeoutMs: number;
  /** 本设备标识，写进卡片与分组。 */
  deviceId: string;
  /** 是否允许「本会话允许」与「始终允许」两个扩大范围的选项。 */
  allowEscalation: boolean;
}

/** 配置 schema。 */
export const Config: sz<ApprovalConfig> = sz.object({
  takeOver: sz.boolean().default(false),
  // 下限一秒：更短的值让 setTimeout 立即触发，审批还没等到客户端作答就已经超时。
  answerTimeoutMs: sz.number().min(1000).default(300_000),
  questionTimeoutMs: sz.number().min(1000).default(600_000),
  deviceId: sz.string().default('local'),
  allowEscalation: sz.boolean().default(true),
});

/** 决策取值。 */
export const OUTCOMES = ['allowed-once', 'rejected', 'cancelled', 'unavailable'] as const;

/** 插件名。 */
export const name = 'chatdsh-approval';

/** 投影键。 */
export const PROJECTION_KEY = 'chatdshApprovals';

/** 初始状态：没有审批。 */
export const INITIAL_STATE: ApprovalsState = { pending: [], askedCount: 0 };

/** 服务名，同时是 Remote 命名空间。 */
export const SERVICE_NAME = 'chatdshApprovals';

/** 用户提问服务的应答链事件名。 */
const QUESTION_REQUEST_EVENT = 'user-questions/request';

/** 默认配置。 */
const DEFAULT_CONFIG: ApprovalConfig = {
  takeOver: false,
  answerTimeoutMs: 300_000,
  questionTimeoutMs: 600_000,
  deviceId: 'local',
  allowEscalation: true,
};

/** 待处理列表的过滤条件。 */
const PENDING_FILTERS = ['waiting', 'handled', 'all'] as const;

/** 待处理列表的查询。 */
const pendingQuerySchema = z.object({
  filter: z.enum(PENDING_FILTERS).default('waiting'),
  sessionId: z.string().min(1).max(200).optional(),
});

/** 待处理列表的查询。 */
export type PendingQuery = z.infer<typeof pendingQuerySchema>;

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

/**
 * 审批、提问与计划接管服务。
 *
 * 它既是决定的受理方，也是等待者的登记处：决定生效时解除宿主侧等待，会话结束时把仍在等待的
 * 卡片按失效收尾。统计只累计本运行期内的决定，审计仍以会话日志为准。
 */
export class ChatdshApprovalService extends TypertRemoteService {
  static inject = ['sessionProjections', 'sessions'];

  /** 配置 schema，供加载器校验。 */
  static readonly Config = Config;

  private readonly config: ApprovalConfig;

  /** 审批卡片台账。 */
  private readonly desk: ApprovalDesk;

  /** 提问卡片台账。 */
  private readonly questions: QuestionDesk;

  /** 计划接管租约。 */
  private readonly takeovers: TakeoverDesk;

  constructor(ctx: Context, config: Partial<ApprovalConfig> = {}) {
    super(ctx, SERVICE_NAME);
    this.config = { ...DEFAULT_CONFIG, ...config };
    const now = (): number => Date.now();
    this.desk = new ApprovalDesk({
      deviceId: this.config.deviceId,
      answerTimeoutMs: this.config.answerTimeoutMs,
      allowEscalation: this.config.allowEscalation,
      now,
      onDecided: (record) => {
        recordDecision(approvalTelemetryOf(this.ctx), 'approval', record.choice ?? record.result, record.decidedBy);
      },
    });
    this.questions = new QuestionDesk({ now });
    this.takeovers = new TakeoverDesk({ now });
  }

  /** 注册投影与两个应答器。 */
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

    this.ctx.on(APPROVAL_EVENTS.request, async (request, next) => {
      if (!this.config.takeOver) return next();
      const callId = correlationKeyOf(request);
      if (callId === undefined) return 'unavailable';
      // 代理标识与它所属的会话使用同一个标识；目录从会话注册表读，请求本身只带工具身份。
      const sessionId = String(request.agent.id);
      const toolName = request.toolName;
      const cwd = sessionsOf(this.ctx).get(request.agent.id)?.header.cwd;
      const input = {
        callId,
        sessionId,
        toolName,
        ...(request.reason === undefined ? {} : { reason: request.reason }),
        ...(cwd === undefined ? {} : { cwd }),
      };
      const policy = this.desk.policyFor(sessionId, toolName);
      if (policy !== undefined) {
        this.desk.autoApprove(input, policy);
        return 'allowed-once';
      }
      const opened = this.desk.open(input);
      request.signal?.addEventListener('abort', () => {
        this.desk.cancel(callId);
      }, { once: true });
      return runWaitSpan(approvalTelemetryOf(this.ctx), 'approval', 'unavailable', async () => {
        const outcome = await opened.promise;
        return { value: outcome, decision: outcome };
      });
    });

    this.ctx.on(QUESTION_REQUEST_EVENT, async (request, next) => {
      if (!this.config.takeOver) return next();
      const agent = request.agent;
      if (agent === undefined) return next();
      // 卡片关联键：阻塞提问由工具调用给出；计划审阅把调用标识放在意图里；两者都没有时另行生成，
      // 卡片仍然可作答，只是无法与某一次工具调用对上号。
      const planCall = request.questions.find((question) => question.intent?.kind === 'plan-review')?.intent?.callId;
      const callId = request.wait?.callId !== undefined
        ? String(request.wait.callId)
        : planCall !== undefined
          ? String(planCall)
          : `question-${randomUUID()}`;
      const opened = this.questions.open({
        callId,
        sessionId: String(agent.id),
        questions: request.questions,
        timeoutMs: this.config.questionTimeoutMs,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      const kind: ApprovalKind = opened.card.kind === 'plan-review' ? 'plan' : 'question';
      return runWaitSpan(approvalTelemetryOf(this.ctx), kind, 'expired', async () => {
        const answer = await opened.promise;
        return {
          value: {
            answers: answer.answers.map((item) => ({
              id: item.id,
              selected: [...item.selected],
              ...(item.custom === undefined ? {} : { custom: item.custom }),
            })),
          },
          decision: 'submitted',
        };
      });
    });

    this.ctx.effect(() => () => {
      this.desk.dispose();
      this.questions.dispose();
    }, 'chatdsh-approval');
  }

  /**
   * 读待处理概览。
   *
   * 会话结束的卡片在这里按失效收尾，因此客户端读到的列表不会留下已经没有人等待的卡片。
   * @param query - 过滤条件与可选的会话过滤。
   * @returns 卡片、分组与可操作数量。
   */
  @Remote('pending')
  pending(query?: unknown): PendingOverview {
    const parsed = pendingQuerySchema.parse(query ?? {});
    this.desk.settleEndedSessions((sessionId) => this.sessionAlive(sessionId));
    const overview = this.desk.overview();
    const scoped = overview.cards.filter((card) => parsed.sessionId === undefined || card.sessionId === parsed.sessionId);
    const waiting = scoped.filter((card) => card.state === 'pending' || card.state === 'answering');
    const handled = scoped.filter((card) => card.invalidReason !== undefined);
    const cards = parsed.filter === 'waiting' ? waiting : parsed.filter === 'handled' ? handled : scoped;
    const groups = overview.groups
      .map((device) => scopeGroup(device, parsed.sessionId))
      .filter((device) => device.sessions.length > 0);
    return { cards, groups, actionable: waiting.length, readAt: overview.readAt };
  }

  /**
   * 按设备、会话与工具分组的待处理列表。
   * @param query - 过滤条件与可选的会话过滤。
   * @returns 分组。
   */
  @Remote('grouped')
  grouped(query?: unknown): readonly ApprovalDeviceGroup[] {
    return this.pending(query).groups;
  }

  /** 列出正在等待客户端作答的审批关联键。 */
  @Remote('waiting')
  waiting(): string[] {
    return this.desk.waiting();
  }

  /** 读审批统计。 */
  @Remote('stats')
  stats(sessionId?: string): ApprovalStats {
    return this.desk.stats(sessionId === '' ? undefined : sessionId);
  }

  /**
   * 提交一次审批决定。
   * @param raw - 决定请求。
   * @returns 决定结果；冲突、过期与不支持的选项都给出具体错误码。
   */
  @Remote('decide')
  decide(raw: unknown): DecisionResult {
    const parsed = decisionRequestSchema.safeParse(raw);
    if (!parsed.success) return { outcome: 'rejected', code: 'request-invalid' };
    return this.desk.decide(parsed.data);
  }

  /**
   * 单次决定入口：批准或拒绝一张等待中的卡片。
   *
   * 与 {@link decide} 的差别在于调用方不必带状态版本与操作标识，供已经知道关联键的调用方使用。
   * @param id - 工具调用标识。
   * @param outcome - `allowed-once` 或 `rejected`。
   * @returns 是否受理了这次决定。
   */
  @Remote('answer')
  answer(id: string, outcome: string): boolean {
    if (outcome !== 'allowed-once' && outcome !== 'rejected') throw new Error(`未知的审批结果：${outcome}`);
    const card = this.desk.entryOf(id);
    if (card === undefined) return false;
    const result = this.desk.decide({
      callId: id,
      stateVersion: card.stateVersion,
      choice: outcome === 'allowed-once' ? 'once' : 'deny',
      operationId: `legacy-${Date.now().toString(36)}-${Math.trunc(Math.random() * 1e9).toString(36)}`,
      requestDigest: '0'.repeat(64),
      escalationConfirmed: false,
      decidedBy: 'legacy-answer',
    });
    return result.outcome === 'decided';
  }

  /** 列出生效中的会话策略。 */
  @Remote('policies')
  policies(): PolicyRecord[] {
    return this.desk.policyList();
  }

  /**
   * 撤销一条会话策略。
   * @param id - 策略标识。
   * @returns 是否撤销了一条策略。
   */
  @Remote('clearPolicy')
  clearPolicy(id: string): boolean {
    return this.desk.clearPolicy(id);
  }

  /** 列出提问卡片，计划卡片带上接管状态与草稿。 */
  @Remote('questions')
  questionCards(): QuestionView[] {
    return this.questions.cards().map((card) => (card.kind === 'plan-review' ? this.withTakeover(card) : card));
  }

  /**
   * 提交一批提问答案。
   * @param raw - 应答请求。
   * @returns 结果；校验失败带逐条说明，卡片保持可继续填写。
   */
  @Remote('answerQuestion')
  answerQuestion(raw: unknown): QuestionResult {
    const parsed = questionAnswerRequestSchema.safeParse(raw);
    if (!parsed.success) return { outcome: 'rejected', code: 'request-invalid' };
    const result = this.questions.answer(parsed.data);
    this.noteQuestionResult(result, 'question', 'answer');
    return result;
  }

  /**
   * 跳过一张提问卡片。
   * @param raw - 跳过请求。
   * @returns 结果。
   */
  @Remote('skipQuestion')
  skipQuestion(raw: unknown): QuestionResult {
    const parsed = questionSkipRequestSchema.safeParse(raw);
    if (!parsed.success) return { outcome: 'rejected', code: 'request-invalid' };
    const result = this.questions.skip(parsed.data);
    this.noteQuestionResult(result, 'question', 'skip');
    return result;
  }

  /**
   * 取得或释放计划编辑租约。
   * @param raw - 接管请求。
   * @returns 租约结果与草稿。
   */
  @Remote('takeover')
  takeover(raw: unknown): TakeoverResult {
    const parsed = takeoverRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return { outcome: 'rejected', code: 'request-invalid', reason: '接管请求缺少字段' };
    }
    const { action, callId, holderId, holderLabel, stateVersion } = parsed.data;
    const card = this.questions.planCard(callId);
    if (card === undefined) {
      return { outcome: 'rejected', code: 'question-expired', reason: INVALID_REASON_TEXT.expired };
    }
    if (card.stateVersion !== stateVersion) {
      return { outcome: 'rejected', code: 'revision-conflict', reason: '卡片状态已经变化，请重新读取' };
    }
    if (action === 'release') return this.takeovers.release(callId, holderId);
    return this.takeovers.acquire(callId, holderId, holderLabel, card.planMarkdown ?? '');
  }

  /**
   * 保存计划草稿。
   * @param raw - 草稿请求。
   * @returns 保存结果与草稿版本。
   */
  @Remote('savePlanDraft')
  savePlanDraft(raw: unknown): PlanDraftResult {
    const parsed = planDraftRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return { outcome: 'rejected', revision: 0, updatedAt: Date.now(), code: 'request-invalid' };
    }
    const { callId, holderId, text, revision } = parsed.data;
    return this.takeovers.save(callId, holderId, text, revision);
  }

  /**
   * 提交计划审阅结果。
   * @param raw - 提交请求。
   * @returns 结果；批准或保留计划都会交回等待中的工具调用。
   */
  @Remote('submitPlan')
  submitPlan(raw: unknown): QuestionResult {
    const parsed = planSubmitRequestSchema.safeParse(raw);
    if (!parsed.success) return { outcome: 'rejected', code: 'request-invalid' };
    const { callId, holderId, stateVersion, decision, feedback, operationId } = parsed.data;
    const card = this.questions.planCard(callId);
    if (card === undefined) return { outcome: 'rejected', code: 'question-expired' };
    const holder = this.takeovers.state(callId, card.planMarkdown ?? '').holderId;
    if (holder !== undefined && holder !== holderId) {
      return { outcome: 'rejected', code: 'revision-conflict', problems: ['编辑区属于另一位接管者'] };
    }
    const result = this.questions.submitPlan(callId, stateVersion, decision, feedback, operationId);
    if (result.outcome === 'submitted') this.takeovers.drop(callId);
    this.noteQuestionResult(result, 'plan', decision === 'approve' ? 'approve-plan' : 'revise-plan');
    return result;
  }

  /** 记一条提问或计划的结果。 */
  private noteQuestionResult(result: QuestionResult, kind: ApprovalKind, action: string): void {
    const telemetry = approvalTelemetryOf(this.ctx);
    if (result.outcome === 'submitted') {
      recordDecision(telemetry, kind, action, 'client');
      return;
    }
    recordDecision(telemetry, kind, `rejected:${result.code}`, 'client');
  }

  /** 会话是否还在本运行时里。 */
  private sessionAlive(sessionId: string): boolean {
    return sessionsOf(this.ctx).get(sessionId as SessionId) !== undefined;
  }

  /** 把接管状态与草稿并进计划卡片。 */
  private withTakeover(card: QuestionView): QuestionView {
    const state = this.takeovers.state(card.callId, card.planMarkdown ?? '');
    return { ...card, takeover: state };
  }
}

/**
 * 按会话过滤一组分组。
 * @param device - 设备分组。
 * @param sessionId - 会话过滤。
 * @returns 过滤后的分组。
 */
function scopeGroup(device: ApprovalDeviceGroup, sessionId: string | undefined): ApprovalDeviceGroup {
  if (sessionId === undefined) return device;
  const sessions = device.sessions.filter((session) => session.sessionId === sessionId);
  return { ...device, sessions, count: sessions.reduce((sum, session) => sum + session.count, 0) };
}

export { ChatdshApprovalService as default };
