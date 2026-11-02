/**
 * 进行中运行的登记。
 *
 * 删除前的依赖检查需要知道哪些会话正在跑。运行的生命周期属于宿主入口，这一层提供登记的
 * 实现：入口在回合开始时登记会话、回合结束时注销，控制平面据此判定「进行中运行」。登记表是
 * 真实进程内状态，进程重启后为空，符合「重启即没有进行中的运行」。
 * @module @chatdsh/gateway/maintenance/active-runs
 */

/** 进行中运行的读取面。 */
export interface ActiveRunSource {
  /** 列出正在运行的会话标识。 */
  list(): readonly string[];
}

/** 进行中运行的登记表。 */
export class ActiveRunRegistry implements ActiveRunSource {
  readonly #sessions = new Set<string>();

  /** 登记一个开始运行的会话。 */
  begin(sessionId: string): void {
    this.#sessions.add(sessionId);
  }

  /** 注销一个结束运行的会话。 */
  end(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  /** 列出正在运行的会话标识，按登记顺序。 */
  list(): readonly string[] {
    return [...this.#sessions];
  }

  /** 判断一个会话是否正在运行。 */
  isRunning(sessionId: string): boolean {
    return this.#sessions.has(sessionId);
  }

  /** 正在运行的会话数。 */
  get size(): number {
    return this.#sessions.size;
  }
}
