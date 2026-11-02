/**
 * 用量账本。
 *
 * 账本在内存里累加每个 provider 的 token 用量与请求数，每次请求结束写一次持久记录。重启后
 * 从存储读回这些记录，既回答用量查询，也作为额度守卫的启动读数：控制平面的账本是额度的
 * 唯一权威，这里保存的是本运行时观察到的用量，用于在下一轮请求之前提前拒绝。
 *
 * 写入失败不让已经交付的模型输出变成一次失败请求；失败被记录下来，由服务层写一条带
 * `error.type` 与 `error.code` 的事件，并在用量查询里报告 `persisted: false`。
 * @module @chatdsh/host-llm-router/ledger
 */

import type { ProviderUsageRecord } from './domain.ts';

/** 只用到四个方法的表。 */
export interface LedgerTable {
  get(key: string): ProviderUsageRecord | undefined;
  entries(): IterableIterator<[string, ProviderUsageRecord]>;
  put(key: string, value: ProviderUsageRecord): Promise<void>;
}

/** 一次写入失败的事实。 */
export interface UsageWriteFailure {
  /** 写入失败的 provider。 */
  readonly provider: string;
  /** 异常的类名。 */
  readonly errorType: string;
  /** 稳定错误码。 */
  readonly errorCode: string;
}

/** 一次请求的用量。 */
export interface UsageDelta {
  /** 输入 token。 */
  readonly inputTokens: number;
  /** 输出 token。 */
  readonly outputTokens: number;
}

/** 用量账本。 */
export class UsageLedger {
  private readonly table: () => LedgerTable;

  private readonly records = new Map<string, ProviderUsageRecord>();

  private failure: UsageWriteFailure | undefined;

  constructor(table: () => LedgerTable) {
    this.table = table;
  }

  /** 从存储读回既往用量。 */
  load(): void {
    for (const [provider, record] of this.table().entries()) {
      this.records.set(provider, record);
    }
  }

  /** 一个 provider 的累计用量。 */
  get(provider: string): ProviderUsageRecord | undefined {
    return this.records.get(provider);
  }

  /** 全部累计用量，按 provider 排序。 */
  all(): ProviderUsageRecord[] {
    return [...this.records.values()].sort((left, right) => left.provider.localeCompare(right.provider));
  }

  /** 最近一次写入失败。 */
  lastFailure(): UsageWriteFailure | undefined {
    return this.failure;
  }

  /**
   * 累加一次请求的用量并写回存储。
   * @param provider - provider 路由标识。
   * @param delta - 本次请求的 token 增量。
   * @returns 写入失败的事实；写成功时为 `undefined`。
   */
  async record(provider: string, delta: UsageDelta): Promise<UsageWriteFailure | undefined> {
    const current = this.records.get(provider);
    const record: ProviderUsageRecord = {
      provider,
      inputTokens: (current?.inputTokens ?? 0) + delta.inputTokens,
      outputTokens: (current?.outputTokens ?? 0) + delta.outputTokens,
      requests: (current?.requests ?? 0) + 1,
      updatedAt: Date.now(),
    };
    this.records.set(provider, record);
    try {
      await this.table().put(provider, record);
      return undefined;
    } catch (error) {
      const failure: UsageWriteFailure = {
        provider,
        errorType: error instanceof Error ? error.name : 'Unknown',
        errorCode: failureCodeOf(error),
      };
      this.failure = failure;
      return failure;
    }
  }
}

/** 从异常取稳定错误码；没有错误码时归为内部失败。 */
function failureCodeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code !== '') return code;
  }
  return 'internal-error';
}
