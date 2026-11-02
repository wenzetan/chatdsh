/**
 * 通知中心与系统通知契约。
 *
 * 通知 outbox 在副本提交事务内登记；已读与审批决定分别记录，阅读状态不自动决定审批。
 * 审批终结后撤回同关联键的待投递通知，并按稳定 tag 关闭可撤回的已展示通知。
 * @module @chatdsh/core-contracts/notifications
 */

import { z } from 'zod';
import { chatdshErrorCodeSchema } from './errors.ts';
import { identifierSchema, countSchema, epochMillisSchema } from './primitives.ts';

/** 通知种类。 */
export const NOTIFICATION_KINDS = [
  'approval',
  'question',
  'run-finished',
  'run-failed',
  'automation',
  'share',
  'device',
  'system',
] as const;

/** 通知种类取值。 */
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** 通知中心的过滤条件。 */
export const NOTIFICATION_FILTERS = ['all', 'unread', 'approval', 'run-result'] as const;

/** 通知中心的过滤条件取值。 */
export type NotificationFilter = (typeof NOTIFICATION_FILTERS)[number];

/** 一条通知。 */
export const notificationSchema = z.object({
  /** 通知标识。 */
  id: identifierSchema,
  /** 事件类型。 */
  kind: z.enum(NOTIFICATION_KINDS),
  /** 业务标题，取业务对象名称。 */
  title: z.string().min(1).max(300),
  /** 关联设备；系统级通知缺省。 */
  deviceId: identifierSchema.optional(),
  /** 关联会话。 */
  sessionId: identifierSchema.optional(),
  /** 关联对象的稳定标识，例如审批的工具调用标识。 */
  objectId: identifierSchema.optional(),
  /** 事件发生时刻的毫秒时间戳。 */
  createdAt: epochMillisSchema,
  /** 已读时刻；未读时缺省。 */
  readAt: epochMillisSchema.optional(),
  /** 已处理时刻；审批与提问用它与已读区分。 */
  handledAt: epochMillisSchema.optional(),
  /** 系统通知使用的稳定 tag，用于撤回已展示的通知。 */
  tag: identifierSchema.optional(),
  /** 是否可撤回。 */
  revocable: z.boolean(),
});

/** 一条通知。 */
export type Notification = z.infer<typeof notificationSchema>;

/** 已读标记请求。同一客户端对同一通知重复提交按幂等处理。 */
export const notificationReadRequestSchema = z.object({
  /** 要标记的通知标识；不做标记时至少一条。 */
  ids: z.array(identifierSchema).min(1).max(500),
  /** 客户端标识，已读状态按它保存。 */
  clientId: identifierSchema,
});

/** 已读标记请求。 */
export type NotificationReadRequest = z.infer<typeof notificationReadRequestSchema>;

/** 已读标记结果。 */
export const notificationReadResultSchema = z.object({
  /** 本次新标记的条数。 */
  marked: countSchema,
  /** 已经处于已读状态的条数。 */
  unchanged: countSchema,
});

/** 已读标记结果。 */
export type NotificationReadResult = z.infer<typeof notificationReadResultSchema>;

/** 通知投递的节奏。 */
export const NOTIFICATION_DELIVERY_MODES = ['all-at-once', 'two-stage'] as const;

/** 通知投递的节奏取值。 */
export type NotificationDeliveryMode = (typeof NOTIFICATION_DELIVERY_MODES)[number];

/** 第一阶段等待上限，单位秒。 */
export const NOTIFICATION_FIRST_STAGE_MAX_SECONDS = 300;

/** 第二阶段等待上限，单位秒。 */
export const NOTIFICATION_SECOND_STAGE_MAX_SECONDS = 3600;

/** 通知设置。 */
export const notificationSettingsSchema = z
  .object({
    /** 投递节奏。 */
    deliveryMode: z.enum(NOTIFICATION_DELIVERY_MODES),
    /** 第一阶段等待，单位秒。 */
    firstStageSeconds: z.number().int().min(0).max(NOTIFICATION_FIRST_STAGE_MAX_SECONDS),
    /** 第二阶段等待，单位秒。 */
    secondStageSeconds: z.number().int().min(1).max(NOTIFICATION_SECOND_STAGE_MAX_SECONDS),
    /** 回合结束时投递。 */
    onTurnEnd: z.boolean(),
    /** 审批提出时投递。 */
    onApproval: z.boolean(),
    /** 系统通知显示消息预览；默认关闭。 */
    messagePreview: z.boolean(),
    /** 当前会话聚焦时静默。 */
    quietWhenFocused: z.boolean(),
  })
  .superRefine((settings, context) => {
    if (settings.deliveryMode !== 'two-stage') return;
    if (settings.secondStageSeconds <= settings.firstStageSeconds) {
      context.addIssue({
        code: 'custom',
        message: '第二阶段等待必须大于第一阶段等待',
        path: ['secondStageSeconds'],
      });
    }
  });

/** 通知设置。 */
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;

/** 系统通知权限状态。 */
export const NOTIFICATION_PERMISSIONS = ['default', 'granted', 'denied', 'unsupported'] as const;

/** 推送订阅状态。 */
export const PUSH_SUBSCRIPTION_STATES = ['subscribed', 'expired', 'gone', 'unsubscribed'] as const;

/** 推送订阅状态取值。 */
export type PushSubscriptionState = (typeof PUSH_SUBSCRIPTION_STATES)[number];

/** 推送订阅的对外状态；端点与密钥不进入界面与导出。 */
export const pushSubscriptionViewSchema = z.object({
  /** 订阅状态。 */
  state: z.enum(PUSH_SUBSCRIPTION_STATES),
  /** 系统通知权限。 */
  permission: z.enum(NOTIFICATION_PERMISSIONS),
  /** 最近更新时刻的毫秒时间戳。 */
  updatedAt: epochMillisSchema,
  /** 失效或失败时的错误码。 */
  code: chatdshErrorCodeSchema.optional(),
});

/** 推送订阅的对外状态。 */
export type PushSubscriptionView = z.infer<typeof pushSubscriptionViewSchema>;

/** 通知投递结果的对外状态。 */
export const NOTIFICATION_DELIVERY_RESULTS = ['accepted', 'delivered', 'failed', 'revoked'] as const;

/** 通知投递结果的对外状态取值。 */
export type NotificationDeliveryResult = (typeof NOTIFICATION_DELIVERY_RESULTS)[number];

/** 一次验证通知的结果：服务端受理与客户端实际接收分别报告。 */
export const notificationProbeSchema = z.object({
  /** 服务端受理时刻的毫秒时间戳。 */
  acceptedAt: epochMillisSchema.optional(),
  /** 客户端实际接收时刻的毫秒时间戳。 */
  receivedAt: epochMillisSchema.optional(),
  /** 结果。 */
  result: z.enum(NOTIFICATION_DELIVERY_RESULTS),
  /** 失败原因码。 */
  code: chatdshErrorCodeSchema.optional(),
});

/** 一次验证通知的结果。 */
export type NotificationProbe = z.infer<typeof notificationProbeSchema>;
