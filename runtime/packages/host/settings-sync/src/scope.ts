/**
 * 白名单字段与作用范围的判定。
 *
 * 跨设备同步只覆盖「应该一致」的用户偏好：默认模型、界面语言、会话视图、分析开关与默认预设。
 * 路径、电源、超时与平台配置属于设备自己的组合，留在设备范围：读取时标注作用范围，写入时
 * 拒绝，任何情况下都不进入上报载荷。字段清单与运行程序文档 `target-shape.md` 第七节一致。
 * @module @chatdsh/host-settings-sync/scope
 */

import type { SettingsSection } from '@chatdsh/core-contracts';

/** 跨设备同步的命名空间。 */
export const SYNC_NAMESPACES = [
  'agent-default-model',
  'client-locale',
  'client-ui-chat',
  'client-product-analytics',
  'agent-preset-registry',
] as const;

/** 跨设备同步的命名空间取值。 */
export type SyncNamespace = typeof SYNC_NAMESPACES[number];

/** 每个同步命名空间参与同步的字段。 */
export const SYNC_FIELDS: Record<SyncNamespace, readonly string[]> = {
  'agent-default-model': ['provider', 'model', 'reasoningEffort'],
  'client-locale': ['language'],
  'client-ui-chat': ['transcriptView', 'collapseTiming'],
  'client-product-analytics': ['enabled'],
  'agent-preset-registry': ['selectedDefault'],
};

/** 设备范围的字段：路径、超时、电源与平台配置。 */
export const DEVICE_FIELDS: Record<string, readonly string[]> = {
  'bash-local': ['cwd', 'timeoutMs', 'maxTimeoutMs', 'maxOutputBytes', 'maxSpillBytes', 'graceMs'],
  'spill-policy': ['maxInlineTokens'],
  'chatdsh-mobile-gateway': ['deviceFile', 'gatewayStateFile', 'path'],
};

/** 字段名里出现即按设备范围处理的关键词，覆盖尚未进入登记表的路径、超时、电源与平台字段。 */
export const DEVICE_FIELD_KEYWORDS = ['path', 'cwd', 'power', 'timeout', 'platform', 'tray', 'sandbox'];

/** 每个同步命名空间对应的设置区段。 */
const SECTIONS: Record<SyncNamespace, SettingsSection> = {
  'agent-default-model': 'models',
  'client-locale': 'general',
  'client-ui-chat': 'general',
  'client-product-analytics': 'general',
  'agent-preset-registry': 'assistants',
};

/** 判定一个命名空间是否参与跨设备同步。 */
export function isSyncNamespace(namespace: string): namespace is SyncNamespace {
  return (SYNC_NAMESPACES as readonly string[]).includes(namespace);
}

/** 判定一个字段是否属于设备范围。 */
export function isDeviceField(namespace: string, field: string): boolean {
  const listed = DEVICE_FIELDS[namespace];
  if (listed !== undefined && listed.includes(field)) return true;
  const lower = field.toLowerCase();
  return DEVICE_FIELD_KEYWORDS.some((keyword) => lower.includes(keyword));
}

/** 判定一个字段是否参与跨设备同步。 */
export function isSyncField(namespace: string, field: string): boolean {
  if (!isSyncNamespace(namespace)) return false;
  if (!SYNC_FIELDS[namespace].includes(field)) return false;
  return !isDeviceField(namespace, field);
}

/** 一个命名空间的作用范围。 */
export function scopeOfNamespace(namespace: string): 'client' | 'device' {
  return isSyncNamespace(namespace) ? 'client' : 'device';
}

/** 一个字段的作用范围。 */
export function scopeOfField(namespace: string, field: string): 'client' | 'device' {
  return isSyncField(namespace, field) ? 'client' : 'device';
}

/** 一个命名空间对应的设置区段。 */
export function sectionOf(namespace: string): SettingsSection {
  return isSyncNamespace(namespace) ? SECTIONS[namespace] : 'general';
}

/** 一个命名空间的字段清单，含作用范围与是否参与同步。 */
export function fieldsOfNamespace(namespace: string): { field: string; scope: 'client' | 'device'; synced: boolean }[] {
  const names = new Set<string>();
  if (isSyncNamespace(namespace)) for (const field of SYNC_FIELDS[namespace]) names.add(field);
  for (const field of DEVICE_FIELDS[namespace] ?? []) names.add(field);
  return [...names].map((field) => ({
    field,
    scope: scopeOfField(namespace, field),
    synced: isSyncField(namespace, field),
  }));
}
