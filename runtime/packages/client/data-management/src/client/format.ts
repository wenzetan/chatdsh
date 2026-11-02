/**
 * 数据管理界面的文本换算：字节、占比、时刻、维度与内容范围。
 *
 * 界面只显示真实读数与它出自哪个维度。字节按 1024 进制换算，换算结果保留一位小数；内容范围
 * 按完整回合编号表达，附件完整性与压缩标记直接取自范围本身。
 * @module @chatdsh/client-data-management/format
 */

import type { ContentScope } from '@chatdsh/core-contracts';

/** 字节单位，按 1024 进制递增。 */
const BYTE_UNITS = ['字节', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;

/**
 * 把字节数换算成可读文本。
 * @param bytes - 字节数，非负整数。
 * @returns 可读文本，例如 `12.4 MiB`。
 */
export function formatBytes(bytes: number): string {
  if (!Number.isInteger(bytes) || bytes < 0) throw new Error(`字节数必须是非负整数：${String(bytes)}`);
  if (bytes < 1024) return `${String(bytes)} 字节`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${BYTE_UNITS[unit] as string}`;
}

/**
 * 把计数换算成带单位的文本。
 * @param value - 计数值。
 * @param unit - 单位词。
 * @returns 可读文本。
 */
export function formatCount(value: number, unit: string): string {
  if (!Number.isInteger(value) || value < 0) throw new Error(`计数必须是非负整数：${String(value)}`);
  return `${value.toLocaleString('zh-CN')} ${unit}`;
}

/**
 * 计算一个读数在总量里的占比。
 * @param part - 部分读数。
 * @param total - 总量。
 * @returns 占比文本；总量为零时给「无占比」。
 */
export function formatShare(part: number, total: number): string {
  if (total <= 0) return '没有可比较的总量';
  return `${((part / total) * 100).toFixed(1)}%`;
}

/** 补足两位。 */
function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * 把毫秒时间戳格式化成 `YYYY-MM-DD HH:mm:ss`。
 * @param millis - 毫秒时间戳。
 * @returns 本地时间文本。
 */
export function formatTimestamp(millis: number): string {
  const date = new Date(millis);
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 用量维度的名称。 */
export const DIMENSION_LABELS: Readonly<Record<'device' | 'workspace' | 'session', string>> = {
  device: '设备',
  workspace: '工作区',
  session: '会话',
};

/** 字节来源分类的名称。 */
export const BUCKET_LABELS: Readonly<Record<'session' | 'replica' | 'attachment' | 'memory' | 'other', string>> = {
  session: '会话',
  replica: '副本',
  attachment: '附件',
  memory: '记忆',
  other: '其他',
};

/** 只读副本状态的名称。 */
export const REPLICA_STATE_LABELS: Readonly<Record<'complete' | 'partial' | 'missing', string>> = {
  complete: '完整可读',
  partial: '部分可读',
  missing: '不可读取',
};

/** 内容读取来源的名称。 */
export const READ_SOURCE_LABELS: Readonly<Record<'authoritative' | 'replica' | 'snapshot', string>> = {
  authoritative: '设备权威日志',
  replica: '控制平面副本',
  snapshot: '公开快照',
};

/** 只读原因的名称。 */
export const READ_ONLY_REASON_LABELS: Readonly<Record<'device-offline' | 'replica-only' | 'public-snapshot' | 'permission', string>> = {
  'device-offline': '源设备离线',
  'replica-only': '按只读副本阅读',
  'public-snapshot': '公开快照只读',
  permission: '权限限制',
};

/** 复制方式的名称。 */
export const IMPORT_MODE_LABELS: Readonly<Record<'full-prefix' | 'compressed', string>> = {
  'full-prefix': '完整前缀',
  compressed: '压缩摘要',
};

/**
 * 取内容范围覆盖的完整回合数。
 * @param scope - 内容范围。
 * @returns 回合数。
 */
export function turnsOf(scope: ContentScope): number {
  return scope.turnTo - scope.turnFrom + 1;
}

/**
 * 描述一段内容范围。
 * @param scope - 内容范围。
 * @returns 供界面显示的说明。
 */
export function scopeText(scope: ContentScope): string {
  const turns = turnsOf(scope);
  return `第 ${String(scope.turnFrom)} 到 ${String(scope.turnTo)} 回合 · ${formatCount(turns, '个完整回合')} · ${formatCount(scope.eventCount, '个事件')} · ${formatCount(scope.charCount, '个字符')}`;
}

/**
 * 描述压缩标记。
 * @param scope - 内容范围。
 * @returns 复制方式说明。
 */
export function compressionText(scope: ContentScope): string {
  return scope.compressed ? '压缩复制，工具输出原文已经替换成摘要' : '原文复制，没有内容被替换';
}

/**
 * 描述附件完整性。
 * @param scope - 内容范围。
 * @returns 附件说明。
 */
export function attachmentsText(scope: ContentScope): string {
  return scope.attachmentsComplete ? '范围内附件全部可用' : '范围内有附件缺失';
}
