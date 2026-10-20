/**
 * 制品的存储域声明。
 *
 * 元数据落在结构化存储里，内容字节落在产品数据目录下，两者以 `storageKey` 关联。
 * @module @chatdsh/host-artifacts/domain
 */

import { z } from 'zod';
import { defineDomain, domainTable } from '@chatdsh/adapter';

/** 一条制品记录（当前版本）。 */
export interface ArtifactRecord {
  /** 制品标识。 */
  readonly id: string;
  /** 所属会话。 */
  readonly sessionId: string;
  /** 所属工作区；聊天会话产出制品时为空。 */
  readonly workspaceId?: string;
  /** 展示名。 */
  readonly title: string;
  /** 制品种类。 */
  readonly kind: string;
  /** 媒体类型。 */
  readonly mimeType: string;
  /** 当前版本的字节数。 */
  readonly size: number;
  /** 当前版本号，从 1 开始。 */
  readonly version: number;
  /** 创建时刻的毫秒时间戳。 */
  readonly createdAt: number;
  /** 最后更新时刻的毫秒时间戳。 */
  readonly updatedAt: number;
  /** 产生该制品的会话事件序号。 */
  readonly sourceEventSeq?: number;
}

/** 一条版本记录。 */
export interface ArtifactVersionRecord {
  readonly artifactId: string;
  readonly version: number;
  readonly size: number;
  readonly mimeType: string;
  readonly createdAt: number;
  /** 内容在产品数据目录里的相对路径。 */
  readonly storageKey: string;
}

/** 制品记录 schema。 */
export const artifactSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string(),
  workspaceId: z.string().optional(),
  title: z.string(),
  kind: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  sourceEventSeq: z.number().int().nonnegative().optional(),
});

/** 版本记录 schema。 */
export const versionSchema = z.object({
  artifactId: z.string().min(1),
  version: z.number().int().positive(),
  size: z.number().int().nonnegative(),
  mimeType: z.string(),
  createdAt: z.number().int().nonnegative(),
  storageKey: z.string().min(1),
});

/** 存储域声明。域名只允许小写字母、数字与下划线。 */
export const ARTIFACTS_DOMAIN = defineDomain({
  name: 'artifacts_store',
  version: 1,
  tables: {
    artifacts: domainTable<'artifact', ArtifactRecord>(artifactSchema),
    versions: domainTable<'version', ArtifactVersionRecord>(versionSchema),
  },
});
