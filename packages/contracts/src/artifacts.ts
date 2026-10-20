/**
 * 制品与附件的元数据契约。
 *
 * 制品是模型产出的可版本化文件（文档、代码、页面），附件是用户上传的字节。
 * 两者都落在对象存储（单机是本地目录），元数据落在结构化存储里。
 * @module @chatdsh/contracts/artifacts
 */

/** 制品标识。 */
export type ArtifactId = string;

/** 制品种类。 */
export type ArtifactKind = 'document' | 'code' | 'html' | 'svg' | 'markdown' | 'image' | 'other';

/** 一个制品的元数据。 */
export interface ArtifactMetadata {
  readonly id: ArtifactId;
  /** 所属会话。 */
  readonly sessionId: string;
  /** 所属工作区；聊天会话产出制品时为空。 */
  readonly workspaceId?: string;
  /** 展示名。 */
  readonly title: string;
  readonly kind: ArtifactKind;
  /** 媒体类型。 */
  readonly mimeType: string;
  /** 当前版本的字节数。 */
  readonly size: number;
  /** 当前版本号，从 1 开始，每次写入递增。 */
  readonly version: number;
  /** 创建时刻的毫秒时间戳。 */
  readonly createdAt: number;
  /** 最后更新时刻的毫秒时间戳。 */
  readonly updatedAt: number;
  /** 来源会话事件序号，用于从会话回看是哪一步产出的。 */
  readonly sourceEventSeq?: number;
}

/** 制品的一个历史版本。 */
export interface ArtifactVersion {
  readonly artifactId: ArtifactId;
  readonly version: number;
  readonly size: number;
  readonly mimeType: string;
  readonly createdAt: number;
  /** 该版本在存储里的键。 */
  readonly storageKey: string;
}

/** 附件的元数据。 */
export interface AttachmentMetadata {
  readonly id: string;
  /** 上传者账号。 */
  readonly accountId: string;
  /** 关联会话；上传后尚未发送时为空。 */
  readonly sessionId?: string;
  /** 原始文件名。 */
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
  readonly createdAt: number;
  /** 内容摘要，用于去重与完整性校验。 */
  readonly digest: string;
  /** 在存储里的键。 */
  readonly storageKey: string;
}

/** 制品的版本标识，形如 `<id>@<version>`。 */
export function artifactVersionKey(id: ArtifactId, version: number): string {
  return `${id}@${version}`;
}
