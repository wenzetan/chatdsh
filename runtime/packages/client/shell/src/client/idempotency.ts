/**
 * 同一意图的重复提交合并。
 *
 * 创建会话、本机继续这类动作在提交期间重复点击只能产生一次写入：同一个键上的调用共享同一个
 * 进行中的操作，完成后才允许下一次。键由动作与目标对象组成，界面因此在网络慢、双击与
 * 键盘重复触发的条件下都不会多建会话。
 * @module @chatdsh/client-shell/idempotency
 */

/** 进行中操作的登记表。 */
export class OperationGate {
  private readonly running = new Map<string, Promise<unknown>>();

  /**
   * 在同一键上执行一次操作。
   *
   * 键上已有进行中的操作时直接返回它的结果，不再次调用工作函数。
   * @param key - 操作键，包含动作与目标对象。
   * @param work - 工作函数。
   * @returns 本次意图的结果。
   */
  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const existing = this.running.get(key);
    if (existing !== undefined) return existing as Promise<T>;
    const started = Promise.resolve()
      .then(work)
      .finally(() => {
        if (this.running.get(key) === started) this.running.delete(key);
      });
    this.running.set(key, started);
    return started;
  }

  /**
   * 判断一个键上是否有进行中的操作。
   * @param key - 操作键。
   * @returns 有进行中的操作时为真。
   */
  isRunning(key: string): boolean {
    return this.running.has(key);
  }

  /** 进行中的操作数量。 */
  get size(): number {
    return this.running.size;
  }
}
