/**
 * 上游事件名的唯一登记处。
 *
 * 事件名是字符串，上游改名不会在编译期报错，只会在运行期变成「监听器收不到事件」。
 * 把它们收在这里，升级时只改这一处，并在类型层面限定取值集合。
 * @module @chatdsh/adapter/events
 */

/** agent 生命周期事件。 */
export const AGENT_EVENTS = {
  /** 一个 agent 建立：可在此为它注册提示席位。 */
  created: 'agent/created',
  /** 每一步开始前：waterfall，可在此按当前问题做召回。 */
  preStep: 'agent/pre-step',
} as const;

/** agent 事件名的取值集合。 */
export type AgentEventName = typeof AGENT_EVENTS[keyof typeof AGENT_EVENTS];

/** 会话生命周期事件。 */
export const SESSION_EVENTS = {
  /** 会话进入 store 并广播：用于补齐副本。 */
  created: 'session/created',
  /** 每个已提交事件：用于上报与投影驱动。 */
  event: 'session/event',
} as const;

/** 会话事件名的取值集合。 */
export type SessionEventName = typeof SESSION_EVENTS[keyof typeof SESSION_EVENTS];

/** 审批事件。 */
export const APPROVAL_EVENTS = {
  /** 一次审批请求：waterfall，返回结果即认领该请求。 */
  request: 'approval/request',
} as const;

/** 审批事件名的取值集合。 */
export type ApprovalEventName = typeof APPROVAL_EVENTS[keyof typeof APPROVAL_EVENTS];

/**
 * 会话日志里的事件类型名。
 *
 * 这些是落进会话日志的 `type` 值，投影与统计按它们分派。上游新增类型时这里
 * 不需要跟着加——投影遇到不认识的事件类型应当忽略而不是报错，但已用到的
 * 类型必须在这里登记，避免字面量散落。
 */
export const SESSION_EVENT_TYPES = {
  userMessage: 'user/message',
  assistantMessage: 'assistant/message',
  toolCall: 'tool/call',
  toolResult: 'tool/result',
  turnStart: 'turn/start',
  turnEnd: 'turn/end',
  stepStart: 'step/start',
  stepEnd: 'step/end',
  approvalAsked: 'approval/asked',
  approvalDecided: 'approval/decided',
} as const;

/** 会话事件类型名的取值集合。 */
export type SessionEventType = typeof SESSION_EVENT_TYPES[keyof typeof SESSION_EVENT_TYPES];
