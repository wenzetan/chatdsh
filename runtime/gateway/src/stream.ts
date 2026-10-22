/**
 * 把 OpenAI 兼容的响应翻译成 DSH 的分块。
 *
 * 模型入口不把上游的字节原样交回运行时：运行时的适配器要的是 `StreamChunk`。翻译在
 * 入口处完成一次，适配器只做透传，这样上游的协议差异集中在一个文件里。
 *
 * 翻译器同时接受两种上游形态：流式响应的 `choices[].delta` 与非流式响应的
 * `choices[].message`。入口按上游响应的 `content-type` 选择逐帧或整段投喂，向外始终是
 * SSE，因此运行时侧的解析只有一条路径。
 * @module @chatdsh/gateway/stream
 */

import type { ServerResponse } from 'node:http';

/** 上游的一条工具调用。非流式带完整 `id` 与 `function`，流式可能只带增量。 */
interface OpenAiToolCall {
  readonly index?: number;
  readonly id?: string;
  readonly function?: { readonly name?: string; readonly arguments?: string };
}

/** 上游的一条消息内容；流式在 `delta`，非流式在 `message`。 */
interface OpenAiContent {
  readonly content?: string | null;
  readonly reasoning_content?: string | null;
  readonly tool_calls?: readonly OpenAiToolCall[];
}

/** 上游的一条响应或响应分块。 */
interface OpenAiChunk {
  readonly choices?: readonly {
    readonly delta?: OpenAiContent;
    readonly message?: OpenAiContent;
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
  | { type: 'finish'; reason: { kind: 'stop' | 'tool-calls' | 'max-tokens'; upstreamReason?: string } };

/** 翻译状态。 */
export interface StreamTranslator {
  /** 吃一批上游 SSE 文本，返回就绪的 DSH 分块。 */
  push(text: string): StreamChunk[];
  /** 整段投喂非流式响应，返回全部分块。 */
  pushResponse(body: unknown): StreamChunk[];
  /** 结束输入，返回剩余分块。 */
  flush(): StreamChunk[];
}

/**
 * 建立一个翻译器。
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

  /** 记录结束原因；上游原因原样保留，`kind` 只做归一。 */
  const noteFinish = (reason: string): void => {
    finish = {
      type: 'finish',
      reason: {
        kind: reason === 'tool_calls' ? 'tool-calls' : reason === 'length' ? 'max-tokens' : 'stop',
        upstreamReason: reason,
      },
    };
  };

  /** 记录用量。 */
  const noteUsage = (value: OpenAiChunk['usage']): void => {
    if (value === null || value === undefined) return;
    usage = {
      inputTokens: value.prompt_tokens ?? 0,
      outputTokens: value.completion_tokens ?? 0,
      ...(value.total_tokens === undefined ? {} : { totalTokens: value.total_tokens }),
    };
  };

  const translate = (chunk: OpenAiChunk): StreamChunk[] => {
    const out: StreamChunk[] = [];
    for (const choice of chunk.choices ?? []) {
      const content = choice.delta ?? choice.message;
      if (typeof content?.content === 'string' && content.content !== '') {
        out.push({ type: 'text-delta', index: textIndex, text: content.content });
      }
      if (typeof content?.reasoning_content === 'string' && content.reasoning_content !== '') {
        out.push({ type: 'reasoning-delta', index: reasoningIndex, text: content.reasoning_content });
      }
      for (const call of content?.tool_calls ?? []) {
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
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) noteFinish(choice.finish_reason);
    }
    noteUsage(chunk.usage);
    return out;
  };

  /** 从一段 SSE 文本里取出全部分块。 */
  const framesOf = (text: string): StreamChunk[] => {
    const out: StreamChunk[] = [];
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice('data:'.length).trim();
      if (data === '' || data === '[DONE]') continue;
      out.push(...translate(JSON.parse(data) as OpenAiChunk));
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
        out.push(...framesOf(frame));
        boundary = buffer.indexOf('\n\n');
      }
      return out;
    },
    pushResponse(body) {
      if (typeof body !== 'object' || body === null) throw new Error('非流式模型响应必须是 JSON 对象');
      return translate(body as OpenAiChunk);
    },
    flush() {
      const out: StreamChunk[] = [];
      if (buffer.trim() !== '') out.push(...framesOf(buffer));
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
