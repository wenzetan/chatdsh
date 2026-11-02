/**
 * 会话后端的遥测出口。
 *
 * 只经宿主注册的 `ctx.chatdshTelemetry` 记录；未注册时全部退化为空操作。连接串、事件正文
 * 与提示词一律不进属性，属性只有结果、计数、错误类型与错误码。
 *
 * 信号名集中在 `PERSISTENCE_SIGNALS`，包的 `chatdsh.telemetry` 声明引用同一组常量。
 * @module @chatdsh/core-session-persistence-postgres/telemetry
 */

/** 属性值。 */
export type PersistenceAttribute = string | number | boolean | undefined;

/** 属性表。 */
export type PersistenceAttributes = Readonly<Record<string, PersistenceAttribute>>;

/** span 句柄。 */
export interface PersistenceSpan {
  /** 设置一个属性。 */
  setAttribute(key: string, value: PersistenceAttribute): void;
  /** 批量设置属性。 */
  setAttributes(attributes: PersistenceAttributes): void;
  /** 记录一次异常。 */
  recordException(error: unknown): void;
  /** 结束 span。 */
  end(): void;
}

/** 计数器句柄。 */
export interface PersistenceCounter {
  /** 累加一个增量。 */
  add(delta: number, attributes?: PersistenceAttributes): void;
}

/** 宿主遥测出口里本包用到的那部分。 */
export interface PersistenceTelemetry {
  /** 记录一条结构化事件。 */
  event(name: string, attributes?: PersistenceAttributes, body?: string): void;
  /** 取得计数器。 */
  counter(name: string, options?: { readonly description?: string; readonly unit?: string }): PersistenceCounter;
  /** 开始一个 span。 */
  startSpan(name: string, attributes?: PersistenceAttributes): PersistenceSpan;
  /** 异步执行并把结果记入 span。 */
  runSpan<T>(name: string, attributes: PersistenceAttributes, fn: (span: PersistenceSpan) => Promise<T>): Promise<T>;
}

/** 本包产生的信号名。 */
export const PERSISTENCE_SIGNALS = {
  /** 创建、打开与删除会话的花费与结果。 */
  open: 'chatdsh.session.persist.open',
  /** 一次事件追加。 */
  append: 'chatdsh.session.persist.append',
  /** 一次耐久屏障。 */
  flush: 'chatdsh.session.persist.flush',
  /** 写所有权丢失。 */
  ownershipLost: 'chatdsh.session.persist.ownership.lost',
  /** 追加计数。 */
  appendsTotal: 'chatdsh_session_persist_appends_total',
  /** 写所有权丢失计数。 */
  ownershipLossesTotal: 'chatdsh_session_persist_ownership_losses_total',
} as const;

/** 空 span。 */
function createNoopSpan(): PersistenceSpan {
  return {
    setAttribute: () => {},
    setAttributes: () => {},
    recordException: () => {},
    end: () => {},
  };
}

/** 没有遥测出口时的空实现。 */
export const NO_TELEMETRY: PersistenceTelemetry = {
  event: () => {},
  counter: () => ({ add: () => {} }),
  startSpan: () => createNoopSpan(),
  runSpan: async (_name, _attributes, fn) => fn(createNoopSpan()),
};

/** 把错误整理成 span 属性。 */
export function describeError(error: unknown): PersistenceAttributes {
  const name = error instanceof Error ? error.name : 'Error';
  const code =
    typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : name;
  return { outcome: 'failed', 'error.type': name, 'error.code': code };
}
