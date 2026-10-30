/**
 * 模型路由器宿主插件。
 *
 * 把控制平面的模型入口注册成 DSH 的模型适配器：每条路由一个实例，`stream()` 入口先做
 * 额度检查，再转发到 `POST /chatdsh/gateway/llm`。拒绝使用 `QUOTA` 错误码，调用方的
 * 重试按不可恢复失败处理。
 *
 * 每次请求一个 `chatdsh.llm.stream` span，失败补 `error.type` 与 `error.code`；额度拒绝
 * 另记 `chatdsh.llm.quota.rejected` 事件。用量与耗时进入 6.4 节登记的三条指标。
 * @module @chatdsh/host-llm-router
 */

import {
  LlmAdapter,
  llmOf,
  Service,
  schema as z,
  telemetryOf,
  type Context,
  type GenerateOptions,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@chatdsh/adapter';
import { CHATDSH_ERROR_CODES } from '@chatdsh/core-contracts';
import { GatewayLlmAdapter } from './adapter.ts';
import { resolveRouterRoute, type RouterRoute } from './config.ts';
import { LlmQuotaError } from './quota.ts';

export { GatewayLlmAdapter } from './adapter.ts';
export { probeRoute } from './probe.ts';
export type { ProbeResult } from './probe.ts';
export type { GatewayLlmAdapterOptions } from './adapter.ts';
export { LlmRouterConfigError, resolveRouterRoute } from './config.ts';
export type { RouterRoute, RouterRouteInput } from './config.ts';
export { LlmUpstreamError, mapUpstreamFailure } from './errors.ts';
export type { UpstreamFailureInput } from './errors.ts';
export { createQuotaGuard, LlmQuotaError } from './quota.ts';
export type { QuotaGuard, QuotaLimit, QuotaReading } from './quota.ts';

/** 插件名。 */
export const name = 'chatdsh-llm-router';

/** 配置里的一条路由；入口地址在顶层统一给出。 */
export interface RouterRouteEntry {
  /** provider 路由标识，与控制平面注册的提供方一致。 */
  readonly provider: string;
  /** 该路由的额度上限。 */
  readonly limit?: number;
  /** 该路由启动时的已用额度。 */
  readonly used?: number;
}

/** 配置。 */
export interface LlmRouterConfig {
  /**
   * 模型入口地址；所有路由共用一个入口。入口按请求里的 provider 转发，因此一条
   * 路由器可以接管多个 provider。
   */
  readonly baseUrl: string;
  /** 接管的路由列表；入口地址由 `baseUrl` 给出。 */
  readonly routes: RouterRouteEntry[];
  /** 请求超时，单位毫秒。 */
  readonly requestTimeoutMs?: number;
}

/** 配置 schema。 */
export const Config: z<LlmRouterConfig> = z.object({
  baseUrl: z.string(),
  routes: z.array(z.object({
    provider: z.string(),
    limit: z.number(),
    used: z.number(),
  })).required(false),
  requestTimeoutMs: z.number(),
});

/** 用到的遥测面。 */
interface RouterTelemetry {
  startSpan(name: string, attributes?: Record<string, unknown>): {
    setAttribute(key: string, value: unknown): void;
    recordException(error: unknown): void;
    end(): void;
  };
  event(name: string, attributes?: Record<string, unknown>): void;
  counter(name: string, options?: { description: string }): { add(delta: number, attributes?: Record<string, unknown>): void };
  histogram(name: string, options?: { unit?: string; description?: string }): { record(value: number, attributes?: Record<string, unknown>): void };
}

/**
 * 带遥测与额度事件的适配器包装。
 *
 * DSH 的 `stream()` 返回惰性流，请求在开始迭代时才发出；因此开始、结果、错误与耗时
 * 都记在一个 span 上，并在这里把额度拒绝的事件与计数与其它失败分开。
 */
class RoutedAdapter extends LlmAdapter {
  private readonly inner: GatewayLlmAdapter;
  private readonly route: RouterRoute;
  private readonly telemetry: RouterTelemetry | undefined;

  constructor(inner: GatewayLlmAdapter, route: RouterRoute, telemetry: RouterTelemetry | undefined) {
    super();
    this.inner = inner;
    this.route = route;
    this.telemetry = telemetry;
  }

  /** 提供方元数据。 */
  override providerInfo(provider: string): LlmProviderInfo {
    return this.inner.providerInfo(provider);
  }

  /** 模型元数据。 */
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return this.inner.resolveModel(provider, model);
  }

  /** 转发一次模型请求，并把结果记入遥测。 */
  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 额度检查先于任何异步边界执行，拒绝时同步抛出。
    const source = this.inner.stream(options);
    const telemetry = this.telemetry;
    if (telemetry === undefined) return source;
    const route = this.route;
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
        const span = telemetry.startSpan('chatdsh.llm.stream', { provider: route.provider, model: options.model });
        const started = Date.now();
        let firstTokenAt: number | undefined;
        try {
          for await (const chunk of source) {
            if (firstTokenAt === undefined && isVisible(chunk)) {
              firstTokenAt = Date.now();
              telemetry.histogram('chatdsh_llm_first_token_seconds', { unit: 's', description: '首 token 延迟' })
                .record((firstTokenAt - started) / 1000, { provider: route.provider });
            }
            if (chunk.type === 'usage') {
              telemetry.counter('chatdsh_llm_tokens_total', { description: '模型 token 计数' })
                .add(chunk.usage.inputTokens, { provider: route.provider, model: options.model, kind: 'input' });
              telemetry.counter('chatdsh_llm_tokens_total', { description: '模型 token 计数' })
                .add(chunk.usage.outputTokens, { provider: route.provider, model: options.model, kind: 'output' });
            }
            yield chunk;
          }
          span.setAttribute('outcome', 'ok');
          telemetry.counter('chatdsh_llm_requests_total', { description: '模型请求数' })
            .add(1, { provider: route.provider, model: options.model, outcome: 'ok' });
        } catch (error) {
          const quota = error instanceof LlmQuotaError;
          const code = quota ? CHATDSH_ERROR_CODES.quotaExceeded : errorCodeOf(error);
          span.setAttribute('outcome', quota ? 'quota-rejected' : 'failed');
          span.setAttribute('error.type', error instanceof Error ? error.name : 'Unknown');
          span.setAttribute('error.code', code);
          span.recordException(error);
          telemetry.counter('chatdsh_llm_requests_total', { description: '模型请求数' })
            .add(1, { provider: route.provider, model: options.model, outcome: quota ? 'quota-rejected' : 'failed' });
          if (quota) {
            telemetry.event('chatdsh.llm.quota.rejected', {
              'error.code': CHATDSH_ERROR_CODES.quotaExceeded,
            });
          }
          throw error;
        } finally {
          telemetry.histogram('chatdsh_llm_request_duration_seconds', { unit: 's', description: '模型请求耗时' })
            .record((Date.now() - started) / 1000, { provider: route.provider });
          span.end();
        }
      },
    };
  }
}

/** 是否为可见输出分块，用于首 token 计时。 */
function isVisible(chunk: StreamChunk): boolean {
  return chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta';
}

/** 从异常取错误码。 */
function errorCodeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  return 'UNKNOWN';
}

/**
 * 模型路由器服务。
 *
 * 注册时把每条路由登记成模型适配器；服务销毁时适配器随之注销。依赖写在静态字段上，
 * 加载器只认这个字段。
 */
export class ChatdshLlmRouterService extends Service {
  /** 依赖的模型运行时。 */
  static inject = ['llm'];

  constructor(ctx: Context, config: LlmRouterConfig) {
    super(ctx, 'chatdshLlmRouter');
    const routes = (config.routes ?? []).map((route) => resolveRouterRoute({ ...route, baseUrl: config.baseUrl }));
    const telemetry = telemetryOf<RouterTelemetry>(ctx);
    const requestTimeoutMs = config.requestTimeoutMs ?? 120_000;

    for (const route of routes) {
      const inner = new GatewayLlmAdapter({
        baseUrl: route.baseUrl,
        provider: route.provider,
        quota: { limit: route.limit, used: route.used },
        requestTimeoutMs,
      });
      const registration = llmOf(ctx).registerAdapter([route.provider], new RoutedAdapter(inner, route, telemetry));
      ctx.effect(() => registration, `chatdsh-llm-router:${route.provider}`);
    }
  }
}

/**
 * 注册模型路由器。
 * @param ctx - 宿主上下文。
 * @param config - 入口地址、路由与超时。
 */
export function apply(ctx: Context, config: LlmRouterConfig): void {
  ctx.plugin(ChatdshLlmRouterService, config);
}
