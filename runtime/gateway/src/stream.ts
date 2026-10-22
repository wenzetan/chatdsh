/**
 * 把 OpenAI 兼容的 SSE 响应翻译成 DSH 的分块。
 *
 * 模型入口不把上游的字节原样交回运行时：运行时的适配器要的是 `StreamChunk`。翻译在
 * 入口处完成一次，适配器只做透传，这样上游的协议差异集中在一个文件里。
 * @module @chatdsh/gateway/stream
 */

import type { ServerResponse } from 'node:http';

/** 上游的一条流式分块。 */
interface OpenAiChunk {
  readonly choices?: readonly {
    readonly delta?: {
      readonly content?: string | null;
      readonly reasoning_content?: string | null;
      readonly tool_calls?: readonly {
        readonly index?: number;
        readonly id?: string;
        readonly function?: { readonly name?: string; readonly arguments?: string };
      }[];
    };
    readonly finish_reason?: string | null;
  }[];
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number; readonly total_tokens?: number } | null;
}

/** DSH 的分块。 */
type StreamChunk =
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'usage'; usage: { inputTokens: number; outputTokens: number; totalTokens?: number } }
  | { type: 'finish'; reason: { kind: 'stop' | 'tool-calls' | 'max-tokens' } };

/** 翻译状态。 */
export interface StreamTranslator {
  /** 吃一批上游 SSE 文本，返回就绪的 DSH 分块。 */
  push(text: string): StreamChunk[];
  /** 结束输入，返回剩余分块。 */
  flush(): StreamChunk[];
}

/**
 * 建立一个流式翻译器。
 * @returns 翻译器。
 */
export function createStreamTranslator(): StreamTranslator {
  let buffer = '';
  let textIndex = 0;
  let reasoningIndex = 1;
  let usage: { inputTokens: number; outputTokens: number; totalTokens?: number } | undefined;
  let finish: StreamChunk | undefined;
  const toolIndexes = new Map<number, number>();
  let nextToolIndex = 10;

  const translate = (chunk: OpenAiChunk): StreamChunk[] => {
    const out: StreamChunk[] = [];
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta;
      if (typeof delta?.content === 'string' && delta.content !== '') out.push({ type: 'text-delta', index: textIndex, text: delta.content });
      if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content !== '') {
        out.push({ type: 'reasoning-delta', index: reasoningIndex, text: delta.reasoning_content });
      }
      for (const call of delta?.tool_calls ?? []) {
        const upstreamIndex = call.index ?? 0;
        let index = toolIndexes.get(upstreamIndex);
        if (index === undefined) {
          index = nextToolIndex;
          nextToolIndex += 1;
          toolIndexes.set(upstreamIndex, index);
        }
        out.push({
          type: 'tool-call-delta',
          index,
          id: call.id ?? '',
          ...(call.function?.name === undefined ? {} : { name: call.function.name }),
          argumentsDelta: call.function?.arguments ?? '',
        });
      }
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
        finish = {
          type: 'finish',
          reason: { kind: choice.finish_reason === 'tool_calls' ? 'tool-calls' : choice.finish_reason === 'length' ? 'max-tokens' : 'stop' },
        };
      }
    }
    if (chunk.usage !== null && chunk.usage !== undefined) {
      usage = {
        inputTokens: chunk.usage.prompt_tokens ?? 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
        ...(chunk.usage.total_tokens === undefined ? {} : { totalTokens: chunk.usage.total_tokens }),
      };
    }
    return out;
  };

  return {
    push(text) {
      buffer += text;
      const out: StreamChunk[] = [];
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice('data:'.length).trim();
          if (data === '' || data === '[DONE]') continue;
          out.push(...translate(JSON.parse(data) as OpenAiChunk));
        }
        boundary = buffer.indexOf('\n\n');
      }
      return out;
    },
    flush() {
      const out: StreamChunk[] = [];
      if (buffer.trim() !== '') {
        for (const line of buffer.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice('data:'.length).trim();
          if (data === '' || data === '[DONE]') continue;
          out.push(...translate(JSON.parse(data) as OpenAiChunk));
        }
      }
      buffer = '';
      if (usage !== undefined) out.push({ type: 'usage', usage });
      if (finish !== undefined) out.push(finish);
      return out;
    },
  };
}

/** 写一帧 SSE。 */
export function writeFrame(response: ServerResponse, chunk: StreamChunk): void {
  response.write(`data: ${JSON.stringify(chunk)}\n\n`);
}
