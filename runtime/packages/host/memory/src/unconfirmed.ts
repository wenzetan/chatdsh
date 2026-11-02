/**
 * 未确认写入记录。
 *
 * 回合写入先登记一条记录再交给适配层：适配层返回成功就删除记录，失败则保留并记下错误码。
 * 适配层当前不提供客户端操作标识与写入查询，因此这里不自动重放——重放可能把已经受理的
 * 内容再写一次；记录只用于人工查询与丢弃。对外只给数量、时间与错误码，内容留在宿主侧。
 * @module @chatdsh/host-memory/unconfirmed
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ChatdshError,
  chatdshErrorCodeSchema,
  countSchema,
  epochMillisSchema,
  identifierSchema,
  memoryWriteQueueViewSchema,
  type ChatdshErrorCode,
  type MemoryWriteQueueView,
} from '@chatdsh/core-contracts';
import type { MemoryStore } from './store.ts';

/** 存储文件名。 */
export const WRITES_STORE = 'memory-writes';

/** 未确认写入记录数量上限。达到上限后拒绝登记。 */
export const WRITES_LIMIT = 1024;

/** 未确认写入记录的 schema。 */
const recordSchema = z.object({
  id: z.string().min(1).max(64),
  bank: identifierSchema,
  content: z.string().min(1),
  context: z.string().optional(),
  createdAt: epochMillisSchema,
  updatedAt: epochMillisSchema,
  attempts: countSchema,
});

/** 存储文件的 schema。 */
const writesFileSchema = z.object({
  records: z.array(recordSchema),
  discardedCount: countSchema,
  lastErrorCode: chatdshErrorCodeSchema.optional(),
});

/** 一条未确认写入记录。 */
export type UnconfirmedWriteRecord = z.infer<typeof recordSchema>;

/** 存储里的形状。 */
type WritesFile = z.infer<typeof writesFileSchema>;

/** 文件缺省值。 */
const EMPTY: WritesFile = { records: [], discardedCount: 0 };

/** 未确认写入记录表。 */
export class UnconfirmedWrites {
  constructor(private readonly store: MemoryStore, private readonly now: () => number = Date.now) {}

  /**
   * 登记一条待写入记录。
   * @param input - 目标 bank、内容与上下文标签。
   * @returns 登记后的记录。
   */
  async register(input: { readonly bank: string; readonly content: string; readonly context?: string }): Promise<UnconfirmedWriteRecord> {
    const createdAt = this.now();
    const record: UnconfirmedWriteRecord = {
      id: randomUUID(),
      bank: input.bank,
      content: input.content,
      ...(input.context === undefined ? {} : { context: input.context }),
      createdAt,
      updatedAt: createdAt,
      attempts: 0,
    };
    return this.store.mutate<WritesFile, UnconfirmedWriteRecord>(WRITES_STORE, writesFileSchema, EMPTY, async (current) => {
      if (current.records.length >= WRITES_LIMIT) {
        throw new ChatdshError('request-invalid', '未确认写入记录达到上限，请先处理既有记录', { limit: WRITES_LIMIT });
      }
      return { value: { ...current, records: [...current.records, record] }, result: record };
    });
  }

  /**
   * 写入成功，删除登记。
   * @param id - 记录标识。
   */
  async delivered(id: string): Promise<void> {
    await this.store.mutate<WritesFile, void>(WRITES_STORE, writesFileSchema, EMPTY, async (current) => {
      const records = current.records.filter((record) => record.id !== id);
      if (records.length === current.records.length) return { result: undefined };
      return { value: { ...current, records }, result: undefined };
    });
  }

  /**
   * 写入抛出错误，保留记录并记下错误码。
   * @param id - 记录标识。
   * @param code - 错误码。
   */
  async failed(id: string, code: ChatdshErrorCode): Promise<void> {
    await this.store.mutate<WritesFile, void>(WRITES_STORE, writesFileSchema, EMPTY, async (current) => {
      const updatedAt = this.now();
      let changed = false;
      const records = current.records.map((record) => {
        if (record.id !== id) return record;
        changed = true;
        return { ...record, updatedAt, attempts: record.attempts + 1 };
      });
      if (!changed) return { value: { ...current, lastErrorCode: code }, result: undefined };
      return { value: { ...current, records, lastErrorCode: code }, result: undefined };
    });
  }

  /**
   * 人工丢弃一条记录，写入的内容随之删除。
   * @param id - 记录标识。
   * @returns 记录存在且被丢弃时为 true。
   */
  async discard(id: string): Promise<boolean> {
    return this.store.mutate<WritesFile, boolean>(WRITES_STORE, writesFileSchema, EMPTY, async (current) => {
      const records = current.records.filter((record) => record.id !== id);
      if (records.length === current.records.length) return { result: false };
      return { value: { ...current, records, discardedCount: current.discardedCount + 1 }, result: true };
    });
  }

  /**
   * 脱敏视图：只给出数量、时间与错误码。
   * @returns 待处理与废弃记录的计数。
   */
  async view(): Promise<MemoryWriteQueueView> {
    const file = await this.store.read(WRITES_STORE, writesFileSchema, EMPTY);
    const oldest = file.records.reduce<number | undefined>(
      (current, record) => (current === undefined || record.createdAt < current ? record.createdAt : current),
      undefined,
    );
    const view = {
      pendingCount: file.records.length,
      ...(oldest === undefined ? {} : { oldestPendingAt: oldest }),
      discardedCount: file.discardedCount,
      ...(file.lastErrorCode === undefined ? {} : { lastErrorCode: file.lastErrorCode }),
    };
    return memoryWriteQueueViewSchema.parse(view);
  }
}
