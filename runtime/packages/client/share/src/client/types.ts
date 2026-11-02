/**
 * 分享面板用到的数据形状。
 *
 * 形状取自控制平面真实返回：会话聚合、副本事件、分享预览、分享记录与导入结果。字段一律按
 * 返回值命名，界面不在这一层改名，避免出现两套叫法。分享范围与 `@chatdsh/client-share`
 * 宿主侧的四种方式一一对应：会话全部、指定回合集合、完整回合边界与截止上界。
 * @module @chatdsh/client-share/types
 */

/** 聚合会话列表里的一条会话。 */
export interface SessionSummary {
  readonly sessionId: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly cwd: string;
  readonly workspaceName: string;
  readonly kind: 'work' | 'chat';
}

/** 会话所属的设备。 */
export interface DeviceSessions {
  readonly deviceId: string;
  readonly name: string;
  readonly platform: string;
  readonly online: boolean;
  readonly lastSeenAt: number;
  readonly sessions: readonly SessionSummary[];
}

/** 会话聚合返回值。 */
export interface SessionsSnapshot {
  readonly devices: readonly DeviceSessions[];
}

/** 副本里的一条事件。 */
export interface ReplicaEvent {
  readonly seq: number;
  readonly kind: string;
  readonly time: number;
  readonly bytes?: number;
  readonly payload?: unknown;
}

/** 副本读取结果。 */
export interface ReplicaSnapshot {
  readonly sessionId: string;
  readonly watermark: number | null;
  readonly events: readonly ReplicaEvent[];
}

/** 快照内容的范围统计，取自契约的 `ContentScope`。 */
export interface ContentScope {
  readonly turnFrom: number;
  readonly turnTo: number;
  readonly eventCount: number;
  readonly charCount: number;
  readonly compressed: boolean;
  /** 声明的附件副本是否齐全；为假时公开页的附件缺失。 */
  readonly attachmentsComplete: boolean;
}

/** 分享状态。 */
export type ShareStatus = 'active' | 'revoked' | 'expired';

/** 默认排除的内容种类，与契约 `SHARE_DEFAULT_EXCLUSIONS` 同一组取值。 */
export const SHARE_EXCLUSIONS = [
  'memory-recall',
  'tool-arguments',
  'internal-paths',
  'sensitive-metadata',
  'replica-watermark',
] as const;

/** 一项排除内容。 */
export type ShareExclusion = (typeof SHARE_EXCLUSIONS)[number];

/** 分享范围，四种方式与宿主一一对应。 */
export type ShareRange =
  | { readonly mode: 'session' }
  | { readonly mode: 'turns'; readonly turns: readonly number[] }
  | { readonly mode: 'range'; readonly turnFrom: number; readonly turnTo: number }
  | { readonly mode: 'bound'; readonly upToSeq: number };

/** 一次分享的公开选择：公开哪些文本与哪些附件。 */
export interface ShareSelection {
  readonly includeUserText: boolean;
  readonly includeAssistantText: boolean;
  /** 逐项授权的附件标识；未列入的附件不进入分享包。 */
  readonly attachmentIds: readonly string[];
}

/** 预览请求。 */
export interface SharePreviewInput extends ShareSelection {
  readonly sessionId: string;
  readonly range: ShareRange;
}

/** 建立分享的请求。 */
export interface ShareCreateInput extends SharePreviewInput {
  /** 有效期毫秒数；缺省表示不设期限。 */
  readonly ttlMs?: number;
}

/** 源会话里可以被逐项授权的一份附件。 */
export interface ShareAttachmentCandidate {
  readonly id: string;
  readonly filename: string;
  readonly mimeType?: string;
  readonly size?: number;
}

/** 预览响应里的一份附件。 */
export interface SharePreviewAttachment {
  readonly id: string;
  readonly filename: string;
  /** 源附件当前可读为真；为假时建立分享会被拒绝。 */
  readonly downloadable: boolean;
}

/** 预览响应。 */
export interface SharePreview {
  readonly title: string;
  readonly scope: ContentScope;
  /** 快照覆盖的回合编号。 */
  readonly turns: readonly number[];
  /** 公开页会出现多少条消息。 */
  readonly messageCount: number;
  readonly attachments: readonly SharePreviewAttachment[];
  /** 本次实际生效的排除项。 */
  readonly excluded: readonly ShareExclusion[];
  /** 脱敏替换次数。 */
  readonly redactions: {
    readonly paths: number;
    readonly credentials: number;
  };
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
  /** 公开页被读取的次数。 */
  readonly visits: number;
  /** 快照占用字节：消息文本与附件字节之和。 */
  readonly bytes: number;
  /** 有效时控制平面给出的公开路径。 */
  readonly path?: string;
}

/** 分享记录列表与总量。 */
export interface ShareList {
  readonly shares: readonly ShareRecordView[];
  readonly totalBytes: number;
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

/** 撤销结果。 */
export interface ShareRevoked {
  readonly revoked: boolean;
  readonly revokedAt?: number;
  readonly status?: ShareStatus;
}

/** 导入结果。 */
export interface ImportResult {
  readonly sessionId: string;
  readonly parentSession: string;
  readonly watermark: number | null;
  readonly imported: number;
}

/** 公开页探测结论。 */
export interface SnapshotProbe {
  readonly reachable: boolean;
  readonly status: number;
  /**
   * 结论。控制平面对撤销与过期都返回 410，且返回体不带原因，因此这里只区分「可读」、
   * 「已失效」与「不存在」；撤销还是过期由分享记录里的时间字段判定。
   */
  readonly reason: 'active' | 'unavailable' | 'unknown' | 'stream-not-ready';
}

/** 界面动作名，取值集合固定。 */
export type ShareAction =
  | 'share-reload'
  | 'share-preview'
  | 'share-create'
  | 'share-copy'
  | 'share-open'
  | 'share-revoke'
  | 'share-import'
  | 'share-import-preview';

/** 动作结果。 */
export type ActionOutcome = 'ok' | 'failed' | 'degraded' | 'unavailable';

/** 浏览器侧遥测面。 */
export interface PanelTelemetry {
  action(action: ShareAction, outcome: ActionOutcome): void;
}

/** 面板依赖的数据面，测试与嵌入场景可以整体替换。 */
export interface ShareGateway {
  readonly sessions: () => Promise<SessionsSnapshot>;
  readonly replica: (sessionId: string, upToSeq?: number) => Promise<ReplicaSnapshot>;
  readonly shares: () => Promise<ShareList>;
  readonly preview: (input: SharePreviewInput) => Promise<SharePreview>;
  readonly create: (input: ShareCreateInput) => Promise<ShareCreatedView>;
  readonly revoke: (shareId: string) => Promise<ShareRevoked>;
  readonly probe: (shareId: string) => Promise<SnapshotProbe>;
  readonly importSession: (input: { sourceSessionId: string; deviceId?: string; cwd?: string }) => Promise<ImportResult>;
  readonly noteAction: (action: ShareAction, outcome: ActionOutcome) => void;
}
