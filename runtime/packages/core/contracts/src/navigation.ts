/**
 * 导航消息与命令面板契约。
 *
 * 外壳与设备内容端通过经过校验的消息通道导航；消息携带版本、请求标识、目标设备与会话，
 * 校验 `origin`、`source` 与消息 schema 之后才接受导航，未知动作直接拒绝。命令面板按当前
 * 设备、会话与能力过滤，最近使用只保存命令标识。
 * @module @chatdsh/core-contracts/navigation
 */

import { z } from 'zod';
import { chatdshErrorCodeSchema } from './errors.ts';
import { epochMillisSchema, identifierSchema } from './primitives.ts';

/** 导航消息的协议版本。 */
export const NAVIGATION_MESSAGE_VERSION = 1;

/** 导航确认的等待时限，单位毫秒。 */
export const NAVIGATION_TIMEOUT_MS = 5000;

/** 内容端允许接收的动作。 */
export const NAVIGATION_ACTIONS = ['navigate', 'query-selection', 'query-capabilities', 'set-readonly'] as const;

/** 内容端允许接收的动作取值。 */
export type NavigationAction = (typeof NAVIGATION_ACTIONS)[number];

/** 外壳发往内容端的消息。 */
export const shellMessageSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('navigate'),
    /** 协议版本。 */
    version: z.literal(NAVIGATION_MESSAGE_VERSION),
    /** 请求标识，用于匹配确认。 */
    requestId: identifierSchema,
    /** 目标设备。 */
    deviceId: identifierSchema,
    /** 目标会话。 */
    sessionId: identifierSchema,
  }),
  z.object({
    action: z.literal('query-selection'),
    version: z.literal(NAVIGATION_MESSAGE_VERSION),
    requestId: identifierSchema,
    deviceId: identifierSchema,
  }),
  z.object({
    action: z.literal('query-capabilities'),
    version: z.literal(NAVIGATION_MESSAGE_VERSION),
    requestId: identifierSchema,
    deviceId: identifierSchema,
  }),
  z.object({
    action: z.literal('set-readonly'),
    version: z.literal(NAVIGATION_MESSAGE_VERSION),
    requestId: identifierSchema,
    deviceId: identifierSchema,
    /** 只读原因。 */
    reason: z.enum(['device-offline', 'replica-only', 'public-snapshot', 'permission']),
  }),
]);

/** 外壳发往内容端的消息。 */
export type ShellMessage = z.infer<typeof shellMessageSchema>;

/** 内容端回给外壳的确认。 */
export const frameMessageSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('selected'),
    /** 对应的请求标识。 */
    requestId: identifierSchema,
    /** 内容端所属设备。 */
    deviceId: identifierSchema,
    /** 当前选中的会话。 */
    sessionId: identifierSchema,
  }),
  z.object({
    outcome: z.literal('rejected'),
    /** 对应的请求标识。 */
    requestId: identifierSchema,
    /** 拒绝原因。 */
    code: chatdshErrorCodeSchema,
  }),
]);

/** 内容端回给外壳的确认。 */
export type FrameMessage = z.infer<typeof frameMessageSchema>;

/** 消息通道的校验参数。 */
export const messageGuardSchema = z.object({
  /** 握手登记的来源，与消息的 `source` 完全相等。 */
  sourceOrigin: z.string().min(1),
  /** 期望的 `origin`。 */
  expectedOrigin: z.string().min(1),
  /** 内容端已完成握手。 */
  handshakeComplete: z.boolean(),
});

/** 消息通道的校验参数。 */
export type MessageGuard = z.infer<typeof messageGuardSchema>;

/** 命令作用范围。 */
export const COMMAND_SCOPES = ['global', 'session', 'device'] as const;

/** 命令作用范围取值。 */
export type CommandScope = (typeof COMMAND_SCOPES)[number];

/** 一个命令。 */
export const commandDescriptorSchema = z.object({
  /** 命令标识。 */
  id: identifierSchema,
  /** 展示名称。 */
  name: z.string().min(1).max(120),
  /** 分组。 */
  group: z.string().min(1).max(120),
  /** 说明。 */
  description: z.string().max(300).optional(),
  /** 快捷键提示。 */
  shortcut: z.string().max(60).optional(),
  /** 作用范围。 */
  scope: z.enum(COMMAND_SCOPES),
  /** 是否可用。 */
  enabled: z.boolean(),
  /** 禁用原因；可用时缺省。 */
  disabledReason: z.string().max(200).optional(),
});

/** 一个命令。 */
export type CommandDescriptor = z.infer<typeof commandDescriptorSchema>;

/** 命令查询。 */
export const commandQuerySchema = z.object({
  /** 输入文本。 */
  text: z.string().max(200),
  /** 当前设备；按设备能力过滤时携带。 */
  deviceId: identifierSchema.optional(),
  /** 当前会话；按会话能力过滤时携带。 */
  sessionId: identifierSchema.optional(),
  /** 返回条数上限。 */
  limit: z.number().int().min(1).max(100).default(50),
});

/** 命令查询。 */
export type CommandQuery = z.infer<typeof commandQuerySchema>;

/** 命令查询结果。 */
export const commandListSchema = z.object({
  items: z.array(commandDescriptorSchema),
  /** 读取时刻的毫秒时间戳。 */
  readAt: epochMillisSchema,
});

/** 命令查询结果。 */
export type CommandList = z.infer<typeof commandListSchema>;

/** 最近使用命令的保存上限。 */
export const RECENT_COMMANDS_MAX = 20;

/** 最近使用命令：只保存命令标识。 */
export const recentCommandsSchema = z.object({
  ids: z.array(identifierSchema).max(RECENT_COMMANDS_MAX),
});

/** 最近使用命令。 */
export type RecentCommands = z.infer<typeof recentCommandsSchema>;

/** 首次引导的步骤。 */
export const ONBOARDING_STEPS = ['welcome', 'model', 'workspace', 'assistant'] as const;

/** 首次引导的步骤取值。 */
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** 首次引导进度。 */
export const onboardingProgressSchema = z.object({
  /** 已完成的步骤。 */
  completed: z.array(z.enum(ONBOARDING_STEPS)),
  /** 当前步骤。 */
  current: z.enum(ONBOARDING_STEPS),
  /** 已跳过的步骤。 */
  skipped: z.array(z.enum(ONBOARDING_STEPS)),
  /** 关闭时刻的毫秒时间戳；重新打开时清除。 */
  dismissedAt: epochMillisSchema.optional(),
});

/** 首次引导进度。 */
export type OnboardingProgress = z.infer<typeof onboardingProgressSchema>;

/** 引导的完成度，取已完成与已跳过步骤数之和。 */
export function onboardingCompletedCount(progress: OnboardingProgress): number {
  return new Set<OnboardingStep>([...progress.completed, ...progress.skipped]).size;
}
