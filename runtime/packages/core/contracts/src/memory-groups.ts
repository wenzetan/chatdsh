/**
 * 记忆配置、记忆组与 bank 契约。
 *
 * 记忆组用稳定 `memoryGroupId` 关联工作区集合；显示名与工作区路径独立可编辑，关联只修改
 * 映射，不删除既有记忆。召回读组 bank 与个人 bank，回合写入个人 bank。地址与凭据环境变量
 * 名称只读展示，值不进入公开导出与遥测。
 * @module @chatdsh/core-contracts/memory-groups
 */

import { z } from 'zod';
import { chatdshErrorCodeSchema } from './errors.ts';
import { countSchema, displayNameSchema, epochMillisSchema, identifierSchema, revisionSchema } from './primitives.ts';

/** 召回令牌上限的产品范围。 */
export const MEMORY_MAX_TOKENS_RANGE = { min: 100, max: 16000, default: 1024 } as const;

/** 记忆后端的状态。 */
export const MEMORY_STATES = ['enabled-available', 'enabled-unreachable', 'disabled', 'read-failed'] as const;

/** 记忆后端的状态取值。 */
export type MemoryState = (typeof MEMORY_STATES)[number];

/** 个人 bank 名。 */
export const MEMORY_ACCOUNT_BANK = 'acct';

/** 记忆组 bank 的前缀。 */
export const MEMORY_GROUP_BANK_PREFIX = 'ws:';

/** 记忆配置视图。 */
export const memorySettingsViewSchema = z.object({
  /** 启用状态。 */
  enabled: z.boolean(),
  /** 当前状态。 */
  state: z.enum(MEMORY_STATES),
  /** 单次召回的令牌上限。 */
  maxTokens: z.number().int().min(MEMORY_MAX_TOKENS_RANGE.min).max(MEMORY_MAX_TOKENS_RANGE.max),
  /** 额外召回的 bank，按优先级排序。 */
  extraBanks: z.array(identifierSchema),
  /** 配置来源说明，例如环境变量名称。 */
  configSource: z.string().min(1).max(200),
  /** 服务地址是否已配置；值不回显。 */
  endpointConfigured: z.boolean(),
  /** 凭据环境变量是否已设置；名称回显，值不回显。 */
  credentialEnvConfigured: z.boolean(),
  /** 最近成功时刻的毫秒时间戳。 */
  lastSuccessAt: epochMillisSchema.optional(),
  /** 最近失败时刻的毫秒时间戳。 */
  lastFailureAt: epochMillisSchema.optional(),
  /** 最近一次失败的错误码。 */
  lastErrorCode: chatdshErrorCodeSchema.optional(),
  /** 配置版本。 */
  revision: revisionSchema,
});

/** 记忆配置视图。 */
export type MemorySettingsView = z.infer<typeof memorySettingsViewSchema>;

/** 记忆配置保存请求。 */
export const memorySettingsSaveSchema = z.object({
  /** 启用状态。 */
  enabled: z.boolean(),
  /** 单次召回的令牌上限。 */
  maxTokens: z.number().int().min(MEMORY_MAX_TOKENS_RANGE.min).max(MEMORY_MAX_TOKENS_RANGE.max),
  /** 额外召回的 bank，只接受已配置的 bank 标识。 */
  extraBanks: z.array(identifierSchema),
  /** 当前版本。 */
  revision: revisionSchema,
});

/** 记忆配置保存请求。 */
export type MemorySettingsSave = z.infer<typeof memorySettingsSaveSchema>;

/** 工作区关联：设备与绝对路径共同确定一个工作区。 */
export const memoryWorkspaceRefSchema = z.object({
  /** 设备标识。 */
  deviceId: identifierSchema,
  /** 工作目录的绝对路径。 */
  path: z.string().min(1),
});

/** 工作区关联。 */
export type MemoryWorkspaceRef = z.infer<typeof memoryWorkspaceRefSchema>;

/** 一个记忆组。 */
export const memoryGroupSchema = z.object({
  /** 稳定的记忆组标识。 */
  memoryGroupId: identifierSchema,
  /** 可编辑的显示名。 */
  displayName: displayNameSchema,
  /** 关联的工作区集合；至少一个。 */
  workspaces: z.array(memoryWorkspaceRefSchema).min(1),
  /** 组内记忆条目数。 */
  entryCount: countSchema,
  /** 建立时刻的毫秒时间戳。 */
  createdAt: epochMillisSchema,
  /** 最后修改时刻的毫秒时间戳。 */
  updatedAt: epochMillisSchema,
  /** 记录版本。 */
  revision: revisionSchema,
});

/** 一个记忆组。 */
export type MemoryGroup = z.infer<typeof memoryGroupSchema>;

/** 记忆组保存请求。 */
export const memoryGroupSaveSchema = z.object({
  /** 记忆组标识；新建时缺省。 */
  memoryGroupId: identifierSchema.optional(),
  /** 显示名。 */
  displayName: displayNameSchema,
  /** 关联的工作区集合。 */
  workspaces: z.array(memoryWorkspaceRefSchema).min(1),
  /** 当前版本；新建时缺省。 */
  revision: revisionSchema.optional(),
});

/** 记忆组保存请求。 */
export type MemoryGroupSave = z.infer<typeof memoryGroupSaveSchema>;

/** 一个 bank 的目录项。 */
export const bankCatalogEntrySchema = z.object({
  /** bank 标识。 */
  bank: identifierSchema,
  /** 展示名。 */
  displayName: displayNameSchema,
  /** 条目数。 */
  entryCount: countSchema,
  /** 查询状态。 */
  state: z.enum(['idle', 'querying', 'available', 'unreachable']),
});

/** 一个 bank 的目录项。 */
export type BankCatalogEntry = z.infer<typeof bankCatalogEntrySchema>;

/** bank 目录。 */
export const bankCatalogSchema = z.object({
  items: z.array(bankCatalogEntrySchema),
  /** 读取时刻的毫秒时间戳。 */
  readAt: epochMillisSchema,
});

/** bank 目录。 */
export type BankCatalog = z.infer<typeof bankCatalogSchema>;

/** 检索请求。查询文本只保留页面内存。 */
export const memoryRecallRequestSchema = z.object({
  /** bank 范围；缺省时按当前会话的召回规则。 */
  banks: z.array(identifierSchema).min(1).optional(),
  /** 查询文本。 */
  text: z.string().min(1).max(4000),
  /** 返回条数上限。 */
  limit: z.number().int().min(1).max(50).default(10),
  /** 令牌上限。 */
  maxTokens: z.number().int().min(MEMORY_MAX_TOKENS_RANGE.min).max(MEMORY_MAX_TOKENS_RANGE.max).optional(),
});

/** 检索请求。 */
export type MemoryRecallRequest = z.infer<typeof memoryRecallRequestSchema>;

/** 一条检索结果。 */
export const memoryRecallHitSchema = z.object({
  /** 命中的 bank。 */
  bank: identifierSchema,
  /** 命中内容。 */
  text: z.string().min(1),
  /** 来源标识。 */
  source: identifierSchema.optional(),
  /** 相关性得分。 */
  score: z.number().min(0).max(1).optional(),
  /** 记忆建立时刻的毫秒时间戳。 */
  at: epochMillisSchema.optional(),
});

/** 一条检索结果。 */
export type MemoryRecallHit = z.infer<typeof memoryRecallHitSchema>;

/** 检索结果。 */
export const memoryRecallResultSchema = z.object({
  hits: z.array(memoryRecallHitSchema),
  /** 读取时刻的毫秒时间戳。 */
  readAt: epochMillisSchema,
  /** 后端不可达时为真；当前回合继续执行。 */
  degraded: z.boolean(),
  /** 降级原因码。 */
  code: chatdshErrorCodeSchema.optional(),
});

/** 检索结果。 */
export type MemoryRecallResult = z.infer<typeof memoryRecallResultSchema>;

/** 待写入与废弃记录的计数视图：只显示数量、时间与错误码。 */
export const memoryWriteQueueViewSchema = z.object({
  /** 待写入任务数。 */
  pendingCount: countSchema,
  /** 最早登记时刻的毫秒时间戳。 */
  oldestPendingAt: epochMillisSchema.optional(),
  /** 废弃任务数。 */
  discardedCount: countSchema,
  /** 最近一次失败的错误码。 */
  lastErrorCode: chatdshErrorCodeSchema.optional(),
});

/** 待写入与废弃记录的计数视图。 */
export type MemoryWriteQueueView = z.infer<typeof memoryWriteQueueViewSchema>;
