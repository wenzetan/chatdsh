/**
 * 内部游标字段的对外守卫。
 *
 * 控件平面用副本序号与同步位置维持连续性，这些值是实现细节。界面与导出只描述「看到多少内容、
 * 何时读取、占用多少空间」，任何对外形状带着这些字段返回都是缺陷，因此在 DTO 解析处统一检查，
 * 命中就地拒绝，界面因此不会把它们渲染到页面或写进导出文件。
 * @module @chatdsh/client-data-management/cursor
 */

import { DataCallError, LOCAL_ERROR_CODES } from './errors.ts';

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
 * @param value - 待渲染或导出的形状。
 * @param label - 形状名称，写进拒绝说明。
 * @throws DataCallError - 形状里出现内部游标字段。
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
        throw new DataCallError(
          LOCAL_ERROR_CODES.internalCursor,
          `${label} 暴露了内部游标字段：${path === '' ? '' : `${path}.`}${key}`,
        );
      }
      visit(child, `${path === '' ? '' : `${path}.`}${key}`);
    }
  };
  visit(value, '');
}
