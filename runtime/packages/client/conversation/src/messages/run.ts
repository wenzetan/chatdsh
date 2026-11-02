/**
 * 当前运行与准确停止。
 *
 * 停止只作用于当前运行：请求携带运行标识，应答里的运行标识与当前不符时整条丢弃，因此上一
 * 次运行的迟到应答不会把这一次运行标记成已停止。宿主确认之前状态停留在「正在停止」，确认
 * 之后才显示「已停止」；未确认与拒绝分别显示「停止请求未确认」与失败原因，都不显示已停止。
 * 停止确认之后，该运行对应尝试的迟到片段整份丢弃。
 * @module @chatdsh/client-conversation/messages/run
 */

/** 运行状态。 */
export const RUN_STATES = ['idle', 'running', 'stopping', 'stopped', 'stop-unconfirmed', 'stop-failed'] as const;

/** 运行状态取值。 */
export type RunState = (typeof RUN_STATES)[number];

/** 运行状态的展示文字。 */
export const RUN_STATE_TEXT: Readonly<Record<RunState, string>> = {
  idle: '空闲',
  running: '正在运行',
  stopping: '正在停止',
  stopped: '已停止',
  'stop-unconfirmed': '停止请求未确认',
  'stop-failed': '停止请求失败',
};

/** 一次运行。 */
export interface RunRecord {
  /** 运行标识，由宿主给出。 */
  readonly runId: string;
  /** 当前尝试标识；流式帧按它对上。 */
  readonly attemptId?: string;
  /** 开始时刻的毫秒时间戳。 */
  readonly startedAt: number;
}

/** 一次停止请求。 */
export interface StopRequest {
  /** 操作标识，重复点击共享同一个。 */
  readonly operationId: string;
  /** 请求停止的运行。 */
  readonly runId: string;
  /** 发起时刻的毫秒时间戳。 */
  readonly startedAt: number;
}

/** 宿主对停止请求的应答。与停止应答契约一致。 */
export interface StopAcknowledgement {
  readonly outcome: 'stopped' | 'unconfirmed' | 'rejected';
  readonly runId?: string;
  readonly code?: string;
}

/** 应答处理结论。 */
export interface StopAcknowledgementResult {
  /** 应答是否作用于当前运行。 */
  readonly applied: boolean;
  readonly state: RunState;
  /** 失败或未确认的原因码。 */
  readonly code?: string;
}

/** 运行跟踪器的依赖。 */
export interface ActiveRunOptions {
  /** 当前时刻的毫秒时间戳。 */
  readonly now?: () => number;
}

/**
 * 当前运行的跟踪器。
 */
export class ActiveRun {
  private state: RunState = 'idle';
  private current: RunRecord | undefined;
  private stop: StopRequest | undefined;
  private stoppedAttempt: string | undefined;
  private failureCode: string | undefined;
  private readonly now: () => number;

  /**
   * 建立跟踪器。
   * @param options - 时钟。
   */
  constructor(options: ActiveRunOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  /** 当前状态。 */
  get runState(): RunState {
    return this.state;
  }

  /** 当前运行；没有运行时缺省。 */
  get run(): RunRecord | undefined {
    return this.current;
  }

  /** 当前停止请求；没有发起时缺省。 */
  get stopRequest(): StopRequest | undefined {
    return this.stop;
  }

  /** 失败或未确认的原因码。 */
  get code(): string | undefined {
    return this.failureCode;
  }

  /** 是否有运行在进行。 */
  get isRunning(): boolean {
    return this.state === 'running' || this.state === 'stopping' || this.state === 'stop-failed';
  }

  /**
   * 开始一次运行。
   *
   * 新运行开始后，上一次运行留下的停止状态与丢弃标记一并清空。
   * @param input - 运行标识与尝试标识。
   */
  begin(input: { readonly runId: string; readonly attemptId?: string }): void {
    if (input.runId === '') throw new Error('运行标识不能为空');
    if (this.current !== undefined && this.current.runId === input.runId) {
      // 同一运行内的新尝试只更新尝试标识，停止状态与丢弃标记保持不变。
      this.current = {
        ...this.current,
        ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
      };
      return;
    }
    this.current = {
      runId: input.runId,
      ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
      startedAt: this.now(),
    };
    this.state = 'running';
    this.stop = undefined;
    this.stoppedAttempt = undefined;
    this.failureCode = undefined;
  }

  /**
   * 发起停止请求。
   *
   * 重复点击共享同一个操作标识：已经处于「正在停止」时返回同一个请求，不产生第二个请求。
   * @param operationId - 操作标识。
   * @returns 停止请求。
   */
  requestStop(operationId: string): StopRequest {
    if (operationId === '') throw new Error('操作标识不能为空');
    if (this.current === undefined) throw new Error('当前没有可以停止的运行');
    if (this.state === 'stopping' && this.stop !== undefined) return this.stop;
    if (this.state !== 'running' && this.state !== 'stop-failed') {
      throw new Error(`当前没有可以停止的运行：${this.state}`);
    }
    this.stop = { operationId, runId: this.current.runId, startedAt: this.now() };
    this.state = 'stopping';
    this.failureCode = undefined;
    return this.stop;
  }

  /**
   * 处理宿主对停止请求的应答。
   *
   * 应答的运行标识与当前运行不符时整条丢弃，因此只影响当前运行。
   * @param acknowledgement - 停止应答。
   * @returns 处理结论。
   */
  acknowledge(acknowledgement: StopAcknowledgement): StopAcknowledgementResult {
    const current = this.current;
    if (current === undefined) return { applied: false, state: this.state };
    if (acknowledgement.runId !== undefined && acknowledgement.runId !== current.runId) {
      return { applied: false, state: this.state };
    }
    if (acknowledgement.outcome === 'stopped') {
      this.state = 'stopped';
      this.stoppedAttempt = current.attemptId;
      this.failureCode = undefined;
      return { applied: true, state: this.state };
    }
    if (acknowledgement.outcome === 'unconfirmed') {
      this.state = 'stop-unconfirmed';
      this.failureCode = acknowledgement.code ?? 'stop-unconfirmed';
      return {
        applied: true,
        state: this.state,
        ...(acknowledgement.code === undefined ? {} : { code: acknowledgement.code }),
      };
    }
    this.state = 'stop-failed';
    this.failureCode = acknowledgement.code ?? 'stop-rejected';
    return {
      applied: true,
      state: this.state,
      ...(acknowledgement.code === undefined ? {} : { code: acknowledgement.code }),
    };
  }

  /**
   * 运行自然结束。
   * @param runId - 结束的运行标识；与当前不符时忽略。
   */
  end(runId?: string): void {
    if (this.current === undefined) return;
    if (runId !== undefined && runId !== this.current.runId) return;
    if (this.state === 'stopped') return;
    this.state = 'idle';
    this.current = undefined;
    this.stop = undefined;
  }

  /**
   * 判断一个迟到片段是否要丢弃。
   *
   * 停止确认之后，属于被停止运行的尝试一律丢弃；其他运行的片段照常应用。
   * @param attemptId - 片段所属尝试。
   * @returns 需要丢弃时为真。
   */
  isLateFragment(attemptId: string | undefined): boolean {
    if (this.state !== 'stopped') return false;
    if (this.stoppedAttempt === undefined) return true;
    return attemptId === undefined || attemptId === this.stoppedAttempt;
  }

  /**
   * 停止确认后要丢弃的尝试标识。
   * @returns 尝试标识；没有确认停止或缺省时返回 `undefined`。
   */
  get discardedAttempt(): string | undefined {
    return this.state === 'stopped' ? this.stoppedAttempt : undefined;
  }
}
