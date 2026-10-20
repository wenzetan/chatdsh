/**
 * 记忆后端契约。
 *
 * Hindsight 与将来的其他记忆服务实现这一组接口。接入层只做编排与规则，存储由实现承担。
 * bank 的命名规则属于本项目策略，不写进契约。
 * @module @chatdsh/core-contracts/memory-backend
 */

import type { BackendCallContext, BackendHealth } from './services.ts';

/** 一次召回请求。 */
export interface MemoryQuery {
  /** 读取的 bank 列表，按优先级排序。 */
  readonly banks: readonly string[];
  /** 用于召回的问题文本。 */
  readonly text: string;
  /** 结果令牌上限。 */
  readonly maxTokens?: number;
}

/** 一条召回结果。 */
export interface MemoryHit {
  /** 命中的 bank。 */
  readonly bank: string;
  /** 命中内容。 */
  readonly text: string;
  /** 相似度得分，实现未提供时缺省。 */
  readonly score?: number;
  /** 来源标识，例如会话编号。 */
  readonly source?: string;
}

/** 一条写入请求。 */
export interface MemoryWrite {
  /** 写入的 bank。 */
  readonly bank: string;
  /** 写入内容。 */
  readonly text: string;
  /** 附加元数据。 */
  readonly metadata?: Readonly<Record<string, string>>;
}

/** 记忆后端。 */
export interface MemoryBackend {
  /** 按 bank 规则召回。 */
  recall(query: MemoryQuery, context: BackendCallContext): Promise<readonly MemoryHit[]>;
  /** 写入一条记忆。 */
  write(entry: MemoryWrite, context: BackendCallContext): Promise<void>;
  /** 探测可用性。 */
  health(context: BackendCallContext): Promise<BackendHealth>;
  /** 声明支持的能力名。 */
  capabilities(): readonly string[];
}
