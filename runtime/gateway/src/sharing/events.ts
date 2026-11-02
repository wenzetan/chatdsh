/**
 * 副本事件到回合的分组与文本抽取。
 *
 * 分享以完整回合为单位：`turn/start` 划出回合边界，边界之间的全部事件属于同一个回合。
 * 这一层只读事件结构，不做过滤；哪些事件进入快照由 `filter.ts` 决定。
 * @module @chatdsh/gateway/sharing/events
 */

import type { ReplicaEvent } from './types.ts';

/** 一个完整回合。 */
export interface TurnSpan {
  /** 回合编号，取自 `turn/start` 的 `data.turn`；缺失时按位次顺延。 */
  readonly turn: number;
  readonly startSeq: number;
  readonly endSeq: number;
  readonly events: readonly ReplicaEvent[];
}

/** 回合索引。 */
export interface TurnIndex {
  /** 首个 `turn/start` 之前的事件，只承载会话标题一类的信息。 */
  readonly prelude: readonly ReplicaEvent[];
  readonly turns: readonly TurnSpan[];
}

/** 取事件的数据段。 */
export function dataOf(payload: unknown): Record<string, unknown> | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const data = (payload as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return undefined;
  return data as Record<string, unknown>;
}

/** 回合编号：只接受正整数的 `data.turn`。 */
function turnNumberOf(event: ReplicaEvent): number | undefined {
  const data = dataOf(event.payload);
  const turn = data?.['turn'];
  return typeof turn === 'number' && Number.isInteger(turn) && turn > 0 ? turn : undefined;
}

/**
 * 按 `turn/start` 把事件切成完整回合。
 * @param events - 副本事件，按序号升序。
 * @returns 回合索引。
 */
export function buildTurnIndex(events: readonly ReplicaEvent[]): TurnIndex {
  const prelude: ReplicaEvent[] = [];
  const turns: { turn: number; startSeq: number; endSeq: number; events: ReplicaEvent[] }[] = [];
  for (const event of events) {
    if (event.kind === 'turn/start') {
      const explicit = turnNumberOf(event);
      const turn = explicit ?? (turns.length === 0 ? 1 : (turns[turns.length - 1]?.turn ?? 0) + 1);
      turns.push({ turn, startSeq: event.seq, endSeq: event.seq, events: [event] });
      continue;
    }
    const current = turns[turns.length - 1];
    if (current === undefined) {
      prelude.push(event);
      continue;
    }
    current.events.push(event);
    current.endSeq = event.seq;
  }
  // 没有任何回合边界标记的会话按一个完整回合处理，避免整段历史无法分享。
  if (turns.length === 0 && prelude.length > 0) {
    const first = prelude[0];
    const last = prelude[prelude.length - 1];
    if (first !== undefined && last !== undefined) {
      return {
        prelude: [],
        turns: [{ turn: 1, startSeq: first.seq, endSeq: last.seq, events: [...prelude] }],
      };
    }
  }
  return { prelude, turns };
}

/** 会话标题：取最后一条合法的 `session/title`。 */
export function sessionTitleOf(events: readonly ReplicaEvent[]): string | undefined {
  let title: string | undefined;
  for (const event of events) {
    if (event.kind !== 'session/title') continue;
    const value = dataOf(event.payload)?.['title'];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed === '' || trimmed.length > 120) continue;
    title = trimmed;
  }
  return title;
}

/**
 * 从消息内容里取可见文本。
 *
 * 只接受字符串与 `text` 片段：图像、工具调用等片段本身可能带参数与路径，一律不进入分享。
 * @param value - `content` 或 `text` 字段。
 * @returns 可见文本；没有文本片段时为空字符串。
 */
export function textOfContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  const parts: string[] = [];
  for (const part of value) {
    if (typeof part === 'string') {
      parts.push(part);
      continue;
    }
    if (typeof part !== 'object' || part === null) continue;
    const type = (part as { type?: unknown }).type;
    if (type !== undefined && type !== 'text') continue;
    const text = (part as { text?: unknown }).text;
    if (typeof text === 'string') parts.push(text);
  }
  return parts.join('');
}

/** 工具名：只接受安全字符集，避免把参数或路径带进快照。 */
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:@-]{1,64}$/;

/** 取工具调用里的工具名。 */
export function toolNameOf(payload: unknown): string | undefined {
  const data = dataOf(payload);
  const name = data?.['name'] ?? data?.['tool'];
  return typeof name === 'string' && TOOL_NAME_PATTERN.test(name) ? name : undefined;
}
