/**
 * 网关模型适配器。
 *
 * 把 DSH 的 `GenerateOptions` 转发到控制平面的模型入口，再把入口返回的 SSE 分块翻译回
 * `StreamChunk`。额度检查在发出请求之前完成；控制平面返回 402 时映射成 `QUOTA`，
 * 直接抛给调用方，让重试与压缩的恢复路径按不可恢复失败处理。
 *
 * 请求体只含 DSH 的请求字段；身份头部按账号写入，链路标识由调用方注入的载体给出。
 * @module @chatdsh/host-llm-router/adapter
 */

import {
  attributionHeaders,
  LlmAdapter,
  type GenerateOptions,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@chatdsh/adapter';
import { mapUpstreamFailure, type UpstreamFailureInput } from './errors.ts';
import { createQuotaGuard, type QuotaGuard, type QuotaReading } from './quota.ts';

/** 路由器配置里的一条路由。 */
export interface RouterRoute {
  /** provider 路由标识，与控制平面注册的提供方一致。 */
  readonly provider: string;
  /** 控制平面的模型入口地址。 */
  readonly baseUrl: string;
  /** 已用额度的本地初值；缺省为 0。 */
  readonly used?: number;
}

/** 适配器构造参数。 */
export interface GatewayLlmAdapterOptions {
  /** 模型入口的完整地址，例如 `http://127.0.0.1:3170/chatdsh/gateway/llm`。 */
  readonly baseUrl: string;
  /** provider 路由标识；缺省为 `gateway`。 */
  readonly provider?: string;
  /** 额度配置。 */
  readonly quota: { readonly limit?: number; readonly used?: number };
  /** 凭据所在的环境变量名；控制平面侧通常不需要，留作直连网关时使用。 */
  readonly apiKeyEnv?: string;
  /** 请求超时，单位毫秒。 */
  readonly requestTimeoutMs?: number;
  /** 额度守卫；缺省由 `quota` 建立。 */
  readonly guard?: QuotaGuard;
  /** 请求实现，缺省为全局 `fetch`。 */
  readonly fetch?: typeof fetch;
  /** 链路标识提供者，返回当前 span 的 W3C `traceparent`。 */
  readonly traceparent?: () => string | undefined;
  /** 用量回调，每收到一个 usage 分块调用一次。 */
  readonly onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
}

/** 一次请求带回的结果事实。 */
export interface GatewayLlmAdapterFacts {
  /** 最近一次额度读数。 */
  readonly reading: QuotaReading;
}

/**
 * 转发到控制平面模型入口的适配器。
 */
export class GatewayLlmAdapter extends LlmAdapter {
  /** provider 路由标识。 */
  readonly provider: string;

  /** 模型入口地址。 */
  readonly baseUrl: string;

  private readonly guard: QuotaGuard;
  private readonly apiKeyEnv: string | undefined;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly traceparent: (() => string | undefined) | undefined;
  private readonly onUsage: ((usage: { inputTokens: number; outputTokens: number }) => void) | undefined;

  constructor(options: GatewayLlmAdapterOptions) {
    super();
    const url = new URL(options.baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`模型入口地址必须以 http:// 或 https:// 开头：${options.baseUrl}`);
    }
    this.provider = options.provider ?? 'gateway';
    this.baseUrl = options.baseUrl;
    this.apiKeyEnv = options.apiKeyEnv;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.fetchImpl = options.fetch ?? fetch;
    this.traceparent = options.traceparent;
    this.onUsage = options.onUsage;
    this.guard = options.guard ?? createQuotaGuard(options.quota);
  }

  /** 提供方元数据。 */
  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'ChatDSH 模型网关' };
  }

  /** 模型元数据；上下文窗口由网关侧配置，这里不臆测。 */
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model };
  }

  /**
   * 转发一次模型请求。
   * @param options - DSH 的完整请求。
   * @returns 分块流；额度拒绝在返回流之前抛出。
   */
  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 额度检查在发出任何网络请求之前完成；拒绝照样以异步迭代器抛出，
    // 调用方统一按流失败处理。
    return this.streamUpstream(options);
  }

  private async *streamUpstream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.guard.check();
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...attributionHeaders(),
    };
    const key = this.apiKeyEnv === undefined ? undefined : process.env[this.apiKeyEnv];
    if (key !== undefined) headers.authorization = `Bearer ${key}`;
    const traceparent = this.traceparent?.();
    if (traceparent !== undefined) headers.traceparent = traceparent;

    const body = JSON.stringify({
      provider: options.provider,
      model: options.model,
      messages: options.messages,
      ...(options.system === undefined ? {} : { system: options.system }),
      ...(options.tools === undefined ? {} : { tools: options.tools }),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options.stop === undefined ? {} : { stop: options.stop }),
      ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
    });

    const response = await this.fetchImpl(this.baseUrl, {
      method: 'POST',
      headers,
      body,
      signal: options.signal ?? AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok) {
      // 响应原文原样带回：错误码只用于分支，用户拿到的是上游给出的说明。
      const body = await response.text();
      const failure: UpstreamFailureInput = {
        status: response.status,
        body,
        contentType: response.headers.get('content-type') ?? undefined,
        upstreamCode: readUpstreamCode(body),
      };
      throw mapUpstreamFailure(failure);
    }
    if (response.body === null) throw mapUpstreamFailure({ status: response.status });

    let usageSeen = false;
    for await (const chunk of parseSse(response.body)) {
      if (chunk.type === 'usage') {
        usageSeen = true;
        this.guard.record(chunk.usage.inputTokens + chunk.usage.outputTokens);
        this.onUsage?.({ inputTokens: chunk.usage.inputTokens, outputTokens: chunk.usage.outputTokens });
      }
      yield chunk;
    }
    if (!usageSeen) {
      // 没有用量时账本不变；这里不补默认值，避免把失败记为已用。
    }
  }
}

/** 从错误体里取上游错误码，只用于分类；非 JSON 或形状不符时返回 `undefined`。 */
function readUpstreamCode(text: string): string | undefined {
  if (text === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const error = (parsed as { error?: unknown }).error;
  if (typeof error === 'string') return error;
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * 把 SSE 字节流翻译成分块。
 * @param body - 响应体。
 * @returns 分块流。
 */
async function* parseSse(body: ReadableStream<Uint8Array>): AsyncIterable<StreamChunk> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const bytes of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(bytes, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const chunk = parseFrame(frame);
      if (chunk !== undefined) yield chunk;
      boundary = buffer.indexOf('\n\n');
    }
  }
  buffer += decoder.decode();
  for (const line of buffer.split('\n')) {
    const chunk = parseFrame(line);
    if (chunk !== undefined) yield chunk;
  }
}

/** 解析一帧 SSE；非 `data:` 行返回 `undefined`。 */
function parseFrame(frame: string): StreamChunk | undefined {
  for (const line of frame.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice('data:'.length).trim();
    if (data === '' || data === '[DONE]') continue;
    return JSON.parse(data) as StreamChunk;
  }
  return undefined;
}
