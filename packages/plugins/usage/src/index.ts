/**
 * 用量：把每个会话的模型记账折叠成一份 token 用量读数。
 *
 * 记账跟着助手消息走（`assistant/message` 的 `usage`），因此这个投影只在该事件上改变状态，
 * 其余事件返回同一引用，不产生下游工作。控制平面按会话、工作区与设备三个维度聚合它。
 * @module @chatdsh/plugin-usage
 */

import type { Context } from '@chatdsh/adapter';
import { z } from 'zod';
import type { ChatdshUsageState } from './types.ts';

export type { ChatdshUsageState } from './types.ts';

/** 插件名。 */
export const name = 'chatdsh-usage';

/** 依赖的服务：投影注册表。 */
export const inject = ['sessionProjections'];

/** 投影键。 */
export const PROJECTION_KEY = 'chatdshUsage';

/** 投影状态版本。 */
export const STATE_VERSION = 1;

/** 状态 schema。 */
export const stateSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  accountedSteps: z.number().int().nonnegative(),
  reportedSteps: z.number().int().nonnegative(),
});

/** 初始状态：全部为零。 */
export const EMPTY_USAGE: ChatdshUsageState = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  accountedSteps: 0,
  reportedSteps: 0,
};

/**
 * 注册用量投影。
 * @param ctx - 宿主上下文，提供 `sessionProjections`。
 * @returns 注销函数。
 */
export function apply(ctx: Context): () => void {
  return ctx.sessionProjections.register({
    key: PROJECTION_KEY,
    stateVersion: STATE_VERSION,
    stateSchema,
    init: () => EMPTY_USAGE,
    apply: (state, event) => {
      if (event.type !== 'assistant/message') return state;
      const usage = event.data.usage;
      if (usage === undefined) return state;
      return {
        inputTokens: state.inputTokens + usage.inputTokens,
        outputTokens: state.outputTokens + usage.outputTokens,
        cacheReadTokens: state.cacheReadTokens + (usage.cacheReadTokens ?? 0),
        cacheWriteTokens: state.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
        accountedSteps: state.accountedSteps + (usage.totalTokens === undefined ? 0 : 1),
        reportedSteps: state.reportedSteps + 1,
      };
    },
    wire: {
      viewSchema: stateSchema,
      view: (state) => state,
    },
  });
}
