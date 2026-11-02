/**
 * 并发冲突：两个窗口同时操作同一对象时的判定与提示。
 *
 * 判定有三条来源：同一操作标识只在第一个窗口写入一次，第二个窗口读到已有结论；服务端版本
 * 高于本窗口读取时的版本时，本窗口的写入会覆盖别人的修改，界面给出冲突提示并只提供刷新
 * 入口；同一审批在另一个窗口已经处理时，界面显示已处理结果。
 *
 * 判定只读本地登记与跨窗口广播，不猜服务端结论：真正写入之前调用 `begin`，写入返回之后
 * 调用 `settle`，服务端给的版本与结论都记在登记里。
 * @module @chatdsh/client-multi-window/conflicts
 */

/** 冲突种类。 */
export type ConflictKind = 'revision' | 'duplicate' | 'handled';

/** 一次写入尝试。 */
export interface OperationAttempt {
  /** 操作标识，同一意图跨窗口复用时只写入一次。 */
  readonly operationId: string;
  /** 对象键，例如设备与会话组成的键。 */
  readonly objectKey: string;
  /** 发起窗口标识。 */
  readonly windowId: string;
  /** 写入时基于的服务端版本。 */
  readonly baseRevision: number;
  /** 动作种类。 */
  readonly action: 'send' | 'approve' | 'settings';
}

/** 写入结论。 */
export interface OperationOutcome {
  /** 服务端结论。 */
  readonly outcome: 'applied' | 'rejected' | 'handled';
  /** 写入后的服务端版本。 */
  readonly revision?: number;
  /** 失败原因码，仅拒绝时出现。 */
  readonly code?: string;
}

/** 一条冲突提示。 */
export interface ConflictNotice {
  /** 冲突种类。 */
  readonly kind: ConflictKind;
  /** 对象键。 */
  readonly objectKey: string;
  /** 操作标识。 */
  readonly operationId: string;
  /** 已经在另一个窗口操作这个对象的窗口标识；同一窗口重复提交时是自己。 */
  readonly windowId: string;
  /** 本窗口写入时基于的版本。 */
  readonly localRevision: number;
  /** 服务端当前版本。 */
  readonly serverRevision: number;
  /** 面向用户的说明。 */
  readonly message: string;
  /** 刷新入口的按钮文案。 */
  readonly refreshLabel: string;
}

/** 冲突判定的结论。 */
export type AttemptDecision =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly notice: ConflictNotice };

/** 对象版本见证。 */
interface Witness {
  readonly revision: number;
  readonly windowId: string;
  readonly at: number;
}

/** 冲突判定的构造参数。 */
export interface ConflictBoardOptions {
  /** 本窗口标识。 */
  readonly windowId: string;
  /** 广播通道；`null` 表示只在当前窗口内判定。 */
  readonly channel?: BroadcastChannel | null;
  /** 广播通道名。 */
  readonly channelName?: string;
  /** 当前时刻的毫秒时间戳。 */
  readonly now?: () => number;
}

/** 跨窗口消息。 */
type ConflictMessage =
  | {
    readonly type: 'operation';
    readonly windowId: string;
    readonly operationId: string;
    readonly objectKey: string;
    readonly revision: number;
    readonly action: OperationAttempt['action'];
  }
  | {
    readonly type: 'settled';
    readonly windowId: string;
    readonly operationId: string;
    readonly objectKey: string;
    readonly action: OperationAttempt['action'];
    readonly outcome: OperationOutcome;
  };

/** 刷新入口的默认文案。 */
export const REFRESH_LABEL = '刷新读取最新内容';

/**
 * 冲突登记表。
 */
export class ConflictBoard {
  private readonly windowId: string;
  private readonly channel: BroadcastChannel | null;
  private readonly now: () => number;
  private readonly witnesses = new Map<string, Witness>();
  private readonly operations = new Map<string, { attempt: OperationAttempt; outcome?: OperationOutcome }>();
  private readonly noticeMap = new Map<string, ConflictNotice>();
  private readonly conflictListeners = new Set<(notice: ConflictNotice) => void>();
  private readonly changeListeners = new Set<() => void>();
  private refreshHandler: ((objectKey: string) => Promise<void>) | undefined;
  private readonly onMessage = (event: MessageEvent<unknown>): void => {
    this.receive(event.data);
  };

  /**
   * 建立冲突登记表。
   * @param options - 本窗口标识与广播通道。
   */
  constructor(options: ConflictBoardOptions) {
    this.windowId = options.windowId;
    this.channel = options.channel ?? null;
    this.now = options.now ?? (() => Date.now());
    if (this.channel !== null) this.channel.addEventListener('message', this.onMessage);
  }

  /** 停止接收跨窗口消息。 */
  stop(): void {
    if (this.channel !== null) this.channel.removeEventListener('message', this.onMessage);
  }

  /**
   * 设置刷新入口的处理函数。
   * @param handler - 收到刷新请求时读取该对象的服务端最新内容。
   */
  setRefreshHandler(handler: (objectKey: string) => Promise<void>): void {
    this.refreshHandler = handler;
  }

  /**
   * 记下读到的服务端版本。
   * @param objectKey - 对象键。
   * @param revision - 服务端版本。
   * @param windowId - 读到该版本的窗口标识。
   */
  observeObject(objectKey: string, revision: number, windowId: string = this.windowId): void {
    if (!Number.isFinite(revision) || revision < 0) throw new Error(`服务端版本不合法：${String(revision)}`);
    const previous = this.witnesses.get(objectKey);
    if (previous !== undefined && previous.revision > revision) return;
    this.witnesses.set(objectKey, { revision, windowId, at: this.now() });
  }

  /**
   * 取登记里的服务端版本。
   * @param objectKey - 对象键。
   * @returns 版本；没有登记时返回 `undefined`。
   */
  revisionOf(objectKey: string): number | undefined {
    return this.witnesses.get(objectKey)?.revision;
  }

  /**
   * 在写入之前判定这次尝试。
   * @param attempt - 写入尝试。
   * @returns 允许写入，或者一条冲突提示。
   */
  begin(attempt: OperationAttempt): AttemptDecision {
    const duplicate = this.operations.get(attempt.operationId);
    if (duplicate !== undefined) {
      return { accepted: false, notice: this.raise('duplicate', attempt, duplicate.attempt.windowId, duplicate.attempt.baseRevision) };
    }
    const witness = this.witnesses.get(attempt.objectKey);
    if (witness !== undefined && witness.revision > attempt.baseRevision) {
      return { accepted: false, notice: this.raise('revision', attempt, witness.windowId, witness.revision) };
    }
    this.operations.set(attempt.operationId, { attempt });
    this.post({
      type: 'operation',
      windowId: this.windowId,
      operationId: attempt.operationId,
      objectKey: attempt.objectKey,
      revision: attempt.baseRevision,
      action: attempt.action,
    });
    return { accepted: true };
  }

  /**
   * 记下一次尝试的结论。
   * @param operationId - 操作标识。
   * @param outcome - 服务端结论。
   */
  settle(operationId: string, outcome: OperationOutcome): void {
    const record = this.operations.get(operationId);
    if (record === undefined) throw new Error(`没有登记的操作：${operationId}`);
    record.outcome = outcome;
    if (outcome.revision !== undefined) {
      this.observeObject(record.attempt.objectKey, outcome.revision);
    }
    if (outcome.outcome === 'handled') {
      this.raise('handled', record.attempt, this.windowId, outcome.revision ?? record.attempt.baseRevision);
    }
    this.post({ type: 'settled', windowId: this.windowId, operationId, objectKey: record.attempt.objectKey, action: record.attempt.action, outcome });
    this.emitChange();
  }

  /**
   * 取一个操作标识的结论。
   * @param operationId - 操作标识。
   * @returns 结论；尚未写入完成时返回 `undefined`。
   */
  resultOf(operationId: string): OperationOutcome | undefined {
    return this.operations.get(operationId)?.outcome;
  }

  /**
   * 取一个操作标识登记过的尝试。
   * @param operationId - 操作标识。
   * @returns 尝试；没有登记时返回 `undefined`。
   */
  attemptOf(operationId: string): OperationAttempt | undefined {
    return this.operations.get(operationId)?.attempt;
  }

  /** 当前的冲突提示，按对象键排列。 */
  notices(): ConflictNotice[] {
    return [...this.noticeMap.values()].sort((left, right) => left.objectKey.localeCompare(right.objectKey));
  }

  /**
   * 取某个对象的冲突提示。
   * @param objectKey - 对象键。
   * @returns 提示；没有冲突时返回 `undefined`。
   */
  noticeOf(objectKey: string): ConflictNotice | undefined {
    return this.noticeMap.get(objectKey);
  }

  /**
   * 撤掉一个对象的冲突提示。
   * @param objectKey - 对象键。
   */
  dismiss(objectKey: string): void {
    if (this.noticeMap.delete(objectKey)) this.emitChange();
  }

  /**
   * 走刷新入口重新读取对象。
   * @param objectKey - 对象键。
   * @returns 读取完成时兑现。
   */
  async refresh(objectKey: string): Promise<void> {
    if (this.refreshHandler === undefined) throw new Error('没有登记刷新入口');
    await this.refreshHandler(objectKey);
    this.dismiss(objectKey);
  }

  /**
   * 订阅新的冲突提示。
   * @param listener - 收到提示时调用。
   * @returns 取消订阅的函数。
   */
  onConflict(listener: (notice: ConflictNotice) => void): () => void {
    this.conflictListeners.add(listener);
    return () => {
      this.conflictListeners.delete(listener);
    };
  }

  /**
   * 订阅登记变化。
   * @param listener - 变化回调。
   * @returns 取消订阅的函数。
   */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  /**
   * 生成并登记一条提示。
   * @param kind - 冲突种类。
   * @param attempt - 本次尝试。
   * @param windowId - 已经操作该对象的窗口标识。
   * @param serverRevision - 服务端当前版本。
   * @returns 提示。
   */
  private raise(kind: ConflictKind, attempt: OperationAttempt, windowId: string, serverRevision: number): ConflictNotice {
    const notice: ConflictNotice = {
      kind,
      objectKey: attempt.objectKey,
      operationId: attempt.operationId,
      windowId,
      localRevision: attempt.baseRevision,
      serverRevision,
      message: describeConflict(kind, windowId === this.windowId ? '当前窗口' : `窗口 ${windowId}`, attempt.baseRevision, serverRevision),
      refreshLabel: REFRESH_LABEL,
    };
    this.noticeMap.set(attempt.objectKey, notice);
    for (const listener of this.conflictListeners) listener(notice);
    this.emitChange();
    return notice;
  }

  /**
   * 处理一条跨窗口消息。
   * @param raw - 消息内容。
   */
  private receive(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return;
    const record = raw as Record<string, unknown>;
    if (record['type'] === 'operation') {
      const windowId = record['windowId'];
      const operationId = record['operationId'];
      const objectKey = record['objectKey'];
      const revision = record['revision'];
      const action = record['action'];
      if (typeof windowId !== 'string' || windowId === this.windowId) return;
      if (typeof operationId !== 'string' || typeof objectKey !== 'string') return;
      if (typeof revision !== 'number' || !Number.isFinite(revision)) return;
      if (action !== 'send' && action !== 'approve' && action !== 'settings') return;
      this.witnesses.set(objectKey, { revision, windowId, at: this.now() });
      if (!this.operations.has(operationId)) {
        this.operations.set(operationId, { attempt: { operationId, objectKey, windowId, baseRevision: revision, action } });
      }
      this.emitChange();
      return;
    }
    if (record['type'] === 'settled') {
      const outcome = record['outcome'];
      const operationId = record['operationId'];
      const objectKey = record['objectKey'];
      const windowId = record['windowId'];
      if (typeof operationId !== 'string' || typeof objectKey !== 'string' || typeof windowId !== 'string') return;
      if (typeof outcome !== 'object' || outcome === null) return;
      const value = outcome as Record<string, unknown>;
      const revision = value['revision'];
      if (typeof revision !== 'number' || !Number.isFinite(revision)) return;
      this.observeObject(objectKey, revision, windowId);
      const known = this.operations.get(operationId);
      if (known !== undefined) {
        known.outcome = { outcome: value['outcome'] === 'handled' ? 'handled' : value['outcome'] === 'rejected' ? 'rejected' : 'applied', revision };
        if (known.outcome.outcome === 'handled') {
          this.raise('handled', known.attempt, windowId, revision);
        }
      }
      this.emitChange();
    }
  }

  /**
   * 广播一条消息。
   * @param message - 消息内容。
   */
  private post(message: ConflictMessage): void {
    if (this.channel === null) return;
    this.channel.postMessage(message);
  }

  /** 通知登记变化的订阅者。 */
  private emitChange(): void {
    for (const listener of this.changeListeners) listener();
  }
}

/**
 * 生成冲突提示的说明文本。
 * @param kind - 冲突种类。
 * @param actor - 已经操作该对象的窗口说明。
 * @param localRevision - 本窗口基于的版本。
 * @param serverRevision - 服务端当前版本。
 * @returns 说明文本。
 */
export function describeConflict(kind: ConflictKind, actor: string, localRevision: number, serverRevision: number): string {
  switch (kind) {
    case 'revision':
      return `${actor}已在同一对象上提交更新：服务端版本 ${String(serverRevision)}，本窗口基于版本 ${String(localRevision)}。请刷新读取最新内容后再提交。`;
    case 'duplicate':
      return `同一操作已在${actor}提交，按操作标识去重，本次没有再次写入。`;
    case 'handled':
      return `同一审批或设置已在另一个窗口处理，服务端版本 ${String(serverRevision)}，本窗口显示已处理结果。`;
  }
}

/**
 * 打开冲突登记表。
 * @param options - 本窗口标识与广播通道；通道缺省按浏览器的广播通道建立。
 * @returns 冲突登记表。
 */
export function openConflictBoard(options: ConflictBoardOptions): ConflictBoard {
  const channel = 'channel' in options
    ? options.channel ?? null
    : typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(options.channelName ?? 'chatdsh-multi-window.conflicts.v1');
  return new ConflictBoard({ ...options, channel });
}
