/**
 * 上下文占用洞察。
 *
 * 读两个投影：会话索引给出事件规模，用量投影给出输入与输出 token。窗口优先取会话固定模型
 * 在模型目录里披露的上下文长度；目录没有披露、会话没有固定模型或路由未装载时回落到部署
 * 配置的窗口，并在结果里写明降级原因，不把回落当成模型目录的真实读数。
 *
 * 服务只读，不写回任何状态；会话不存在时就地抛出，不用默认值掩盖失效的会话标识。
 * @module @chatdsh/host-context-insights
 */

import {
  llmOf,
  Remote,
  schema as z,
  sessionProjectionsOf,
  sessionsOf,
  telemetryOf,
  TypertRemoteService,
  type Context,
  type LlmResolvedModelInfo,
  type SessionId,
} from '@chatdsh/adapter';
import { ChatdshError, CHATDSH_ERROR_CODES } from '@chatdsh/core-contracts';
// 投影键的类型增强来自这两个包：接入本插件时要能解析它们的声明合并。
import type {} from '@deepseek-ai/dsh-session-projection';
import type { ChatdshSessionIndexState } from '@chatdsh/core-session-index/types';
import type { ChatdshUsageState } from '@chatdsh/host-usage/types';
import { fallbackWindow, summarizeContext, type ContextInsight, type ContextWindow } from './summarize.ts';

export { CRITICAL_RATIO, fallbackWindow, summarizeContext, WARN_RATIO } from './summarize.ts';
export type {
  ContextInsight,
  ContextInsightInput,
  ContextLevel,
  ContextWindow,
  WindowReason,
  WindowSource,
} from './summarize.ts';

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
  /** 上下文窗口的 token 数，模型目录没有披露时回落到它。 */
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
  counter(name: string, options?: { description: string }): { add(delta: number, attributes?: Record<string, unknown>): void };
}

/** 会话固定模型的读取面。 */
interface SessionModelFace {
  sessionModel(sessionId: string): Promise<{ provider: string; model: string } | undefined>;
}

/** 服务对外的一个动作名字。 */
type InsightAction = 'insight' | 'all';

/**
 * 上下文占用服务。
 */
export class ChatdshContextInsightsService extends TypertRemoteService {
  /** 配置 schema，供加载器校验。 */
  static readonly Config = Config;

  /** 依赖的服务：两个投影的读面、会话注册表与模型运行时。 */
  static inject = ['sessionProjections', 'sessions', 'llm'];

  constructor(ctx: Context, private readonly config: ContextInsightsConfig) {
    super(ctx, SERVICE_NAME);
  }

  /** 一个会话的占用洞察。 */
  @Remote('insight')
  async insight(sessionId: string): Promise<ContextInsight> {
    return this.access('insight', async () => this.insightOf(sessionId));
  }

  /** 全部会话的占用洞察，键是会话标识。 */
  @Remote('all')
  async all(): Promise<Record<string, ContextInsight>> {
    return this.access('all', async () => {
      const out: Record<string, ContextInsight> = {};
      for (const session of sessionsOf(this.ctx).list()) {
        out[session.id] = await this.insightOf(session.id);
      }
      return out;
    });
  }

  /** 计算一个会话的占用。 */
  private async insightOf(sessionId: string): Promise<ContextInsight> {
    const session = sessionsOf(this.ctx).get(sessionId as SessionId);
    if (session === undefined) throw new ChatdshError('session-not-found', '会话不存在', { sessionId });
    const registry = sessionProjectionsOf(this.ctx);
    const index: ChatdshSessionIndexState | undefined = registry.stateOf(session, SESSION_INDEX_PROJECTION);
    const usage: ChatdshUsageState | undefined = registry.stateOf(session, USAGE_PROJECTION);
    const window = await this.windowOf(sessionId);
    const compute = async (span?: { setAttribute(key: string, value: unknown): void }): Promise<ContextInsight> => {
      try {
        const insight = summarizeContext({
          events: index?.events ?? 0,
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          window,
          tokensSource: usage === undefined ? 'unavailable' : 'usage-projection',
        });
        span?.setAttribute('outcome', 'ok');
        telemetryOf<InsightTelemetry>(this.ctx)?.gauge('chatdsh_context_usage_ratio', { description: '上下文占用比例' })
          .record(insight.usedRatio, { level: insight.level });
        return insight;
      } catch (error) {
        // 失败即抛出。span 只带登记过的 `session.id` 与 `outcome`，错误码交给 Remote 调用计数，
        // 免得同名事件行被 check-telemetry 当成未登记的信号名。
        span?.setAttribute('outcome', 'failed');
        throw error;
      }
    };
    const telemetry = telemetryOf<InsightTelemetry>(this.ctx);
    if (telemetry === undefined) return compute();
    return telemetry.runSpan('chatdsh.runtime.context.insight', { 'session.id': sessionId }, compute);
  }

  /**
   * 取一个会话的上下文窗口。
   *
   * 会话固定的模型由模型路由服务给出；模型目录披露了上下文长度就用它，没有披露、会话
   * 还没有固定模型、路由服务没有装载或路由已不在时回落到配置窗口，并写明原因。
   * @param sessionId - 会话标识。
   * @returns 窗口与来源。
   */
  private async windowOf(sessionId: string): Promise<ContextWindow> {
    const router = this.ctx.reflect.get('chatdshLlmRouter') as SessionModelFace | undefined;
    if (router === undefined) return fallbackWindow(this.config.windowTokens, 'router-unavailable');
    const binding = await router.sessionModel(sessionId);
    if (binding === undefined) return fallbackWindow(this.config.windowTokens, 'no-session-model');
    let info: LlmResolvedModelInfo;
    try {
      info = await llmOf(this.ctx).resolveModelInfo(binding.provider, binding.model);
    } catch (error) {
      return {
        ...fallbackWindow(this.config.windowTokens, 'model-lookup-failed'),
        provider: binding.provider,
        model: binding.model,
        errorCode: errorCodeOf(error),
      };
    }
    const tokens = info.context?.contextWindow;
    if (tokens === undefined || !Number.isFinite(tokens) || tokens <= 0) {
      return {
        ...fallbackWindow(this.config.windowTokens, 'catalog-unsupported'),
        provider: binding.provider,
        model: binding.model,
      };
    }
    return { tokens, source: 'model-catalog', degraded: false, provider: binding.provider, model: binding.model };
  }

  /**
   * 跑一次带遥测的 Remote 动作：成功记 `outcome=ok`，失败记错误码与计数。
   * @param action - 动作名，写进 `rpc.method`。
   * @param body - 动作本体。
   * @returns 动作结果。
   */
  private async access<T>(action: InsightAction, body: () => Promise<T>): Promise<T> {
    const telemetry = telemetryOf<InsightTelemetry>(this.ctx);
    if (telemetry === undefined) return body();
    const method = `${SERVICE_NAME}/${action}`;
    const counter = telemetry.counter('chatdsh_remote_calls_total', { description: 'Remote 调用数' });
    return telemetry.runSpan('chatdsh.runtime.remote.call', { 'rpc.method': method }, async (span) => {
      try {
        const result = await body();
        span.setAttribute('outcome', 'ok');
        counter.add(1, { method, outcome: 'ok' });
        return result;
      } catch (error) {
        const type = error instanceof Error ? error.name : 'Unknown';
        const code = error instanceof ChatdshError ? error.code : errorCodeOf(error);
        span.setAttribute('outcome', 'failed');
        counter.add(1, { method, outcome: 'failed', error_code: code, error_type: type });
        throw error;
      }
    });
  }
}

/** 从异常取稳定错误码。 */
function errorCodeOf(error: unknown): string  {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code !== '') return code;
  }
  return CHATDSH_ERROR_CODES.internalError;
}

/** 注册服务。 */
export function apply(ctx: Context, config: ContextInsightsConfig): void {
  ctx.plugin(ChatdshContextInsightsService, config);
}

export default ChatdshContextInsightsService;
