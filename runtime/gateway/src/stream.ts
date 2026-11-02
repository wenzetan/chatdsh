/**
 * 把 OpenAI 兼容的响应翻译成 DSH 的分块。
 *
 * 模型入口不把上游的字节原样交回运行时：运行时的适配器要的是 `StreamChunk`。翻译在
 * 入口处完成一次，适配器只做透传，这样上游的协议差异集中在一个文件里。
 *
 * 翻译器同时接受两种上游形态：流式响应的 `choices[].delta` 与非流式响应的
 * `choices[].message`。入口按上游响应的 `content-type` 选择逐帧或整段投喂，向外始终是
 * SSE，因此运行时侧的解析只有一条路径。
 *
 * 通知下发同样走 SSE，事件形状与编码在本文件声明，推送中枢与通知模块共用一份编码。
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

/** 通知投递节奏的取值，与通知设置里的枚举一致。 */
export type PushEventMode = 'all-at-once' | 'two-stage';

/**
 * 推送事件里的一条通知。
 *
 * 字段按隐私级别裁剪之后才出现在这里：摘要只在摘要级别出现，命令与消息原文只在预览
 * 级别出现。这里的取值就是客户端与系统通知能看到的内容。
 */
export interface PushEventNotification {
  /** 通知标识。 */
  readonly id: string;
  /** 通知种类。 */
  readonly kind: string;
  /** 展示标题。 */
  readonly title: string;
  /** 摘要；隐私级别为仅类型时缺省。 */
  readonly summary?: string;
  /** 命令或消息原文；只有预览级别且开启消息预览时才有值。 */
  readonly preview?: string;
  /** 关联设备。 */
  readonly deviceId?: string;
  /** 关联会话；隐私级别为仅类型时缺省。 */
  readonly sessionId?: string;
  /** 关联对象的稳定标识。 */
  readonly objectId?: string;
  /** 系统通知使用的稳定 tag。 */
  readonly tag?: string;
  /** 事件发生时刻的毫秒时间戳。 */
  readonly createdAt: number;
  /** 已读时刻；未读时缺省。 */
  readonly readAt?: number;
  /** 已处理时刻；未处理时缺省。 */
  readonly handledAt?: number;
  /** 是否可撤回。 */
  readonly revocable: boolean;
}

/** 控制平面通过事件流下发的事件。 */
export type PushEvent =
  | {
    /** 一批通知。 */
    readonly kind: 'notification';
    /** 这一批的通知，顺序与通知中心一致。 */
    readonly items: readonly PushEventNotification[];
    /** 这一批的条数，与 `items` 等长。 */
    readonly count: number;
    /** 投递阶段：0 为实时，1 为第一阶段，2 为第二阶段。 */
    readonly stage: number;
    /** 生成这一批时生效的投递节奏。 */
    readonly mode: PushEventMode;
  }
  | {
    /** 已读状态变化，供其他客户端同步未读数。 */
    readonly kind: 'notification-read';
    /** 本次标记的通知标识。 */
    readonly ids: readonly string[];
    /** 标记已读的访问客户端。 */
    readonly clientId: string;
    /** 标记已读的访问客户端所在设备。 */
    readonly deviceId?: string;
    /** 标记时刻的毫秒时间戳。 */
    readonly readAt: number;
    /** 标记之后的未读条数。 */
    readonly unread: number;
  }
  | {
    /** 业务已处理，与已读分开记录。 */
    readonly kind: 'notification-handled';
    /** 本次标记为已处理的通知标识。 */
    readonly ids: readonly string[];
    /** 处理时刻的毫秒时间戳。 */
    readonly handledAt: number;
  }
  | {
    /** 撤回通知：审批决定之后待投递的与已展示的系统通知都要关闭。 */
    readonly kind: 'notification-withdraw';
    /** 被撤回的通知标识。 */
    readonly ids: readonly string[];
    /** 被撤回通知的稳定 tag，客户端按它关闭已展示的系统通知。 */
    readonly tags: readonly string[];
    /** 关联会话。 */
    readonly sessionId?: string;
    /** 关联对象的稳定标识，审批场景里是工具调用标识。 */
    readonly objectId?: string;
    /** 撤回时刻的毫秒时间戳。 */
    readonly at: number;
  };

/**
 * 把推送事件编码成 SSE 数据部分。
 * @param event - 要下发的事件。
 * @returns 可直接写在 `data: ` 之后的 JSON。
 */
export function encodePushEvent(event: PushEvent): string {
  return JSON.stringify(event);
}

/**
 * 写一帧推送事件。
 *
 * 连接已经断开时返回假，调用方据此把连接从在线表里摘除。
 * @param response - 订阅连接的响应。
 * @param event - 要下发的事件。
 * @returns 写入成功为真。
 */
export function writePushEvent(response: ServerResponse, event: PushEvent): boolean {
  try {
    response.write(`data: ${encodePushEvent(event)}\n\n`);
    return true;
  } catch {
    return false;
  }
}
