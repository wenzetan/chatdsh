/**
 * 桌面控制租约。
 *
 * 一份租约带上失效时刻、作用范围与状态。到期由真实计时器触发，到期之后旧租约标识再也不能
 * 发起动作；中断立即生效，正在执行的动作收到停止信号，之后发起的动作一律被拒绝。全部状态
 * 变化广播给订阅者，多个窗口因此看到同一份状态。
 * @module chatdsh-desktop-control/lease
 */

/** 租约状态。 */
export const LEASE_STATES = Object.freeze(['active', 'paused', 'expired', 'revoked', 'interrupted']);

/** 授权期限的下限，一秒。单次动作的短租约按这个粒度给出，界面按分钟给会话选项。 */
export const MIN_DURATION_MS = 1_000;

/** 授权期限的上限，十二小时。 */
export const MAX_DURATION_MS = 12 * 60 * 60 * 1000;

/** 租约拒绝一次动作。 */
export class LeaseRejection extends Error {
  /**
   * @param code - 拒绝原因代码。
   * @param detail - 说明。
   */
  constructor(code, detail) {
    super(detail === undefined ? `租约拒绝：${code}` : `租约拒绝：${code}（${detail}）`);
    this.name = 'LeaseRejection';
    this.code = code;
    this.detail = detail;
  }
}

/** 中断时投给动作的停止信号。 */
export class LeaseInterruption extends Error {
  /**
   * @param reason - 中断原因。
   */
  constructor(reason) {
    super(reason === undefined ? '桌面控制已被中断' : `桌面控制已被中断：${reason}`);
    this.name = 'LeaseInterruption';
    this.code = 'lease-interrupted';
  }
}

/**
 * 租约的单一权威。
 *
 * 同一时刻只有一份租约生效：再次授权会撤销上一份并停止它正在执行的动作。
 */
export class LeaseAuthority {
  #now;

  #schedule;

  #cancel;

  #lease;

  #timer;

  #permitSeq = 0;

  #inflight = new Map();

  #listeners = new Set();

  /**
   * @param options.now - 当前时刻的实现。
   * @param options.schedule - 定时器实现。
   * @param options.cancel - 取消定时器的实现。
   */
  constructor({
    now = () => Date.now(),
    schedule = (callback, delay) => setTimeout(callback, delay),
    cancel = (handle) => clearTimeout(handle),
  } = {}) {
    this.#now = now;
    this.#schedule = schedule;
    this.#cancel = cancel;
  }

  /**
   * 广播一次状态变化。
   * @param change - 变化种类。
   */
  #emit(change) {
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) listener(snapshot, change);
  }

  /** 取当前时刻。 */
  get now() {
    return this.#now();
  }

  /** 清除到期计时器。 */
  #clearTimer() {
    if (this.#timer !== undefined) {
      this.#cancel(this.#timer);
      this.#timer = undefined;
    }
  }

  /**
   * 停止全部正在执行的动作。
   * @param reason - 中断原因。
   */
  #abortInflight(reason) {
    for (const entry of this.#inflight.values()) {
      entry.controller.abort(new LeaseInterruption(reason));
    }
    this.#inflight.clear();
  }

  /**
   * 让租约进入失效状态。
   * @param state - 目标状态。
   * @param reason - 原因。
   */
  #settle(state, reason) {
    const lease = this.#lease;
    if (lease === undefined) return;
    lease.status = state;
    lease.reason = reason;
    lease.endedAt = this.#now();
    this.#clearTimer();
    this.#abortInflight(reason ?? state);
    this.#emit(state);
  }

  /** 到期处理。到期以真实计时器触发，动作校验另外按时刻再判一次。 */
  #expire() {
    if (this.#lease === undefined) return;
    if (this.#lease.status === 'expired') return;
    this.#settle('expired', '授权期限已到');
  }

  /**
   * 授权一份新租约。
   * @param input.scope - 规范化之后的作用范围。
   * @param input.durationMs - 授权期限，毫秒。
   * @param input.requestId - 这次授权的申请标识。
   * @returns 新租约的快照。
   */
  grant({ scope, durationMs, requestId }) {
    if (scope === undefined) throw new LeaseRejection('scope-missing', '缺少作用范围');
    if (typeof durationMs !== 'number' || !Number.isInteger(durationMs)) {
      throw new LeaseRejection('duration-type', '授权期限需要整数毫秒');
    }
    if (durationMs < MIN_DURATION_MS || durationMs > MAX_DURATION_MS) {
      throw new LeaseRejection('duration-range', `授权期限需要在 ${MIN_DURATION_MS} 到 ${MAX_DURATION_MS} 毫秒之间`);
    }
    if (this.#lease !== undefined && (this.#lease.status === 'active' || this.#lease.status === 'paused')) {
      this.#settle('revoked', '新的授权替换了上一份租约');
    }
    const grantedAt = this.#now();
    const expiresAt = grantedAt + durationMs;
    this.#lease = {
      leaseId: `lease-${grantedAt.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      requestId,
      scope,
      grantedAt,
      expiresAt,
      status: 'active',
      reason: undefined,
      endedAt: undefined,
      actionCount: 0,
    };
    this.#clearTimer();
    this.#timer = this.#schedule(() => this.#expire(), durationMs);
    if (typeof this.#timer?.unref === 'function') this.#timer.unref();
    this.#emit('grant');
    return this.snapshot();
  }

  /**
   * 核对一份租约此刻是否可以发起动作。
   * @param leaseId - 租约标识。
   * @returns 是否可用。
   */
  #assertUsable(leaseId) {
    const lease = this.#lease;
    if (lease === undefined) throw new LeaseRejection('lease-missing', '没有生效中的授权');
    if (leaseId !== undefined && leaseId !== lease.leaseId) {
      throw new LeaseRejection('lease-stale', '这份租约已经被替换');
    }
    if (lease.status === 'paused') throw new LeaseRejection('lease-paused', '授权已暂停');
    if (lease.status === 'interrupted') throw new LeaseRejection('lease-interrupted', '授权已中断');
    if (lease.status === 'revoked') throw new LeaseRejection('lease-revoked', '授权已撤销');
    if (lease.status === 'expired') throw new LeaseRejection('lease-expired', '授权期限已到');
    if (this.#now() >= lease.expiresAt) {
      this.#expire();
      throw new LeaseRejection('lease-expired', '授权期限已到');
    }
    return lease;
  }

  /**
   * 发起一次受控动作。
   * @param leaseId - 租约标识。
   * @param action - 动作名。
   * @returns 动作许可，包含停止信号与结束入口。
   */
  begin(leaseId, action) {
    const lease = this.#assertUsable(leaseId);
    if (typeof action !== 'string' || action.trim() === '') {
      throw new LeaseRejection('action-missing', '动作名不能为空');
    }
    this.#permitSeq += 1;
    const permitId = `${lease.leaseId}:${this.#permitSeq}`;
    const controller = new AbortController();
    this.#inflight.set(permitId, { action, controller, startedAt: this.#now() });
    lease.actionCount += 1;
    this.#emit('use');
    return Object.freeze({
      permitId,
      leaseId: lease.leaseId,
      action,
      expiresAt: lease.expiresAt,
      signal: controller.signal,
    });
  }

  /**
   * 结束一次受控动作。
   * @param permitId - 动作许可标识。
   * @param outcome - 动作结果。
   * @returns 动作条目，没有登记时返回 `undefined`。
   */
  end(permitId, outcome) {
    const entry = this.#inflight.get(permitId);
    if (entry === undefined) return undefined;
    this.#inflight.delete(permitId);
    return { ...entry, outcome, endedAt: this.#now() };
  }

  /**
   * 暂停或恢复授权。暂停期间不发起新动作。
   * @param paused - 是否暂停。
   * @returns 状态快照。
   */
  setPaused(paused) {
    const lease = this.#lease;
    if (lease === undefined) throw new LeaseRejection('lease-missing', '没有生效中的授权');
    if (lease.status === 'expired' || lease.status === 'revoked' || lease.status === 'interrupted') {
      throw new LeaseRejection(`lease-${lease.status}`, '这份租约已经结束');
    }
    if (paused === true) {
      if (lease.status === 'paused') return this.snapshot();
      lease.status = 'paused';
      this.#emit('pause');
      return this.snapshot();
    }
    if (lease.status === 'active') return this.snapshot();
    if (lease.status === 'paused') {
      if (this.#now() >= lease.expiresAt) {
        this.#expire();
        throw new LeaseRejection('lease-expired', '授权期限已到');
      }
      lease.status = 'active';
      this.#emit('resume');
      return this.snapshot();
    }
    throw new LeaseRejection(`lease-${lease.status}`, '这份租约已经结束');
  }

  /**
   * 立即中断。正在执行的动作收到停止信号，之后不再接受新动作。
   * @param reason - 中断原因。
   * @returns 状态快照。
   */
  interrupt(reason) {
    const lease = this.#lease;
    if (lease === undefined) throw new LeaseRejection('lease-missing', '没有生效中的授权');
    if (lease.status === 'expired' || lease.status === 'revoked' || lease.status === 'interrupted') {
      throw new LeaseRejection(`lease-${lease.status}`, '这份租约已经结束');
    }
    this.#settle('interrupted', reason ?? '用户中断');
    return this.snapshot();
  }

  /**
   * 撤销。与中断的区别在原因来源：撤销来自权限本身失效。
   * @param reason - 撤销原因。
   * @returns 状态快照。
   */
  revoke(reason) {
    const lease = this.#lease;
    if (lease === undefined) throw new LeaseRejection('lease-missing', '没有生效中的授权');
    this.#settle('revoked', reason ?? '权限已撤销');
    return this.snapshot();
  }

  /** 当前状态。 */
  snapshot() {
    const lease = this.#lease;
    if (lease === undefined) {
      return Object.freeze({
        lease: undefined,
        now: this.#now(),
        activeActions: 0,
      });
    }
    return Object.freeze({
      lease: Object.freeze({
        leaseId: lease.leaseId,
        requestId: lease.requestId,
        scope: lease.scope,
        grantedAt: lease.grantedAt,
        expiresAt: lease.expiresAt,
        endedAt: lease.endedAt,
        status: lease.status,
        paused: lease.status === 'paused',
        reason: lease.reason,
        actionCount: lease.actionCount,
      }),
      now: this.#now(),
      activeActions: this.#inflight.size,
      remainingMs: lease.status === 'active' || lease.status === 'paused'
        ? Math.max(0, lease.expiresAt - this.#now())
        : 0,
    });
  }

  /**
   * 订阅状态变化。
   * @param listener - 收到快照与变化种类的函数。
   * @returns 取消订阅函数。
   */
  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('订阅者必须是函数');
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** 取消到期计时器，用于进程退出。 */
  dispose() {
    this.#clearTimer();
    this.#listeners.clear();
  }
}
