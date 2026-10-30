/**
 * 控制平面的模型入口。
 *
 * 运行时的 `@chatdsh/host-llm-router` 把模型请求转发到这里。入口做三件事：在转发之前
 * 检查额度、把 DSH 请求翻译成 OpenAI 兼容请求、把上游的 SSE 响应翻译回 DSH 的分块。
 *
 * 单账号形态下额度账本只有一份读数，拒绝时返回 402 与 `quota-exceeded` 错误码；这个
 * 错误码由运行时侧映射成 `QUOTA`，不进入请求失败的重试与压缩恢复路径。
 * @module @chatdsh/gateway/llm
 */

import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { CHATDSH_ERROR_CODES, type ChatdshTelemetry } from '@chatdsh/core-contracts';
import { toOpenAiRequest } from './openai.ts';
import { createStreamTranslator, writeFrame } from './stream.ts';

/** 模型入口配置。 */
export interface LlmGatewayConfig {
  /** 上游模型网关的 chat completions 地址；缺省时入口返回 503。 */
  readonly upstreamUrl?: string;
  /** 可用额度；缺省表示不限制。 */
  readonly quota: LlmQuotaConfig;
  /** 上游凭据所在的环境变量名；凭据本身不落配置。 */
  readonly apiKeyEnv?: string;
}

/** 额度配置。 */
export interface LlmQuotaConfig {
  /** 额度上限，取 token 数。 */
  readonly limit?: number;
  /** 启动时已经用掉的额度。 */
  readonly used?: number;
}

/** 额度账本的存储面，控制平面用 SQLite 实现。 */
export interface QuotaLedgerStore {
  /** 取已经用掉的额度。 */
  llmQuotaUsed(): number;
  /** 累加额度用量。 */
  recordLlmQuota(tokens: number): number;
}

/** 额度读数。 */
export interface QuotaReading {
  /** 是否允许发起请求。 */
  readonly allowed: boolean;
  /** 上限；不限制时为 `undefined`。 */
  readonly limit?: number;
  /** 已用额度。 */
  readonly used: number;
  /** 剩余额度；不限制时为 `undefined`。 */
  readonly remaining?: number;
}

/** 额度账本：读取与累加已用额度。 */
export class LlmQuotaLedger {
  private readonly store: QuotaLedgerStore;
  private readonly limit: number | undefined;
  private readonly initialUsed: number;

  constructor(store: QuotaLedgerStore, config: LlmQuotaConfig) {
    this.store = store;
    this.limit = config.limit;
    this.initialUsed = config.used ?? 0;
  }

  /** 额度读数。 */
  readingOf(): QuotaReading {
    const used = this.initialUsed + this.store.llmQuotaUsed();
    if (this.limit === undefined) return { allowed: true, used };
    return { allowed: used < this.limit, limit: this.limit, used, remaining: Math.max(0, this.limit - used) };
  }

  /** 记录一次用量。 */
  record(tokens: number): void {
    this.store.recordLlmQuota(tokens);
  }
}

/** 模型入口需要的遥测面。 */
type LlmTelemetry = Pick<ChatdshTelemetry, 'event' | 'counter'>;

/**
 * 处理一次模型入口请求。
 * @param request - 入站请求。
 * @param response - 响应。
 * @param options - 上游配置、额度账本与遥测。
 */
export async function handleLlmRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: {
    readonly config: LlmGatewayConfig;
    readonly ledger: LlmQuotaLedger;
    readonly telemetry: LlmTelemetry;
  },
): Promise<void> {
  const { config, ledger, telemetry } = options;
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'method-not-allowed' });
    return;
  }
  const reading = ledger.readingOf();
  if (!reading.allowed) {
    telemetry.event('chatdsh.llm.quota.rejected', {
      'error.code': CHATDSH_ERROR_CODES.quotaExceeded,
    });
    telemetry.counter('chatdsh_llm_requests_total', { description: '模型请求数' })
      .add(1, { provider: 'gateway', model: 'unknown', outcome: 'quota-rejected' });
    sendJson(response, 402, { error: { code: CHATDSH_ERROR_CODES.quotaExceeded, message: '额度不足' } });
    return;
  }

  if (config.upstreamUrl === undefined) {
    sendJson(response, 503, { error: { code: 'llm-upstream-unconfigured', message: '模型入口没有配置上游地址' } });
    return;
  }

  const raw = await readBody(request, 8 * 1024 * 1024);
  const incoming = JSON.parse(raw) as Record<string, unknown>;
  const body = JSON.stringify(toOpenAiRequest(incoming));
  const target = new URL(config.upstreamUrl);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
  };
  const key = config.apiKeyEnv === undefined ? undefined : process.env[config.apiKeyEnv];
  if (key !== undefined) headers.authorization = `Bearer ${key}`;
  const requestId = request.headers['x-chatdsh-request-id'];
  if (typeof requestId === 'string' && requestId !== '') headers['x-chatdsh-request-id'] = requestId;

  await new Promise<void>((resolve) => {
    const upstream = (target.protocol === 'https:' ? httpsRequest : httpRequest)({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port === '' ? undefined : target.port,
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: { ...headers, 'content-length': Buffer.byteLength(body) },
    }, (upstreamResponse) => {
      // 非 2xx 原样回传：状态码、content-type 与响应体都是上游给出的，入口不解析也不重组。
      // 错误码的分支由运行时适配器在收到响应后做，只用于重试与遥测。
      if ((upstreamResponse.statusCode ?? 500) >= 300) {
        response.writeHead(upstreamResponse.statusCode ?? 502, {
          'content-type': upstreamResponse.headers['content-type'] ?? 'application/octet-stream',
        });
        upstreamResponse.pipe(response);
        upstreamResponse.on('end', () => resolve());
        return;
      }
      const contentType = String(upstreamResponse.headers['content-type'] ?? '');
      const translator = createStreamTranslator();
      if (contentType.includes('text/event-stream')) {
        // 流式：逐帧翻译，边到边发。
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
        upstreamResponse.setEncoding('utf8');
        upstreamResponse.on('data', (chunk: string) => {
          for (const frame of translator.push(chunk)) writeFrame(response, frame);
        });
        upstreamResponse.on('end', () => {
          for (const frame of translator.flush()) writeFrame(response, frame);
          response.end();
          resolve();
        });
        upstreamResponse.on('error', () => {
          response.end();
          resolve();
        });
        return;
      }
      if (contentType.includes('application/json')) {
        // 非流式：整段解析后一次发出全部分块；上游忽略流式要求时也走这条。
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
        const chunks: Buffer[] = [];
        upstreamResponse.on('data', (chunk: Buffer) => chunks.push(chunk));
        upstreamResponse.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          for (const frame of translator.pushResponse(JSON.parse(text))) writeFrame(response, frame);
          for (const frame of translator.flush()) writeFrame(response, frame);
          response.end();
          resolve();
        });
        upstreamResponse.on('error', () => {
          response.end();
          resolve();
        });
        return;
      }
      // 既不是流也不是 JSON：无法翻译，回 502 并写明上游给的 content-type，不猜测格式。
      const chunks: Buffer[] = [];
      upstreamResponse.on('data', (chunk: Buffer) => chunks.push(chunk));
      upstreamResponse.on('end', () => {
        sendJson(response, 502, {
          error: {
            code: 'llm-upstream-unsupported-content-type',
            message: `上游模型网关返回了无法翻译的 content-type：${contentType}`,
            body: Buffer.concat(chunks).toString('utf8'),
          },
        });
        resolve();
      });
    });
    upstream.on('error', () => {
      if (!response.headersSent) sendJson(response, 502, { error: { code: 'llm-upstream-unreachable', message: '模型网关不可达' } });
      else response.end();
      resolve();
    });
    upstream.end(body);
  });
}

/** 读取请求体；超过上限时抛出，由调用方按协议错误处理。 */
async function readBody(request: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) throw new Error('payload too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
}
