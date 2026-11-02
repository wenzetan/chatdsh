/**
 * 制品版本契约。
 *
 * 制品元数据在 `artifacts.ts` 里定义，本文件补齐客户端的版本列表、版本选择与删除范围。
 * 历史版本不可改写，删除确认列出全部版本与占用空间。HTML 制品在独立受限预览里呈现，
 * 禁用脚本与宿主访问。
 * @module @chatdsh/core-contracts/artifact-versions
 */

import { z } from 'zod';
import { countSchema, epochMillisSchema, identifierSchema } from './primitives.ts';

/** 一个制品版本。 */
export const artifactVersionSchema = z.object({
  /** 制品标识。 */
  artifactId: identifierSchema,
  /** 版本号，从 1 开始。 */
  version: z.number().int().positive(),
  /** 媒体类型。 */
  mimeType: z.string().min(1).max(200),
  /** 字节数。 */
  size: countSchema,
  /** 建立时刻的毫秒时间戳。 */
  createdAt: epochMillisSchema,
  /** 历史版本不可改写。 */
  immutable: z.literal(true),
  /** 产生该版本的会话。 */
  sourceSessionId: identifierSchema,
  /** 产生该版本的回合编号。 */
  sourceTurn: z.number().int().positive().optional(),
  /** 内容是否可下载。 */
  downloadable: z.boolean(),
});

/** 一个制品版本。 */
export type ArtifactVersionView = z.infer<typeof artifactVersionSchema>;

/** 版本引用。 */
export const artifactVersionRefSchema = z.object({
  /** 制品标识。 */
  artifactId: identifierSchema,
  /** 版本号。 */
  version: z.number().int().positive(),
});

/** 版本引用。 */
export type ArtifactVersionRef = z.infer<typeof artifactVersionRefSchema>;

/** 版本列表。 */
export const artifactVersionListSchema = z
  .object({
    /** 制品标识。 */
    artifactId: identifierSchema,
    /** 当前版本号。 */
    currentVersion: z.number().int().positive(),
    /** 全部版本，按版本号升序。 */
    versions: z.array(artifactVersionSchema).min(1),
  })
  .superRefine((list, context) => {
    for (const version of list.versions) {
      if (version.artifactId !== list.artifactId) {
        context.addIssue({ code: 'custom', message: '版本与制品标识不一致', path: ['versions'] });
      }
    }
    if (!list.versions.some((version) => version.version === list.currentVersion)) {
      context.addIssue({ code: 'custom', message: '当前版本必须出现在版本列表里', path: ['currentVersion'] });
    }
  });

/** 版本列表。 */
export type ArtifactVersionList = z.infer<typeof artifactVersionListSchema>;

/** 删除范围：删除全部版本时需要显式确认。 */
export const artifactDeleteScopeSchema = z.object({
  /** 制品标识。 */
  artifactId: identifierSchema,
  /** 删除全部版本。 */
  allVersions: z.boolean(),
  /** 指定删除的版本号。 */
  versions: z.array(z.number().int().positive()),
  /** 涉及的全部版本。 */
  affectedVersions: z.array(z.number().int().positive()).min(1),
  /** 占用空间字节数。 */
  totalBytes: countSchema,
  /** 需要确认。 */
  requiresConfirm: z.literal(true),
});

/** 删除范围。 */
export type ArtifactDeleteScope = z.infer<typeof artifactDeleteScopeSchema>;

/** 预览方式。 */
export const ARTIFACT_PREVIEW_MODES = ['text', 'html-sandbox', 'image', 'pdf', 'download-only'] as const;

/** 预览约束。HTML 预览禁用脚本与宿主访问。 */
export const artifactPreviewSchema = z.object({
  /** 预览方式。 */
  mode: z.enum(ARTIFACT_PREVIEW_MODES),
  /** 脚本是否允许执行；恒为假。 */
  scriptAllowed: z.literal(false),
  /** 是否允许访问宿主桥；恒为假。 */
  hostBridgeAllowed: z.literal(false),
  /** 是否允许表单提交；恒为假。 */
  formSubmitAllowed: z.literal(false),
});

/** 预览约束。 */
export type ArtifactPreview = z.infer<typeof artifactPreviewSchema>;
