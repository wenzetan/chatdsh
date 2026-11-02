/**
 * 设置服务的数据入口与字段目录。
 *
 * 读数来自宿主设置服务的描述接口，作用范围来自设置同步插件的白名单表；写入带读到的版本，
 * 版本落后时宿主按 `settings/conflict` 拒绝，界面据此按字段给出服务器当前值。字段目录是
 * 本页维护的显示清单：每个字段的名字、类型、范围与可选项在这里声明，取值一律来自宿主读数。
 * @module @chatdsh/host-settings-enhancements/settings
 */

import { ENHANCEMENT_FIELDS, NAMESPACE_ID } from '../shared.ts';
import { readJson, SETTINGS_SCOPES_PATH, SETTINGS_SYNC_PATH } from './transport.ts';
import {
  SettingsCallError,
  type FieldSpec,
  type NamespaceReading,
  type NamespaceScope,
  type SettingsDocument,
  type SettingsGateway,
  type SettingsLoad,
  type SyncStatus,
} from './types.ts';

/** 读取作用范围与同步状态的依赖。 */
export interface SettingsGatewayOptions {
  /** 同源 Remote 调用器。 */
  readonly caller: { call<T>(endpoint: string, args: Readonly<Record<string, unknown>>): Promise<T> };
  /** 发请求的实现。 */
  readonly fetchImpl?: typeof fetch;
}

/** 判一个取值是普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 读一个必填字符串字段。 */
function requiredString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') throw new SettingsCallError('gateway/internal', `${what} 缺少字符串取值`);
  return value;
}

/** 解析设置服务的描述应答。 */
function documentOf(value: unknown): SettingsDocument {
  if (!isRecord(value) || !Array.isArray(value.namespaces)) {
    throw new SettingsCallError('gateway/internal', '设置描述的返回形状不符合约定');
  }
  const namespaces: NamespaceReading[] = value.namespaces.map((entry: unknown) => {
    if (!isRecord(entry)) throw new SettingsCallError('gateway/internal', '设置命名空间的返回形状不符合约定');
    const reading: NamespaceReading = {
      ns: requiredString(entry.ns, '设置命名空间'),
      value: isRecord(entry.value) ? entry.value : {},
      revision: typeof entry.revision === 'number' ? entry.revision : 0,
      ...(isRecord(entry.user) ? { user: entry.user } : {}),
      ...(typeof entry.writable === 'boolean' ? { writable: entry.writable } : {}),
    };
    return reading;
  });
  return { namespaces, writable: value.writable === true };
}

/** 解析作用范围应答。 */
function scopesOf(value: unknown): NamespaceScope[] {
  if (!isRecord(value) || !Array.isArray(value.namespaces)) {
    throw new SettingsCallError('gateway/internal', '作用范围的返回形状不符合约定');
  }
  return value.namespaces.map((entry: unknown) => {
    if (!isRecord(entry)) throw new SettingsCallError('gateway/internal', '作用范围条目形状不符合约定');
    const fields = Array.isArray(entry.fields) ? entry.fields : [];
    return {
      namespace: requiredString(entry.namespace, '作用范围命名空间'),
      scope: entry.scope === 'client' ? 'client' : 'device',
      fields: fields.map((field: unknown) => {
        if (!isRecord(field)) throw new SettingsCallError('gateway/internal', '作用范围字段形状不符合约定');
        return {
          field: requiredString(field.field, '作用范围字段'),
          scope: field.scope === 'client' ? 'client' : 'device',
          synced: field.synced === true,
        };
      }),
    };
  });
}

/** 解析同步状态应答。 */
function syncOf(value: unknown): SyncStatus {
  if (!isRecord(value) || !isRecord(value.whitelist)) {
    throw new SettingsCallError('gateway/internal', '同步状态的返回形状不符合约定');
  }
  const whitelist = value.whitelist;
  const filtered = isRecord(value.filtered) ? value.filtered : {};
  return {
    deviceId: typeof value.deviceId === 'string' ? value.deviceId : 'local',
    whitelist: {
      namespaces: Array.isArray(whitelist.namespaces) ? whitelist.namespaces.map((item) => String(item)) : [],
      fields: isRecord(whitelist.fields) ? whitelist.fields as Record<string, readonly string[]> : {},
      deviceFields: isRecord(whitelist.deviceFields) ? whitelist.deviceFields as Record<string, readonly string[]> : {},
    },
    namespaces: isRecord(value.namespaces) ? value.namespaces : {},
    devices: Array.isArray(value.devices)
      ? value.devices.filter(isRecord).map((device) => ({
        deviceId: String(device.deviceId ?? device.id ?? ''),
        name: String(device.name ?? device.deviceId ?? ''),
        online: device.online === true,
      }))
      : [],
    filtered: {
      total: typeof filtered.total === 'number' ? filtered.total : 0,
      byNamespace: isRecord(filtered.byNamespace) ? filtered.byNamespace as Record<string, number> : {},
      at: typeof filtered.at === 'number' ? filtered.at : 0,
    },
  };
}

/**
 * 建立设置入口。
 * @param options - 调用器与请求实现。
 * @returns 设置入口。
 */
export function createSettingsGateway(options: SettingsGatewayOptions): SettingsGateway {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  return {
    async load(): Promise<SettingsLoad> {
      const document = documentOf(await options.caller.call<unknown>('settings/describe', {}));
      const scopes = scopesOf(await readJson(SETTINGS_SCOPES_PATH, fetchImpl));
      const sync = syncOf(await readJson(SETTINGS_SYNC_PATH, fetchImpl));
      return { document, scopes, sync };
    },

    async update(ns: string, patch: Record<string, unknown>, expectedRevision: number): Promise<NamespaceReading> {
      const value = await options.caller.call<unknown>('settings/update', { ns, patch, expectedRevision });
      if (!isRecord(value)) throw new SettingsCallError('gateway/internal', '设置写入的返回形状不符合约定');
      return {
        ns: requiredString(value.ns, '写入结果命名空间'),
        value: isRecord(value.value) ? value.value : {},
        revision: typeof value.revision === 'number' ? value.revision : expectedRevision + 1,
      };
    },
  };
}

/** 通用区段的字段目录。 */
export const GENERAL_FIELDS: readonly FieldSpec[] = [
  {
    key: `locale.preference`,
    ns: 'locale',
    field: 'preference',
    label: '界面语言',
    kind: 'select',
    options: [
      { value: 'zh-CN', label: '简体中文' },
      { value: 'en', label: 'English' },
    ],
    help: '语言偏好随白名单同步到其他设备。',
  },
  {
    key: 'ui-theme.preference',
    ns: 'ui-theme',
    field: 'preference',
    label: '主题',
    kind: 'select',
    options: [
      { value: 'system', label: '跟随系统' },
      { value: 'light', label: '亮色' },
      { value: 'dark', label: '暗色' },
    ],
    help: '主题切换只替换令牌，不重建会话。',
  },
  {
    key: 'ui-theme.fontSize',
    ns: 'ui-theme',
    field: 'fontSize',
    label: '正文字号',
    kind: 'number',
    min: 10,
    max: 22,
    unit: '像素',
  },
  {
    key: 'ui-theme.codeFontSize',
    ns: 'ui-theme',
    field: 'codeFontSize',
    label: '代码字号',
    kind: 'number',
    min: 10,
    max: 16,
    unit: '像素',
  },
  {
    key: 'ui-theme.terminalFontSize',
    ns: 'ui-theme',
    field: 'terminalFontSize',
    label: '终端字号',
    kind: 'number',
    min: 10,
    max: 20,
    unit: '像素',
  },
  {
    key: `${NAMESPACE_ID}.${ENHANCEMENT_FIELDS.motion}`,
    ns: NAMESPACE_ID,
    field: ENHANCEMENT_FIELDS.motion,
    label: '动效偏好',
    kind: 'select',
    options: [
      { value: 'system', label: '跟随系统' },
      { value: 'reduced', label: '减少动效' },
      { value: 'full', label: '完整动效' },
    ],
    help: '设备范围，不同步；减少动效时界面过渡与骨架动画停止。',
    deviceOnly: true,
  },
  {
    key: 'ui-chat.transcriptView',
    ns: 'ui-chat',
    field: 'transcriptView',
    label: '消息视图',
    kind: 'select',
    options: [
      { value: 'standard', label: '标准' },
      { value: 'detailed', label: '详细' },
      { value: 'compact', label: '紧凑' },
      { value: 'verbose', label: '完整' },
    ],
  },
  {
    key: 'ui-chat.collapseTiming',
    ns: 'ui-chat',
    field: 'collapseTiming',
    label: '折叠时间信息',
    kind: 'select',
    options: [
      { value: 'completion', label: '回合完成后折叠' },
      { value: 'next-input', label: '下一次输入时折叠' },
    ],
  },
  {
    key: 'ui-chat.linkOpening',
    ns: 'ui-chat',
    field: 'linkOpening',
    label: '外部打开策略',
    kind: 'select',
    options: [
      { value: 'sidebar', label: '侧栏打开' },
      { value: 'new-tab', label: '新标签页打开' },
    ],
  },
  {
    key: 'ui-conversation.busyEnter',
    ns: 'ui-conversation',
    field: 'busyEnter',
    label: '忙碌时回车',
    kind: 'select',
    options: [
      { value: 'queue', label: '排队发送' },
      { value: 'steer', label: '插入当前回合' },
    ],
  },
  {
    key: `${NAMESPACE_ID}.${ENHANCEMENT_FIELDS.shortcutSend}`,
    ns: NAMESPACE_ID,
    field: ENHANCEMENT_FIELDS.shortcutSend,
    label: '发送消息',
    kind: 'shortcut',
    help: '录入时不执行任何命令；与已有快捷键或系统保留键冲突时拒绝录入。',
    deviceOnly: true,
  },
  {
    key: `${NAMESPACE_ID}.${ENHANCEMENT_FIELDS.shortcutNewline}`,
    ns: NAMESPACE_ID,
    field: ENHANCEMENT_FIELDS.shortcutNewline,
    label: '消息换行',
    kind: 'shortcut',
    deviceOnly: true,
  },
  {
    key: `${NAMESPACE_ID}.${ENHANCEMENT_FIELDS.shortcutCommand}`,
    ns: NAMESPACE_ID,
    field: ENHANCEMENT_FIELDS.shortcutCommand,
    label: '命令搜索',
    kind: 'shortcut',
    deviceOnly: true,
  },
];

/** 运行区段的字段目录。 */
export const RUNTIME_FIELDS: readonly FieldSpec[] = [
  {
    key: `${NAMESPACE_ID}.${ENHANCEMENT_FIELDS.shellProgram}`,
    ns: NAMESPACE_ID,
    field: ENHANCEMENT_FIELDS.shellProgram,
    label: '终端程序路径',
    kind: 'path',
    help: '设备范围，不同步；按本机绝对路径保存，不拼接任何脚本。',
    deviceOnly: true,
  },
  {
    key: `${NAMESPACE_ID}.${ENHANCEMENT_FIELDS.shellArgs}`,
    ns: NAMESPACE_ID,
    field: ENHANCEMENT_FIELDS.shellArgs,
    label: '终端程序参数',
    kind: 'list',
    help: '逗号分隔的参数表，与程序路径分开保存。',
    deviceOnly: true,
  },
  {
    key: `${NAMESPACE_ID}.${ENHANCEMENT_FIELDS.editorProgram}`,
    ns: NAMESPACE_ID,
    field: ENHANCEMENT_FIELDS.editorProgram,
    label: '编辑器程序路径',
    kind: 'path',
    deviceOnly: true,
  },
  {
    key: `${NAMESPACE_ID}.${ENHANCEMENT_FIELDS.fileManagerProgram}`,
    ns: NAMESPACE_ID,
    field: ENHANCEMENT_FIELDS.fileManagerProgram,
    label: '文件管理器程序路径',
    kind: 'path',
    deviceOnly: true,
  },
  {
    key: 'agent-loop.maxParallelToolCalls',
    ns: 'agent-loop',
    field: 'maxParallelToolCalls',
    label: '并行工具调用上限',
    kind: 'number',
    min: 1,
    unit: '个',
    help: '范围以宿主 schema 为准，保存时由宿主校验。',
  },
  {
    key: 'subagent.maxDepth',
    ns: 'subagent',
    field: 'maxDepth',
    label: '子代理层级上限',
    kind: 'number',
    min: 0,
    unit: '层',
  },
  {
    key: 'subagent.maxActiveSubagents',
    ns: 'subagent',
    field: 'maxActiveSubagents',
    label: '同时运行的子代理上限',
    kind: 'number',
    min: 1,
    unit: '个',
  },
  {
    key: 'web.searchProvider',
    ns: 'web',
    field: 'searchProvider',
    label: '检索提供方',
    kind: 'text',
    help: '留空表示关闭网页检索；连通性由宿主在发送时探测。',
  },
  {
    key: 'web.fetchProvider',
    ns: 'web',
    field: 'fetchProvider',
    label: '网页抓取提供方',
    kind: 'text',
  },
  {
    key: 'session-log-deepseek.enabled',
    ns: 'session-log-deepseek',
    field: 'enabled',
    label: '记录会话日志',
    kind: 'boolean',
    help: '日志级别由宿主固定，这里只提供开关。',
  },
  {
    key: 'bash-sandbox.cwd',
    ns: 'bash-sandbox',
    field: 'cwd',
    label: '命令默认工作目录',
    kind: 'path',
    help: '设备范围，不同步。',
    deviceOnly: true,
  },
  {
    key: 'bash-sandbox.timeoutMs',
    ns: 'bash-sandbox',
    field: 'timeoutMs',
    label: '命令超时',
    kind: 'number',
    min: 1000,
    unit: '毫秒',
    help: '设备范围，不同步。',
    deviceOnly: true,
  },
  {
    key: 'bash-sandbox.maxOutputBytes',
    ns: 'bash-sandbox',
    field: 'maxOutputBytes',
    label: '单流输出上限',
    kind: 'number',
    min: 1024,
    unit: '字节',
    deviceOnly: true,
  },
];

/** 读一个命名空间的读数。 */
export function readingOf(load: SettingsLoad, ns: string): NamespaceReading | undefined {
  return load.document.namespaces.find((entry) => entry.ns === ns);
}

/**
 * 读一个字段的生效值。
 * @param value - 命名空间的生效值。
 * @param field - 字段路径。
 * @returns 取值；不存在时为空。
 */
export function readFieldValue(value: Record<string, unknown>, field: string): unknown {
  let current: unknown = value;
  for (const part of field.split('.')) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

/**
 * 把取值转成输入框里的文本。
 * @param value - 取值。
 * @returns 文本；没有取值时为空串。
 */
export function textOfValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map((item) => String(item)).join(', ');
  return String(value);
}

/** 一次输入校验的结论。 */
export type DraftCheck =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string };

/**
 * 校验并转换一次输入。
 * @param spec - 字段。
 * @param draft - 输入框文本。
 * @returns 转换后的取值或错误说明。
 */
export function checkDraft(spec: FieldSpec, draft: string): DraftCheck {
  if (spec.kind === 'number') {
    const text = draft.trim();
    if (text === '') return { ok: false, message: `${spec.label} 需要一个整数` };
    const value = Number(text);
    if (!Number.isInteger(value)) return { ok: false, message: `${spec.label} 需要一个整数` };
    if (spec.min !== undefined && value < spec.min) return { ok: false, message: `${spec.label} 不能小于 ${String(spec.min)}` };
    if (spec.max !== undefined && value > spec.max) return { ok: false, message: `${spec.label} 不能大于 ${String(spec.max)}` };
    return { ok: true, value };
  }
  if (spec.kind === 'boolean') {
    if (draft !== 'true' && draft !== 'false') return { ok: false, message: `${spec.label} 只能是开或关` };
    return { ok: true, value: draft === 'true' };
  }
  if (spec.kind === 'list') {
    const items = draft.split(',').map((item) => item.trim()).filter((item) => item !== '');
    return { ok: true, value: items };
  }
  if (spec.kind === 'select' && spec.options !== undefined) {
    if (!spec.options.some((option) => option.value === draft)) {
      return { ok: false, message: `${spec.label} 的取值不在允许范围内` };
    }
    return { ok: true, value: draft };
  }
  if (spec.kind === 'path' && draft.trim() !== '' && !draft.startsWith('/')) {
    return { ok: false, message: `${spec.label} 需要本机绝对路径` };
  }
  return { ok: true, value: draft };
}

/**
 * 把一次输入的取值写进补丁对象。
 * @param target - 补丁对象。
 * @param field - 字段路径。
 * @param value - 取值。
 */
export function assignPatch(target: Record<string, unknown>, field: string, value: unknown): void {
  const parts = field.split('.');
  let current = target;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (!isRecord(next)) current[part] = {};
    current = current[part] as Record<string, unknown>;
  }
  const last = parts.at(-1);
  if (last === undefined) throw new Error('字段路径不能为空');
  current[last] = value;
}

/**
 * 由当前生效值与改动字段拼出写入补丁。
 * @param current - 命名空间的生效值。
 * @param changes - 字段路径与取值。
 * @returns 写入补丁。
 */
export function patchOf(current: Record<string, unknown>, changes: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(changes)) {
    const parts = field.split('.');
    if (parts.length === 1) {
      patch[field] = value;
      continue;
    }
    const root = parts[0];
    if (root === undefined) continue;
    if (!isRecord(patch[root])) {
      const source = current[root];
      patch[root] = isRecord(source) ? { ...source } : {};
    }
    assignPatch(patch[root] as Record<string, unknown>, parts.slice(1).join('.'), value);
  }
  return patch;
}

/**
 * 取一个字段的作用范围。
 * @param load - 一次读数。
 * @param spec - 字段。
 * @returns 作用范围与是否同步。
 */
export function scopeOfField(load: SettingsLoad, spec: FieldSpec): { scope: 'client' | 'device'; synced: boolean } {
  const namespace = load.scopes.find((entry) => entry.namespace === spec.ns);
  const field = namespace?.fields.find((entry) => entry.field === spec.field);
  if (field !== undefined) return { scope: field.scope, synced: field.synced };
  if (spec.deviceOnly === true) return { scope: 'device', synced: false };
  const whitelist = load.sync.whitelist.fields[spec.ns];
  if (whitelist !== undefined && whitelist.includes(spec.field)) return { scope: 'client', synced: true };
  return { scope: 'device', synced: false };
}

/**
 * 说明为什么一个命名空间写不进去。
 * @param load - 一次读数。
 * @param ns - 命名空间。
 * @returns 说明；可以写入时为空。
 */
export function readOnlyReason(load: SettingsLoad, ns: string): string | undefined {
  if (!load.document.writable) return '宿主设置文档是只读的，不能写入';
  const reading = readingOf(load, ns);
  if (reading === undefined) return `宿主设置服务没有提供命名空间 ${ns}`;
  if (reading.writable === false) return `命名空间 ${ns} 在本部署里不接受写入`;
  return undefined;
}
