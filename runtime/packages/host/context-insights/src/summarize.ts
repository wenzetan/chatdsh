/**
 * 上下文占用的判定规则。
 *
 * 这一层是纯函数：给定事件数、两个 token 计数与窗口大小，算出占用比例、三档等级与剩余
 * 空间。它不知道 token 从哪来，也不做任何 I/O，因此可以单独验证。
 * @module @chatdsh/host-context-insights/summarize
 */

/** 占用等级。 */
export type ContextLevel = 'ok' | 'warn' | 'critical';

/** 一次洞察结果。 */
export interface ContextInsight {
  /** 已用与窗口的比例；超过窗口时大于 1。 */
  readonly usedRatio: number;
  /** 三档等级。 */
  readonly level: ContextLevel;
  /** 剩余可用 token；已超出时为零。 */
  readonly remainingTokens: number;
}

/** 输入。 */
export interface ContextInsightInput {
  /** 会话事件数，用于界面显示规模。 */
  readonly events: number;
  /** 已用的输入 token。 */
  readonly inputTokens: number;
  /** 已用的输出 token。 */
  readonly outputTokens: number;
  /** 当前模型或配置给出的上下文窗口。 */
  readonly windowTokens: number;
}

/** 进入 warn 的比例下限。 */
export const WARN_RATIO = 0.7;

/** 进入 critical 的比例下限。 */
export const CRITICAL_RATIO = 0.9;

/**
 * 计算一次上下文占用洞察。
 * @param input - 事件数、两个 token 计数与窗口大小。
 * @returns 占用比例、等级与剩余 token。
 * @throws 窗口不大于零时抛出，避免把「没有窗口」当成「占用为零」。
 */
export function summarizeContext(input: ContextInsightInput): ContextInsight {
  if (!Number.isFinite(input.windowTokens) || input.windowTokens <= 0) {
    throw new Error(`上下文窗口必须大于零，收到 ${String(input.windowTokens)}`);
  }
  const used = input.inputTokens + input.outputTokens;
  const usedRatio = used / input.windowTokens;
  const level: ContextLevel = usedRatio >= CRITICAL_RATIO ? 'critical' : usedRatio >= WARN_RATIO ? 'warn' : 'ok';
  return {
    usedRatio,
    level,
    remainingTokens: Math.max(0, input.windowTokens - used),
  };
}
