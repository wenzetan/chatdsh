/**
 * Hindsight 记忆后端。
 *
 * 把 {@link MemoryBackend} 的三个动作翻译成 Hindsight 的 HTTP 接口：探活、按 bank 召回、
 * 写入。这一层不含 bank 命名规则，也不缓存召回结果；服务不可达时抛
 * {@link HindsightUnavailableError}，调用方据此进入降级路径。
 * @module @chatdsh/hindsight-adapter
 */

import type {
  BackendCallContext,
  BackendHealth,
  MemoryBackend,
  MemoryHit,
  MemoryQuery,
  MemoryWrite,
} from '@chatdsh/core-contracts';

/** 记忆后端，另外带一个返回整合任务标识的写入方法。 */
export interface HindsightMemoryBackend extends MemoryBackend {
  /** 写入并返回整合任务标识；重试时用同一标识提交，服务端不会重复抽取。 */
  writeWithOperation(entry: MemoryWrite, context: BackendCallContext): Promise<{ operationId?: string }>;
}

/** 适配器配置。 */
export interface HindsightConfig {
  /** Hindsight 服务地址，例如 `http://127.0.0.1:8889`。 */
  readonly baseUrl: string;
  /** 凭据所在的环境变量名；凭据本身不落配置。 */
  readonly apiKeyEnv?: string;
  /** 单次请求的超时。 */
  readonly requestTimeoutMs: number;
  /** 单次召回的令牌上限。 */
  readonly maxTokens: number;
}

/** 记忆服务不可用。 */
export class HindsightUnavailableError extends Error {
  /** HTTP 状态码；网络失败时缺省。 */
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'HindsightUnavailableError';
    this.status = status;
  }
}

/** Hindsight 召回结果在接口里的形状。 */
interface RecallItem {
  readonly id?: unknown;
  readonly text?: unknown;
  readonly type?: unknown;
  readonly scores?: { readonly semantic?: unknown };
}

/** 按文本去重并保序。 */
function dedupe(hits: readonly MemoryHit[]): MemoryHit[] {
  const seen = new Set<string>();
  const out: MemoryHit[] = [];
  for (const hit of hits) {
    if (seen.has(hit.text)) continue;
    seen.add(hit.text);
    out.push(hit);
  }
  return out;
}

/** 取消信号是否已中止。 */
function aborted(context: BackendCallContext): boolean {
  return context.signal?.aborted === true;
}

/**
 * 按配置建立一个记忆后端。
 * @param config - 地址、凭据环境变量名、超时与令牌上限。
 * @returns 记忆后端。
 */
export function createHindsightMemoryBackend(config: HindsightConfig): HindsightMemoryBackend {
  const endpoint = config.baseUrl.replace(/\/+$/, '');
  const key = config.apiKeyEnv === undefined ? undefined : process.env[config.apiKeyEnv];
  const headers: Record<string, string> = key === undefined
    ? { 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };

  async function call(path: string, init: RequestInit): Promise<unknown> {
    const response = await fetch(`${endpoint}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
    if (!response.ok) {
      throw new HindsightUnavailableError(`Hindsight 返回 ${response.status}`, response.status);
    }
    return response.json();
  }

  /** 写入一条记忆并取回整合任务标识。 */
  async function writeOnce(entry: MemoryWrite, context: BackendCallContext): Promise<{ operationId?: string }> {
    if (aborted(context)) throw new Error('调用已被取消');
    const item: Record<string, unknown> = { content: entry.text };
    // Hindsight 的 context 是短标签；metadata 里登记的 kind 直接映射过去。
    if (entry.metadata?.kind !== undefined) item.context = entry.metadata.kind;
    const payload = (await call(`/v1/default/banks/${encodeURIComponent(entry.bank)}/memories`, {
      method: 'POST',
      body: JSON.stringify({ items: [item], async: true }),
    })) as { operation_id?: unknown };
    return typeof payload.operation_id === 'string' ? { operationId: payload.operation_id } : {};
  }

  return {
    capabilities(): readonly string[] {
      return ['recall', 'write', 'operation-id'];
    },

    async recall(query: MemoryQuery, context: BackendCallContext): Promise<readonly MemoryHit[]> {
      if (aborted(context)) throw new Error('调用已被取消');
      const collected: MemoryHit[] = [];
      for (const bank of query.banks) {
        if (aborted(context)) throw new Error('调用已被取消');
        const payload = (await call(`/v1/default/banks/${encodeURIComponent(bank)}/memories/recall`, {
          method: 'POST',
          body: JSON.stringify({
            query: query.text,
            max_tokens: query.maxTokens ?? config.maxTokens,
          }),
        })) as { results?: readonly RecallItem[] };
        for (const item of payload.results ?? []) {
          if (typeof item.text !== 'string') continue;
          const hit: { bank: string; text: string; source?: string; score?: number } = { bank, text: item.text };
          if (typeof item.id === 'string') hit.source = item.id;
          if (typeof item.scores?.semantic === 'number') hit.score = item.scores.semantic;
          collected.push(hit);
        }
      }
      return dedupe(collected);
    },

    async write(entry: MemoryWrite, context: BackendCallContext): Promise<void> {
      if (aborted(context)) throw new Error('调用已被取消');
      await writeOnce(entry, context);
    },

    /** 写入并返回整合任务标识；后台整合可据此重试而不产生重复抽取。 */
    writeWithOperation(entry: MemoryWrite, context: BackendCallContext): Promise<{ operationId?: string }> {
      return writeOnce(entry, context);
    },

    async health(): Promise<BackendHealth> {
      try {
        const response = await fetch(`${endpoint}/version`, {
          headers,
          signal: AbortSignal.timeout(config.requestTimeoutMs),
        });
        return response.ok ? { ok: true } : { ok: false, detail: 'unreachable' };
      } catch {
        return { ok: false, detail: 'unreachable' };
      }
    },
  };
}
