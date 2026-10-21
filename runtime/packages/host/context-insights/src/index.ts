/**
 * 上下文占用洞察。
 *
 * 读两个投影：会话索引给出事件规模，用量投影给出输入与输出 token。窗口取配置值，默认
 * 按当前主流的 128K 模型给 131072。服务只读，不写回任何状态；会话不存在时就地抛出，
 * 不用默认值掩盖失效的会话标识。
 * @module @chatdsh/host-context-insights
 */

import { Remote, schema as z, sessionProjectionsOf, sessionsOf, telemetryOf, TypertRemoteService, type Context, type SessionId } from '@chatdsh/adapter';
// 投影键的类型增强来自这两个包：接入本插件时要能解析它们的声明合并。
import type {} from '@deepseek-ai/dsh-session-projection';
import type { ChatdshSessionIndexState } from '@chatdsh/core-session-index/types';
import type { ChatdshUsageState } from '@chatdsh/host-usage/types';
import { summarizeContext, type ContextInsight } from './summarize.ts';

export { CRITICAL_RATIO, summarizeContext, WARN_RATIO } from './summarize.ts';
export type { ContextInsight, ContextInsightInput, ContextLevel } from './summarize.ts';

/** 插件名。 */
export const name = 'chatdsh-context-insights';

/** 服务名，同时是 Remote 命名空间。 */
export const SERVICE_NAME = 'chatdshContextInsights';

/** 会话索引投影键。 */
export const SESSION_INDEX_PROJECTION = 'chatdshSessionIndex';

/** 用量投影键。 */
export const USAGE_PROJECTION = 'chatdshUsage';

/** 配置。 */
export interface ContextInsightsConfig {
  /** 上下文窗口的 token 数。 */
  readonly windowTokens: number;
}

/** 配置 schema。 */
export const Config: z<ContextInsightsConfig> = z.object({
  windowTokens: z.number().min(1).default(131072),
});

/** 用到的遥测面。 */
interface InsightTelemetry {
  runSpan<T>(name: string, attributes: Record<string, unknown>, body: (span: { setAttribute(key: string, value: unknown): void }) => Promise<T>): Promise<T>;
  event(name: string, attributes?: Record<string, unknown>): void;
  gauge(name: string, options?: { description: string }): { record(value: number, attributes?: Record<string, unknown>): void };
}

/**
 * 上下文占用服务。
 */
export class ChatdshContextInsightsService extends TypertRemoteService {
  /** 配置 schema，供加载器校验。 */
  static readonly Config = Config;

  constructor(ctx: Context, private readonly config: ContextInsightsConfig) {
    super(ctx, SERVICE_NAME);
  }

  /** 一个会话的占用洞察。 */
  @Remote('insight')
  insight(sessionId: string): Promise<ContextInsight> {
    return this.insightOf(sessionId);
  }

  /** 全部会话的占用洞察，键是会话标识。 */
  @Remote('all')
  async all(): Promise<Record<string, ContextInsight>> {
    const out: Record<string, ContextInsight> = {};
    for (const session of sessionsOf(this.ctx).list()) {
      out[session.id] = await this.insightOf(session.id);
    }
    return out;
  }

  private async insightOf(sessionId: string): Promise<ContextInsight> {
    const session = sessionsOf(this.ctx).get(sessionId as SessionId);
    if (session === undefined) throw new Error(`会话不存在：${sessionId}`);
    const registry = sessionProjectionsOf(this.ctx);
    const index: ChatdshSessionIndexState | undefined = registry.stateOf(session, SESSION_INDEX_PROJECTION);
    const usage: ChatdshUsageState | undefined = registry.stateOf(session, USAGE_PROJECTION);
    const telemetry = telemetryOf<InsightTelemetry>(this.ctx);
    const run = async (span?: { setAttribute(key: string, value: unknown): void }): Promise<ContextInsight> => {
      try {
        const insight = summarizeContext({
          events: index?.events ?? 0,
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          windowTokens: this.config.windowTokens,
        });
        span?.setAttribute('outcome', 'ok');
        telemetry?.gauge('chatdsh_context_usage_ratio', { description: '上下文占用比例' }).record(insight.usedRatio, { level: insight.level });
        return insight;
      } catch (error) {
        // 失败即抛出，不再补一条同名事件：同名的事件行不是 span，check-telemetry 会把它当成
        // 未登记的事件名。span 的 outcome 与 error 属性已足够定位。
        span?.setAttribute('outcome', 'failed');
        span?.setAttribute('error.type', error instanceof Error ? error.name : 'Unknown');
        span?.setAttribute('error.code', 'context-window-invalid');
        throw error;
      }
    };

    if (telemetry === undefined) return run();
    return telemetry.runSpan('chatdsh.runtime.context.insight', { 'session.id': sessionId }, run);
  }
}

/** 注册服务。 */
export function apply(ctx: Context, config: ContextInsightsConfig): void {
  ctx.plugin(ChatdshContextInsightsService, config);
}
