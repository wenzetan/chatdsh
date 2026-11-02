/**
 * 设置表单的版本、来源与冲突。
 *
 * 表单读数给出每个字段的有效值、来源（设备、控制平面、默认）、作用范围与作用设备；写入
 * 携带读到的版本，版本落后时拒绝并返回最新版本与当前值。同步状态的版本保存在
 * `SettingsSyncStore` 里，跨设备写入被采纳时版本加一，另一台设备的下一次提交因此被拒。
 * @module @chatdsh/host-settings-sync/form
 */

import {
  settingsConflictSchema,
  settingsWriteResultSchema,
  type SettingsConflict,
  type SettingsSection,
} from '@chatdsh/core-contracts';
import { isSyncField, isSyncNamespace, scopeOfField, sectionOf, SYNC_FIELDS } from './scope.ts';
import type { FieldRecord, SettingsSyncStore, SyncState } from './state.ts';

/** 设置服务的读取面：命名空间、生效值与被用户改过的字段。 */
export interface SettingsDescriptorView {
  /** 命名空间。 */
  readonly ns: string;
  /** 生效值。 */
  readonly value: unknown;
  /** 用户层，字段出现在这里表示本设备改过。 */
  readonly user?: unknown;
  /** 设置服务自己的版本。 */
  readonly revision?: number;
}

/** 表单依赖。 */
export interface SettingsFormDependencies {
  /** 同步记录。 */
  readonly store: SettingsSyncStore;
  /** 本设备标识。 */
  readonly deviceId: string;
  /** 设置服务的描述；未挂载时返回空数组。 */
  describe(): readonly SettingsDescriptorView[];
  /** home 层里一个命名空间已经写好的字段；home 层承载控制平面同步来的取值。 */
  homeFields(namespace: string): Record<string, unknown>;
}

/** 字段来源。 */
export type FieldOrigin = 'device' | 'control-plane' | 'default';

/** 一个字段的表单读数。 */
export interface SettingsFieldView {
  /** 字段名。 */
  readonly field: string;
  /** 有效值。 */
  readonly value: unknown;
  /** 来源。 */
  readonly source: FieldOrigin;
  /** 作用范围。 */
  readonly scope: 'client' | 'device';
  /** 是否参与跨设备同步。 */
  readonly synced: boolean;
}

/** 一份表单读数。 */
export interface SettingsFormView {
  /** 命名空间。 */
  readonly namespace: string;
  /** 设置区段。 */
  readonly section: SettingsSection;
  /** 命名空间的作用范围。 */
  readonly scope: 'client' | 'device';
  /** 当前版本。 */
  readonly revision: number;
  /** 最近一次变更时刻。 */
  readonly updatedAt: number;
  /** 本设备标识。 */
  readonly deviceId: string;
  /** 作用设备列表。 */
  readonly devices: readonly { deviceId: string; name: string; platform: string; online: boolean }[];
  /** 字段读数。 */
  readonly fields: readonly SettingsFieldView[];
  /** 这个命名空间里被过滤掉的字段数。 */
  readonly filteredCount: number;
}

/** 一次写入校验的结论。 */
export type SettingsWriteCheck =
  | { readonly ok: true; readonly fields: Record<string, unknown> }
  | { readonly ok: false; readonly status: number; readonly body: Record<string, unknown> };

/** 取一个取值对象的字段表；非对象时返回空表。 */
function fieldsOfValue(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/** 判定取值对象里是否有这个字段。 */
function hasField(value: Record<string, unknown>, field: string): boolean {
  return Object.hasOwn(value, field);
}

/** 生成一次拒绝的应答体，形状与设置写入结果契约一致。 */
function rejectedBody(code: 'request-invalid' | 'permission-denied', fields?: string[]): Record<string, unknown> {
  const parsed = settingsWriteResultSchema.parse({
    outcome: 'rejected',
    code,
    ...(fields === undefined ? {} : { fields }),
  });
  return { ...parsed };
}

/**
 * 表单读数、写入校验与冲突视图。
 */
export class SettingsForm {
  constructor(private readonly dependencies: SettingsFormDependencies) {}

  /** 设置服务里这个命名空间的描述。 */
  private descriptorOf(namespace: string): SettingsDescriptorView | undefined {
    return this.dependencies.describe().find((entry) => entry.ns === namespace);
  }

  /** 字段的有效值：已同步的值优先，其次是 home 层写入的值，最后是设置服务给出的生效值。 */
  private valueOf(state: SyncState, namespace: string, field: string, descriptor: SettingsDescriptorView | undefined): unknown {
    const entry = state.namespaces[namespace]?.fields[field];
    if (entry !== undefined) return entry.value;
    const home = this.dependencies.homeFields(namespace);
    if (hasField(home, field)) return home[field];
    const effective = fieldsOfValue(descriptor?.value);
    return hasField(effective, field) ? effective[field] : undefined;
  }

  /** 字段的来源。 */
  private sourceOf(state: SyncState, namespace: string, field: string, descriptor: SettingsDescriptorView | undefined): FieldOrigin {
    const entry = state.namespaces[namespace]?.fields[field];
    if (entry !== undefined) return entry.source;
    if (hasField(this.dependencies.homeFields(namespace), field)) return 'control-plane';
    if (descriptor !== undefined && hasField(fieldsOfValue(descriptor.user), field)) return 'device';
    return 'default';
  }

  /** 一个命名空间的同步字段名。 */
  private syncFieldNames(state: SyncState, namespace: keyof typeof SYNC_FIELDS, descriptor: SettingsDescriptorView | undefined): string[] {
    const names = new Set<string>();
    for (const field of SYNC_FIELDS[namespace]) {
      if (isSyncField(namespace, field)) names.add(field);
    }
    for (const field of Object.keys(fieldsOfValue(descriptor?.value))) {
      if (isSyncField(namespace, field)) names.add(field);
    }
    for (const field of Object.keys(state.namespaces[namespace]?.fields ?? {})) {
      if (isSyncField(namespace, field)) names.add(field);
    }
    return [...names];
  }

  /** 生成一份表单读数；命名空间既不在白名单里也没有设置服务描述时返回 undefined。 */
  read(state: SyncState, namespace: string): SettingsFormView | undefined {
    const descriptor = this.descriptorOf(namespace);
    const synced = isSyncNamespace(namespace);
    if (!synced && descriptor === undefined) return undefined;
    const fields: SettingsFieldView[] = [];
    if (synced) {
      for (const field of this.syncFieldNames(state, namespace, descriptor)) {
        fields.push({
          field,
          value: this.valueOf(state, namespace, field, descriptor),
          source: this.sourceOf(state, namespace, field, descriptor),
          scope: 'client',
          synced: true,
        });
      }
    } else {
      for (const [field, value] of Object.entries(fieldsOfValue(descriptor?.value))) {
        fields.push({
          field,
          value,
          source: this.sourceOf(state, namespace, field, descriptor),
          scope: scopeOfField(namespace, field),
          synced: false,
        });
      }
    }
    const record = state.namespaces[namespace];
    const devices = synced && state.devices.length > 0
      ? state.devices
      : [{ deviceId: this.dependencies.deviceId, name: this.dependencies.deviceId, platform: 'unknown', online: true }];
    return {
      namespace,
      section: sectionOf(namespace),
      scope: synced ? 'client' : 'device',
      revision: record?.revision ?? 0,
      updatedAt: record?.updatedAt ?? 0,
      deviceId: this.dependencies.deviceId,
      devices,
      fields,
      filteredCount: state.filtered.byNamespace[namespace] ?? 0,
    };
  }

  /** 读一个命名空间的最新版本与全部同步字段取值。 */
  latest(state: SyncState, namespace: string): { namespace: string; revision: number; updatedAt: number; values: Record<string, unknown> } | undefined {
    const view = this.read(state, namespace);
    if (view === undefined) return undefined;
    const values: Record<string, unknown> = {};
    for (const field of view.fields) if (field.synced) values[field.field] = field.value;
    return { namespace, revision: view.revision, updatedAt: view.updatedAt, values };
  }

  /** 冲突视图：逐字段给出用户编辑值与服务端当前值。 */
  conflictOf(state: SyncState, namespace: string, fields: Record<string, unknown>): SettingsConflict {
    const descriptor = this.descriptorOf(namespace);
    const record = state.namespaces[namespace];
    return settingsConflictSchema.parse({
      section: sectionOf(namespace),
      scope: 'client',
      changedAt: record?.updatedAt ?? 0,
      currentRevision: record?.revision ?? 0,
      fields: Object.keys(fields).map((field) => ({
        field,
        sensitive: false,
        userValue: fields[field],
        serverValue: this.valueOf(state, namespace, field, descriptor),
      })),
    });
  }

  /**
   * 校验一次写入。
   *
   * 只接受白名单命名空间的白名单字段；携带的版本落后时返回冲突，冲突体里给出最新版本与
   * 当前值。校验失败与作用范围拒绝不写任何记录。
   * @param state - 同步记录。
   * @param namespace - 命名空间。
   * @param revision - 客户端读到的版本。
   * @param fields - 待写入的字段。
   */
  check(state: SyncState, namespace: string, revision: unknown, fields: unknown): SettingsWriteCheck {
    if (!isSyncNamespace(namespace)) {
      return { ok: false, status: 400, body: { ...rejectedBody('permission-denied'), reason: 'namespace-device-scope' } };
    }
    if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
      return { ok: false, status: 400, body: { ...rejectedBody('request-invalid'), reason: 'revision-invalid' } };
    }
    const submitted = fieldsOfValue(fields);
    const names = Object.keys(submitted);
    if (names.length === 0) {
      return { ok: false, status: 400, body: { ...rejectedBody('request-invalid'), reason: 'fields-empty' } };
    }
    const filtered = names.filter((field) => !isSyncField(namespace, field));
    if (filtered.length > 0) {
      return { ok: false, status: 400, body: rejectedBody('request-invalid', filtered) };
    }
    const current = state.namespaces[namespace]?.revision ?? 0;
    if (revision !== current) {
      const conflict = this.conflictOf(state, namespace, submitted);
      const result = settingsWriteResultSchema.parse({ outcome: 'conflict', conflict });
      return { ok: false, status: 409, body: { ...result, revision: conflict.currentRevision, values: this.latest(state, namespace)?.values ?? {} } };
    }
    return { ok: true, fields: submitted };
  }

  /**
   * 提交已经通过校验的字段。
   * @param state - 同步记录。
   * @param namespace - 命名空间。
   * @param incoming - 字段记录，时刻取控制平面的接收时刻。
   */
  commit(state: SyncState, namespace: string, incoming: Record<string, FieldRecord>): { revision: number; applied: string[] } {
    const applied = this.dependencies.store.merge(state, namespace, incoming);
    const record = this.dependencies.store.namespaceOf(state, namespace);
    return { revision: record.revision, applied };
  }
}
