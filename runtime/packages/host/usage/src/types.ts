/**
 * 用量投影的类型与声明合并。
 * @module @chatdsh/host-usage/types
 */

import type {} from '@deepseek-ai/dsh-session-projection';

/** 会话级的 token 用量。模型适配器未报告记账时全部保持为零。 */
export interface ChatdshUsageState {
  /** 提示侧 token 数。 */
  inputTokens: number;
  /** 生成侧 token 数。 */
  outputTokens: number;
  /** 命中缓存的读取 token 数。 */
  cacheReadTokens: number;
  /** 写入缓存的 token 数。 */
  cacheWriteTokens: number;
  /** 报告了完整总量的步数。 */
  accountedSteps: number;
  /** 报告过记账的步骤数（含只报告了输入输出、没有总量的步骤）。 */
  reportedSteps: number;
}

declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionMap {
    chatdshUsage: ChatdshUsageState;
  }

  interface SessionProjectionStateMap {
    chatdshUsage: ChatdshUsageState;
  }
}
