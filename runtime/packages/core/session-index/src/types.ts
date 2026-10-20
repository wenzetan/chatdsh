/**
 * 会话索引投影的类型与声明合并。
 *
 * 投影键注册进 `SessionProjectionStateMap` 与 `SessionProjectionMap`：前者是宿主的折叠状态，
 * 后者是对客户端可见的取值。状态必须是纯 JSON，投影缓存才能持久化它。
 * @module @chatdsh/core-session-index/types
 */

import type {} from '@deepseek-ai/dsh-session-projection';

/** 会话索引状态。会话列表、检索与用量视图都读它。 */
export interface ChatdshSessionIndexState {
  /** 已提交事件总数。 */
  events: number;
  /** 用户消息条数。 */
  userMessages: number;
  /** 助手消息条数。 */
  assistantMessages: number;
  /** 工具调用条数。 */
  toolCalls: number;
  /** 工具结果条数。 */
  toolResults: number;
  /** 回合数。 */
  turns: number;
  /** 步骤数。 */
  steps: number;
  /** 会话创建时刻的毫秒时间戳。 */
  createdAt: number;
  /** 最后一个事件的时刻，没有事件时等于创建时刻。 */
  lastActivityAt: number;
}

declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionMap {
    chatdshSessionIndex: ChatdshSessionIndexState;
  }

  interface SessionProjectionStateMap {
    chatdshSessionIndex: ChatdshSessionIndexState;
  }
}
