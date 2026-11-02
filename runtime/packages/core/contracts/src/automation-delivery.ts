/**
 * 自动化投递结果与设备定时任务契约。
 *
 * webhook 每次投递登记事件标识与去重结果，状态按 received → validated → dispatching →
 * accepted → completed 或 failed 推进，受理结果未知时进入 unconfirmed 并查询原结果。
 * 定时任务只连接原会话的 `ctx.schedule`：单次、间隔、每日、每周与 cron 互斥提交，
 * cron 表达式由自动化宿主引入成熟解析库校验，本包只声明字段与互斥规则。
 * @module @chatdsh/core-contracts/automation-delivery
 */

import { z } from 'zod';
import { AUTOMATION_EVENT_SOURCES } from './automation.ts';
import { chatdshErrorCodeSchema } from './errors.ts';
import {
  clockTimeSchema,
  epochMillisSchema,
  ianaTimeZoneSchema,
  identifierSchema,
  operationIdSchema,
  requestDigestSchema,
} from './primitives.ts';

/** 投递状态。 */
export const AUTOMATION_DELIVERY_STATES = [
  'received',
  'validated',
  'dispatching',
  'accepted',
  'completed',
  'failed',
  'unconfirmed',
] as const;

/** 投递状态取值。 */
export type AutomationDeliveryState = (typeof AUTOMATION_DELIVERY_STATES)[number];

/** 一次投递的性质。 */
export const AUTOMATION_DEDUPE_RESULTS = ['new', 'duplicate'] as const;

/** 去重结果取值。 */
export type AutomationDedupeResult = (typeof AUTOMATION_DEDUPE_RESULTS)[number];

/** 一条投递记录。 */
export const automationDeliverySchema = z.object({
  /** 投递标识。 */
  deliveryId: identifierSchema,
  /** 命中的自动化标识。 */
  automationId: identifierSchema,
  /** 外部事件标识；重复投递按它去重。 */
  eventId: identifierSchema,
  /** 来源。 */
  source: z.enum(AUTOMATION_EVENT_SOURCES),
  /** 接收时刻的毫秒时间戳。 */
  receivedAt: epochMillisSchema,
  /** 去重结果。 */
  dedupe: z.enum(AUTOMATION_DEDUPE_RESULTS),
  /** 当前状态。 */
  state: z.enum(AUTOMATION_DELIVERY_STATES),
  /** 建立的执行会话；尚未建立时缺省。 */
  sessionId: identifierSchema.optional(),
  /** 完成时刻的毫秒时间戳。 */
  completedAt: epochMillisSchema.optional(),
  /** 失败或未确认时的错误码。 */
  code: chatdshErrorCodeSchema.optional(),
});

/** 一条投递记录。 */
export type AutomationDelivery = z.infer<typeof automationDeliverySchema>;

/** 投递记录查询。 */
export const automationDeliveryQuerySchema = z.object({
  /** 自动化过滤。 */
  automationId: identifierSchema.optional(),
  /** 来源过滤。 */
  source: z.enum(AUTOMATION_EVENT_SOURCES).optional(),
  /** 状态过滤。 */
  state: z.enum(AUTOMATION_DELIVERY_STATES).optional(),
  /** 上一页游标。 */
  cursor: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/).optional(),
  /** 每页条数。 */
  limit: z.number().int().min(1).max(200).default(50),
});

/** 投递记录查询。 */
export type AutomationDeliveryQuery = z.infer<typeof automationDeliveryQuerySchema>;

/** 人工重试请求：沿用原事件标识的去重语义。 */
export const automationRetryRequestSchema = z.object({
  /** 原投递标识。 */
  deliveryId: identifierSchema,
  /** 原事件标识。 */
  eventId: identifierSchema,
  /** 操作标识。 */
  operationId: operationIdSchema,
  /** 请求摘要。 */
  requestDigest: requestDigestSchema,
});

/** 人工重试请求。 */
export type AutomationRetryRequest = z.infer<typeof automationRetryRequestSchema>;

/** 定时任务的互斥时间方式。 */
export const SCHEDULE_KINDS = ['once', 'interval', 'daily', 'weekly', 'cron'] as const;

/** 定时任务的互斥时间方式取值。 */
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

/** 间隔任务的最短间隔，单位秒。 */
export const SCHEDULE_MIN_INTERVAL_SECONDS = 60;

/** 单次任务。 */
export const onceScheduleSchema = z.object({
  kind: z.literal('once'),
  /** 发生时刻的毫秒时间戳。 */
  at: epochMillisSchema,
  /** IANA 时区。 */
  timeZone: ianaTimeZoneSchema,
});

/** 固定间隔任务。 */
export const intervalScheduleSchema = z.object({
  kind: z.literal('interval'),
  /** 间隔秒数，不少于 60 秒。 */
  everySeconds: z.number().int().min(SCHEDULE_MIN_INTERVAL_SECONDS),
  /** IANA 时区。 */
  timeZone: ianaTimeZoneSchema,
});

/** 每日任务。 */
export const dailyScheduleSchema = z.object({
  kind: z.literal('daily'),
  /** 每日发生时刻。 */
  time: clockTimeSchema,
  /** IANA 时区。 */
  timeZone: ianaTimeZoneSchema,
});

/** 每周任务。 */
export const weeklyScheduleSchema = z
  .object({
    kind: z.literal('weekly'),
    /** ISO 星期编号，周一为 1，周日为 7；不得重复。 */
    weekdays: z.array(z.number().int().min(1).max(7)).min(1),
    /** 发生时刻。 */
    time: clockTimeSchema,
    /** IANA 时区。 */
    timeZone: ianaTimeZoneSchema,
  })
  .refine((value) => new Set(value.weekdays).size === value.weekdays.length, {
    message: '星期编号不得重复',
    path: ['weekdays'],
  });

/** cron 任务。 */
export const cronScheduleSchema = z.object({
  kind: z.literal('cron'),
  /** 五段式 cron 表达式，由自动化宿主的成熟解析库校验。 */
  expression: z.string().min(5).max(200),
  /** IANA 时区。 */
  timeZone: ianaTimeZoneSchema,
});

/** 定时任务的触发方式。 */
export const scheduleSpecSchema = z.discriminatedUnion('kind', [
  onceScheduleSchema,
  intervalScheduleSchema,
  dailyScheduleSchema,
  weeklyScheduleSchema,
  cronScheduleSchema,
]);

/** 定时任务的触发方式。 */
export type ScheduleSpec = z.infer<typeof scheduleSpecSchema>;

/** 一条定时任务。 */
export const scheduleViewSchema = z.object({
  /** 定时任务标识。 */
  scheduleId: identifierSchema,
  /** 原会话标识；任务跟随原会话持久化。 */
  sessionId: identifierSchema,
  /** 名称。 */
  name: z.string().min(1).max(120),
  /** 提醒文本。 */
  prompt: z.string().min(1).max(4000),
  /** 触发方式。 */
  spec: scheduleSpecSchema,
  /** 是否启用。 */
  enabled: z.boolean(),
  /** 下次发生时刻的毫秒时间戳。 */
  nextRunAt: epochMillisSchema.optional(),
  /** 上次发生时刻的毫秒时间戳。 */
  lastRunAt: epochMillisSchema.optional(),
});

/** 一条定时任务。 */
export type ScheduleView = z.infer<typeof scheduleViewSchema>;
