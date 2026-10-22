/**
 * 模型入口的就绪探针。
 *
 * 探针判断控制平面的模型入口是否接管了 DSH 的模型调用：用一次最小请求走完整的
 * 适配器链路，要求拿到可见文本与正常结束原因。返回的数据只含计数与结束原因，不含
 * 提示词或模型输出原文。
 * @module @chatdsh/host-llm-router/probe
 */

import type { GenerateOptions, StreamChunk } from '@chatdsh/adapter';
import type { GatewayLlmAdapter } from './adapter.ts';

/** 探测结果。 */
export interface ProbeResult {
  /** 是否拿到可见文本。 */
  readonly ok: boolean;
  /** 可见文本的字符数。 */
  readonly visibleChars: number;
  /** 结束原因的 `kind`。 */
  readonly finish?: string;
}

/**
 * 用一次最小请求探测一条路由。
 * @param adapter - 已登记的适配器。
 * @param model - 要探测的模型。
 * @param signal - 取消信号。
 * @returns 探测结果。
 */
export async function probeRoute(adapter: GatewayLlmAdapter, model: string, signal?: AbortSignal): Promise<ProbeResult> {
  const options: GenerateOptions = {
    provider: 'gateway',
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: '只回复两个字：收到' }] }],
    maxTokens: 32,
    ...(signal === undefined ? {} : { signal }),
  };
  let visibleChars = 0;
  let finish: string | undefined;
  for await (const chunk of adapter.stream(options) as AsyncIterable<StreamChunk>) {
    if (chunk.type === 'text-delta') visibleChars += chunk.text.length;
    if (chunk.type === 'finish') finish = chunk.reason.kind;
  }
  return { ok: visibleChars > 0 && (finish === 'stop' || finish === 'tool-calls'), visibleChars, ...(finish === undefined ? {} : { finish }) };
}
