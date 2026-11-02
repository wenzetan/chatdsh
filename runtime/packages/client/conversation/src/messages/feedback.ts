/**
 * 消息反馈与复制。
 *
 * 反馈支持赞、踩两类，踩可以带原因与说明。提交携带操作标识，重复点击共享同一个标识；失败
 * 时保留已经填写的类型、原因与说明，界面据此显示具体结果。复制正文走浏览器剪贴板接口，
 * 被拒绝时保留正文并给出「请手动选择复制」的说明。
 * @module @chatdsh/client-conversation/messages/feedback
 */

/** 反馈类型。 */
export const FEEDBACK_RATINGS = ['like', 'dislike'] as const;

/** 反馈类型取值。 */
export type FeedbackRating = (typeof FEEDBACK_RATINGS)[number];

/** 反馈原因的固定取值。 */
export const FEEDBACK_REASONS = ['incorrect', 'incomplete', 'off-topic', 'unsafe', 'other'] as const;

/** 反馈原因取值。 */
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];

/** 反馈原因的展示文字。 */
export const FEEDBACK_REASON_TEXT: Readonly<Record<FeedbackReason, string>> = {
  incorrect: '内容不正确',
  incomplete: '内容不完整',
  'off-topic': '偏离主题',
  unsafe: '内容不安全',
  other: '其他原因',
};

/** 反馈状态。 */
export const FEEDBACK_STATUSES = ['idle', 'submitting', 'submitted', 'failed'] as const;

/** 反馈状态取值。 */
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** 一条反馈。 */
export interface FeedbackState {
  readonly messageId: string;
  /** 选择的类型；还没选择时缺省。 */
  readonly rating?: FeedbackRating;
  /** 踩的原因；赞不携带。 */
  readonly reason?: FeedbackReason;
  /** 补充说明。 */
  readonly note?: string;
  readonly status: FeedbackStatus;
  /** 提交标识；提交过之后保留。 */
  readonly operationId?: string;
  /** 失败原因码。 */
  readonly failureCode?: string;
}

/** 提交反馈的入参。 */
export interface FeedbackSubmitInput {
  readonly messageId: string;
  readonly rating: FeedbackRating;
  readonly reason?: FeedbackReason;
  readonly note?: string;
  readonly operationId: string;
}

/** 提交结果。 */
export interface FeedbackSubmitResult {
  readonly accepted: boolean;
  readonly code?: string;
}

/** 提交反馈的实现。 */
export type FeedbackSubmitter = (input: FeedbackSubmitInput) => Promise<FeedbackSubmitResult>;

/** 复制结果。 */
export interface CopyResult {
  readonly outcome: 'copied' | 'failed';
  /** 失败原因码。 */
  readonly code?: string;
  /** 失败说明，提示用户手动选择复制。 */
  readonly detail?: string;
}

/** 反馈面板的依赖。 */
export interface FeedbackBoardOptions {
  /** 提交实现。 */
  readonly submit: FeedbackSubmitter;
  /** 生成标识的实现。 */
  readonly createOperationId: () => string;
  /** 当前时刻的毫秒时间戳。 */
  readonly now?: () => number;
  /** 剪贴板；缺省用浏览器剪贴板接口。 */
  readonly clipboard?: { writeText(text: string): Promise<void> };
}

/** 一条反馈的完整状态。 */
interface FeedbackRecord extends FeedbackState {
  readonly submittedAt?: number;
}

/**
 * 消息反馈面板。
 */
export class FeedbackBoard {
  private readonly records = new Map<string, FeedbackRecord>();
  private readonly copied = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<FeedbackState>>();
  private readonly submitImpl: FeedbackSubmitter;
  private readonly createOperationId: () => string;
  private readonly now: () => number;
  private readonly clipboard: { writeText(text: string): Promise<void> };

  /**
   * 建立反馈面板。
   * @param options - 提交实现、标识生成与剪贴板。
   */
  constructor(options: FeedbackBoardOptions) {
    this.submitImpl = options.submit;
    this.createOperationId = options.createOperationId;
    this.now = options.now ?? (() => Date.now());
    this.clipboard = options.clipboard ?? { writeText: (text) => navigator.clipboard.writeText(text) };
  }

  /**
   * 取一条消息的反馈状态。
   * @param messageId - 消息标识。
   * @returns 反馈状态；没有填写过时返回空闲状态。
   */
  stateOf(messageId: string): FeedbackState {
    const record = this.records.get(messageId);
    if (record === undefined) return { messageId, status: 'idle' };
    return {
      messageId: record.messageId,
      ...(record.rating === undefined ? {} : { rating: record.rating }),
      ...(record.reason === undefined ? {} : { reason: record.reason }),
      ...(record.note === undefined ? {} : { note: record.note }),
      status: record.status,
      ...(record.operationId === undefined ? {} : { operationId: record.operationId }),
      ...(record.failureCode === undefined ? {} : { failureCode: record.failureCode }),
    };
  }

  /**
   * 选择反馈类型，可以同时给出原因与说明。
   *
   * 已提交过的反馈再改类型会回到未提交状态，并用新的操作标识重新提交。
   * @param messageId - 消息标识。
   * @param rating - 反馈类型。
   * @param reason - 踩的原因。
   * @param note - 补充说明。
   * @returns 更新后的状态。
   */
  rate(messageId: string, rating: FeedbackRating, reason?: FeedbackReason, note?: string): FeedbackState {
    if (rating === 'like' && reason !== undefined) throw new Error('赞不携带原因');
    if (note !== undefined && note.length > 2000) throw new Error('反馈说明不能超过 2000 字符');
    const record: FeedbackRecord = {
      messageId,
      rating,
      ...(reason === undefined ? {} : { reason }),
      ...(note === undefined ? {} : { note }),
      status: 'idle',
    };
    this.records.set(messageId, record);
    return this.stateOf(messageId);
  }

  /**
   * 提交一条已经选择类型的反馈。
   *
   * 提交中重复调用返回同一个进行中的结果，不会产生第二次写入。
   * @param messageId - 消息标识。
   * @returns 提交后的状态。
   */
  async submit(messageId: string): Promise<FeedbackState> {
    const running = this.inFlight.get(messageId);
    if (running !== undefined) return running;
    const record = this.records.get(messageId);
    if (record === undefined || record.rating === undefined) throw new Error('还没有选择反馈类型');
    if (record.status === 'submitted') return this.stateOf(messageId);
    const operationId = record.operationId ?? this.createOperationId();
    this.records.set(messageId, { ...record, status: 'submitting', operationId });
    const started = this.send(messageId, record, operationId);
    this.inFlight.set(messageId, started);
    try {
      return await started;
    } finally {
      this.inFlight.delete(messageId);
    }
  }

  /**
   * 实际提交一条反馈。
   * @param messageId - 消息标识。
   * @param record - 提交前的记录。
   * @param operationId - 提交标识。
   * @returns 提交后的状态。
   */
  private async send(messageId: string, record: FeedbackRecord, operationId: string): Promise<FeedbackState> {
    const result = await this.submitImpl({
      messageId,
      rating: record.rating!,
      ...(record.reason === undefined ? {} : { reason: record.reason }),
      ...(record.note === undefined ? {} : { note: record.note }),
      operationId,
    });
    if (result.accepted) {
      this.records.set(messageId, {
        ...record,
        status: 'submitted',
        operationId,
        submittedAt: this.now(),
      });
      return this.stateOf(messageId);
    }
    this.records.set(messageId, {
      ...record,
      status: 'failed',
      operationId,
      ...(result.code === undefined ? {} : { failureCode: result.code }),
    });
    return this.stateOf(messageId);
  }

  /**
   * 复制一条消息的正文。
   * @param messageId - 消息标识。
   * @param text - 正文。
   * @returns 复制结果。
   */
  async copy(messageId: string, text: string): Promise<CopyResult> {
    if (text === '') return { outcome: 'failed', code: 'empty-text', detail: '这条消息没有可复制的正文' };
    try {
      await this.clipboard.writeText(text);
    } catch (error) {
      const code = error instanceof Error && error.name === 'NotAllowedError' ? 'not-allowed' : 'write-failed';
      return { outcome: 'failed', code, detail: '浏览器拒绝了剪贴板写入，请手动选择正文复制' };
    }
    this.copied.set(messageId, this.now());
    return { outcome: 'copied' };
  }

  /**
   * 取一条消息最近一次复制成功的时刻。
   * @param messageId - 消息标识。
   * @returns 毫秒时间戳；没有复制过时缺省。
   */
  copiedAt(messageId: string): number | undefined {
    return this.copied.get(messageId);
  }
}
