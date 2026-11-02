/**
 * 导出内容的收集：完整回合、条目、附件引用与排除项。
 *
 * 范围按完整回合编号取：`turnFrom` 与 `turnTo` 落在回合中间也按整段回合取，导出永远从回合
 * 边界开始与结束。默认只收用户与助手的可见文本；打开工具阅读记录开关后额外收工具调用与
 * 结果，工具内容同样经过脱敏。记忆召回、思考过程、控制事件与插件记录不入正文，只计数。
 * @module @chatdsh/gateway/exports/collect
 */

import { CHATDSH_ERROR_CODES, type ContentScope } from '@chatdsh/core-contracts';
import type { ReplicaEventRow } from '../maintenance/rows.ts';
import { buildTurnIndex, dataOf, sessionTitleOf, textOfContent, toolNameOf, type TurnSpan } from '../sharing/events.ts';
import type { ReplicaEvent } from '../sharing/types.ts';
import { redactText, type RedactionMode } from './redact.ts';
import { ExportError, type AttachmentRef, type ExportEntry } from './types.ts';

/** 单条条目的字符上限。 */
const MAX_ENTRY_CHARS = 200_000;

/** 一次导出的总字符上限。 */
export const MAX_EXPORT_CHARS = 8_000_000;

/** 附件标记：`[附件 <标识> <文件名> <媒体类型> <字节> 字节]`。 */
const ATTACHMENT_MARKER = /\[附件 ([^\s\]]+) ([^\s\]]+)(?: ([^\s\]]+))?(?: (\d+))?(?: 字节)?\]/gu;

/** 控制事件：与正文无关，不入导出。 */
const CONTROL_KINDS = new Set([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'session/title',
  'session/header',
  'session/created',
  'system/message',
  'developer/message',
]);

/** 收集选项。 */
export interface CollectOptions {
  /** 起始回合，从 1 开始。 */
  readonly turnFrom: number;
  /** 结束回合，含该回合。 */
  readonly turnTo: number;
  /** 是否包含工具阅读记录。 */
  readonly includeToolReads: boolean;
  /** 脱敏方式。 */
  readonly redaction: RedactionMode;
  /** 产品内部路径的根。 */
  readonly internalRoots: readonly string[];
}

/** 收集结果。 */
export interface CollectedContent {
  readonly title: string | undefined;
  readonly turns: readonly number[];
  readonly entries: readonly ExportEntry[];
  readonly attachments: readonly AttachmentRef[];
  readonly excluded: readonly string[];
  readonly redactions: { readonly paths: number; readonly credentials: number };
  readonly dropped: {
    readonly memory: number;
    readonly reasoning: number;
    readonly control: number;
    readonly tool: number;
    readonly other: number;
  };
  /** 正文内容的真实范围；附件完整性由调用方按解析结论补齐。 */
  readonly scope: ContentScope;
}

/** 把副本行还原成带载荷对象的事件。 */
function toReplicaEvents(rows: readonly ReplicaEventRow[]): ReplicaEvent[] {
  return rows.map((row) => ({
    seq: row.seq,
    kind: row.kind,
    time: row.time,
    bytes: row.bytes,
    payload: row.payload === null ? undefined : (JSON.parse(row.payload) as unknown),
  }));
}

/** 值到文本：字符串原样，文本片段拼接，其余按 JSON 序列化。 */
function textOfValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const part of value) {
      if (typeof part === 'object' && part !== null && (part as { type?: unknown }).type !== undefined) {
        if ((part as { type?: unknown }).type !== 'text') continue;
        const text = (part as { text?: unknown }).text;
        if (typeof text === 'string') parts.push(text);
        continue;
      }
      parts.push(textOfValue(part));
    }
    return parts.join('');
  }
  return JSON.stringify(value);
}

/** 用户消息的可见文本。 */
function userTextOf(payload: unknown): string {
  const data = dataOf(payload);
  if (data === undefined) return '';
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

/** 工具调用的记录文本：工具名加参数。 */
function toolCallTextOf(payload: unknown): string {
  const name = toolNameOf(payload) ?? '未命名工具';
  const data = dataOf(payload) ?? {};
  const argumentsText = textOfValue(data['arguments'] ?? data['input'] ?? data['args']);
  return argumentsText === '' ? `工具调用：${name}` : `工具调用：${name}\n参数：${argumentsText}`;
}

/** 工具结果的记录文本。 */
function toolResultTextOf(payload: unknown): string {
  const name = toolNameOf(payload);
  const data = dataOf(payload) ?? {};
  const resultText = textOfValue(
    data['result'] ?? data['output'] ?? data['content'] ?? data['text'] ?? data['summary'],
  );
  const head = name === undefined ? '工具结果' : `工具结果：${name}`;
  return resultText === '' ? head : `${head}\n${resultText}`;
}

/** 消息来源是否为记忆召回。 */
function isMemorySource(payload: unknown): boolean {
  const source = dataOf(payload)?.['source'];
  if (typeof source !== 'object' || source === null) return false;
  return (source as { kind?: unknown }).kind === 'memory-recall';
}

/** 本轮覆盖的完整回合，按回合编号升序。 */
function selectTurns(turns: readonly TurnSpan[], options: CollectOptions): TurnSpan[] {
  const known = new Set(turns.map((turn) => turn.turn));
  if (!known.has(options.turnFrom)) {
    throw new ExportError(
      CHATDSH_ERROR_CODES.requestInvalid,
      'turn-unknown',
      `会话里没有第 ${String(options.turnFrom)} 回合`,
    );
  }
  if (!known.has(options.turnTo)) {
    throw new ExportError(
      CHATDSH_ERROR_CODES.requestInvalid,
      'turn-unknown',
      `会话里没有第 ${String(options.turnTo)} 回合`,
    );
  }
  const selected = turns.filter((turn) => turn.turn >= options.turnFrom && turn.turn <= options.turnTo);
  if (selected.length === 0) {
    throw new ExportError(CHATDSH_ERROR_CODES.requestInvalid, 'range-empty', '这个范围里没有可导出的回合');
  }
  return selected;
}

/**
 * 从副本事件收集导出内容。
 * @param rows - 会话的副本事件，按序号升序。
 * @param options - 回合范围、工具阅读记录开关与脱敏选项。
 * @returns 正文条目、附件引用与排除项。
 */
export function collectContent(rows: readonly ReplicaEventRow[], options: CollectOptions): CollectedContent {
  const events = toReplicaEvents(rows);
  const index = buildTurnIndex(events);
  const selected = selectTurns(index.turns, options);

  const entries: ExportEntry[] = [];
  const dropped = { memory: 0, reasoning: 0, control: 0, tool: 0, other: 0 };
  let paths = 0;
  let credentials = 0;
  let charCount = 0;

  const push = (turn: number, role: ExportEntry['role'], time: number, kind: ExportEntry['kind'], raw: string): void => {
    const trimmed = raw.trim();
    if (trimmed === '') return;
    const redacted = redactText(trimmed.slice(0, MAX_ENTRY_CHARS), {
      mode: options.redaction,
      internalRoots: options.internalRoots,
    });
    paths += redacted.paths;
    credentials += redacted.credentials;
    charCount += [...redacted.text].length;
    entries.push({ turn, role, time, kind, text: redacted.text });
  };

  for (const turn of selected) {
    for (const event of turn.events) {
      if (isMemorySource(event.payload)) {
        dropped.memory += 1;
        continue;
      }
      const kind = event.kind;
      if (kind === 'user/message') {
        push(turn.turn, 'user', event.time, 'message', userTextOf(event.payload));
        continue;
      }
      if (kind === 'assistant/message') {
        push(turn.turn, 'assistant', event.time, 'message', assistantTextOf(event.payload));
        continue;
      }
      if (kind === 'tool/call') {
        dropped.tool += 1;
        if (options.includeToolReads) push(turn.turn, 'tool', event.time, 'tool-read', toolCallTextOf(event.payload));
        continue;
      }
      if (kind === 'tool/result') {
        dropped.tool += 1;
        if (options.includeToolReads) push(turn.turn, 'tool', event.time, 'tool-read', toolResultTextOf(event.payload));
        continue;
      }
      if (kind.includes('reasoning') || kind.includes('thinking')) {
        dropped.reasoning += 1;
        continue;
      }
      if (kind.includes('memory')) {
        dropped.memory += 1;
        continue;
      }
      if (CONTROL_KINDS.has(kind) || kind.startsWith('plugin:')) {
        dropped.control += 1;
        continue;
      }
      dropped.other += 1;
    }
  }

  if (charCount > MAX_EXPORT_CHARS) {
    throw new ExportError(
      CHATDSH_ERROR_CODES.exportTooLarge,
      'chars-too-many',
      `导出内容超过 ${String(MAX_EXPORT_CHARS)} 字符，请缩小回合范围`,
    );
  }

  const excluded = new Set<string>(['replica-watermark']);
  if (credentials > 0) excluded.add('credentials');
  if (paths > 0) excluded.add('internal-paths');
  if (dropped.memory > 0) excluded.add('memory-recall');

  const selectedEvents: ReplicaEvent[] = [];
  for (const turn of selected) selectedEvents.push(...turn.events);

  const first = selected[0];
  const last = selected[selected.length - 1];
  const scope: ContentScope = {
    turnFrom: first === undefined ? options.turnFrom : first.turn,
    turnTo: last === undefined ? options.turnTo : last.turn,
    eventCount: selected.reduce((total, turn) => total + turn.events.length, 0),
    charCount,
    compressed: !options.includeToolReads,
    attachmentsComplete: true,
  };

  return {
    title: sessionTitleOf(events),
    turns: selected.map((turn) => turn.turn),
    entries,
    attachments: attachmentRefsOf(selectedEvents),
    excluded: [...excluded],
    redactions: { paths, credentials },
    dropped,
    scope,
  };
}

/**
 * 提取一段事件里引用到的附件。
 * @param events - 范围内的副本事件。
 * @returns 按出现顺序去重的附件引用。
 */
export function attachmentRefsOf(events: readonly ReplicaEvent[]): AttachmentRef[] {
  const seen = new Map<string, AttachmentRef>();
  for (const event of events) {
    const text = event.payload === undefined ? '' : JSON.stringify(event.payload);
    for (const match of text.matchAll(ATTACHMENT_MARKER)) {
      const id = match[1];
      const filename = match[2];
      if (id === undefined || filename === undefined) continue;
      if (seen.has(id)) continue;
      const mimeType = match[3];
      const size = match[4];
      seen.set(id, {
        id,
        filename,
        ...(mimeType === undefined ? {} : { mimeType }),
        ...(size === undefined ? {} : { size: Number.parseInt(size, 10) }),
      });
    }
  }
  return [...seen.values()];
}
