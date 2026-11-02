/**
 * 数据管理的对外形状守卫。
 *
 * 界面与导出只描述看到了多少内容、何时读取、占用多少空间。副本序号、同步水位、连续前缀长度
 * 与内部标识属于实现细节，任何 DTO 带着这些字段返回都是缺陷，因此每个对外形状在返回前统一
 * 走一次检查，命中就地拒绝。
 * @module @chatdsh/gateway/maintenance/dto
 */

import { ChatdshError, CHATDSH_ERROR_CODES } from '@chatdsh/core-contracts';

/** 不允许出现在对外形状里的内部字段名。 */
export const INTERNAL_CURSOR_KEYS = [
  'seq',
  'watermark',
  'upToSeq',
  'up_to_seq',
  'readUpToSeq',
  'read_up_to_seq',
  'sourceWatermark',
  'source_watermark',
  'eventSeq',
  'event_seq',
  'lastSeq',
  'last_seq',
  'cursor',
  'replicaSeq',
  'replica_seq',
] as const;

/**
 * 递归检查一个对外形状，发现内部游标字段就地拒绝。
 * @param value - 待返回的形状。
 * @param label - 形状名称，写进拒绝说明。
 * @throws ChatdshError - 形状里出现内部游标字段。
 */
export function assertNoInternalCursor(value: unknown, label: string): void {
  const blocked = new Set<string>(INTERNAL_CURSOR_KEYS);
  const visit = (current: unknown, path: string): void => {
    if (current === null || typeof current !== 'object') return;
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${path}[${String(index)}]`));
      return;
    }
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      if (blocked.has(key)) {
        throw new ChatdshError(CHATDSH_ERROR_CODES.internalError, `${label} 暴露了内部游标字段：${path}${path === '' ? '' : '.'}${key}`);
      }
      visit(child, `${path}${path === '' ? '' : '.'}${key}`);
    }
  };
  visit(value, '');
}
