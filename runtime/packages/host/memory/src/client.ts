/**
 * 记忆存储层的客户端门面。
 *
 * 真正的 HTTP 细节在 `@chatdsh/hindsight-adapter`，本模块只把适配器包成接入层用到的
 * 形状：按 bank 列表召回、按一条内容写入、探活。适配层抛出的异常在这里翻译成带错误码
 * 的异常，接入层按错误码记录降级事件。
 * @module @chatdsh/host-memory/client
 */

import {
  createHindsightMemoryBackend,
  HindsightUnavailableError,
  type HindsightConfig,
} from '@chatdsh/hindsight-adapter';
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

/** 记忆服务不可用；保留旧名字，接入层与验收脚本按它判断降级。 */
export { HindsightUnavailableError as MemoryUnavailableError };

/**
 * 建立客户端。
 * @param config - 地址、凭据环境变量名与超时。
 * @param onFailure - 每次请求失败后的回调，用于上报降级。
 * @returns 客户端。
 */
export function createMemoryClient(config: MemoryClientConfig, onFailure?: (operation: string, error: unknown) => void): MemoryClient {
  const adapterConfig: HindsightConfig = {
    baseUrl: config.hindsightUrl,
    ...(config.apiKeyEnv === undefined ? {} : { apiKeyEnv: config.apiKeyEnv }),
    requestTimeoutMs: config.requestTimeoutMs,
    maxTokens: config.maxTokens,
  };
  const backend = createHindsightMemoryBackend(adapterConfig);

  /** 适配器的结果带 bank 与来源，接入层把它原样带到检索命中里。 */
  function toHits(bank: string, hits: readonly { readonly bank?: string; readonly text: string; readonly source?: string; readonly score?: number }[]): MemoryHit[] {
    return hits.map((hit) => ({
      id: hit.source ?? bank,
      bank: hit.bank ?? bank,
      text: hit.text,
      type: 'world',
      ...(hit.score === undefined ? {} : { score: hit.score }),
    }));
  }

  return {
    async probe(): Promise<boolean> {
      const state = await backend.health({});
      return state.ok;
    },

    async recall(banks: readonly string[], options: RecallOptions): Promise<MemoryHit[]> {
      const collected: MemoryHit[] = [];
      for (const bank of banks) {
        try {
          const hits = await backend.recall({
            banks: [bank],
            text: options.query,
            ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
          }, {});
          collected.push(...toHits(bank, hits));
        } catch (error) {
          onFailure?.('召回', error);
          throw error;
        }
      }
      return dedupeHits(collected);
    },

    async write(bank: string, options: WriteOptions): Promise<{ items: number; operationId?: string }> {
      try {
        const written = await backend.writeWithOperation({
          bank,
          text: options.content,
          ...(options.context === undefined ? {} : { metadata: { kind: options.context } }),
          ...(options.async === undefined ? {} : { async: options.async }),
        }, {});
        return written.operationId === undefined ? { items: 1 } : { items: 1, operationId: written.operationId };
      } catch (error) {
        onFailure?.('写入', error);
        throw error;
      }
    },
  };
}
