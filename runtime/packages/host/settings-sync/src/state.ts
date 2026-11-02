/**
 * 同步记录的持久化与合并。
 *
 * 每台设备在 `$DSH_HOME/settings-sync/state.json` 里保存白名单设置的当前值、每个命名空间的
 * 表单版本与最近一次控制平面接收时刻。合并按控制平面接收时刻进行：只有更新的记录才覆盖
 * 本机记录，同一时刻以到达的一方为准。写入先写同目录临时文件再原子替换，进程崩溃不会留下
 * 半个文件。
 * @module @chatdsh/host-settings-sync/state
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 记录目录。 */
export const STATE_DIRECTORY = 'settings-sync';

/** 记录文件名。 */
export const STATE_FILE = 'state.json';

/** 一条字段记录的来源。 */
export type FieldSource = 'device' | 'control-plane';

/** 一条字段记录。 */
export interface FieldRecord {
  /** 当前值。 */
  readonly value: unknown;
  /** 控制平面接收时刻，本机写入时为控制平面应答里的接收时刻。 */
  readonly updatedAt: number;
  /** 值由本设备写入还是由控制平面下发。 */
  readonly source: FieldSource;
}

/** 一个命名空间的记录。 */
export interface NamespaceRecord {
  /** 表单版本，每次被采纳的写入加一。 */
  revision: number;
  /** 最近一次变更的时刻。 */
  updatedAt: number;
  /** 字段记录。 */
  fields: Record<string, FieldRecord>;
}

/** 控制平面登记的一台设备。 */
export interface DeviceRecord {
  /** 设备标识。 */
  deviceId: string;
  /** 设备名称。 */
  name: string;
  /** 平台。 */
  platform: string;
  /** 是否在线。 */
  online: boolean;
}

/** 被过滤字段的统计。 */
export interface FilteredRecord {
  /** 被过滤的字段总数。 */
  total: number;
  /** 按命名空间分开的字段数。 */
  byNamespace: Record<string, number>;
  /** 统计时刻。 */
  at: number;
}

/** 一份同步记录。 */
export interface SyncState {
  /** 格式版本。 */
  version: 1;
  /** 本设备标识。 */
  deviceId: string;
  /** 按命名空间分组的记录。 */
  namespaces: Record<string, NamespaceRecord>;
  /** 控制平面登记的设备，供作用设备列表使用。 */
  devices: DeviceRecord[];
  /** 设备列表的读取时刻。 */
  devicesAt: number;
  /** 被过滤字段的统计。 */
  filtered: FilteredRecord;
}

/** 把取值转成可比较的文本；`undefined` 单独表示，避免与 `null` 混淆。 */
export function textOf(value: unknown): string {
  return value === undefined ? '\u0000undefined' : JSON.stringify(value);
}

/** 两个取值是否相等。 */
export function sameValue(left: unknown, right: unknown): boolean {
  return textOf(left) === textOf(right);
}

/**
 * 判断一条记录是否会被合并采纳。
 *
 * 接收时刻更晚的记录覆盖旧记录；时刻相同且取值相同时不必再写；时刻相同而取值不同时以
 * 到达的一方为准，这就是「最后写入者胜」。
 * @param current - 现有记录。
 * @param incoming - 待合并的记录。
 */
export function adopts(current: FieldRecord | undefined, incoming: FieldRecord): boolean {
  if (current === undefined) return true;
  if (incoming.updatedAt < current.updatedAt) return false;
  if (incoming.updatedAt === current.updatedAt && sameValue(current.value, incoming.value)) return false;
  return true;
}

/** 读一份空的同步记录。 */
function emptyState(deviceId: string): SyncState {
  return {
    version: 1,
    deviceId,
    namespaces: {},
    devices: [],
    devicesAt: 0,
    filtered: { total: 0, byNamespace: {}, at: 0 },
  };
}

/** 校验一个从磁盘读出的取值，形状不符时就地失败。 */
function assertState(value: unknown, path: string): SyncState {
  if (typeof value !== 'object' || value === null) throw new Error(`同步记录不是对象：${path}`);
  const candidate = value as Partial<SyncState>;
  if (candidate.version !== 1) throw new Error(`同步记录版本不符：${path}`);
  if (typeof candidate.deviceId !== 'string') throw new Error(`同步记录缺少设备标识：${path}`);
  if (typeof candidate.namespaces !== 'object' || candidate.namespaces === null) throw new Error(`同步记录缺少命名空间：${path}`);
  for (const [namespace, record] of Object.entries(candidate.namespaces)) {
    if (typeof record !== 'object' || record === null) throw new Error(`同步记录的命名空间 ${namespace} 不是对象：${path}`);
    if (!Number.isInteger(record.revision) || record.revision < 0) throw new Error(`同步记录的命名空间 ${namespace} 版本非法：${path}`);
    if (!Number.isInteger(record.updatedAt) || record.updatedAt < 0) throw new Error(`同步记录的命名空间 ${namespace} 时刻非法：${path}`);
    if (typeof record.fields !== 'object' || record.fields === null) throw new Error(`同步记录的命名空间 ${namespace} 缺少字段：${path}`);
    for (const [field, entry] of Object.entries(record.fields)) {
      if (typeof entry !== 'object' || entry === null) throw new Error(`同步记录的字段 ${namespace}.${field} 不是对象：${path}`);
      if (!Number.isInteger(entry.updatedAt) || entry.updatedAt < 0) throw new Error(`同步记录的字段 ${namespace}.${field} 时刻非法：${path}`);
      if (entry.source !== 'device' && entry.source !== 'control-plane') throw new Error(`同步记录的字段 ${namespace}.${field} 来源非法：${path}`);
    }
  }
  if (!Array.isArray(candidate.devices)) throw new Error(`同步记录缺少设备列表：${path}`);
  if (typeof candidate.filtered !== 'object' || candidate.filtered === null) throw new Error(`同步记录缺少过滤统计：${path}`);
  return {
    version: 1,
    deviceId: candidate.deviceId,
    namespaces: candidate.namespaces,
    devices: candidate.devices,
    devicesAt: typeof candidate.devicesAt === 'number' ? candidate.devicesAt : 0,
    filtered: {
      total: typeof candidate.filtered.total === 'number' ? candidate.filtered.total : 0,
      byNamespace: candidate.filtered.byNamespace ?? {},
      at: typeof candidate.filtered.at === 'number' ? candidate.filtered.at : 0,
    },
  };
}

/**
 * 同步记录的读写与合并。
 *
 * 同一个运行时进程内由调用方串行调用，磁盘上的文件是唯一权威。
 */
export class SettingsSyncStore {
  /** 记录文件路径。 */
  readonly path: string;

  /**
   * @param homeRoot - 数据根。
   * @param deviceId - 本设备标识。
   */
  constructor(homeRoot: string, private readonly deviceId: string) {
    this.path = join(homeRoot, STATE_DIRECTORY, STATE_FILE);
  }

  /** 读同步记录；文件不存在时给出空记录。 */
  load(): SyncState {
    if (!existsSync(this.path)) return emptyState(this.deviceId);
    const text = readFileSync(this.path, 'utf8');
    if (text.trim() === '') return emptyState(this.deviceId);
    return assertState(JSON.parse(text) as unknown, this.path);
  }

  /** 原子写入同步记录。 */
  save(state: SyncState): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.path);
  }

  /** 取一个命名空间的记录，没有时建立空记录。 */
  namespaceOf(state: SyncState, namespace: string): NamespaceRecord {
    const existing = state.namespaces[namespace];
    if (existing !== undefined) return existing;
    const created: NamespaceRecord = { revision: 0, updatedAt: 0, fields: {} };
    state.namespaces[namespace] = created;
    return created;
  }

  /**
   * 合并若干字段记录。
   *
   * 每个字段按接收时刻比较：更新的记录覆盖旧记录；同一时刻取值不同时以到达的一方为准。
   * 有字段被采纳时命名空间版本加一，避免同一轮多字段合并把版本推高多次。
   * @param state - 同步记录。
   * @param namespace - 命名空间。
   * @param incoming - 待合并的字段记录。
   * @returns 被采纳的字段名。
   */
  merge(state: SyncState, namespace: string, incoming: Record<string, FieldRecord>): string[] {
    const record = this.namespaceOf(state, namespace);
    const applied: string[] = [];
    let newest = record.updatedAt;
    for (const [field, entry] of Object.entries(incoming)) {
      const current = record.fields[field];
      if (!adopts(current, entry)) continue;
      record.fields[field] = entry;
      applied.push(field);
      if (entry.updatedAt > newest) newest = entry.updatedAt;
    }
    if (applied.length === 0) return applied;
    record.revision += 1;
    record.updatedAt = newest;
    return applied;
  }
}
