/**
 * 提问卡片的运行期台账：选择题、自由输入、跳过与答案回填。
 *
 * 提问来自运行时的用户提问服务：宿主侧在这个服务的应答链上登记一个应答器，把请求挂起成一张
 * 卡片，等客户端提交之后把同一批答案交回去。因此答案会到达真正在等它的工具调用；跳过是一个
 * 显式结果，按上游约定表达成「选中为空、没有自由输入」的应答项。校验失败保留卡片与填写内容，
 * 只拒绝这一次提交。
 *
 * 计划审阅是同一份请求上的一种意图：卡片带着计划正文与批准选项，编辑器与草稿由
 * {@link TakeoverDesk} 承担，提交时在本台账里转成一次提问应答。
 * @module @chatdsh/host-approval/questions
 */

import type { AnswerItem, QuestionAnswerRequest, QuestionResult, QuestionSkipRequest } from './contracts.ts';
import { INVALID_REASON_TEXT, type InvalidReason, type QuestionItemView, type QuestionView } from './types.ts';

/** 提问里的一项。 */
export interface QuestionItemWire {
  /** 问题标识。 */
  readonly id: string;
  /** 问题文本。 */
  readonly question: string;
  /** 补充说明。 */
  readonly detail?: string;
  /** 分组标题。 */
  readonly header?: string;
  /** 候选项。 */
  readonly options?: readonly { readonly label: string; readonly description?: string }[];
  /** 是否多选。 */
  readonly multiSelect?: boolean;
  /** 展示意图。 */
  readonly intent?: {
    readonly kind: 'plan-review';
    readonly approve: string;
    readonly callId?: string;
  };
}

/** 一题的答案。 */
export interface AnswerWire {
  /** 问题标识。 */
  readonly id: string;
  /** 选中的选项文本。 */
  readonly selected: readonly string[];
  /** 自由输入。 */
  readonly custom?: string;
}

/** 只取用到的请求字段。 */
export interface QuestionRequestWire {
  /** 问题列表。 */
  readonly questions: readonly QuestionItemWire[];
  /** 附带取消信号。 */
  readonly signal?: AbortSignal;
  /** 卡片关联的工具调用。 */
  readonly wait?: { readonly callId: string; readonly timed?: boolean };
}

/** 打开一张提问卡片的输入。 */
export interface OpenQuestionInput {
  /** 工具调用标识。 */
  readonly callId: string;
  /** 会话标识。 */
  readonly sessionId: string;
  /** 问题列表。 */
  readonly questions: readonly QuestionItemWire[];
  /** 等待上限，单位毫秒。 */
  readonly timeoutMs: number;
  /** 取消信号。 */
  readonly signal?: AbortSignal;
}

/** 打开一张提问卡片的结果。 */
export interface OpenQuestionResult {
  /** 等待作答的承诺，交出答案批次。 */
  readonly promise: Promise<{ readonly answers: readonly AnswerWire[] }>;
  /** 刚建立的卡片。 */
  readonly card: QuestionView;
}

/** 台账里的一张提问卡片。 */
interface QuestionEntry {
  readonly callId: string;
  readonly sessionId: string;
  readonly questions: readonly QuestionItemWire[];
  readonly kind: 'question' | 'plan-review';
  readonly planMarkdown?: string;
  readonly approveLabel?: string;
  readonly raisedAt: number;
  readonly expiresAt: number;
  state: 'pending' | 'answering' | 'submitted' | 'expired' | 'cancelled';
  stateVersion: number;
  readonly resolve: (answer: { readonly answers: readonly AnswerWire[] }) => void;
  readonly reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  operationId?: string;
  invalidReason?: InvalidReason;
}

/** 提问台账。 */
export class QuestionDesk {
  private readonly entries = new Map<string, QuestionEntry>();
  private readonly now: () => number;

  constructor(options: { readonly now: () => number }) {
    this.now = options.now;
  }

  /**
   * 打开一张等待作答的卡片。
   * @param input - 卡片字段。
   * @returns 等待承诺与卡片。
   */
  open(input: OpenQuestionInput): OpenQuestionResult {
    if (input.questions.length === 0) throw new Error('提问卡片没有问题');
    const at = this.now();
    let resolve: (answer: { readonly answers: readonly AnswerWire[] }) => void = () => {};
    let reject: (error: Error) => void = () => {};
    const promise = new Promise<{ readonly answers: readonly AnswerWire[] }>((settle, fail) => {
      resolve = settle;
      reject = fail;
    });
    const plan = input.questions.find((question) => question.intent?.kind === 'plan-review');
    const entry: QuestionEntry = {
      callId: input.callId,
      sessionId: input.sessionId,
      questions: input.questions,
      kind: plan === undefined ? 'question' : 'plan-review',
      ...(plan?.detail === undefined ? {} : { planMarkdown: plan.detail }),
      ...(plan?.intent === undefined ? {} : { approveLabel: plan.intent.approve }),
      raisedAt: at,
      expiresAt: at + input.timeoutMs,
      state: 'pending',
      stateVersion: 1,
      resolve,
      reject,
      timer: setTimeout(() => {
        this.expire(entry);
      }, input.timeoutMs),
    };
    input.signal?.addEventListener('abort', () => {
      if (!this.entries.has(entry.callId)) return;
      this.clearTimer(entry);
      entry.state = 'cancelled';
      entry.stateVersion += 1;
      entry.invalidReason = 'waiter-gone';
      this.entries.delete(entry.callId);
      entry.reject(new Error('提问被调用方撤回'));
    }, { once: true });
    this.entries.set(entry.callId, entry);
    return { promise, card: this.cardOf(entry) };
  }

  /** 等待作答的关联键。 */
  waiting(): string[] {
    return [...this.entries.keys()];
  }

  /** 全部卡片。 */
  cards(): QuestionView[] {
    return [...this.entries.values()].map((entry) => this.cardOf(entry));
  }

  /**
   * 读一张计划审阅卡片。
   * @param callId - 工具调用标识。
   * @returns 卡片；不是计划卡片或已经结束时为 `undefined`。
   */
  planCard(callId: string): QuestionView | undefined {
    const entry = this.entries.get(callId);
    if (entry === undefined || entry.kind !== 'plan-review') return undefined;
    return this.cardOf(entry);
  }

  /**
   * 提交一批答案。
   * @param request - 应答请求。
   * @returns 结果，校验失败时带逐条说明。
   */
  answer(request: QuestionAnswerRequest): QuestionResult {
    const entry = this.entries.get(request.callId);
    if (entry === undefined) return this.closedResult(request.stateVersion);
    if (entry.stateVersion !== request.stateVersion) return { outcome: 'rejected', code: 'revision-conflict' };
    if (this.now() >= entry.expiresAt) {
      this.expire(entry);
      return { outcome: 'rejected', code: 'question-expired' };
    }
    const problems = validateAnswers(entry.questions, request.answers);
    if (problems.length > 0) return { outcome: 'rejected', code: 'question-invalid', problems };
    return this.settle(entry, request.answers, request.operationId);
  }

  /**
   * 跳过一张提问卡片。
   * @param request - 跳过请求。
   * @returns 结果。
   */
  skip(request: QuestionSkipRequest): QuestionResult {
    const entry = this.entries.get(request.callId);
    if (entry === undefined) return this.closedResult(request.stateVersion);
    if (entry.stateVersion !== request.stateVersion) return { outcome: 'rejected', code: 'revision-conflict' };
    if (this.now() >= entry.expiresAt) {
      this.expire(entry);
      return { outcome: 'rejected', code: 'question-expired' };
    }
    const skipped: AnswerItem[] = entry.questions.map((question) => ({ id: question.id, selected: [] }));
    return this.settle(entry, skipped, request.operationId);
  }

  /**
   * 提交计划审阅的结果。
   * @param callId - 工具调用标识。
   * @param stateVersion - 卡片状态版本。
   * @param decision - 批准或保留计划。
   * @param feedback - 修改意见，保留计划时作为自由输入交回。
   * @param operationId - 操作标识。
   * @returns 结果。
   */
  submitPlan(
    callId: string,
    stateVersion: number,
    decision: 'approve' | 'revise',
    feedback: string,
    operationId: string,
  ): QuestionResult {
    const entry = this.entries.get(callId);
    if (entry === undefined) return this.closedResult(stateVersion);
    if (entry.kind !== 'plan-review') return { outcome: 'rejected', code: 'question-invalid', problems: ['这张卡片不是计划审阅'] };
    if (entry.stateVersion !== stateVersion) return { outcome: 'rejected', code: 'revision-conflict' };
    if (this.now() >= entry.expiresAt) {
      this.expire(entry);
      return { outcome: 'rejected', code: 'question-expired' };
    }
    const answers: AnswerItem[] = entry.questions.map((question) => {
      if (question.intent?.kind !== 'plan-review') return { id: question.id, selected: [] };
      const optionLabels = (question.options ?? []).map((option) => option.label);
      if (decision === 'approve') return { id: question.id, selected: [question.intent.approve] };
      const decline = optionLabels.find((label) => label !== question.intent?.approve);
      const selected = decline === undefined ? [] : [decline];
      const trimmed = feedback.trim();
      return { id: question.id, selected, ...(trimmed === '' ? {} : { custom: feedback }) };
    });
    return this.settle(entry, answers, operationId);
  }

  /** 释放定时器。 */
  dispose(): void {
    for (const entry of this.entries.values()) this.clearTimer(entry);
    this.entries.clear();
  }

  /** 卡片已经结束时的结果。 */
  private closedResult(stateVersion: number): QuestionResult {
    return { outcome: 'rejected', code: stateVersion === 0 ? 'question-missing-correlation' : 'question-expired' };
  }

  /** 交出一批答案并结束卡片。 */
  private settle(entry: QuestionEntry, answers: readonly AnswerItem[], operationId: string): QuestionResult {
    const at = this.now();
    this.clearTimer(entry);
    entry.state = 'submitted';
    entry.stateVersion += 1;
    entry.operationId = operationId;
    this.entries.delete(entry.callId);
    entry.resolve({ answers: answers.map((answer) => ({
      id: answer.id,
      selected: [...answer.selected],
      ...(answer.custom === undefined ? {} : { custom: answer.custom }),
    })) });
    return { outcome: 'submitted', stateVersion: entry.stateVersion, submittedAt: at };
  }

  /** 超时收尾：卡片失效，等待方拿到错误而不是编造的答案。 */
  private expire(entry: QuestionEntry): void {
    if (!this.entries.has(entry.callId)) return;
    this.clearTimer(entry);
    entry.state = 'expired';
    entry.stateVersion += 1;
    entry.invalidReason = 'expired';
    this.entries.delete(entry.callId);
    entry.reject(new Error('提问在等待时限内没有作答'));
  }

  /** 清掉定时器。 */
  private clearTimer(entry: QuestionEntry): void {
    if (entry.timer === undefined) return;
    clearTimeout(entry.timer);
    entry.timer = undefined;
  }

  /** 卡片视图。 */
  private cardOf(entry: QuestionEntry): QuestionView {
    return {
      sessionId: entry.sessionId,
      callId: entry.callId,
      stateVersion: entry.stateVersion,
      state: entry.state,
      kind: entry.kind,
      questions: entry.questions.map((question) => questionViewOf(question)),
      ...(entry.planMarkdown === undefined ? {} : { planMarkdown: entry.planMarkdown }),
      raisedAt: entry.raisedAt,
      expiresAt: entry.expiresAt,
      ...(entry.invalidReason === undefined ? {} : {
        invalidReason: entry.invalidReason,
        invalidText: INVALID_REASON_TEXT[entry.invalidReason],
      }),
    };
  }
}

/** 一项问题的视图。 */
function questionViewOf(question: QuestionItemWire): QuestionItemView {
  return {
    id: question.id,
    question: question.question,
    ...(question.detail === undefined ? {} : { detail: question.detail }),
    ...(question.header === undefined ? {} : { header: question.header }),
    options: (question.options ?? []).map((option) => ({
      label: option.label,
      ...(option.description === undefined ? {} : { description: option.description }),
    })),
    multiple: question.multiSelect === true,
    allowFreeText: true,
  };
}

/**
 * 按提问的 schema 校验一批答案。
 *
 * 每个问题必须恰好有一个应答项；选项必须属于该问题；单选问题只能选一个；自由输入不超过上限。
 * 跳过表达成「选中为空、没有自由输入」的应答项，因此不校验必答。
 * @param questions - 问题列表。
 * @param answers - 提交的答案。
 * @returns 错误说明列表；空数组表示可以提交。
 */
export function validateAnswers(questions: readonly QuestionItemWire[], answers: readonly AnswerItem[]): string[] {
  const problems: string[] = [];
  const byId = new Map(questions.map((question) => [question.id, question]));
  const seen = new Set<string>();
  for (const answer of answers) {
    const question = byId.get(answer.id);
    if (question === undefined) {
      problems.push(`回答的问题不存在：${answer.id}`);
      continue;
    }
    if (seen.has(answer.id)) problems.push(`同一个问题被回答了多次：${answer.id}`);
    seen.add(answer.id);
    const labels = new Set((question.options ?? []).map((option) => option.label));
    for (const selected of answer.selected) {
      if (!labels.has(selected)) problems.push(`选项不属于该问题：${selected}`);
    }
    if (question.multiSelect !== true && answer.selected.length > 1) {
      problems.push(`单选问题只能选择一个候选项：${answer.id}`);
    }
    if ((answer.custom ?? '').length > 20000) problems.push(`自由输入超过长度上限：${answer.id}`);
    if (answer.custom !== undefined && answer.custom !== '' && answer.selected.length > 0 && question.multiSelect !== true) {
      problems.push(`单选问题不能同时选择候选项和自由输入：${answer.id}`);
    }
  }
  for (const question of questions) {
    if (!seen.has(question.id)) problems.push(`缺少问题的应答：${question.id}`);
  }
  return problems;
}
