/**
 * 上游事件名的唯一登记处。
 * @module @chatdsh/adapter/events
 */

/** 会话生命周期事件。 */
export const SESSION_EVENTS = {
  /** 会话进入 store 并广播：用于补齐副本。 */
  created: 'session/created',
  /** 每个已提交事件：用于增量上报副本。 */
  event: 'session/event',
} as const;

/** 会话事件名的取值集合。 */
export type SessionEventName = typeof SESSION_EVENTS[keyof typeof SESSION_EVENTS];

/** 会话日志里的事件类型名。 */
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
