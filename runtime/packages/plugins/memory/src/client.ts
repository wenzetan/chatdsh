/**
 * Hindsight 的 HTTP 客户端。
 *
 * 只用两条接口：`GET /version` 探活、`POST /v1/default/banks/{bank}/memories/recall`
 * 召回、`POST /v1/default/banks/{bank}/memories` 写入。这一层不依赖运行时，遥测通过
 * 可选的回调接入，因此可以脱离 DSH 单独验证。
 * @module @chatdsh/plugin-memory/client
 */

import { dedupeHits, type MemoryHit } from './rules.ts';

/** 配置。 */
export interface MemoryClientConfig {
  /** Hindsight 服务地址。 */
  readonly hindsightUrl: string;
  /** 凭据所在的环境变量名；凭据本身不落配置。 */
  readonly apiKeyEnv?: string;
  /** 单次召回的令牌上限。 */
  readonly maxTokens: number;
  /** 单次请求的超时。 */
  readonly requestTimeoutMs: number;
}

/** 召回输入。 */
export interface RecallOptions {
  readonly query: string;
  readonly tags?: readonly string[];
  readonly maxTokens?: number;
}

/** 写入输入。 */
export interface WriteOptions {
  readonly content: string;
  readonly context?: string;
  readonly tags?: readonly string[];
  /** 是否交给服务端后台整合；默认异步，避免阻塞整合同步抽取事实。 */
  readonly async?: boolean;
}

/** 客户端。 */
export interface MemoryClient {
  probe(): Promise<boolean>;
  recall(banks: readonly string[], options: RecallOptions): Promise<MemoryHit[]>;
  write(bank: string, options: WriteOptions): Promise<{ items: number; operationId?: string }>;
}

/** 记忆服务不可用。 */
export class MemoryUnavailableError extends Error {
  constructor(detail: string) {
    super(`记忆服务不可用：${detail}`);
    this.name = 'MemoryUnavailableError';
  }
}

/** 一条召回结果在接口里的形状。 */
interface RecallItem {
  id: string;
  text: string;
  type?: string;
  tags?: string[];
  scores?: { semantic?: number };
}

/**
 * 建立客户端。
 * @param config - 地址、凭据环境变量名与超时。
 * @param onFailure - 每次请求失败后的回调，用于上报降级。
 * @returns 客户端。
 */
export function createMemoryClient(config: MemoryClientConfig, onFailure?: (operation: string, error: unknown) => void): MemoryClient {
  const endpoint = config.hindsightUrl.replace(/\/+$/, '');
  const key = config.apiKeyEnv === undefined ? undefined : process.env[config.apiKeyEnv];
  const headers: Record<string, string> = key === undefined
    ? { 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };

  async function call(operation: string, path: string, init: RequestInit): Promise<unknown> {
    try {
      const response = await fetch(`${endpoint}${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
      if (!response.ok) throw new MemoryUnavailableError(`${operation}返回 ${response.status}`);
      return await response.json();
    } catch (error) {
      onFailure?.(operation, error);
      throw error;
    }
  }

  return {
    async probe(): Promise<boolean> {
      try {
        const response = await fetch(`${endpoint}/version`, {
          headers,
          signal: AbortSignal.timeout(config.requestTimeoutMs),
        });
        return response.ok;
      } catch {
        return false;
      }
    },

    async recall(banks: readonly string[], options: RecallOptions): Promise<MemoryHit[]> {
      const collected: MemoryHit[] = [];
      for (const bank of banks) {
        const body: Record<string, unknown> = {
          query: options.query,
          max_tokens: options.maxTokens ?? config.maxTokens,
        };
        if (options.tags !== undefined) body.tags = [...options.tags];
        const payload = (await call('召回', `/v1/default/banks/${encodeURIComponent(bank)}/memories/recall`, {
          method: 'POST',
          body: JSON.stringify(body),
        })) as { results?: RecallItem[] };
        for (const item of payload.results ?? []) {
          collected.push({
            id: item.id,
            text: item.text,
            type: item.type ?? 'world',
            tags: item.tags,
            score: item.scores?.semantic,
          });
        }
      }
      return dedupeHits(collected);
    },

    async write(bank: string, options: WriteOptions): Promise<{ items: number; operationId?: string }> {
      const item: Record<string, unknown> = { content: options.content };
      if (options.context !== undefined) item.context = options.context;
      if (options.tags !== undefined) item.tags = [...options.tags];
      const payload = (await call('写入', `/v1/default/banks/${encodeURIComponent(bank)}/memories`, {
        method: 'POST',
        body: JSON.stringify({ items: [item], async: options.async ?? true }),
      })) as { items_count?: number; operation_id?: string };
      return { items: payload.items_count ?? 1, operationId: payload.operation_id };
    },
  };
}
