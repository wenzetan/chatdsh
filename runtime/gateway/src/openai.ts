/**
 * 模型入口的 OpenAI 兼容请求翻译。
 *
 * 运行时把 DSH 的消息结构原样送来；外部模型网关普遍接受 OpenAI 的 chat completions
 * 格式。这里在入口处做一次单向翻译，并指定 `stream: true`，把上游的 SSE 响应交给
 * 适配器翻译回 `StreamChunk`。
 *
 * OpenAI 兼容协议没有「声明列表中途变更」的原生表达：工具只能整体重发，没有
 * `tool-addition` 与 `tool-removal` 这两种增量块。因此这两类块在这里渲染成一段明确的
 * 文本说明，放进 developer 消息里，随缓存历史一起追加，而不是丢掉。丢弃会让模型看不到
 * 工具已经可用或已经撤下，表现为它继续调用不存在的工具。
 * @module @chatdsh/gateway/openai
 */

/** DSH 的内容块。 */
interface ContentBlock {
  readonly type: string;
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  readonly arguments?: string;
  /** `tool-addition` 块里被激活的工具名。 */
  readonly toolName?: string;
}

/** DSH 的消息。 */
interface DshMessage {
  readonly role: string;
  readonly content: string | readonly ContentBlock[];
  readonly toolCallId?: string;
  readonly isError?: boolean;
}

/** OpenAI 的一条消息。 */
export interface OpenAiMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content?: string;
  readonly tool_calls?: readonly { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  readonly tool_call_id?: string;
}

/** OpenAI 请求体。 */
export interface OpenAiRequest {
  readonly model: string;
  readonly messages: OpenAiMessage[];
  readonly stream: true;
  readonly stream_options: { include_usage: true };
  readonly temperature?: number;
  readonly max_tokens?: number;
  readonly stop?: string[];
  readonly tools?: readonly unknown[];
}

/**
 * 把 DSH 的一次请求翻译成 OpenAI 兼容请求。
 * @param body - 模型入口收到的 JSON 对象。
 * @returns 发往上游的请求体。
 */
export function toOpenAiRequest(body: Record<string, unknown>): OpenAiRequest {
  if (typeof body.model !== 'string' || body.model === '') throw new Error('模型请求缺少 model');
  const messages = Array.isArray(body.messages) ? body.messages as DshMessage[] : [];
  const system = typeof body.system === 'string' ? [{ role: 'system' as const, content: body.system }] : [];
  const request: OpenAiRequest = {
    model: body.model,
    messages: [...system, ...messages.map(toOpenAiMessage)],
    stream: true,
    stream_options: { include_usage: true },
    ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
    ...(typeof body.maxTokens === 'number' ? { max_tokens: body.maxTokens } : {}),
    ...(Array.isArray(body.stop) ? { stop: body.stop as string[] } : {}),
    ...(Array.isArray(body.tools) ? { tools: body.tools } : {}),
  };
  return request;
}

/** 翻译一条消息。 */
function toOpenAiMessage(message: DshMessage): OpenAiMessage {
  if (message.role === 'tool') {
    return { role: 'tool', content: textOf(message.content), tool_call_id: message.toolCallId ?? '' };
  }
  if (message.role === 'assistant') {
    const blocks = typeof message.content === 'string' ? [] : message.content;
    const toolCalls = blocks
      .filter((block) => block.type === 'tool-call')
      .map((block) => ({ id: block.id ?? '', type: 'function' as const, function: { name: block.name ?? '', arguments: block.arguments ?? '{}' } }));
    const text = blocks.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('');
    return {
      role: 'assistant',
      ...(text === '' ? {} : { content: text }),
      ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
    };
  }
  return { role: message.role === 'developer' ? 'system' : 'user', content: textOf(message.content) };
}

/** 把内容块拼成纯文本；工具变更块渲染成说明行，图像与文件以占位说明出现。 */
function textOf(content: string | readonly ContentBlock[]): string {
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      if (block.text !== undefined && block.text !== '') parts.push(block.text);
      continue;
    }
    if (block.type === 'image') {
      parts.push('[图像]');
      continue;
    }
    if (block.type === 'file') {
      parts.push('[文件]');
      continue;
    }
    if (block.type === 'tool-addition') {
      if (block.toolName !== undefined) added.push(block.toolName);
      continue;
    }
    if (block.type === 'tool-removal') {
      if (block.toolName !== undefined) removed.push(block.toolName);
      continue;
    }
  }
  // 两类变更合成一句放在文本之后：OpenAI 兼容协议没有增量声明，只能靠说明表达。
  const changes: string[] = [];
  if (added.length > 0) changes.push(`以下工具现已可用：${added.join('、')}`);
  if (removed.length > 0) changes.push(`以下工具已撤下，不要继续调用：${removed.join('、')}`);
  if (changes.length > 0) parts.push(changes.join('；'));
  return parts.join('\n');
}
