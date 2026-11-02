/**
 * 会话事件与投影的扩展契约。
 *
 * ChatDSH 不新增会话事件词汇，扩展一律走 `appendPluginRecord` 写出的 `plugin:` 记录：
 * 类型名匹配 `plugin:<小写段>`，写入的记录带 `ignorable: true`，冷读路径放行，
 * 随 fork 与 resume 一起搬运。这类记录在会话格式迁移中可能被丢弃，因此只承载可以丢失的状态。
 * @module @chatdsh/core-contracts/session-events
 */

/** 插件记录类型名。 */
export type PluginRecordType = `plugin:${string}`;

/** 导入会话时的复制方式。 */
export const IMPORT_MODES = ['full-prefix', 'compressed'] as const;

/** 导入会话时写入的来源声明种类。 */
export type ImportMode = (typeof IMPORT_MODES)[number];

/** 一条导入声明的载荷。 */
export interface ImportDeclaredRecord {
  /** 记录种类标识。 */
  readonly kind: 'import';
  /** 源会话标识。 */
  readonly sourceSessionId: string;
  /** 源会话所在设备。 */
  readonly sourceDeviceId: string;
  /** 导入时源会话副本的同步水位。 */
  readonly sourceWatermark: number;
  /** 导入粒度。 */
  readonly mode: ImportMode;
  /** 复制的事件条数。 */
  readonly eventCount: number;
  /** 复制的字符数。 */
  readonly charCount: number;
  /** 压缩导入时为真，表示工具输出已替换成摘要。 */
  readonly lossy: boolean;
  /** 导入时刻的毫秒时间戳。 */
  readonly importedAt: number;
}

/** 一条转工作的来源声明。 */
export interface HandoffDeclaredRecord {
  /** 记录种类标识。 */
  readonly kind: 'handoff';
  /** 内容来源执行体。 */
  readonly provider: ApprovalOriginName;
  /** 来源模型标识，例如 `hermes-0.21.7`。 */
  readonly model: string;
  /** 转工作时刻的毫秒时间戳。 */
  readonly at: number;
}

/** 内容来源执行体的取值。 */
export type ApprovalOriginName = 'dsh' | 'hermes';

/** ChatDSH 写入会话的插件记录载荷。 */
export type ChatdshSessionRecord = ImportDeclaredRecord | HandoffDeclaredRecord;

/** 会话类型。 */
export type SessionKind = 'work' | 'chat';

/** 会话归属记录，控制平面持有并由运行时投影补全。 */
export interface SessionOwnership {
  readonly sessionId: string;
  /** 工作会话的工作区标识；聊天会话为空。 */
  readonly workspaceId?: string;
  /** 会话类型，由 `workspaceId` 是否为空判定，写入后不再变化。 */
  readonly kind: SessionKind;
  /** 执行节点标识，创建后不可修改。 */
  readonly deviceId: string;
  /** 会话头里的工作目录，写入后不可变。 */
  readonly cwd: string;
  /** 分叉来源会话。 */
  readonly parentSession?: string;
  /** 被复制的源事件条数，分叉会话的游标三元组用它区分区间。 */
  readonly inheritedEventCount?: number;
  readonly createdAt: number;
  /** 软删除时刻；未删除时为空。 */
  readonly deletedAt?: number;
}

/** 跨端游标三元组。 */
export interface SessionCursor {
  readonly sessionId: string;
  /** 分叉标识；非分叉会话为 `undefined`。 */
  readonly forkOf?: string;
  readonly seq: number;
}

/** 客户端游标比较：先按会话，再按分叉，最后按序号。 */
export function compareCursor(a: SessionCursor, b: SessionCursor): number {
  if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? -1 : 1;
  const forkA = a.forkOf ?? '';
  const forkB = b.forkOf ?? '';
  if (forkA !== forkB) return forkA < forkB ? -1 : 1;
  return a.seq - b.seq;
}
