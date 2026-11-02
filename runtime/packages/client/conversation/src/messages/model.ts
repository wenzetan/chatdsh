/**
 * 会话事件的呈现投影：把已落盘的会话事件折叠成消息条目与轨迹条目。
 *
 * 投影规则固定：
 * - 消息正文来自 `user/message`、`assistant/message`、`system/message`、`developer/message`
 *   的内容块；连续的文本块合并成一个文本片段，思考块单独成段并默认折叠。
 * - `tool/call` 提供工具名、原始参数与开始时刻，`tool/result` 按 `callId` 与调用配对，
 *   给出状态、耗时与结果正文；结果超过展示上限时截断并保留完整正文供展开读取。
 * - `turn/*` 与 `step/*` 进入轨迹，默认折叠；未知事件与可跳过的插件记录只计数。
 * - 每条消息带时刻、状态与执行来源（本机执行或远程执行）。
 * @module @chatdsh/client-conversation/messages/model
 */

import { booleanOf, fieldOf, numberOf, recordOf, stringOf, type SessionWireEvent } from './frames.ts';

/** 消息角色。 */
export const MESSAGE_ROLES = ['user', 'assistant', 'system', 'developer'] as const;

/** 消息角色取值。 */
export type MessageRole = (typeof MESSAGE_ROLES)[number];

/** 执行来源：本机执行或远程执行。 */
export const EXECUTION_SOURCES = ['local', 'remote'] as const;

/** 执行来源取值。 */
export type ExecutionSource = (typeof EXECUTION_SOURCES)[number];

/** 执行来源的展示文字。 */
export const EXECUTION_SOURCE_TEXT: Readonly<Record<ExecutionSource, string>> = {
  local: '本机执行',
  remote: '远程执行',
};

/** 消息状态。 */
export const MESSAGE_STATUSES = ['waiting-first-token', 'streaming', 'completed', 'interrupted', 'failed'] as const;

/** 消息状态取值。 */
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/** 消息状态的展示文字。 */
export const MESSAGE_STATUS_TEXT: Readonly<Record<MessageStatus, string>> = {
  'waiting-first-token': '等待首字',
  streaming: '正在输出',
  completed: '已完成',
  interrupted: '连接中断',
  failed: '输出失败',
};

/** 文本片段。 */
export interface TextSegment {
  readonly kind: 'text';
  readonly text: string;
}

/** 思考片段；默认折叠。 */
export interface ReasoningSegment {
  readonly kind: 'reasoning';
  readonly text: string;
  readonly collapsed: boolean;
}

/** 工具结果视图：截断标记与完整读取入口。 */
export interface ToolResultView {
  /** 展示用正文；超出上限时为前缀。 */
  readonly text: string;
  /** 完整正文，保留在本地供展开读取。 */
  readonly fullText: string;
  /** 完整正文的字节数。 */
  readonly bytes: number;
  /** 是否被截断。 */
  readonly truncated: boolean;
  /** 完整正文是否已经在本地，可以展开读取。 */
  readonly fullReadable: boolean;
  /** 失败原因码；工具成功时缺省。 */
  readonly errorCode?: string;
}

/** 工具调用片段。 */
export interface ToolSegment {
  readonly kind: 'tool';
  /** 工具调用标识，与结果配对。 */
  readonly callId: string;
  /** 工具名。 */
  readonly name: string;
  /** 调用状态。 */
  readonly status: 'running' | 'succeeded' | 'failed';
  /** 原始参数文本，按代码卡片展示。 */
  readonly argumentsText: string;
  /** 单行参数摘要，供卡片标题行使用。 */
  readonly argumentsSummary: string;
  /** 调用开始时刻的毫秒时间戳。 */
  readonly startedAt: number;
  /** 耗时；结果未到时缺省。 */
  readonly durationMs?: number;
  /** 结果视图；结果未到时缺省。 */
  readonly result?: ToolResultView;
}

/** 附件片段。 */
export interface AttachmentSegment {
  readonly kind: 'attachment';
  readonly attachmentId: string;
  readonly filename?: string;
  readonly mimeType?: string;
  readonly size?: number;
}

/** 消息片段。 */
export type MessageSegment = TextSegment | ReasoningSegment | ToolSegment | AttachmentSegment;

/** 一条消息。 */
export interface MessageEntry {
  /** 稳定标识：优先取事件里的消息标识。 */
  readonly id: string;
  readonly role: MessageRole;
  readonly source: ExecutionSource;
  /** 消息时刻的毫秒时间戳。 */
  readonly at: number;
  readonly status: MessageStatus;
  readonly segments: readonly MessageSegment[];
  /** 输出被中断时为真。 */
  readonly interrupted?: boolean;
}

/** 轨迹条目的种类。 */
export const TRACE_KINDS = ['turn-start', 'turn-end', 'step-start', 'step-end', 'error'] as const;

/** 轨迹条目种类取值。 */
export type TraceKind = (typeof TRACE_KINDS)[number];

/** 一条轨迹。 */
export interface TraceEntry {
  readonly id: string;
  readonly kind: TraceKind;
  readonly at: number;
  readonly label: string;
  readonly detail?: string;
  /** 轨迹默认折叠。 */
  readonly collapsed: boolean;
}

/** 一次投影的结果。 */
export interface Projection {
  readonly messages: readonly MessageEntry[];
  readonly trace: readonly TraceEntry[];
  /** 被跳过的未知事件数量。 */
  readonly ignoredEvents: number;
  /** 被跳过的未知内容块数量。 */
  readonly ignoredBlocks: number;
}

/** 投影选项。 */
export interface ProjectOptions {
  /** 执行来源。 */
  readonly source: ExecutionSource;
  /** 工具结果展示上限，单位字节。 */
  readonly truncateBytes?: number;
}

/** 工具结果默认展示上限，单位字节。 */
export const DEFAULT_TRUNCATE_BYTES = 4096;

/** 参数摘要的最大字符数。 */
const ARGUMENTS_SUMMARY_MAX = 120;

/**
 * 取字符串的 UTF-8 字节数。
 * @param text - 文本。
 * @returns 字节数。
 */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * 按字节上限截断文本，保留开头部分。
 *
 * 截断点落在码点边界上，不会切开多字节字符。
 * @param text - 完整文本。
 * @param limit - 字节上限。
 * @returns 展示文本、完整字节数与是否被截断。
 */
export function truncateForDisplay(text: string, limit: number): { text: string; bytes: number; truncated: boolean } {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('截断上限必须是正整数');
  const bytes = utf8Bytes(text);
  if (bytes <= limit) return { text, bytes, truncated: false };
  const encoder = new TextEncoder();
  let used = 0;
  let end = 0;
  for (const character of text) {
    const size = encoder.encode(character).length;
    if (used + size > limit) break;
    used += size;
    end += character.length;
  }
  return { text: text.slice(0, end), bytes, truncated: true };
}

/**
 * 生成单行参数摘要。
 * @param text - 原始参数文本。
 * @returns 折叠空白并截断后的摘要。
 */
export function summarizeArguments(text: string): string {
  const single = text.replaceAll(/\s+/g, ' ').trim();
  return single.length <= ARGUMENTS_SUMMARY_MAX ? single : `${single.slice(0, ARGUMENTS_SUMMARY_MAX)}…`;
}

/**
 * 把一段文本追加到片段列表。
 *
 * 末尾已经是文本片段时直接合并，保证连续片段只呈现一个文本片段。
 * @param segments - 现有片段。
 * @param text - 追加的文本。
 * @returns 新的片段列表。
 */
export function appendText(segments: readonly MessageSegment[], text: string): MessageSegment[] {
  if (text === '') return [...segments];
  const last = segments.at(-1);
  if (last !== undefined && last.kind === 'text') {
    return [...segments.slice(0, -1), { kind: 'text', text: last.text + text }];
  }
  return [...segments, { kind: 'text', text }];
}

/**
 * 把一段思考追加到片段列表。
 *
 * 末尾已经是思考片段时直接合并。
 * @param segments - 现有片段。
 * @param text - 追加的思考文本。
 * @returns 新的片段列表。
 */
export function appendReasoning(segments: readonly MessageSegment[], text: string): MessageSegment[] {
  if (text === '') return [...segments];
  const last = segments.at(-1);
  if (last !== undefined && last.kind === 'reasoning') {
    return [...segments.slice(0, -1), { kind: 'reasoning', text: last.text + text, collapsed: last.collapsed }];
  }
  return [...segments, { kind: 'reasoning', text, collapsed: true }];
}

/**
 * 把工具调用的参数片段追加到片段列表。
 *
 * 参数片段按 `callId` 定位；找不到时新建一条调用片段。
 * @param segments - 现有片段。
 * @param callId - 工具调用标识。
 * @param name - 工具名；只在新建时使用。
 * @param delta - 参数片段。
 * @param at - 调用开始时刻。
 * @returns 新的片段列表。
 */
export function appendToolArguments(
  segments: readonly MessageSegment[],
  callId: string,
  name: string,
  delta: string,
  at: number
): MessageSegment[] {
  const index = segments.findIndex((segment) => segment.kind === 'tool' && segment.callId === callId);
  if (index < 0) {
    return [
      ...segments,
      {
        kind: 'tool',
        callId,
        name,
        status: 'running',
        argumentsText: delta,
        argumentsSummary: summarizeArguments(delta),
        startedAt: at,
      },
    ];
  }
  const found = segments[index]!;
  if (found.kind !== 'tool') throw new Error('工具片段定位失败');
  const argumentsText = found.argumentsText + delta;
  const next: ToolSegment = {
    ...found,
    argumentsText,
    argumentsSummary: summarizeArguments(argumentsText),
  };
  return [...segments.slice(0, index), next, ...segments.slice(index + 1)];
}

/**
 * 读取内容块里的附件引用。
 * @param block - 内容块。
 * @returns 附件片段；不是附件块时为 `undefined`。
 */
function attachmentOf(block: unknown): AttachmentSegment | undefined {
  const type = stringOf(block, 'type');
  if (type !== 'image' && type !== 'file') return undefined;
  const attachment = fieldOf(block, 'attachment');
  const attachmentId = stringOf(attachment, 'attachmentId') ?? stringOf(attachment, 'id');
  if (attachmentId === undefined) return undefined;
  const segment: AttachmentSegment = {
    kind: 'attachment',
    attachmentId,
    ...(stringOf(attachment, 'filename') === undefined ? {} : { filename: stringOf(attachment, 'filename') }),
    ...(stringOf(attachment, 'mimeType') === undefined ? {} : { mimeType: stringOf(attachment, 'mimeType') }),
    ...(numberOf(attachment, 'size') === undefined ? {} : { size: numberOf(attachment, 'size') }),
  };
  return segment;
}

/**
 * 把内容块折叠成片段。
 * @param content - 内容块数组。
 * @param at - 事件时刻的毫秒时间戳，作为工具调用的开始时刻。
 * @returns 片段列表与被跳过的块数量。
 */
export function contentToSegments(
  content: unknown,
  at: number
): { segments: MessageSegment[]; ignoredBlocks: number } {
  let segments: MessageSegment[] = [];
  let ignoredBlocks = 0;
  if (!Array.isArray(content)) return { segments, ignoredBlocks };
  for (const block of content) {
    const type = stringOf(block, 'type');
    if (type === 'text') {
      const text = stringOf(block, 'text') ?? '';
      segments = appendText(segments, text);
      continue;
    }
    if (type === 'reasoning') {
      segments = appendReasoning(segments, stringOf(block, 'text') ?? '');
      continue;
    }
    if (type === 'tool-call') {
      const callId = stringOf(block, 'id');
      const name = stringOf(block, 'name');
      if (callId === undefined || name === undefined) {
        ignoredBlocks += 1;
        continue;
      }
      const argumentsText = stringOf(block, 'arguments') ?? '';
      segments = appendToolArguments(segments, callId, name, argumentsText, at);
      continue;
    }
    const attachment = attachmentOf(block);
    if (attachment !== undefined) {
      segments = [...segments, attachment];
      continue;
    }
    ignoredBlocks += 1;
  }
  return { segments, ignoredBlocks };
}

/**
 * 取消息正文的纯文本，供复制与播报使用。
 * @param segments - 片段列表。
 * @returns 文本片段与思考片段按顺序拼接的正文。
 */
export function segmentsText(segments: readonly MessageSegment[]): string {
  const parts: string[] = [];
  for (const segment of segments) {
    if (segment.kind === 'text') parts.push(segment.text);
    else if (segment.kind === 'reasoning') parts.push(segment.text);
    else if (segment.kind === 'tool') parts.push(segment.result?.text ?? '');
  }
  return parts.join('\n').trim();
}

/** 轨迹条目的标签。 */
function traceLabel(kind: TraceKind, data: unknown): string {
  const turn = numberOf(data, 'turn');
  const step = numberOf(data, 'step');
  switch (kind) {
    case 'turn-start':
      return turn === undefined ? '回合开始' : `回合 ${turn} 开始`;
    case 'turn-end': {
      const reason = fieldOf(data, 'reason');
      const reasonKind = stringOf(reason, 'kind') ?? 'unknown';
      const text = reasonKind === 'completed' ? '完成' : reasonKind === 'error' ? '失败' : reasonKind;
      return turn === undefined ? `回合结束（${text}）` : `回合 ${turn} 结束（${text}）`;
    }
    case 'step-start':
      return step === undefined ? '步骤开始' : `步骤 ${step} 开始`;
    case 'step-end':
      return step === undefined ? '步骤结束' : `步骤 ${step} 结束`;
    case 'error': {
      const error = fieldOf(data, 'error');
      return stringOf(error, 'code') ?? '运行错误';
    }
  }
}

/**
 * 把工具结果挂到对应的调用片段上。
 * @param entries - 消息草稿。
 * @param callId - 工具调用标识。
 * @param update - 状态、耗时与结果。
 * @returns 找到并更新时为真。
 */
function attachToolResult(
  entries: MessageEntry[],
  callId: string,
  update: { status: 'succeeded' | 'failed'; durationMs?: number; result: ToolResultView }
): boolean {
  for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex -= 1) {
    const entry = entries[entryIndex]!;
    const segmentIndex = entry.segments.findIndex((segment) => segment.kind === 'tool' && segment.callId === callId);
    if (segmentIndex < 0) continue;
    const segment = entry.segments[segmentIndex]!;
    if (segment.kind !== 'tool') continue;
    const nextSegment: ToolSegment = {
      ...segment,
      status: update.status,
      result: update.result,
      ...(update.durationMs === undefined ? {} : { durationMs: update.durationMs }),
    };
    const segments = [...entry.segments.slice(0, segmentIndex), nextSegment, ...entry.segments.slice(segmentIndex + 1)];
    entries[entryIndex] = { ...entry, segments };
    return true;
  }
  return false;
}

/**
 * 把事件流投影成消息与轨迹。
 *
 * 事件必须按 `seq` 单调递增，乱序输入直接抛出，避免把错位的历史当成正确内容呈现。
 * @param events - 会话事件，按序号升序。
 * @param options - 执行来源与展示上限。
 * @returns 投影结果。
 */
export function projectConversation(events: readonly SessionWireEvent[], options: ProjectOptions): Projection {
  const truncateBytes = options.truncateBytes ?? DEFAULT_TRUNCATE_BYTES;
  const entries: MessageEntry[] = [];
  const trace: TraceEntry[] = [];
  const calls = new Map<string, { name: string; arguments: string; at: number }>();
  let ignoredEvents = 0;
  let ignoredBlocks = 0;
  let previousSeq = -1;

  for (const event of events) {
    if (event.seq <= previousSeq) throw new Error(`会话事件序号不递增：${event.seq}`);
    previousSeq = event.seq;
    const data = recordOf(event.data);

    switch (event.type) {
      case 'user/message': {
        const content = fieldOf(data, 'content');
        const blocks = contentToSegments(content, event.time);
        ignoredBlocks += blocks.ignoredBlocks;
        const text = stringOf(data, 'text');
        const segments = text === undefined ? blocks.segments : appendText(blocks.segments, text);
        entries.push({
          id: stringOf(data, 'id') ?? `user:${event.seq}`,
          role: 'user',
          source: options.source,
          at: event.time,
          status: 'completed',
          segments,
        });
        break;
      }
      case 'assistant/message': {
        const message = fieldOf(data, 'message');
        const blocks = contentToSegments(fieldOf(message, 'content'), event.time);
        ignoredBlocks += blocks.ignoredBlocks;
        const text = stringOf(data, 'text');
        const segments = text === undefined ? blocks.segments : appendText(blocks.segments, text);
        const interrupted = booleanOf(data, 'interrupted') === true;
        entries.push({
          id: stringOf(message, 'id') ?? `assistant:${event.seq}`,
          role: 'assistant',
          source: options.source,
          at: event.time,
          status: interrupted ? 'interrupted' : 'completed',
          segments,
          ...(interrupted ? { interrupted: true } : {}),
        });
        break;
      }
      case 'system/message':
      case 'developer/message': {
        const blocks = contentToSegments(fieldOf(data, 'content'), event.time);
        ignoredBlocks += blocks.ignoredBlocks;
        const text = stringOf(data, 'text');
        const segments = text === undefined ? blocks.segments : appendText(blocks.segments, text);
        entries.push({
          id: stringOf(data, 'id') ?? `${event.type === 'system/message' ? 'system' : 'developer'}:${event.seq}`,
          role: event.type === 'system/message' ? 'system' : 'developer',
          source: options.source,
          at: event.time,
          status: 'completed',
          segments,
        });
        break;
      }
      case 'tool/call': {
        const callId = stringOf(data, 'callId');
        const name = stringOf(data, 'name');
        if (callId === undefined || name === undefined) {
          ignoredEvents += 1;
          break;
        }
        const argumentsText = stringOf(data, 'arguments') ?? '';
        calls.set(callId, { name, arguments: argumentsText, at: event.time });
        const existing = entries.some((entry) =>
          entry.segments.some((segment) => segment.kind === 'tool' && segment.callId === callId)
        );
        if (!existing) {
          const last = entries.at(-1);
          const segment: ToolSegment = {
            kind: 'tool',
            callId,
            name,
            status: 'running',
            argumentsText,
            argumentsSummary: summarizeArguments(argumentsText),
            startedAt: event.time,
          };
          if (last !== undefined && last.role === 'assistant') {
            entries[entries.length - 1] = { ...last, segments: [...last.segments, segment] };
          } else {
            entries.push({
              id: `tool:${callId}`,
              role: 'assistant',
              source: options.source,
              at: event.time,
              status: 'completed',
              segments: [segment],
            });
          }
        }
        break;
      }
      case 'tool/result': {
        const message = fieldOf(data, 'message');
        const source = fieldOf(message, 'source');
        const callId = stringOf(message, 'toolCallId') ?? stringOf(source, 'callId');
        if (callId === undefined) {
          ignoredEvents += 1;
          break;
        }
        const blocks = contentToSegments(fieldOf(message, 'content'), event.time);
        ignoredBlocks += blocks.ignoredBlocks;
        const raw = segmentsText(blocks.segments);
        const shown = truncateForDisplay(raw, truncateBytes);
        const error = fieldOf(data, 'error');
        const failed = booleanOf(message, 'isError') === true || error !== undefined;
        const result: ToolResultView = {
          text: shown.text,
          fullText: raw,
          bytes: shown.bytes,
          truncated: shown.truncated,
          fullReadable: true,
          ...(stringOf(error, 'code') === undefined ? {} : { errorCode: stringOf(error, 'code') }),
        };
        const call = calls.get(callId);
        const attached = attachToolResult(entries, callId, {
          status: failed ? 'failed' : 'succeeded',
          result,
          ...(call === undefined ? {} : { durationMs: Math.max(0, event.time - call.at) }),
        });
        if (!attached) {
          entries.push({
            id: `tool:${callId}`,
            role: 'assistant',
            source: options.source,
            at: event.time,
            status: 'completed',
            segments: [
              {
                kind: 'tool',
                callId,
                name: call?.name ?? '工具',
                status: failed ? 'failed' : 'succeeded',
                argumentsText: call?.arguments ?? '',
                argumentsSummary: summarizeArguments(call?.arguments ?? ''),
                startedAt: call?.at ?? event.time,
                result,
              },
            ],
          });
        }
        break;
      }
      case 'turn/start':
      case 'turn/end':
      case 'step/start':
      case 'step/end': {
        const kind: TraceKind =
          event.type === 'turn/start'
            ? 'turn-start'
            : event.type === 'turn/end'
              ? 'turn-end'
              : event.type === 'step/start'
                ? 'step-start'
                : 'step-end';
        trace.push({
          id: `${kind}:${event.seq}`,
          kind,
          at: event.time,
          label: traceLabel(kind, data),
          ...(kind === 'turn-end' ? { detail: `序号 ${event.seq}` } : {}),
          collapsed: true,
        });
        break;
      }
      default: {
        if (event.ignorable === true) {
          ignoredEvents += 1;
          break;
        }
        if (event.type.includes('error')) {
          trace.push({
            id: `error:${event.seq}`,
            kind: 'error',
            at: event.time,
            label: traceLabel('error', data),
            collapsed: true,
          });
          break;
        }
        ignoredEvents += 1;
      }
    }
  }

  return { messages: entries, trace, ignoredEvents, ignoredBlocks };
}

/**
 * 把毫秒时间戳格式化成时分秒。
 * @param at - 毫秒时间戳。
 * @returns `HH:MM:SS` 形式的本地时间。
 */
export function formatMessageTime(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
