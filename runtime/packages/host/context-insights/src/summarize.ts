/**
 * 上下文占用的判定规则。
 *
 * 这一层是纯函数：给定事件数、两个 token 计数、窗口大小与窗口来源，算出占用比例、三档
 * 等级与剩余空间。它不知道 token 从哪来，也不做任何 I/O，因此可以单独验证。
 * @module @chatdsh/host-context-insights/summarize
 */

/** 占用等级。 */
export type ContextLevel = 'ok' | 'warn' | 'critical';

/** 窗口的来源。模型目录给出窗口时为 `model-catalog`，回落到部署配置时为 `config`。 */
export type WindowSource = 'model-catalog' | 'config';

/** 窗口降级的原因。 */
export type WindowReason =
  | 'catalog-unsupported'
  | 'no-session-model'
  | 'router-unavailable'
  | 'model-lookup-failed';

/** 一次查询使用的上下文窗口。 */
export interface ContextWindow {
  /** 窗口的 token 数。 */
  readonly tokens: number;
  /** 窗口来源。 */
  readonly source: WindowSource;
  /** 是否降级：比例按回落的窗口算。 */
  readonly degraded: boolean;
  /** 降级原因；未降级时缺省。 */
  readonly reason?: WindowReason;
  /** 窗口所属的 provider；没有会话模型时缺省。 */
  readonly provider?: string;
  /** 窗口所属的模型；没有会话模型时缺省。 */
  readonly model?: string;
  /** 模型元数据读取失败时的错误码。 */
  readonly errorCode?: string;
}

/** 一次洞察结果。 */
export interface ContextInsight {
  /** 已用与窗口的比例；超过窗口时大于 1。 */
  readonly usedRatio: number;
  /** 三档等级。 */
  readonly level: ContextLevel;
  /** 剩余可用 token；已超出时为零。 */
  readonly remainingTokens: number;
  /** 已用的 token 数，等于输入与输出之和。 */
  readonly usedTokens: number;
  /** 计算比例用的窗口大小。 */
  readonly windowTokens: number;
  /** 会话事件数，用于界面显示规模。 */
  readonly events: number;
  /** token 计数的来源。用量投影没有装载时为 `unavailable`，此时已用量按零算。 */
  readonly tokensSource: 'usage-projection' | 'unavailable';
  /** 窗口与它的来源。 */
  readonly window: ContextWindow;
}

/** 输入。 */
export interface ContextInsightInput {
  /** 会话事件数，用于界面显示规模。 */
  readonly events: number;
  /** 已用的输入 token。 */
  readonly inputTokens: number;
  /** 已用的输出 token。 */
  readonly outputTokens: number;
  /** 窗口与来源。 */
  readonly window: ContextWindow;
  /** token 计数的来源。 */
  readonly tokensSource: 'usage-projection' | 'unavailable';
}

/** 进入 warn 的比例下限。 */
export const WARN_RATIO = 0.7;

/** 进入 critical 的比例下限。 */
export const CRITICAL_RATIO = 0.9;

/**
 * 计算一次上下文占用洞察。
 * @param input - 事件数、两个 token 计数、窗口与来源。
 * @returns 占用比例、等级、剩余 token 与来源。
 * @throws 窗口不大于零时抛出，避免把「没有窗口」当成「占用为零」。
 */
export function summarizeContext(input: ContextInsightInput): ContextInsight {
  const windowTokens = input.window.tokens;
  if (!Number.isFinite(windowTokens) || windowTokens <= 0) {
    throw new Error(`上下文窗口必须大于零，收到 ${String(windowTokens)}`);
  }
  const used = input.inputTokens + input.outputTokens;
  const usedRatio = used / windowTokens;
  const level: ContextLevel = usedRatio >= CRITICAL_RATIO ? 'critical' : usedRatio >= WARN_RATIO ? 'warn' : 'ok';
  return {
    usedRatio,
    level,
    remainingTokens: Math.max(0, windowTokens - used),
    usedTokens: used,
    windowTokens,
    events: input.events,
    tokensSource: input.tokensSource,
    window: input.window,
  };
}

/**
 * 部署配置给的窗口。
 * @param tokens - 配置里的窗口大小。
 * @param reason - 回落的原因。
 * @returns 降级的窗口。
 */
export function fallbackWindow(tokens: number, reason: WindowReason): ContextWindow {
  return { tokens, source: 'config', degraded: true, reason };
}
