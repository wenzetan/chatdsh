/**
 * 审批卡片的运行期台账：等待项、决定、超时、失效墓碑、会话策略与统计。
 *
 * 台账只记运行期状态，审计仍由运行时的审批记录承担：决定生效时会解除宿主侧等待，等待项本身
 * 由上游的审批服务在会话日志里写下 `approval/asked` 与 `approval/decided`。决定携带状态版本，
 * 两个客户端竞争同一张卡片时第二个请求读到已决定，得到明确的冲突结果。
 *
 * 失效墓碑保留一段时间的已处理卡片，客户端据此说明「这张卡片为什么不能再处理」。原因取
 * {@link InvalidReason} 的登记值，说明文字在 {@link INVALID_REASON_TEXT} 里。
 * @module @chatdsh/host-approval/decisions
 */

import {
  CHOICE_OUTCOME,
  ESCALATING_CHOICES,
  type DecisionChoice,
  type DecisionRequest,
  type DecisionResult,
} from './contracts.ts';
import {
  INVALID_REASON_TEXT,
  type ApprovalCardView,
  type ApprovalDeviceGroup,
  type ApprovalSessionGroup,
  type ApprovalStats,
  type ApprovalToolGroup,
  type DecisionRecord,
  type InvalidReason,
  type LiveCardState,
  type PendingOverview,
  type PolicyRecord,
} from './types.ts';

/** 运行时审批结果。 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

/** 台账里的一张卡片。 */
interface LedgerEntry {
  readonly callId: string;
  readonly sessionId: string;
  readonly toolName: string;
  readonly deviceId: string;
  readonly origin: 'dsh' | 'hermes';
  readonly summary: string;
  readonly reason?: string;
  readonly cwd?: string;
  readonly capabilityScope: string;
  readonly choices: readonly DecisionChoice[];
  readonly priority: number;
  readonly raisedAt: number;
  readonly expiresAt: number;
  state: LiveCardState;
  stateVersion: number;
  decidedBy?: string;
  decidedChoice?: DecisionChoice;
  decidedAt?: number;
  /** 已提交过决定的操作标识，用于幂等重放。 */
  operationId?: string;
  resolve: (outcome: ApprovalOutcome) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** 已处理卡片的墓碑，供客户端说明失效原因。 */
interface Tombstone {
  readonly callId: string;
  readonly sessionId: string;
  readonly toolName: string;
  readonly deviceId: string;
  readonly origin: 'dsh' | 'hermes';
  readonly summary: string;
  readonly reason?: string;
  readonly cwd?: string;
  readonly capabilityScope: string;
  readonly choices: readonly DecisionChoice[];
  readonly priority: number;
  readonly raisedAt: number;
  readonly expiresAt: number;
  readonly stateVersion: number;
  readonly invalidReason: InvalidReason;
  readonly decidedBy?: string;
  readonly decidedChoice?: DecisionChoice;
  readonly decidedAt?: number;
  readonly tombstoneAt: number;
}

/** 打开一张卡片的输入。 */
export interface OpenApprovalInput {
  /** 工具调用标识。 */
  readonly callId: string;
  /** 会话标识。 */
  readonly sessionId: string;
  /** 工具名称。 */
  readonly toolName: string;
  /** 提出原因。 */
  readonly reason?: string;
  /** 目标工作目录。 */
  readonly cwd?: string;
  /** 来源执行体。 */
  readonly origin?: 'dsh' | 'hermes';
}

/** 打开一张卡片的结果。 */
export interface OpenApprovalResult {
  /** 等待客户端决定的承诺。 */
  readonly promise: Promise<ApprovalOutcome>;
  /** 刚建立的卡片。 */
  readonly card: ApprovalCardView;
}

/** 台账的依赖。 */
export interface ApprovalDeskOptions {
  /** 本设备标识。 */
  readonly deviceId: string;
  /** 等待客户端作答的上限，单位毫秒。 */
  readonly answerTimeoutMs: number;
  /** 是否允许扩大范围的选项。 */
  readonly allowEscalation: boolean;
  /** 当前时刻的毫秒时间戳。 */
  readonly now: () => number;
  /** 墓碑保留时长，单位毫秒。 */
  readonly tombstoneMs?: number;
  /** 最近的记录条数上限。 */
  readonly recentLimit?: number;
  /** 决定落定时通知外部（统计与遥测）。 */
  readonly onDecided?: (record: DecisionRecord) => void;
}

/** 会话策略的作用范围说明。 */
function policyText(scope: 'session' | 'device', toolName: string): string {
  if (scope === 'device') return `对本设备所有会话里的工具 ${toolName} 的同类审批不再询问，直到撤销这条策略`;
  return `只对本次会话里的工具 ${toolName} 的同类审批不再询问，会话结束后失效`;
}

/** 统计的空值。 */
function emptyStats(sessionId: string | undefined, now: number): ApprovalStats {
  return {
    ...(sessionId === undefined ? {} : { sessionId }),
    approved: 0,
    denied: 0,
    timeout: 0,
    autoApproved: 0,
    total: 0,
    pending: 0,
    recent: [],
    readAt: now,
  };
}

/** 审批台账。 */
export class ApprovalDesk {
  private readonly entries = new Map<string, LedgerEntry>();
  private readonly tombstones = new Map<string, Tombstone>();
  private readonly records: DecisionRecord[] = [];
  private readonly policies = new Map<string, PolicyRecord>();
  private readonly deviceId: string;
  private readonly answerTimeoutMs: number;
  private readonly allowEscalation: boolean;
  private readonly now: () => number;
  private readonly tombstoneMs: number;
  private readonly recentLimit: number;
  private readonly onDecided: ((record: DecisionRecord) => void) | undefined;

  constructor(options: ApprovalDeskOptions) {
    this.deviceId = options.deviceId;
    this.answerTimeoutMs = options.answerTimeoutMs;
    this.allowEscalation = options.allowEscalation;
    this.now = options.now;
    this.tombstoneMs = options.tombstoneMs ?? 600_000;
    this.recentLimit = options.recentLimit ?? 200;
    this.onDecided = options.onDecided;
  }

  /** 本设备标识。 */
  get device(): string {
    return this.deviceId;
  }

  /**
   * 取会话策略命中的记录。
   * @param sessionId - 会话标识。
   * @param toolName - 工具名称。
   * @returns 命中的策略；没有命中时为 `undefined`。
   */
  policyFor(sessionId: string, toolName: string): PolicyRecord | undefined {
    const sessionPolicy = this.policies.get(`session:${sessionId}:${toolName}`);
    if (sessionPolicy !== undefined) return sessionPolicy;
    return this.policies.get(`device:*:${toolName}`);
  }

  /** 列出生效中的策略，先设备范围后会话范围。 */
  policyList(): PolicyRecord[] {
    return [...this.policies.values()].sort((left, right) => {
      if (left.scope !== right.scope) return left.scope === 'device' ? -1 : 1;
      return left.createdAt - right.createdAt;
    });
  }

  /**
   * 撤销一条策略。
   * @param id - 策略标识。
   * @returns 是否真的撤销了一条策略。
   */
  clearPolicy(id: string): boolean {
    return this.policies.delete(id);
  }

  /**
   * 按决定里的选项记录一条策略。
   * @param choice - 采纳的选项。
   * @param sessionId - 会话标识。
   * @param toolName - 工具名称。
   * @returns 新建的策略；选项不扩大范围时为 `undefined`。
   */
  remember(choice: DecisionChoice, sessionId: string, toolName: string): PolicyRecord | undefined {
    if (!ESCALATING_CHOICES.includes(choice)) return undefined;
    const scope = choice === 'always' ? 'device' : 'session';
    const id = scope === 'device' ? `device:*:${toolName}` : `session:${sessionId}:${toolName}`;
    const record: PolicyRecord = {
      id,
      scope,
      ...(scope === 'session' ? { sessionId } : {}),
      toolName,
      choice,
      createdAt: this.now(),
      description: policyText(scope, toolName),
    };
    this.policies.set(id, record);
    return record;
  }

  /**
   * 打开一张等待决定的卡片。
   *
   * 没有可用的关联键时直接给出不可用，与上游「没有应答器即失败关闭」一致。
   * @param input - 卡片字段。
   * @returns 等待承诺与刚建立的卡片。
   */
  open(input: OpenApprovalInput): OpenApprovalResult {
    if (input.callId === '') throw new Error('审批卡片缺少工具调用标识');
    const at = this.now();
    const stateVersion = 1;
    let resolve = (_outcome: ApprovalOutcome): void => {};
    const promise = new Promise<ApprovalOutcome>((settle) => {
      resolve = settle;
    });
    const entry: LedgerEntry = {
      callId: input.callId,
      sessionId: input.sessionId,
      toolName: input.toolName,
      deviceId: this.deviceId,
      origin: input.origin ?? 'dsh',
      summary: input.reason === undefined || input.reason === '' ? `工具 ${input.toolName} 请求执行` : input.reason,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      capabilityScope: `工具 ${input.toolName} 的本次调用`,
      choices: this.allowEscalation ? ['once', 'session', 'always', 'deny'] : ['once', 'deny'],
      priority: 0,
      raisedAt: at,
      expiresAt: at + this.answerTimeoutMs,
      state: 'pending',
      stateVersion,
      resolve,
    };
    entry.timer = setTimeout(() => {
      this.timeOut(entry);
    }, this.answerTimeoutMs);
    this.entries.set(entry.callId, entry);
    return { promise, card: this.cardOf(entry) };
  }

  /**
   * 按策略自动批准一张卡片。
   *
   * 策略命中时不建立等待项，直接把结果交给调用方，仍然记一条自动批准记录。
   * @param input - 卡片字段。
   * @param policy - 命中的策略。
   * @returns 记录。
   */
  autoApprove(input: OpenApprovalInput, policy: PolicyRecord): DecisionRecord {
    const at = this.now();
    const record: DecisionRecord = {
      callId: input.callId,
      sessionId: input.sessionId,
      toolName: input.toolName,
      result: 'auto-approved',
      choice: policy.choice,
      decidedBy: `policy:${policy.id}`,
      decidedAt: at,
    };
    this.pushRecord(record);
    return record;
  }

  /**
   * 读一张正在等待的卡片。
   * @param callId - 工具调用标识。
   * @returns 卡片；没有等待项时为 `undefined`。
   */
  entryOf(callId: string): ApprovalCardView | undefined {
    const entry = this.entries.get(callId);
    return entry === undefined ? undefined : this.cardOf(entry);
  }

  /** 正在等待的关联键。 */
  waiting(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * 提交一次决定。
   * @param request - 决定请求。
   * @returns 决定结果，冲突与失效都给出具体错误码。
   */
  decide(request: DecisionRequest): DecisionResult {
    const entry = this.entries.get(request.callId);
    if (entry === undefined) return this.conflictOf(request.callId);

    if (entry.state === 'decided') {
      if (entry.operationId === request.operationId && entry.decidedChoice === request.choice) {
        return {
          outcome: 'decided',
          callId: entry.callId,
          stateVersion: entry.stateVersion,
          choice: request.choice,
          decidedAt: entry.decidedAt ?? this.now(),
        };
      }
      return {
        outcome: 'already-decided',
        callId: entry.callId,
        choice: entry.decidedChoice ?? 'deny',
        decidedAt: entry.decidedAt ?? this.now(),
      };
    }
    if (entry.stateVersion !== request.stateVersion) {
      return { outcome: 'rejected', code: 'revision-conflict' };
    }
    if (this.now() >= entry.expiresAt) {
      this.timeOut(entry);
      return { outcome: 'rejected', code: 'approval-expired' };
    }
    if (!entry.choices.includes(request.choice)) {
      return { outcome: 'rejected', code: 'approval-choice-unsupported' };
    }

    const at = this.now();
    entry.state = 'decided';
    entry.stateVersion += 1;
    entry.decidedBy = request.decidedBy ?? 'unknown-client';
    entry.decidedChoice = request.choice;
    entry.decidedAt = at;
    entry.operationId = request.operationId;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.timer = undefined;
    this.entries.delete(entry.callId);
    this.writeTombstone(entry, 'already-decided');
    entry.resolve(CHOICE_OUTCOME[request.choice]);
    this.remember(request.choice, entry.sessionId, entry.toolName);
    this.pushRecord({
      callId: entry.callId,
      sessionId: entry.sessionId,
      toolName: entry.toolName,
      result: request.choice === 'deny' ? 'denied' : 'approved',
      choice: request.choice,
      decidedBy: request.decidedBy ?? 'unknown-client',
      decidedAt: at,
    });
    return {
      outcome: 'decided',
      callId: entry.callId,
      stateVersion: entry.stateVersion,
      choice: request.choice,
      decidedAt: at,
    };
  }

  /**
   * 撤销一张卡片：请求被上游撤回时按取消结束等待。
   * @param callId - 工具调用标识。
   * @returns 是否撤销了一张卡片。
   */
  cancel(callId: string): boolean {
    const entry = this.entries.get(callId);
    if (entry === undefined) return false;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.state = 'unavailable';
    entry.stateVersion += 1;
    this.entries.delete(callId);
    this.writeTombstone(entry, 'waiter-gone');
    entry.resolve('cancelled');
    this.pushRecord({
      callId: entry.callId,
      sessionId: entry.sessionId,
      toolName: entry.toolName,
      result: 'timeout',
      decidedBy: 'host',
      decidedAt: this.now(),
    });
    return true;
  }

  /**
   * 按会话存活情况收尾：会话已经结束时结束等待项并标记失效原因。
   * @param alive - 判定会话是否仍然存在。
   * @returns 收起的卡片数。
   */
  settleEndedSessions(alive: (sessionId: string) => boolean): number {
    let settled = 0;
    for (const entry of [...this.entries.values()]) {
      if (alive(entry.sessionId)) continue;
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      entry.timer = undefined;
      entry.state = 'unavailable';
      entry.stateVersion += 1;
      this.entries.delete(entry.callId);
      this.writeTombstone(entry, 'session-ended');
      entry.resolve('unavailable');
      this.pushRecord({
        callId: entry.callId,
        sessionId: entry.sessionId,
        toolName: entry.toolName,
        result: 'timeout',
        decidedBy: 'host',
        decidedAt: this.now(),
      });
      settled += 1;
    }
    return settled;
  }

  /**
   * 把一次决定的结果记进统计。
   * @param sessionId - 会话标识。
   * @param callId - 工具调用标识。
   * @param toolName - 工具名称。
   * @param result - 结果。
   * @param decidedBy - 作出决定的客户端。
   * @param choice - 采纳的选项。
   */
  noteExternal(sessionId: string, callId: string, toolName: string, result: DecisionRecord['result'], decidedBy: string, choice?: string): void {
    this.pushRecord({
      callId,
      sessionId,
      toolName,
      result,
      ...(choice === undefined ? {} : { choice }),
      decidedBy,
      decidedAt: this.now(),
    });
  }

  /**
   * 读待处理概览。
   * @returns 卡片与分组。
   */
  overview(): PendingOverview {
    const at = this.now();
    this.pruneTombstones(at);
    const cards = [...this.entries.values()].map((entry) => this.cardOf(entry));
    const invalid = [...this.tombstones.values()]
      .sort((left, right) => right.tombstoneAt - left.tombstoneAt)
      .map((tombstone) => this.invalidCardOf(tombstone));
    const ordered = [...cards.sort((left, right) => (left.priority - right.priority) || (left.raisedAt - right.raisedAt)), ...invalid];
    return {
      cards: ordered,
      groups: groupCards(cards),
      actionable: cards.length,
      readAt: at,
    };
  }

  /**
   * 读统计。
   * @param sessionId - 会话标识；缺省时统计全部会话。
   * @returns 统计。
   */
  stats(sessionId?: string): ApprovalStats {
    const at = this.now();
    const scoped = sessionId === undefined ? this.records : this.records.filter((record) => record.sessionId === sessionId);
    const pending = [...this.entries.values()].filter((entry) => sessionId === undefined || entry.sessionId === sessionId).length;
    const result = emptyStats(sessionId, at);
    let approved = 0;
    let denied = 0;
    let timeout = 0;
    let autoApproved = 0;
    for (const record of scoped) {
      if (record.result === 'approved') approved += 1;
      else if (record.result === 'denied') denied += 1;
      else if (record.result === 'timeout') timeout += 1;
      else autoApproved += 1;
    }
    return {
      ...result,
      approved,
      denied,
      timeout,
      autoApproved,
      total: scoped.length,
      pending,
      recent: scoped.slice(-20).reverse(),
    };
  }

  /** 释放全部定时器。 */
  dispose(): void {
    for (const entry of this.entries.values()) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
    }
    this.entries.clear();
    this.tombstones.clear();
  }

  /** 超时收尾。 */
  private timeOut(entry: LedgerEntry): void {
    if (entry.state === 'decided') return;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.state = 'expired';
    entry.stateVersion += 1;
    this.entries.delete(entry.callId);
    this.writeTombstone(entry, 'expired');
    entry.resolve('unavailable');
    this.pushRecord({
      callId: entry.callId,
      sessionId: entry.sessionId,
      toolName: entry.toolName,
      result: 'timeout',
      decidedBy: 'host',
      decidedAt: this.now(),
    });
  }

  /** 已失效卡片的冲突结果。 */
  private conflictOf(callId: string): DecisionResult {
    const tombstone = this.tombstones.get(callId);
    if (tombstone === undefined) return { outcome: 'rejected', code: 'approval-missing-correlation' };
    if (tombstone.invalidReason === 'expired') return { outcome: 'rejected', code: 'approval-expired' };
    if (tombstone.invalidReason === 'session-ended') return { outcome: 'rejected', code: 'approval-already-decided' };
    if (tombstone.decidedChoice !== undefined && tombstone.decidedAt !== undefined) {
      return {
        outcome: 'already-decided',
        callId,
        choice: tombstone.decidedChoice,
        decidedAt: tombstone.decidedAt,
      };
    }
    return { outcome: 'rejected', code: 'approval-already-decided' };
  }

  /** 写入墓碑。 */
  private writeTombstone(entry: LedgerEntry, reason: InvalidReason): void {
    this.tombstones.set(entry.callId, {
      callId: entry.callId,
      sessionId: entry.sessionId,
      toolName: entry.toolName,
      deviceId: entry.deviceId,
      origin: entry.origin,
      summary: entry.summary,
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
      ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
      capabilityScope: entry.capabilityScope,
      choices: entry.choices,
      priority: entry.priority,
      raisedAt: entry.raisedAt,
      expiresAt: entry.expiresAt,
      stateVersion: entry.stateVersion,
      invalidReason: reason,
      ...(entry.decidedBy === undefined ? {} : { decidedBy: entry.decidedBy }),
      ...(entry.decidedChoice === undefined ? {} : { decidedChoice: entry.decidedChoice }),
      ...(entry.decidedAt === undefined ? {} : { decidedAt: entry.decidedAt }),
      tombstoneAt: this.now(),
    });
  }

  /** 清理过期墓碑。 */
  private pruneTombstones(at: number): void {
    for (const [callId, tombstone] of this.tombstones) {
      if (at - tombstone.tombstoneAt > this.tombstoneMs) this.tombstones.delete(callId);
    }
  }

  /** 记一条决定记录。 */
  private pushRecord(record: DecisionRecord): void {
    this.records.push(record);
    if (this.records.length > this.recentLimit) this.records.splice(0, this.records.length - this.recentLimit);
    this.onDecided?.(record);
  }

  /** 卡片视图。 */
  private cardOf(entry: LedgerEntry): ApprovalCardView {
    return {
      sessionId: entry.sessionId,
      callId: entry.callId,
      stateVersion: entry.stateVersion,
      state: entry.state,
      origin: entry.origin,
      toolName: entry.toolName,
      summary: entry.summary,
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
      deviceId: entry.deviceId,
      ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
      capabilityScope: entry.capabilityScope,
      choices: entry.choices,
      priority: entry.priority,
      raisedAt: entry.raisedAt,
      expiresAt: entry.expiresAt,
      ...(entry.decidedBy === undefined ? {} : { decidedBy: entry.decidedBy }),
      ...(entry.decidedChoice === undefined ? {} : { decidedChoice: entry.decidedChoice }),
      ...(entry.decidedAt === undefined ? {} : { decidedAt: entry.decidedAt }),
    };
  }

  /** 失效卡片视图。 */
  private invalidCardOf(tombstone: Tombstone): ApprovalCardView {
    return {
      sessionId: tombstone.sessionId,
      callId: tombstone.callId,
      stateVersion: tombstone.stateVersion,
      state: tombstone.invalidReason === 'expired' ? 'expired' : 'decided',
      origin: tombstone.origin,
      toolName: tombstone.toolName,
      summary: tombstone.summary,
      ...(tombstone.reason === undefined ? {} : { reason: tombstone.reason }),
      deviceId: tombstone.deviceId,
      ...(tombstone.cwd === undefined ? {} : { cwd: tombstone.cwd }),
      capabilityScope: tombstone.capabilityScope,
      choices: tombstone.choices,
      priority: tombstone.priority,
      raisedAt: tombstone.raisedAt,
      expiresAt: tombstone.expiresAt,
      invalidReason: tombstone.invalidReason,
      invalidText: INVALID_REASON_TEXT[tombstone.invalidReason],
      ...(tombstone.decidedBy === undefined ? {} : { decidedBy: tombstone.decidedBy }),
      ...(tombstone.decidedChoice === undefined ? {} : { decidedChoice: tombstone.decidedChoice }),
      ...(tombstone.decidedAt === undefined ? {} : { decidedAt: tombstone.decidedAt }),
    };
  }
}

/**
 * 按设备、会话与工具给卡片分组。
 * @param cards - 可操作的卡片。
 * @returns 分组结果。
 */
export function groupCards(cards: readonly ApprovalCardView[]): ApprovalDeviceGroup[] {
  const devices = new Map<string, Map<string, ApprovalCardView[]>>();
  for (const card of cards) {
    const sessions = devices.get(card.deviceId) ?? new Map<string, ApprovalCardView[]>();
    const list = sessions.get(card.sessionId) ?? [];
    list.push(card);
    sessions.set(card.sessionId, list);
    devices.set(card.deviceId, sessions);
  }
  const out: ApprovalDeviceGroup[] = [];
  for (const [deviceId, sessions] of devices) {
    const sessionGroups: ApprovalSessionGroup[] = [];
    for (const [sessionId, list] of sessions) {
      const tools = new Map<string, string[]>();
      for (const card of list) {
        const ids = tools.get(card.toolName) ?? [];
        ids.push(card.callId);
        tools.set(card.toolName, ids);
      }
      const toolGroups: ApprovalToolGroup[] = [...tools].map(([toolName, callIds]) => ({
        toolName,
        count: callIds.length,
        callIds,
      }));
      sessionGroups.push({
        sessionId,
        sessionHref: `#/session/${encodeURIComponent(sessionId)}`,
        count: list.length,
        tools: toolGroups.sort((left, right) => right.count - left.count || left.toolName.localeCompare(right.toolName)),
      });
    }
    out.push({
      deviceId,
      count: sessionGroups.reduce((sum, group) => sum + group.count, 0),
      sessions: sessionGroups.sort((left, right) => right.count - left.count || left.sessionId.localeCompare(right.sessionId)),
    });
  }
  return out.sort((left, right) => right.count - left.count || left.deviceId.localeCompare(right.deviceId));
}
