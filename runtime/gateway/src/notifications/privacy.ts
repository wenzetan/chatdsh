/**
 * 通知内容的下发裁剪。
 *
 * 通知下发到事件流与系统通知之前按隐私级别裁剪。默认级别给业务标题与摘要，不含命令与
 * 消息原文；仅类型级别只给产品名与事件类型；预览级别需要在设置里明确开启消息预览，并且
 * 只有记录里确实保存了原文时才下发。
 * @module @chatdsh/gateway/notifications/privacy
 */

import type { NotificationKind } from '@chatdsh/core-contracts';
import type { NotificationPrivacyLevel } from './records.ts';

/** 产品名，作为系统通知的固定标题。 */
export const PRODUCT_NAME = 'ChatDSH';

/** 事件类型的中文说明，仅类型级别与摘要级别都会用到。 */
export const NOTIFICATION_KIND_LABELS: Readonly<Record<NotificationKind, string>> = {
  approval: '等待审批',
  question: '等待回答',
  'run-finished': '回合完成',
  'run-failed': '回合失败',
  automation: '自动化任务',
  share: '分享',
  device: '设备',
  system: '系统',
};

/** 一条通知下发时可见的内容。 */
export interface NotificationContent {
  /** 系统通知标题。 */
  readonly title: string;
  /** 摘要；仅类型级别以外才有值。 */
  readonly summary: string;
  /** 关联会话标识；仅类型级别不给。 */
  readonly sessionId?: string;
  /** 关联对象的稳定标识；仅类型级别不给。 */
  readonly objectId?: string;
  /** 命令或消息原文；只有预览级别且开启消息预览时才有值。 */
  readonly preview?: string;
}

/** 裁剪所需的记录字段。 */
export interface ContentSource {
  /** 通知种类。 */
  readonly kind: NotificationKind;
  /** 业务标题。 */
  readonly title: string;
  /** 摘要。 */
  readonly summary: string;
  /** 命令或消息原文。 */
  readonly previewText?: string;
  /** 关联会话。 */
  readonly sessionId?: string;
  /** 关联对象的稳定标识。 */
  readonly objectId?: string;
}

/**
 * 按级别裁剪一条通知的下发内容。
 * @param source - 记录里的字段。
 * @param level - 当前生效的隐私级别。
 * @param messagePreview - 是否开启消息预览。
 * @returns 可以下发的字段。
 */
export function contentOf(source: ContentSource, level: NotificationPrivacyLevel, messagePreview: boolean): NotificationContent {
  if (level === 'type') {
    return { title: PRODUCT_NAME, summary: NOTIFICATION_KIND_LABELS[source.kind] };
  }
  const summary = source.summary === '' ? NOTIFICATION_KIND_LABELS[source.kind] : source.summary;
  const base: NotificationContent = {
    title: PRODUCT_NAME,
    summary: `${source.title}：${summary}`,
    ...(source.sessionId === undefined ? {} : { sessionId: source.sessionId }),
    ...(source.objectId === undefined ? {} : { objectId: source.objectId }),
  };
  if (level !== 'preview' || !messagePreview || source.previewText === undefined) return base;
  return { ...base, preview: source.previewText };
}
