/**
 * Hermes 运行事件流的解析与规范化。
 *
 * SSE 帧由 `eventsource-parser` 处理，分片、换行与事件边界都由它负责；这一层只做
 * 协议翻译与完整性判定：序号必须从续读位置连续递增，未知事件直接失败，运行必须以
 * 恰好一个终态结束。审批事件在到达时立即产出，绝不等待运行结束。
 * @module @chatdsh/hermes-adapter/run-stream
 */

import { EventSourceParserStream } from 'eventsource-parser/stream';
import { HermesError } from './errors.ts';

/** 终态事件名。 */
export const TERMINAL_RUN_EVENTS = ['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted'] as const;

/** 终态取值。 */
export type RunTerminalStatus = 'completed' | 'failed' | 'cancelled' | 'interrupted';

/** 一帧已解析的运行事件。 */
export interface RunFrame {
  /** 运行标识。 */
  readonly runId: string;
  /** 事件标识：SSE 的 `id`，缺省取载荷里的 `seq`。 */
  readonly eventId: string;
  /** 连续序号。 */
  readonly seq: number;
  /** 事件名。 */
  readonly type: string;
  /** 服务端时间戳，毫秒；缺省取收到时刻。 */
  readonly time: number;
  /** 原始载荷。 */
  readonly payload: Readonly<Record<string, unknown>>;
}

/** 审批请求的规范化载荷。 */
export interface ApprovalEventPayload {
  readonly requestId: string;
  readonly title: string;
  readonly choices: readonly string[];
  readonly command?: string;
}

/** 规范化的运行事件；每条都带运行标识与事件标识，便于去重与续读。 */
export type HistoryRunEvent = { readonly runId: string; readonly eventId: string; readonly seq: number } & (
  | { readonly type: 'text.delta'; readonly text: string }
  | { readonly type: 'text.interim'; readonly text: string }
  | { readonly type: 'reasoning'; readonly text: string }
  | { readonly type: 'tool.started'; readonly tool: string; readonly preview: string }
  | { readonly type: 'tool.completed'; readonly tool: string; readonly durationMs: number; readonly failed: boolean }
  | { readonly type: 'subagent.started' }
  | { readonly type: 'subagent.completed' }
  | { readonly type: 'approval.asked'; readonly runId: string; readonly approval: ApprovalEventPayload }
  | { readonly type: 'approval.decided'; readonly requestId: string; readonly choice: string; readonly resolved: number }
  | { readonly type: 'run.steered'; readonly accepted: boolean }
  | { readonly type: 'run.completed'; readonly output: string; readonly usage: Readonly<Record<string, number>> }
  | { readonly type: 'run.failed'; readonly error: string }
  | { readonly type: 'run.cancelled'; readonly partial: boolean }
  | { readonly type: 'run.interrupted'; readonly error: string }
);

/** 流里出现过即失败的事件。 */
const TRUNCATION_EVENT = 'replay.truncated';

/** 文本取值。 */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 数字取值。 */
function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** 审批事件载荷：请求标识必需，标题取说明或命令，选项只保留字符串。 */
function approvalOf(payload: Readonly<Record<string, unknown>>): ApprovalEventPayload {
  const requestId = textOf(payload.request_id);
  if (requestId === '') throw new HermesError('stream', '审批事件缺少 request_id', { code: 'invalid-approval-event' });
  const choices = Array.isArray(payload.choices)
    ? payload.choices.filter((item): item is string => typeof item === 'string')
    : [];
  const title = textOf(payload.description) || textOf(payload.command) || textOf(payload.tool_name) || '审批请求';
  const command = textOf(payload.command);
  return command === ''
    ? { requestId, title, choices }
    : { requestId, title, choices, command };
}

/**
 * 把一帧载荷翻译成规范化事件。
 * @param frame - 已解析的一帧。
 * @returns 规范化事件。
 * @throws {HermesError} 未知事件、截断事件或载荷不合法。
 */
export function translateRunFrame(frame: RunFrame): HistoryRunEvent {
  const base = { runId: frame.runId, eventId: frame.eventId, seq: frame.seq };
  const { payload } = frame;
  switch (frame.type) {
    case 'message.delta':
      return { ...base, type: 'text.delta', text: textOf(payload.delta) };
    case 'message.interim':
      return { ...base, type: 'text.interim', text: textOf(payload.text) };
    case 'reasoning.available':
      return { ...base, type: 'reasoning', text: textOf(payload.text) };
    case 'tool.started':
      return { ...base, type: 'tool.started', tool: textOf(payload.tool), preview: textOf(payload.preview) };
    case 'tool.completed':
      return {
        ...base,
        type: 'tool.completed',
        tool: textOf(payload.tool),
        durationMs: numberOf(payload.duration),
        failed: payload.error === true,
      };
    case 'subagent.start':
      return { ...base, type: 'subagent.started' };
    case 'subagent.complete':
      return { ...base, type: 'subagent.completed' };
    case 'approval.request':
      return { ...base, type: 'approval.asked', approval: approvalOf(payload) };
    case 'approval.responded':
      return {
        ...base,
        type: 'approval.decided',
        requestId: textOf(payload.request_id),
        choice: textOf(payload.choice),
        resolved: numberOf(payload.resolved),
      };
    case 'run.steered':
      return { ...base, type: 'run.steered', accepted: payload.accepted === true };
    case 'run.completed': {
      const usage: Record<string, number> = {};
      if (payload.usage !== null && typeof payload.usage === 'object') {
        for (const [key, value] of Object.entries(payload.usage as Record<string, unknown>)) {
          if (typeof value === 'number' && Number.isFinite(value)) usage[key] = value;
        }
      }
      return { ...base, type: 'run.completed', output: textOf(payload.output), usage };
    }
    case 'run.failed':
      return { ...base, type: 'run.failed', error: textOf(payload.error) || 'Hermes 运行失败' };
    case 'run.cancelled':
      return { ...base, type: 'run.cancelled', partial: payload.partial === true };
    case 'run.interrupted':
      return { ...base, type: 'run.interrupted', error: textOf(payload.error) || 'Hermes 网关中断了运行' };
    case TRUNCATION_EVENT:
      throw new HermesError('stream', 'Hermes 事件流被截断，无法保证事件完整', { code: 'stream-truncated' });
    default:
      throw new HermesError('stream', `Hermes 事件流出现未知必需事件：${frame.type}`, { code: 'unknown-required-event' });
  }
}

/** 终态事件名对应的取值。 */
export function terminalOf(event: HistoryRunEvent): RunTerminalStatus | undefined {
  switch (event.type) {
    case 'run.completed': return 'completed';
    case 'run.failed': return 'failed';
    case 'run.cancelled': return 'cancelled';
    case 'run.interrupted': return 'interrupted';
    default: return undefined;
  }
}

/**
 * 逐帧读取运行事件流。
 *
 * 续读位置之后的帧才产出；序号不连续表示丢帧，直接失败。流结束时没有终态同样失败。
 * @param body - SSE 响应体。
 * @param options - 运行标识、续读序号与取消信号。
 * @returns 帧序列。
 */
export async function* readRunFrames(
  body: ReadableStream<Uint8Array>,
  options: { readonly runId: string; readonly lastEventId?: string; readonly signal?: AbortSignal },
): AsyncGenerator<RunFrame> {
  const decoded = body.pipeThrough(new TextDecoderStream());
  const parsed = decoded.pipeThrough(new EventSourceParserStream({ onError: 'terminate' }));
  const startSeq = options.lastEventId === undefined ? -1 : Number.parseInt(options.lastEventId, 10);
  let lastSeq = Number.isSafeInteger(startSeq) ? startSeq : -1;
  let sawTerminal = false;
  for await (const message of parsed) {
    if (options.signal?.aborted === true) {
      throw new HermesError('stream', 'Hermes 事件流已被取消', { code: 'aborted' });
    }
    const payload = JSON.parse(message.data) as Record<string, unknown>;
    if (payload === null || typeof payload !== 'object') {
      throw new HermesError('stream', 'Hermes 事件流出现非对象载荷', { code: 'invalid-event' });
    }
    const runId = textOf(payload.run_id);
    if (runId !== options.runId) {
      throw new HermesError('stream', `Hermes 事件流属于另一个运行：${runId}`, { code: 'run-mismatch' });
    }
    const eventType = textOf(payload.event) || message.event || '';
    if (eventType === '') throw new HermesError('stream', 'Hermes 事件缺少事件名', { code: 'invalid-event' });
    const seq = typeof payload.seq === 'number' ? payload.seq : Number.parseInt(message.id ?? '', 10);
    if (!Number.isSafeInteger(seq) || seq < 0) {
      throw new HermesError('stream', 'Hermes 事件缺少可用序号', { code: 'invalid-event' });
    }
    if (seq <= lastSeq) continue;
    if (seq !== lastSeq + 1) {
      throw new HermesError('stream', `Hermes 事件流序号不连续：期望 ${lastSeq + 1}，收到 ${seq}`, { code: 'stream-gap' });
    }
    lastSeq = seq;
    if ((TERMINAL_RUN_EVENTS as readonly string[]).includes(eventType)) {
      if (sawTerminal) throw new HermesError('stream', 'Hermes 事件流出现第二个终态', { code: 'multiple-terminal' });
      sawTerminal = true;
    }
    const time = typeof payload.timestamp === 'number' ? payload.timestamp * 1000 : Date.now();
    yield { runId, eventId: String(seq), seq, type: eventType, time, payload };
  }
  if (!sawTerminal) {
    throw new HermesError('stream', `Hermes 运行 ${options.runId} 的事件流结束时没有终态`, { code: 'missing-terminal' });
  }
}

/**
 * 读取并翻译整条运行事件流。
 * @param body - SSE 响应体。
 * @param options - 运行标识、续读序号与取消信号。
 * @returns 规范化事件序列。
 */
export async function* streamRunEvents(
  body: ReadableStream<Uint8Array>,
  options: { readonly runId: string; readonly lastEventId?: string; readonly signal?: AbortSignal },
): AsyncGenerator<HistoryRunEvent> {
  for await (const frame of readRunFrames(body, options)) yield translateRunFrame(frame);
}
