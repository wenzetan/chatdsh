/**
 * 审批界面控制器：取数、决定、提问作答与计划接管的全部判定。
 *
 * 三项硬约束固定在控制器里：
 * - 离线不发送决定：`online` 为假时点击只给出说明，不产生请求；
 * - 决定是显式动作：键盘只有 Escape（关闭）与上下移动，没有「按一下批准」的通路，扩大范围的
 *   选项还要经过一次确认；
 * - 失败保留填写内容：提交被驳回时卡片、答案与计划草稿都留在界面上，并说明具体原因。
 *
 * 竞争终态由宿主给出（另一客户端已处理、卡片已失效），控制器把它显示成一条明确的冲突说明，
 * 同时刷新列表；失效卡片不提供任何选项。
 * @module @chatdsh/client-approval/controller
 */

import {
  cardRows,
  defaultFocusId,
  ESCALATING_CHOICES,
  escalationScopeText,
  keyIntent,
  newOperationId,
  parsePlanDraft,
  planDraftKey,
  rejectionText,
  requestDigestOf,
  type ApprovalCardView,
  type ApprovalDeviceGroup,
  type ApprovalStats,
  type CardRow,
  type DecisionChoice,
  type KeyLike,
  type PlanDraftRecord,
  type PolicyRecord,
  type QuestionCardView,
  type TakeoverStateView,
} from './model.ts';
import type {
  AnswerItemView,
  ApprovalTransport,
  PendingFilter,
} from './transport.ts';

/** 存储面的最小形状，与浏览器本地存储一致。 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 播报面的最小形状，与会话包的实时播报器一致。 */
export interface AnnouncerLike {
  flush(text?: string, urgent?: boolean): { readonly text: string; readonly urgent: boolean } | undefined;
}

/** 遥测面的最小形状。 */
export interface UiTelemetryLike {
  action(action: string, outcome: string): void;
}

/** 一题的作答草稿。 */
export interface QuestionDraft {
  readonly selections: Readonly<Record<string, readonly string[]>>;
  readonly freeText: Readonly<Record<string, string>>;
}

/** 提问卡片的一行。 */
export interface QuestionRow {
  readonly card: QuestionCardView;
  /** 当前作答草稿。 */
  readonly draft: QuestionDraft;
  /** 是否在提交中。 */
  readonly busy: boolean;
  /** 校验说明。 */
  readonly problems: readonly string[];
}

/** 计划编辑区状态。 */
export interface PlanEditorState {
  readonly callId: string;
  readonly sessionId: string;
  readonly holderId?: string;
  readonly holderLabel?: string;
  readonly editable: boolean;
  readonly text: string;
  readonly revision: number;
  readonly dirty: boolean;
  readonly submitting: boolean;
  readonly failure?: string;
  /** 禁用编辑的原因。 */
  readonly reason?: string;
}

/** 界面状态。 */
export interface ApprovalState {
  readonly scope: 'session' | 'global';
  readonly loaded: boolean;
  readonly loading: boolean;
  readonly failure?: string;
  readonly online: boolean;
  readonly filter: PendingFilter;
  readonly rows: readonly CardRow[];
  readonly groups: readonly ApprovalDeviceGroup[];
  readonly actionable: number;
  readonly stats?: ApprovalStats;
  readonly policies: readonly PolicyRecord[];
  readonly questions: readonly QuestionRow[];
  readonly openCallId?: string;
  readonly busyCallId?: string;
  readonly escalation?: { readonly callId: string; readonly choice: DecisionChoice };
  readonly notice?: { readonly text: string; readonly tone: 'info' | 'warn' | 'danger' };
  readonly announcement?: { readonly text: string; readonly urgent: boolean };
  readonly plan?: PlanEditorState;
  readonly focusTarget?: string;
  readonly conflictText?: string;
}

/** 控制器的依赖。 */
export interface ApprovalControllerOptions {
  /** 取数接口。 */
  readonly transport: ApprovalTransport;
  /** 本客户端标识。 */
  readonly clientId: string;
  /** 本客户端展示名。 */
  readonly clientLabel: string;
  /** 本设备标识。 */
  readonly deviceId: string;
  /** 窗口标识，参与草稿键。 */
  readonly windowId?: string;
  /** 限定到一个会话；缺省为全局列表。 */
  readonly sessionId?: string;
  /** 本地存储，用于计划草稿。 */
  readonly storage?: StorageLike;
  /** 实时播报。 */
  readonly announcer?: AnnouncerLike;
  /** 跳转到会话。 */
  readonly navigate?: (sessionId: string) => void;
  /** 界面动作遥测。 */
  readonly telemetry?: UiTelemetryLike;
  /** 当前时刻的毫秒时间戳。 */
  readonly now?: () => number;
  /** 是否在线。 */
  readonly online?: boolean;
}

/**
 * 审批界面控制器。
 */
export class ApprovalController {
  private readonly options: ApprovalControllerOptions;
  private readonly listeners = new Set<() => void>();
  private readonly drafts = new Map<string, QuestionDraft>();
  private current: ApprovalState;
  private focusTarget: string | undefined;
  /** 上一次读到的卡片，离线状态变化时按它重算界面行。 */
  private rawCards: readonly ApprovalCardView[] = [];

  constructor(options: ApprovalControllerOptions) {
    this.options = options;
    this.current = {
      scope: options.sessionId === undefined ? 'global' : 'session',
      loaded: false,
      loading: false,
      online: options.online ?? true,
      filter: 'waiting',
      rows: [],
      groups: [],
      actionable: 0,
      policies: [],
      questions: [],
    };
  }

  /** 当前状态。 */
  state(): ApprovalState {
    return this.current;
  }

  /**
   * 订阅状态变化。
   * @param listener - 状态变化回调。
   * @returns 取消订阅。
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 取走待恢复的焦点目标。 */
  takeFocusTarget(): string | undefined {
    const target = this.focusTarget;
    this.focusTarget = undefined;
    this.current = { ...this.current, focusTarget: undefined };
    return target;
  }

  /**
   * 读取待处理列表、统计、提问卡片与策略。
   * @returns 读取完成的承诺。
   */
  async refresh(): Promise<void> {
    if (!this.current.online) {
      this.set({ failure: '设备离线，列表暂时不能刷新' });
      return;
    }
    this.set({ loading: true });
    try {
      const sessionId = this.options.sessionId;
      const [overview, stats, questions, policies] = await Promise.all([
        this.options.transport.pending({ filter: this.current.filter, ...(sessionId === undefined ? {} : { sessionId }) }),
        this.options.transport.stats(sessionId ?? ''),
        this.options.transport.questions(),
        this.options.transport.policies(),
      ]);
      const rows = cardRows(overview.cards, this.current.scope, { online: this.current.online });
      this.rawCards = overview.cards;
      const questionRows = questions
        .filter((card) => sessionId === undefined || card.sessionId === sessionId)
        .map((card) => this.questionRow(card));
      this.set({
        loaded: true,
        loading: false,
        failure: undefined,
        rows,
        groups: overview.groups,
        actionable: overview.actionable,
        stats,
        policies,
        questions: questionRows,
      });
      this.syncPlanFromCards(questionRows);
    } catch (error) {
      this.set({ loading: false, loaded: true, failure: describe(error, '取数失败') });
    }
  }

  /**
   * 切换过滤条件并重新读取。
   * @param filter - 过滤条件。
   */
  async setFilter(filter: PendingFilter): Promise<void> {
    this.set({ filter });
    await this.refresh();
  }

  /**
   * 设置在线状态。离线时清掉进行中的标记，判断决定之前先看这个值。
   * @param online - 是否在线。
   */
  setOnline(online: boolean): void {
    this.set({
      online,
      rows: cardRows(this.rawCards, this.current.scope, { online }),
    });
    if (!online) this.announce('设备离线，决定与提交都不会发出', true);
  }

  /**
   * 打开一张卡片，并把焦点放在标题上。
   * @param callId - 工具调用标识。
   */
  openCard(callId: string): void {
    this.focusTarget = defaultFocusId(callId);
    this.set({ openCallId: callId, focusTarget: this.focusTarget, notice: undefined, conflictText: undefined });
  }

  /** 关闭当前卡片。 */
  closeCard(): void {
    this.set({ openCallId: undefined, escalation: undefined });
  }

  /**
   * 请求采纳一个选项。
   *
   * 扩大范围的两个选项先进入确认状态，确认之后才发出决定。
   * @param callId - 工具调用标识。
   * @param choice - 选项。
   */
  requestChoice(callId: string, choice: DecisionChoice): void {
    if (ESCALATING_CHOICES.includes(choice)) {
      this.set({ escalation: { callId, choice } });
      this.announce(`确认要${choiceText(choice)}吗？作用是${escalationScopeText(choice)}`, false);
      return;
    }
    void this.decide(callId, choice, false);
  }

  /** 确认一次扩大范围的决定。 */
  async confirmEscalation(): Promise<void> {
    const escalation = this.current.escalation;
    if (escalation === undefined) return;
    this.set({ escalation: undefined });
    await this.decide(escalation.callId, escalation.choice, true);
  }

  /** 取消扩大范围的决定。 */
  cancelEscalation(): void {
    this.set({ escalation: undefined });
    this.announce('已取消，没有发出任何决定', false);
  }

  /**
   * 提交一次审批决定。
   * @param callId - 工具调用标识。
   * @param choice - 选项。
   * @param escalationConfirmed - 是否已经确认扩大范围。
   * @returns 提交完成的承诺。
   */
  async decide(callId: string, choice: DecisionChoice, escalationConfirmed: boolean): Promise<void> {
    const row = this.current.rows.find((item) => item.card.callId === callId);
    if (row === undefined) {
      this.set({ notice: { text: '这张卡片已经不在列表里', tone: 'warn' } });
      return;
    }
    if (!this.current.online) {
      this.options.telemetry?.action('approval-decide', 'offline');
      this.set({ notice: { text: '设备离线，决定没有发出', tone: 'danger' } });
      this.announce('设备离线，决定没有发出', true);
      return;
    }
    if (!row.actionable || !row.offered.includes(choice)) {
      this.set({ notice: { text: '这张卡片已经失效，不能再处理', tone: 'warn' } });
      return;
    }
    this.set({ busyCallId: callId, notice: undefined, conflictText: undefined });
    const operationId = newOperationId();
    const requestDigest = await requestDigestOf({ callId, stateVersion: row.card.stateVersion, action: choice, operationId });
    try {
      const result = await this.options.transport.decide({
        callId,
        stateVersion: row.card.stateVersion,
        choice,
        operationId,
        requestDigest,
        escalationConfirmed,
        decidedBy: this.options.clientId,
      });
      this.set({ busyCallId: undefined });
      if (result.outcome === 'decided') {
        this.options.telemetry?.action('approval-decide', 'decided');
        this.set({ notice: { text: `决定已经交给运行中的工具：${choiceText(choice)}`, tone: 'info' }, openCallId: undefined });
        this.announce(`已提交：${choiceText(choice)}`, false);
      } else if (result.outcome === 'already-decided') {
        this.options.telemetry?.action('approval-decide', 'conflict');
        const text = `另一客户端已经处理了这张卡片，采纳的是${choiceText(result.choice as DecisionChoice)}`;
        this.set({ conflictText: text, notice: { text, tone: 'warn' }, openCallId: undefined });
        this.announce(text, true);
      } else {
        this.options.telemetry?.action('approval-decide', 'rejected');
        const text = rejectionText(result.code);
        this.set({ notice: { text, tone: 'danger' } });
        this.announce(text, true);
      }
      await this.refresh();
    } catch (error) {
      this.options.telemetry?.action('approval-decide', 'failed');
      this.set({ busyCallId: undefined, notice: { text: describe(error, '决定没有发出'), tone: 'danger' } });
      this.announce('决定没有发出，卡片仍然在等待', true);
    }
  }

  /**
   * 跳到卡片所属会话。
   * @param sessionId - 会话标识。
   */
  jumpToSession(sessionId: string): void {
    this.options.telemetry?.action('approval-jump', 'ok');
    this.options.navigate?.(sessionId);
    this.announce(`已跳到会话 ${sessionId}`, false);
  }

  /**
   * 选定一个选项。
   * @param callId - 工具调用标识。
   * @param questionId - 问题标识。
   * @param label - 选项文本。
   * @param multiple - 是否多选。
   */
  selectOption(callId: string, questionId: string, label: string, multiple: boolean): void {
    const draft = this.draftOf(callId);
    const current = draft.selections[questionId] ?? [];
    const next = multiple
      ? current.includes(label) ? current.filter((item) => item !== label) : [...current, label]
      : [label];
    this.drafts.set(callId, {
      selections: { ...draft.selections, [questionId]: next },
      freeText: draft.freeText,
    });
    this.syncQuestions();
  }

  /**
   * 写一题的自由输入。
   * @param callId - 工具调用标识。
   * @param questionId - 问题标识。
   * @param text - 文本。
   */
  setFreeText(callId: string, questionId: string, text: string): void {
    const draft = this.draftOf(callId);
    this.drafts.set(callId, {
      selections: draft.selections,
      freeText: { ...draft.freeText, [questionId]: text },
    });
    this.syncQuestions();
  }

  /**
   * 提交一张提问卡片。
   * @param callId - 工具调用标识。
   * @returns 提交完成的承诺。
   */
  async submitQuestion(callId: string): Promise<void> {
    const row = this.current.questions.find((item) => item.card.callId === callId);
    if (row === undefined) return;
    if (!this.current.online) {
      this.options.telemetry?.action('question-answer', 'offline');
      this.set({ notice: { text: '设备离线，答案没有发出', tone: 'danger' } });
      this.announce('设备离线，答案没有发出', true);
      return;
    }
    const answers: AnswerItemView[] = row.card.questions.map((question) => {
      const selected = row.draft.selections[question.id] ?? [];
      const custom = row.draft.freeText[question.id];
      return {
        id: question.id,
        selected: [...selected],
        ...(custom === undefined || custom.trim() === '' ? {} : { custom }),
      };
    });
    const operationId = newOperationId();
    const requestDigest = await requestDigestOf({ callId, stateVersion: row.card.stateVersion, action: 'answer', operationId });
    this.set({ questions: this.current.questions.map((item) => item.card.callId === callId ? { ...item, busy: true, problems: [] } : item) });
    try {
      const result = await this.options.transport.answerQuestion({
        callId,
        stateVersion: row.card.stateVersion,
        operationId,
        requestDigest,
        answers,
      });
      this.set({ questions: this.current.questions.map((item) => item.card.callId === callId ? { ...item, busy: false } : item) });
      if (result.outcome === 'submitted') {
        this.drafts.delete(callId);
        this.options.telemetry?.action('question-answer', 'submitted');
        this.set({ notice: { text: '答案已经交给等待中的工具', tone: 'info' } });
        this.announce('答案已提交', false);
      } else {
        this.options.telemetry?.action('question-answer', 'rejected');
        const problems = result.problems ?? [rejectionText(result.code)];
        this.set({
          questions: this.current.questions.map((item) => item.card.callId === callId ? { ...item, problems } : item),
          notice: { text: '回答与问题不符，填写内容仍然保留', tone: 'danger' },
        });
        this.announce(problems.join('；'), true);
      }
      await this.refresh();
    } catch (error) {
      this.options.telemetry?.action('question-answer', 'failed');
      this.set({
        questions: this.current.questions.map((item) => item.card.callId === callId ? { ...item, busy: false } : item),
        notice: { text: describe(error, '答案没有发出'), tone: 'danger' },
      });
    }
  }

  /**
   * 跳过一张提问卡片。
   * @param callId - 工具调用标识。
   * @returns 提交完成的承诺。
   */
  async skipQuestion(callId: string): Promise<void> {
    const row = this.current.questions.find((item) => item.card.callId === callId);
    if (row === undefined) return;
    if (!this.current.online) {
      this.options.telemetry?.action('question-skip', 'offline');
      this.set({ notice: { text: '设备离线，跳过没有发出', tone: 'danger' } });
      return;
    }
    const operationId = newOperationId();
    const requestDigest = await requestDigestOf({ callId, stateVersion: row.card.stateVersion, action: 'skip', operationId });
    const result = await this.options.transport.skipQuestion({
      callId,
      stateVersion: row.card.stateVersion,
      operationId,
      requestDigest,
    });
    if (result.outcome === 'submitted') {
      this.drafts.delete(callId);
      this.options.telemetry?.action('question-skip', 'submitted');
      this.set({ notice: { text: '已经跳过这次提问', tone: 'info' } });
      this.announce('已经跳过这次提问', false);
    } else {
      this.options.telemetry?.action('question-skip', 'rejected');
      this.set({ notice: { text: rejectionText(result.code), tone: 'danger' } });
    }
    await this.refresh();
  }

  /**
   * 打开一处计划编辑区并尝试取得编辑租约。
   * @param callId - 计划卡片对应的工具调用标识。
   * @returns 接管完成的承诺。
   */
  async beginPlan(callId: string): Promise<void> {
    const row = this.current.questions.find((item) => item.card.callId === callId);
    if (row === undefined) return;
    const local = this.readLocalDraft(row.card.sessionId, callId);
    const takeover = row.card.takeover;
    const seed = local?.text ?? takeover?.draft ?? row.card.planMarkdown ?? '';
    this.setPlan({
      callId,
      sessionId: row.card.sessionId,
      ...(takeover?.holderId === undefined ? {} : { holderId: takeover.holderId }),
      editable: false,
      text: seed,
      revision: local?.revision ?? takeover?.draftRevision ?? 0,
      dirty: local !== undefined,
      submitting: false,
      reason: '正在取得编辑租约',
    });
    if (!this.current.online) {
      this.set({ notice: { text: '设备离线，无法取得编辑租约', tone: 'danger' } });
      return;
    }
    try {
      const result = await this.options.transport.takeover({
        action: 'acquire',
        callId,
        holderId: this.options.clientId,
        holderLabel: this.options.clientLabel,
        stateVersion: row.card.stateVersion,
      });
      if (result.outcome === 'granted') {
        this.options.telemetry?.action('plan-takeover', 'granted');
        this.setPlan({
          callId,
          sessionId: row.card.sessionId,
          holderId: this.options.clientId,
          holderLabel: this.options.clientLabel,
          editable: true,
          text: result.draft ?? seed,
          revision: result.draftRevision ?? 0,
          dirty: false,
          submitting: false,
        });
        this.announce('已取得编辑租约，其他人这一处只读', false);
        return;
      }
      this.options.telemetry?.action('plan-takeover', 'held');
      this.setPlan({
        callId,
        sessionId: row.card.sessionId,
        ...(result.holderId === undefined ? {} : { holderId: result.holderId }),
        ...(result.holderLabel === undefined ? {} : { holderLabel: result.holderLabel }),
        editable: false,
        text: result.draft ?? seed,
        revision: result.draftRevision ?? 0,
        dirty: false,
        submitting: false,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      });
      this.announce(result.reason ?? '这一处编辑区由他人持有', false);
    } catch (error) {
      this.options.telemetry?.action('plan-takeover', 'failed');
      this.set({ notice: { text: describe(error, '无法取得编辑租约'), tone: 'danger' } });
    }
  }

  /**
   * 编辑计划草稿。
   * @param text - 草稿文本。
   */
  editPlan(text: string): void {
    const plan = this.current.plan;
    if (plan === undefined || !plan.editable) return;
    this.setPlan({ ...plan, text, dirty: true });
    this.writeLocalDraft(plan.sessionId, plan.callId, { text, revision: plan.revision, updatedAt: this.now() });
  }

  /**
   * 把当前草稿写回宿主，供其他客户端接手时读到。
   * @returns 保存完成的承诺。
   */
  async savePlan(): Promise<void> {
    const plan = this.current.plan;
    if (plan === undefined || !plan.editable) return;
    if (!this.current.online) {
      this.set({ notice: { text: '设备离线，草稿只留在本机', tone: 'warn' } });
      return;
    }
    const row = this.current.questions.find((item) => item.card.callId === plan.callId);
    if (row === undefined) return;
    try {
      const result = await this.options.transport.savePlanDraft({
        callId: plan.callId,
        holderId: this.options.clientId,
        text: plan.text,
        revision: plan.revision,
        stateVersion: row.card.stateVersion,
      });
      if (result.outcome === 'saved') {
        this.setPlan({ ...plan, revision: result.revision, dirty: false });
        this.writeLocalDraft(plan.sessionId, plan.callId, { text: plan.text, revision: result.revision, updatedAt: result.updatedAt });
        return;
      }
      this.options.telemetry?.action('plan-draft', result.outcome);
      this.setPlan({ ...plan, failure: result.reason ?? '草稿没有保存成功' });
    } catch (error) {
      this.options.telemetry?.action('plan-draft', 'failed');
      this.setPlan({ ...plan, failure: describe(error, '草稿没有保存成功') });
    }
  }

  /**
   * 提交计划审阅结果。
   * @param decision - 批准执行或保留计划。
   * @returns 提交完成的承诺。
   */
  async submitPlan(decision: 'approve' | 'revise'): Promise<void> {
    const plan = this.current.plan;
    if (plan === undefined) return;
    const row = this.current.questions.find((item) => item.card.callId === plan.callId);
    if (row === undefined) return;
    if (plan.holderId !== undefined && plan.holderId !== this.options.clientId) {
      this.setPlan({ ...plan, failure: '编辑区属于另一位接管者，不能提交' });
      return;
    }
    if (!this.current.online) {
      this.options.telemetry?.action('plan-submit', 'offline');
      this.set({ notice: { text: '设备离线，计划意见没有发出', tone: 'danger' } });
      this.announce('设备离线，计划意见没有发出', true);
      return;
    }
    const operationId = newOperationId();
    const requestDigest = await requestDigestOf({ callId: plan.callId, stateVersion: row.card.stateVersion, action: decision, operationId });
    this.setPlan({ ...plan, submitting: true, failure: undefined });
    try {
      const result = await this.options.transport.submitPlan({
        callId: plan.callId,
        stateVersion: row.card.stateVersion,
        operationId,
        requestDigest,
        holderId: this.options.clientId,
        decision,
        feedback: plan.text,
      });
      if (result.outcome === 'submitted') {
        this.options.telemetry?.action('plan-submit', 'submitted');
        this.clearLocalDraft(plan.sessionId, plan.callId);
        this.setPlan({ ...plan, submitting: false, editable: false, dirty: false });
        this.set({ notice: { text: decision === 'approve' ? '计划已批准，等待运行中的工具继续' : '修改意见已交回运行中的工具', tone: 'info' } });
        this.announce(decision === 'approve' ? '计划已批准' : '修改意见已提交', false);
      } else {
        this.options.telemetry?.action('plan-submit', 'rejected');
        const problems = result.problems ?? [rejectionText(result.code)];
        this.setPlan({ ...plan, submitting: false, failure: problems.join('；') });
        this.announce(problems.join('；'), true);
      }
      await this.refresh();
    } catch (error) {
      this.options.telemetry?.action('plan-submit', 'failed');
      this.setPlan({ ...plan, submitting: false, failure: describe(error, '计划意见没有发出') });
    }
  }

  /** 释放编辑租约。 */
  async releasePlan(): Promise<void> {
    const plan = this.current.plan;
    if (plan === undefined) return;
    const row = this.current.questions.find((item) => item.card.callId === plan.callId);
    if (row !== undefined && this.current.online) {
      await this.options.transport.takeover({
        action: 'release',
        callId: plan.callId,
        holderId: this.options.clientId,
        holderLabel: this.options.clientLabel,
        stateVersion: row.card.stateVersion,
      });
    }
    this.setPlan({ ...plan, editable: false });
  }

  /** 关闭提示。 */
  dismissNotice(): void {
    this.set({ notice: undefined, conflictText: undefined });
  }

  /**
   * 处理卡片区域的按键。
   *
   * Escape 只关闭当前卡片，上下方向键在卡片之间移动焦点；这一层不存在提交决定的按键。
   * @param event - 键盘事件。
   * @returns 已经处理的意图。
   */
  handleKey(event: KeyLike): 'close' | 'next' | 'previous' | 'none' {
    const intent = keyIntent(event);
    if (intent === 'close') {
      this.set({ openCallId: undefined, escalation: undefined });
      return 'close';
    }
    if (intent === 'next' || intent === 'previous') {
      const callIds = this.current.rows.filter((row) => row.actionable).map((row) => row.card.callId);
      if (callIds.length === 0) return intent;
      const index = this.current.openCallId === undefined ? -1 : callIds.indexOf(this.current.openCallId);
      const offset = intent === 'next' ? 1 : -1;
      const next = callIds[(index + offset + callIds.length) % callIds.length];
      if (next !== undefined) {
        this.focusTarget = defaultFocusId(next);
        this.set({ openCallId: next, focusTarget: this.focusTarget, escalation: undefined });
      }
      return intent;
    }
    return 'none';
  }

  /** 取当前时刻。 */
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** 写入状态并通知订阅者。 */
  private set(patch: Partial<ApprovalState>): void {
    this.current = { ...this.current, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** 写入计划编辑区状态。 */
  private setPlan(plan: PlanEditorState): void {
    this.set({ plan });
  }

  /** 取一题的作答草稿。 */
  private draftOf(callId: string): QuestionDraft {
    return this.drafts.get(callId) ?? { selections: {}, freeText: {} };
  }

  /** 把作答草稿并进提问行。 */
  private syncQuestions(): void {
    this.set({
      questions: this.current.questions.map((row) => ({ ...row, draft: this.draftOf(row.card.callId) })),
    });
  }

  /** 提问行。 */
  private questionRow(card: QuestionCardView): QuestionRow {
    const existing = this.current.questions.find((row) => row.card.callId === card.callId);
    return {
      card,
      draft: this.draftOf(card.callId),
      busy: existing?.busy ?? false,
      problems: existing?.problems ?? [],
    };
  }

  /** 列表刷新之后把计划卡片同步进编辑区。 */
  private syncPlanFromCards(rows: readonly QuestionRow[]): void {
    const plan = this.current.plan;
    if (plan === undefined) return;
    const row = rows.find((item) => item.card.callId === plan.callId);
    if (row === undefined) {
      this.set({ plan: undefined });
      return;
    }
    const takeover: TakeoverStateView | undefined = row.card.takeover;
    if (takeover === undefined) return;
    const editable = takeover.holderId === this.options.clientId;
    this.setPlan({
      ...plan,
      ...(takeover.holderId === undefined ? {} : { holderId: takeover.holderId }),
      ...(takeover.holderLabel === undefined ? {} : { holderLabel: takeover.holderLabel }),
      editable,
      ...(plan.dirty ? {} : { text: takeover.draft, revision: takeover.draftRevision }),
      ...(editable ? {} : { reason: takeover.holderId === undefined ? undefined : `${takeover.holderLabel ?? takeover.holderId}正在编辑，本端只读` }),
    });
  }

  /** 播报一段说明。 */
  private announce(text: string, urgent: boolean): void {
    const emitted = this.options.announcer === undefined ? { text, urgent } : this.options.announcer.flush(text, urgent);
    if (emitted === undefined) return;
    this.set({ announcement: emitted });
  }

  /** 草稿键。 */
  private draftKey(sessionId: string, callId: string): string {
    return planDraftKey({
      clientId: this.options.clientId,
      windowId: this.options.windowId ?? 'window',
      deviceId: this.options.deviceId,
      sessionId,
      callId,
    });
  }

  /** 读本地草稿。 */
  private readLocalDraft(sessionId: string, callId: string): PlanDraftRecord | undefined {
    const storage = this.options.storage;
    if (storage === undefined) return undefined;
    const raw = storage.getItem(this.draftKey(sessionId, callId));
    if (raw === null) return undefined;
    try {
      return parsePlanDraft(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }

  /** 写本地草稿。 */
  private writeLocalDraft(sessionId: string, callId: string, record: PlanDraftRecord): void {
    const storage = this.options.storage;
    if (storage === undefined) return;
    storage.setItem(this.draftKey(sessionId, callId), JSON.stringify(record));
  }

  /** 清掉本地草稿。 */
  private clearLocalDraft(sessionId: string, callId: string): void {
    this.options.storage?.removeItem(this.draftKey(sessionId, callId));
  }
}

/**
 * 把异常变成一句说明。
 * @param error - 异常。
 * @param fallback - 没有消息时的说明。
 * @returns 说明。
 */
function describe(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message !== '') return `${fallback}：${error.message}`;
  return fallback;
}

/**
 * 选项文案。
 * @param choice - 选项。
 * @returns 文案。
 */
function choiceText(choice: DecisionChoice): string {
  switch (choice) {
    case 'once': return '本次允许';
    case 'session': return '本会话允许';
    case 'always': return '始终允许';
    case 'deny': return '拒绝';
  }
}

export type { ApprovalCardView, ApprovalStats, PolicyRecord };
