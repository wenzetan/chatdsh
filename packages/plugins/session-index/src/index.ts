/**
 * 会话索引：把每个会话的事件流折叠成一份可供列表、检索与用量视图读取的索引。
 *
 * 索引关心每一个已提交事件（事件总数与最后活动时间是列表排序的依据），因此 `apply` 对任何
 * 事件都返回新状态；折叠是纯同步函数，不持有订阅，也不做 I/O。
 * @module @chatdsh/plugin-session-index
 */

import type { Context } from '@chatdsh/adapter';
import { z } from 'zod';
import type { ChatdshSessionIndexState } from './types.ts';

export type { ChatdshSessionIndexState } from './types.ts';

/** 插件名。 */
export const name = 'chatdsh-session-index';

/** 依赖的服务：投影注册表。 */
export const inject = ['sessionProjections'];

/** 投影键。 */
export const PROJECTION_KEY = 'chatdshSessionIndex';

/** 投影状态版本。折叠语义或字段变化时递增，使旧缓存行被丢弃。 */
export const STATE_VERSION = 1;

/** 状态 schema。 */
export const stateSchema = z.object({
  events: z.number().int().nonnegative(),
  userMessages: z.number().int().nonnegative(),
  assistantMessages: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  toolResults: z.number().int().nonnegative(),
  turns: z.number().int().nonnegative(),
  steps: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  lastActivityAt: z.number().int().nonnegative(),
});

/** 空会话的初始状态。 */
export function initialState(createdAt: number): ChatdshSessionIndexState {
  return {
    events: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    turns: 0,
    steps: 0,
    createdAt,
    lastActivityAt: createdAt,
  };
}

/**
 * 注册会话索引投影。
 * @param ctx - 宿主上下文，提供 `sessionProjections`。
 * @returns 注销函数。
 */
export function apply(ctx: Context): () => void {
  return ctx.sessionProjections.register({
    key: PROJECTION_KEY,
    stateVersion: STATE_VERSION,
    stateSchema,
    init: (header) => initialState(header.createdAt),
    apply: (state, event) => {
      const next: ChatdshSessionIndexState = {
        ...state,
        events: state.events + 1,
        lastActivityAt: event.time,
      };
      switch (event.type) {
        case 'user/message':
          return { ...next, userMessages: state.userMessages + 1 };
        case 'assistant/message':
          return { ...next, assistantMessages: state.assistantMessages + 1 };
        case 'tool/call':
          return { ...next, toolCalls: state.toolCalls + 1 };
        case 'tool/result':
          return { ...next, toolResults: state.toolResults + 1 };
        case 'turn/start':
          return { ...next, turns: state.turns + 1 };
        case 'step/start':
          return { ...next, steps: state.steps + 1 };
        default:
          return next;
      }
    },
    wire: {
      viewSchema: stateSchema,
      view: (state) => state,
    },
  });
}
