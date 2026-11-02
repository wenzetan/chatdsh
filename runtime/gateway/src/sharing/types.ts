/**
 * 分享宿主的依赖接口与对外形状。
 *
 * 这一层只声明边界：会话副本的读取、源附件的读取、请求者身份校验与遥测出口都由装配方
 * 注入；分享范围、内容过滤、快照存储与生命周期在其余模块里实现。返回形状里不出现事件
 * 序号、副本水位与内部标识。
 * @module @chatdsh/gateway/sharing/types
 */

import type { IncomingMessage } from 'node:http';
import type { ContentScope, SharePreview, ShareStatus } from '@chatdsh/core-contracts';

/** 默认排除的内容种类取值。 */
export type ShareExclusion = SharePreview['excluded'][number];

/** 从会话副本读到的一条事件。 */
export interface ReplicaEvent {
  readonly seq: number;
  readonly kind: string;
  readonly time: number;
  readonly bytes: number;
  readonly payload?: unknown;
}

/** 读取会话副本的最小接口，由真实的副本存储满足。 */
export interface ReplicaEventReader {
  read(sessionId: string, upToSeq?: number): readonly ReplicaEvent[];
}

/** 一份源附件的元数据与内容字节。 */
export interface SourceAttachment {
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
  readonly digest: string;
  readonly bytes: Uint8Array;
}

/** 读取源附件的接口；跨设备实现由装配方接入，同机部署用目录实现。 */
export interface ShareAttachmentSource {
  read(attachmentId: string): Promise<SourceAttachment>;
}

/** 快照范围。 */
export type ShareRange =
  | { readonly mode: 'session' }
  | { readonly mode: 'turns'; readonly turns: readonly number[] }
  | { readonly mode: 'range'; readonly turnFrom: number; readonly turnTo: number }
  | { readonly mode: 'bound'; readonly upToSeq: number };

/** 建立分享的输入。 */
export interface ShareCreateInput {
  readonly sessionId: string;
  readonly range: ShareRange;
  readonly includeUserText: boolean;
  readonly includeAssistantText: boolean;
  readonly attachmentIds: readonly string[];
  readonly ttlMs?: number;
  /** 操作标识；同一标识加同一请求摘要重复提交只产生一条记录。 */
  readonly operationId?: string;
  /** 请求摘要，与操作标识配对使用。 */
  readonly requestDigest?: string;
}

/** 预览分享的输入。 */
export interface SharePreviewInput {
  readonly sessionId: string;
  readonly range: ShareRange;
  readonly includeUserText: boolean;
  readonly includeAssistantText: boolean;
  readonly attachmentIds: readonly string[];
}

/** 快照里的一条消息。 */
export interface ShareMessage {
  readonly role: 'user' | 'assistant' | 'tool';
  readonly time: number;
  readonly text: string;
}

/** 分享包里的附件记录。 */
export interface ShareAttachmentRecord {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
  readonly digest: string;
  /** 分享包内的相对路径。 */
  readonly storageKey: string;
}

/** 分享列表里的一条记录。 */
export interface ShareRecordView {
  readonly shareId: string;
  readonly sourceSessionId: string;
  readonly title: string;
  readonly scope: ContentScope;
  readonly status: ShareStatus;
  readonly createdAt: number;
  readonly expiresAt?: number;
  readonly revokedAt?: number;
  readonly visits: number;
  readonly bytes: number;
  /** 有效时的公开路径。 */
  readonly path?: string;
}

/** 建立分享的结果。 */
export interface ShareCreatedView {
  readonly shareId: string;
  readonly path: string;
  readonly sourceSessionId: string;
  readonly title: string;
  readonly scope: ContentScope;
  readonly status: ShareStatus;
  readonly createdAt: number;
  readonly expiresAt?: number;
  readonly bytes: number;
  readonly attachments: readonly {
    readonly id: string;
    readonly filename: string;
    readonly size: number;
  }[];
}

/** 预览结果。 */
export interface SharePreviewView {
  readonly title: string;
  readonly scope: ContentScope;
  readonly turns: readonly number[];
  readonly messageCount: number;
  readonly attachments: readonly {
    readonly id: string;
    readonly filename: string;
    readonly downloadable: boolean;
  }[];
  readonly excluded: readonly ShareExclusion[];
  readonly redactions: {
    readonly paths: number;
    readonly credentials: number;
  };
}

/** 撤销结果。 */
export interface ShareRevokeView {
  readonly shareId: string;
  readonly revokedAt: number;
  readonly status: ShareStatus;
}

/** 公开页上的附件。 */
export interface PublicAttachment {
  readonly id: string;
  readonly filename: string;
  readonly size: number;
}

/** 公开页模型。 */
export interface PublicPageModel {
  readonly title: string;
  readonly createdAt: number;
  readonly scope: ContentScope;
  readonly turns: readonly number[];
  readonly messages: readonly ShareMessage[];
  readonly attachments: readonly PublicAttachment[];
  readonly readOnly: true;
  readonly canPrint: boolean;
  readonly interactive: false;
  /** 生成附件链接用的令牌。 */
  readonly token: string;
}

/** 公开访问的结论。 */
export type PublicAccess =
  | { readonly state: 'active'; readonly page: PublicPageModel }
  | { readonly state: 'revoked' }
  | { readonly state: 'expired' }
  | { readonly state: 'unknown' };

/** 附件读取的结论。 */
export interface PublicAttachmentContent {
  readonly filename: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

/** 已认证的请求者。 */
export interface ShareActor {
  readonly deviceId: string;
}

/** 请求者身份校验；写动作会要求校验方同时核对来源与 CSRF。 */
export type ShareAuthorize = (request: IncomingMessage, action: 'read' | 'write') => ShareActor | undefined;

/** 分享失败。错误码取自跨组件错误码表，原因用于区分同一错误码下的具体条件。 */
export class ShareError extends Error {
  /**
   * @param code - 跨组件错误码。
   * @param reason - 具体条件的稳定取值。
   * @param message - 面向使用者的说明。
   */
  constructor(readonly code: string, readonly reason: string, message: string) {
    super(message);
    this.name = 'ShareError';
  }
}
