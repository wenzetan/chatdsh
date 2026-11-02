/**
 * 分享默认内容过滤，由服务端强制。
 *
 * 只有用户与助手的可见文本进入快照；工具调用的参数与结果原文、记忆召回内容、思考过程、
 * 内部路径与凭据一律不进入。过滤规则只由服务端决定，请求体里没有关闭它的开关。
 * 工具调用只留下工具名与无名标记，以便读者理解回合结构。
 * @module @chatdsh/gateway/sharing/filter
 */

import { SHARE_DEFAULT_EXCLUSIONS } from '@chatdsh/core-contracts';
import type { ShareExclusion, ShareMessage } from './types.ts';
import { dataOf, textOfContent, toolNameOf, type TurnSpan } from './events.ts';

/** 过滤选项：只由分享范围给出。 */
export interface FilterOptions {
  readonly includeUserText: boolean;
  readonly includeAssistantText: boolean;
}

/** 过滤结果。 */
export interface FilterResult {
  readonly messages: readonly ShareMessage[];
  readonly excluded: readonly ShareExclusion[];
  readonly charCount: number;
  readonly redactedPaths: number;
  readonly redactedCredentials: number;
  /** 被排除的事件条数，按类别计数。 */
  readonly dropped: {
    readonly memory: number;
    readonly tool: number;
    readonly reasoning: number;
    readonly control: number;
    readonly other: number;
  };
}

/** 路径替换标记。 */
const PATH_REPLACEMENT = '[路径已隐藏]';

/** 凭据替换标记。 */
const CREDENTIAL_REPLACEMENT = '[凭据已隐藏]';

/** 把凭据形态的片段替换成固定标记。 */
function redactCredentials(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  const replace = (pattern: RegExp): void => {
    out = out.replace(pattern, () => {
      count += 1;
      return CREDENTIAL_REPLACEMENT;
    });
  };
  replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu);
  replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gu);
  replace(/\bsk-[A-Za-z0-9_-]{16,}/gu);
  replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/gu);
  replace(/\bAKIA[0-9A-Z]{16}\b/gu);
  replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/gu);
  replace(/\b(?:api[-_]?key|access[-_]?key|secret|token|password|passwd|authorization|credential)\b\s*[:=]\s*["']?[^\s"'，。；）)]{6,}/giu);
  return { text: out, count };
}

/** 把内部路径形态的片段替换成固定标记。 */
function redactPaths(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  const replace = (pattern: RegExp, keepLead: boolean): void => {
    out = out.replace(pattern, (_whole: string, lead: string | undefined) => {
      count += 1;
      return `${keepLead ? (lead ?? '') : ''}${PATH_REPLACEMENT}`;
    });
  };
  replace(/\bfile:\/\/[^\s"'<>）)，。；]+/gu, false);
  replace(/(?:[A-Za-z]:\\|\\\\)[^\s"'<>）)，。；]+/gu, false);
  replace(/(^|[\s(（"'：:=])(\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)/gu, true);
  replace(/(^|[\s(（"'：:=])(~\/[^\s"'<>）)，。；]+)/gu, true);
  return { text: out, count };
}

/** 一段文本的脱敏结果。 */
function redactText(text: string): { text: string; paths: number; credentials: number } {
  const credentials = redactCredentials(text);
  const paths = redactPaths(credentials.text);
  return { text: paths.text, paths: paths.count, credentials: credentials.count };
}

/** 事件类别。 */
type EventClass = 'user' | 'assistant' | 'tool-call' | 'tool-result' | 'memory' | 'reasoning' | 'control' | 'other';

/** 与内容无关的事件，出现在回合里也不进入快照。 */
const CONTROL_KINDS = new Set([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'session/title',
  'session/header',
  'session/created',
]);

/** 判定一条事件属于哪一类。 */
function classify(kind: string): EventClass {
  if (kind === 'user/message') return 'user';
  if (kind === 'assistant/message') return 'assistant';
  if (kind === 'tool/call') return 'tool-call';
  if (kind === 'tool/result') return 'tool-result';
  if (kind.includes('reasoning') || kind.includes('thinking')) return 'reasoning';
  if (kind.includes('memory')) return 'memory';
  if (CONTROL_KINDS.has(kind) || kind.startsWith('plugin:') || kind === 'system/message' || kind === 'developer/message') {
    return 'control';
  }
  return 'other';
}

/** 消息来源是否为记忆召回。 */
function isMemorySource(payload: unknown): boolean {
  const data = dataOf(payload);
  const source = data?.['source'];
  if (typeof source !== 'object' || source === null) return false;
  return (source as { kind?: unknown }).kind === 'memory-recall';
}

/** 用户消息的可见文本。 */
function userTextOf(payload: unknown): string {
  const data = dataOf(payload);
  if (data === undefined) return '';
  const role = data['role'];
  if (typeof role === 'string' && role !== 'user') return '';
  const content = data['content'];
  return content === undefined ? textOfContent(data['text']) : textOfContent(content);
}

/** 助手消息的可见文本。 */
function assistantTextOf(payload: unknown): string {
  const data = dataOf(payload);
  if (data === undefined) return '';
  const message = data['message'];
  if (typeof message === 'object' && message !== null) {
    const content = (message as { content?: unknown }).content;
    if (content !== undefined) return textOfContent(content);
  }
  const content = data['content'];
  return content === undefined ? textOfContent(data['text']) : textOfContent(content);
}

/** 工具调用的展示标记：只带工具名，不带参数。 */
function toolCallMarker(payload: unknown): string {
  const name = toolNameOf(payload);
  return name === undefined
    ? '工具调用（参数与结果未公开）'
    : `工具调用：${name}（参数与结果未公开）`;
}

/** 工具结果的展示标记：结果原文不进入快照。 */
function toolResultMarker(): string {
  return '工具结果（内容未公开）';
}

/**
 * 过滤选中的完整回合。
 * @param turns - 选中的回合。
 * @param options - 公开哪些文本。
 * @returns 消息、实际生效的排除项与脱敏计数。
 */
export function filterTurns(turns: readonly TurnSpan[], options: FilterOptions): FilterResult {
  const messages: ShareMessage[] = [];
  const dropped = { memory: 0, tool: 0, reasoning: 0, control: 0, other: 0 };
  let redactedPaths = 0;
  let redactedCredentials = 0;
  let charCount = 0;

  const push = (role: ShareMessage['role'], time: number, raw: string): void => {
    const trimmed = raw.trim();
    if (trimmed === '') return;
    const redacted = redactText(trimmed);
    redactedPaths += redacted.paths;
    redactedCredentials += redacted.credentials;
    charCount += [...redacted.text].length;
    messages.push({ role, time, text: redacted.text });
  };

  for (const turn of turns) {
    for (const event of turn.events) {
      const kind = event.kind;
      if (isMemorySource(event.payload)) {
        dropped.memory += 1;
        continue;
      }
      switch (classify(kind)) {
        case 'user':
          if (options.includeUserText) push('user', event.time, userTextOf(event.payload));
          break;
        case 'assistant':
          if (options.includeAssistantText) push('assistant', event.time, assistantTextOf(event.payload));
          break;
        case 'tool-call':
          dropped.tool += 1;
          push('tool', event.time, toolCallMarker(event.payload));
          break;
        case 'tool-result':
          dropped.tool += 1;
          push('tool', event.time, toolResultMarker());
          break;
        case 'memory':
          dropped.memory += 1;
          break;
        case 'reasoning':
          dropped.reasoning += 1;
          break;
        case 'control':
          dropped.control += 1;
          break;
        case 'other':
          dropped.other += 1;
          break;
      }
    }
  }

  const applied = new Set<ShareExclusion>();
  applied.add('replica-watermark');
  if (dropped.memory > 0) applied.add('memory-recall');
  if (dropped.tool > 0) applied.add('tool-arguments');
  if (redactedPaths > 0) applied.add('internal-paths');
  if (dropped.reasoning > 0 || dropped.other > 0) applied.add('sensitive-metadata');
  const excluded = SHARE_DEFAULT_EXCLUSIONS.filter((item) => applied.has(item));

  return {
    messages,
    excluded,
    charCount,
    redactedPaths,
    redactedCredentials,
    dropped,
  };
}
