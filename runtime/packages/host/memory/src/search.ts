/**
 * 记忆检索。
 *
 * 检索复用接入层已有的召回通道：按 bank 顺序召回、按文本去重、截到条数上限。失败由调用方
 * 转成降级结果；查询文本只在本次调用里使用，不写文件。
 * @module @chatdsh/host-memory/search
 */

import type { MemoryHit } from './rules.ts';

/** 检索需要的召回通道。 */
export interface MemoryRecallChannel {
  recall(banks: readonly string[], options: { readonly query: string; readonly maxTokens?: number }): Promise<MemoryHit[]>;
}

/** 检索输入。 */
export interface MemorySearchInput {
  /** 召回通道。 */
  readonly channel: MemoryRecallChannel;
  /** bank 范围，按顺序。 */
  readonly banks: readonly string[];
  /** 查询文本。 */
  readonly text: string;
  /** 返回条数上限。 */
  readonly limit: number;
  /** 单次请求的令牌上限。 */
  readonly maxTokens?: number;
}

/**
 * 在多个 bank 上检索。
 * @param input - 检索输入。
 * @returns 命中结果，按文本去重并截到条数上限。
 */
export async function searchMemory(input: MemorySearchInput): Promise<MemoryHit[]> {
  const hits = await input.channel.recall(input.banks, {
    query: input.text,
    ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
  });
  const seen = new Set<string>();
  const out: MemoryHit[] = [];
  for (const hit of hits) {
    if (seen.has(hit.text)) continue;
    seen.add(hit.text);
    out.push(hit);
    if (out.length >= input.limit) break;
  }
  return out;
}
