/**
 * 业务事件到通知意图的转写。
 *
 * 控制平面已经在推行业务事件（审批提出、回合结束等），通知中心要在同一处生成记录。转写
 * 只取会话标识、业务对象名称与摘要：命令参数与消息原文除非业务事件明确带着它们，否则
 * 不会被记录，下发时还要再按隐私级别裁剪一次。
 * @module @chatdsh/gateway/notifications/intents
 */

import { NOTIFICATION_KINDS, type NotificationKind } from '@chatdsh/core-contracts';

/** 转写出来的一条通知意图。 */
export interface NotificationIntent {
  /** 通知种类。 */
  readonly kind: NotificationKind;
  /** 业务标题，取业务对象名称。 */
  readonly title: string;
  /** 摘要，不含命令与消息原文。 */
  readonly summary: string;
  /** 关联设备。 */
  readonly deviceId?: string;
  /** 关联会话。 */
  readonly sessionId?: string;
  /** 关联对象的稳定标识。 */
  readonly objectId?: string;
  /** 系统通知的稳定 tag。 */
  readonly tag?: string;
  /** 命令或消息原文，只在预览级别下发。 */
  readonly previewText?: string;
  /** 去重键。 */
  readonly dedupeKey: string;
}

/** 业务事件里可用的字段。 */
interface IntentPayload {
  readonly kind?: unknown;
  readonly title?: unknown;
  readonly summary?: unknown;
  readonly sessionId?: unknown;
  readonly deviceId?: unknown;
  readonly objectId?: unknown;
  readonly tag?: unknown;
  readonly callId?: unknown;
  readonly toolName?: unknown;
  readonly message?: unknown;
  readonly command?: unknown;
}

/** 取一个字符串字段，超过长度上限时截断。 */
function textOf(value: unknown, fallback: string, max = 300): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (trimmed === '') return fallback;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** 取一个可选标识字段。 */
function identifierOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * 把一条推送载荷转写成通知意图。
 *
 * 载荷的种类不在通知种类之内时返回 `undefined`，调用方按原样投递。
 * @param payload - 推送载荷的 JSON 文本。
 * @returns 通知意图；不是通知类事件时返回 `undefined`。
 */
export function intentOf(payload: string): NotificationIntent | undefined {
  let parsed: IntentPayload;
  try {
    parsed = JSON.parse(payload) as IntentPayload;
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  if (typeof parsed.kind !== 'string') return undefined;
  if (!(NOTIFICATION_KINDS as readonly string[]).includes(parsed.kind)) return undefined;
  const kind = parsed.kind as NotificationKind;
  const sessionId = identifierOf(parsed.sessionId);
  const deviceId = identifierOf(parsed.deviceId);
  const previewText = textOf(parsed.message ?? parsed.command, '', 2000);
  const common = {
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(deviceId === undefined ? {} : { deviceId }),
    ...(previewText === '' ? {} : { previewText }),
  };

  if (kind === 'approval') {
    const callId = identifierOf(parsed.callId);
    const toolName = identifierOf(parsed.toolName);
    return {
      kind,
      title: toolName === undefined ? '审批请求' : `审批：${toolName}`,
      summary: toolName === undefined ? '等待审批：工具调用' : `等待审批：${toolName}`,
      objectId: callId,
      ...(callId === undefined ? {} : { tag: `approval-${callId}` }),
      dedupeKey: `approval:${sessionId ?? '-'}:${callId ?? '-'}`,
      ...common,
    };
  }

  const objectId = identifierOf(parsed.objectId);
  const tag = identifierOf(parsed.tag);
  return {
    kind,
    title: textOf(parsed.title, 'ChatDSH 通知', 80),
    summary: textOf(parsed.summary, '有新的通知', 300),
    ...(objectId === undefined ? {} : { objectId }),
    ...(tag === undefined ? {} : { tag }),
    dedupeKey: `${kind}:${sessionId ?? '-'}:${objectId ?? tag ?? '-'}`,
    ...common,
  };
}
