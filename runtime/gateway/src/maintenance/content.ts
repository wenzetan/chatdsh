/**
 * 副本内容的事实计算：回合范围、字符数、附件引用与导入声明。
 *
 * 内容范围按完整回合编号表达，字符数取事件数据的 JSON 长度，附件引用按我们自己的标记语法
 * 从载荷文本里提取。附件是否可用直接看数据根下的 `attachments/<附件标识>/` 是否存在，不猜测。
 * @module @chatdsh/gateway/maintenance/content
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { contentScopeSchema, type ContentScope } from '@chatdsh/core-contracts';
import type { ReplicaEventRow } from './rows.ts';

/** 附件标记的识别式，与附件包的 `attachmentMarker` 语法一致。 */
const ATTACHMENT_MARKER = /\[附件 ([^\s\]]+)/g;

/** 一条导入声明。 */
export interface ImportedRecord {
  /** 源会话标识。 */
  readonly sourceSessionId: string;
  /** 源会话所在设备。 */
  readonly sourceDeviceId: string;
  /** 导入粒度。 */
  readonly mode: string;
  /** 复制的事件条数。 */
  readonly eventCount: number;
  /** 复制的字符数。 */
  readonly charCount: number;
  /** 压缩导入时为真。 */
  readonly lossy: boolean;
  /** 导入时刻的毫秒时间戳。 */
  readonly importedAt: number;
}

/** 数据根。 */
export function gatewayDataRoot(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

/** 解析一条副本事件的载荷。 */
function payloadOf(event: ReplicaEventRow): unknown {
  if (event.payload === null) return undefined;
  return JSON.parse(event.payload);
}

/**
 * 取一段事件数据的 JSON 长度。
 * @param events - 副本事件。
 * @returns 字符数。
 */
export function charCountOf(events: readonly ReplicaEventRow[]): number {
  let total = 0;
  for (const event of events) {
    const payload = payloadOf(event) as { readonly data?: unknown } | undefined;
    const data = payload?.data;
    if (data === undefined) continue;
    total += JSON.stringify(data).length;
  }
  return total;
}

/**
 * 提取一段事件里引用到的附件标识。
 * @param events - 副本事件。
 * @returns 按出现顺序去重的附件标识。
 */
export function attachmentIdsOf(events: readonly ReplicaEventRow[]): string[] {
  const seen = new Set<string>();
  for (const event of events) {
    const text = event.payload ?? '';
    for (const match of text.matchAll(ATTACHMENT_MARKER)) {
      const id = match[1];
      if (id !== undefined) seen.add(id);
    }
  }
  return [...seen];
}

/**
 * 核对附件内容是否在控制平面可用。
 * @param attachmentIds - 附件标识。
 * @param root - 数据根。
 * @returns 可用与缺失的附件标识。
 */
export function attachmentAvailability(attachmentIds: readonly string[], root: string = gatewayDataRoot()): { available: string[]; missing: string[] } {
  const available: string[] = [];
  const missing: string[] = [];
  for (const id of attachmentIds) {
    if (existsSync(join(root, 'attachments', id))) available.push(id);
    else missing.push(id);
  }
  return { available, missing };
}

/**
 * 由一段事件算出内容范围。
 * @param events - 范围内的副本事件。
 * @param options - 压缩标记与附件完整性。
 * @returns 校验过的内容范围。
 */
export function contentScopeOf(events: readonly ReplicaEventRow[], options: { readonly compressed: boolean; readonly attachmentsComplete: boolean }): ContentScope {
  let turns = 0;
  for (const event of events) if (event.kind === 'turn/end') turns += 1;
  return contentScopeSchema.parse({
    turnFrom: 1,
    turnTo: Math.max(1, turns),
    eventCount: events.length,
    charCount: charCountOf(events),
    compressed: options.compressed,
    attachmentsComplete: options.attachmentsComplete,
  });
}

/**
 * 从副本里取导入声明。
 * @param events - 副本事件。
 * @returns 导入声明；没有导入记录时为空。
 */
export function importedRecordOf(events: readonly ReplicaEventRow[]): ImportedRecord | undefined {
  for (const event of events) {
    if (!event.kind.startsWith('plugin:')) continue;
    const payload = payloadOf(event) as { readonly data?: unknown } | undefined;
    const data = payload?.data;
    if (typeof data !== 'object' || data === null) continue;
    const record = data as Record<string, unknown>;
    if (record.kind !== 'import') continue;
    const { sourceSessionId, sourceDeviceId, mode, eventCount, charCount, lossy, importedAt } = record;
    if (typeof sourceSessionId !== 'string' || sourceSessionId === '') continue;
    if (typeof sourceDeviceId !== 'string' || sourceDeviceId === '') continue;
    if (typeof mode !== 'string' || mode === '') continue;
    if (typeof eventCount !== 'number' || !Number.isInteger(eventCount) || eventCount < 0) continue;
    if (typeof charCount !== 'number' || !Number.isInteger(charCount) || charCount < 0) continue;
    if (typeof importedAt !== 'number' || !Number.isInteger(importedAt) || importedAt < 0) continue;
    return {
      sourceSessionId,
      sourceDeviceId,
      mode,
      eventCount,
      charCount,
      lossy: lossy === true,
      importedAt,
    };
  }
  return undefined;
}

/**
 * 比较子会话与父会话的连续相同前缀长度。
 *
 * 分叉与导入都从父会话的第 1 回合连续复制，因此两者的日志从开头起逐条相同，直到分叉边界。
 * 这段长度就是继承的事件条数。
 * @param child - 子会话的副本事件，按序号升序。
 * @param parent - 父会话的副本事件，按序号升序。
 * @returns 连续相同的事件条数。
 */
export function inheritedPrefixLength(child: readonly ReplicaEventRow[], parent: readonly ReplicaEventRow[]): number {
  const limit = Math.min(child.length, parent.length);
  for (let index = 0; index < limit; index += 1) {
    const left = child[index] as ReplicaEventRow;
    const right = parent[index] as ReplicaEventRow;
    if (left.kind !== right.kind) return index;
    if ((left.payload ?? '') !== (right.payload ?? '')) return index;
  }
  return limit;
}
