/**
 * 设置版本、作用范围与冲突契约。
 *
 * 页面读取服务提供的字段值、限制与 `revision`；保存携带读到的版本，版本落后即返回冲突，
 * 禁止静默覆盖另一客户端的修改。作用范围分部署、设备与客户端三类：路径、电源与平台配置
 * 按设备保存，语言与视图偏好按客户端保存，跨设备同步的命名空间白名单由设置同步插件维护。
 * @module @chatdsh/core-contracts/settings
 */

import { z } from 'zod';
import { chatdshErrorCodeSchema } from './errors.ts';
import { epochMillisSchema, identifierSchema, revisionSchema } from './primitives.ts';

/** 设置区段。 */
export const SETTINGS_SECTIONS = [
  'general',
  'models',
  'plugins',
  'runtime',
  'assistants',
  'skills',
  'memory',
  'connectors',
  'automation',
  'share',
  'devices',
  'access',
  'notifications',
  'data',
  'diagnostics',
] as const;

/** 设置区段取值。 */
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** 设置作用范围。 */
export const SETTINGS_SCOPES = ['deployment', 'device', 'client'] as const;

/** 设置作用范围取值。 */
export type SettingsScope = (typeof SETTINGS_SCOPES)[number];

/** 字段取值表。敏感字段回显的标记只有两种。 */
export const settingsValuesSchema = z.record(z.string(), z.unknown());

/** 一份设置快照。 */
export const settingsSnapshotSchema = z.object({
  /** 区段。 */
  section: z.enum(SETTINGS_SECTIONS),
  /** 作用范围。 */
  scope: z.enum(SETTINGS_SCOPES),
  /** 作用设备；范围为设备时必填。 */
  deviceId: identifierSchema.optional(),
  /** 当前版本。 */
  revision: revisionSchema,
  /** 字段取值。 */
  values: settingsValuesSchema,
  /** 最后修改时刻的毫秒时间戳。 */
  updatedAt: epochMillisSchema,
});

/** 一份设置快照。 */
export type SettingsSnapshot = z.infer<typeof settingsSnapshotSchema>;

/** 设置写入。 */
export const settingsPatchSchema = z
  .object({
    /** 区段。 */
    section: z.enum(SETTINGS_SECTIONS),
    /** 作用范围。 */
    scope: z.enum(SETTINGS_SCOPES),
    /** 作用设备；范围为设备时必填。 */
    deviceId: identifierSchema.optional(),
    /** 读取到的版本。 */
    revision: revisionSchema,
    /** 变更的字段。 */
    fields: settingsValuesSchema,
  })
  .superRefine((patch, context) => {
    if (patch.scope === 'device' && patch.deviceId === undefined) {
      context.addIssue({ code: 'custom', message: '设备范围的设置必须携带设备标识', path: ['deviceId'] });
    }
    if (patch.scope !== 'device' && patch.deviceId !== undefined) {
      context.addIssue({ code: 'custom', message: '非设备范围的设置不得携带设备标识', path: ['deviceId'] });
    }
    if (Object.keys(patch.fields).length === 0) {
      context.addIssue({ code: 'custom', message: '设置写入至少包含一个字段', path: ['fields'] });
    }
  });

/** 设置写入。 */
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

/** 敏感字段的回显标记。 */
export const SENSITIVE_VALUE_MARKERS = ['configured', 'unset'] as const;

/** 一个字段的冲突。敏感字段只比较已配置与未配置。 */
export const settingsFieldConflictSchema = z.discriminatedUnion('sensitive', [
  z.object({
    /** 字段名。 */
    field: identifierSchema,
    /** 非敏感字段。 */
    sensitive: z.literal(false),
    /** 用户编辑值。 */
    userValue: z.unknown(),
    /** 当前服务器值。 */
    serverValue: z.unknown(),
  }),
  z.object({
    field: identifierSchema,
    /** 敏感字段。 */
    sensitive: z.literal(true),
    /** 用户编辑的配置状态。 */
    userValue: z.enum(SENSITIVE_VALUE_MARKERS),
    /** 服务器当前的配置状态。 */
    serverValue: z.enum(SENSITIVE_VALUE_MARKERS),
  }),
]);

/** 一个字段的冲突。 */
export type SettingsFieldConflict = z.infer<typeof settingsFieldConflictSchema>;

/** 冲突视图。 */
export const settingsConflictSchema = z.object({
  /** 区段。 */
  section: z.enum(SETTINGS_SECTIONS),
  /** 作用范围。 */
  scope: z.enum(SETTINGS_SCOPES),
  /** 作用设备。 */
  deviceId: identifierSchema.optional(),
  /** 发生时刻的毫秒时间戳。 */
  changedAt: epochMillisSchema,
  /** 服务端当前版本。 */
  currentRevision: revisionSchema,
  /** 逐字段冲突。 */
  fields: z.array(settingsFieldConflictSchema).min(1),
});

/** 冲突视图。 */
export type SettingsConflict = z.infer<typeof settingsConflictSchema>;

/** 冲突的逐字段解决方式。 */
export const SETTINGS_RESOLUTIONS = ['server', 'user', 'reload', 'cancel'] as const;

/** 冲突的逐字段解决方式取值。 */
export type SettingsResolution = (typeof SETTINGS_RESOLUTIONS)[number];

/** 逐字段的解决选择。 */
export const settingsResolutionSchema = z.object({
  /** 字段名。 */
  field: identifierSchema,
  /** 解决方式。 */
  resolution: z.enum(SETTINGS_RESOLUTIONS),
});

/** 逐字段的解决选择。 */
export type SettingsResolutionChoice = z.infer<typeof settingsResolutionSchema>;

/** 设置写入结果。 */
export const settingsWriteResultSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('applied'),
    /** 写入后的版本。 */
    revision: revisionSchema,
    /** 写入成功的字段名。 */
    fields: z.array(identifierSchema),
  }),
  z.object({
    outcome: z.literal('conflict'),
    /** 冲突视图。 */
    conflict: settingsConflictSchema,
  }),
  z.object({
    outcome: z.literal('rejected'),
    /** 错误码。 */
    code: chatdshErrorCodeSchema,
    /** 只读或锁定的字段名。 */
    fields: z.array(identifierSchema).optional(),
  }),
]);

/** 设置写入结果。 */
export type SettingsWriteResult = z.infer<typeof settingsWriteResultSchema>;
