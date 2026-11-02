/**
 * 跟随帧的校验与分类。
 *
 * 会话跟随流有三种帧：`snapshot` 给出打开窗口与游标，`event` 是一条已落盘的会话事件，
 * `assistant-stream` 是模型流式片段。三种帧都来自真实跟随流，字段形状与运行时的会话线上
 * 事件一致：事件带 `type`、`seq`、`time`、`data`，可带 `surfaceOp`、`sourceEventSeqs` 与
 * `ignorable`。
 *
 * 校验用 zod 做结构判定，未知帧类型、缺少 `seq` 或 `type` 的帧直接拒绝，交给调用方登记
 * 错误；不做猜测修补。
 * @module @chatdsh/client-conversation/messages/frames
 */

import { z } from 'zod';

/** 一条会话线上事件。 */
export interface SessionWireEvent {
  /** 事件类型，例如 `assistant/message`。 */
  readonly type: string;
  /** 会话内连续序号。 */
  readonly seq: number;
  /** 事件时刻的毫秒时间戳。 */
  readonly time: number;
  /** 事件载荷。 */
  readonly data: unknown;
  /** 可跳过的插件记录。 */
  readonly ignorable?: true;
  /** 可替换的表面事件引用的更早事件序号。 */
  readonly sourceEventSeqs?: unknown;
  /** 表面事件的位置声明。 */
  readonly surfaceOp?: unknown;
}

/** 一条模型流式片段。 */
export type StreamChunk =
  | { readonly type: 'text-delta'; readonly index: number; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly index: number; readonly text: string }
  | {
      readonly type: 'tool-call-delta';
      readonly index: number;
      readonly id: string;
      readonly name?: string;
      readonly argumentsDelta: string;
    }
  | { readonly type: 'block-start'; readonly index: number; readonly blockType: string }
  | { readonly type: 'block-end'; readonly index: number; readonly block: unknown }
  | { readonly type: 'usage'; readonly usage: unknown }
  | { readonly type: 'finish'; readonly reason: unknown };

/** 一次流式尝试的片段帧。 */
export type AssistantStreamFrame =
  | {
      readonly type: 'start';
      readonly attemptId: string;
      readonly revision: number;
      readonly startedAfterSeq: number;
      readonly turn: number;
      readonly step: number;
    }
  | {
      readonly type: 'chunk';
      readonly attemptId: string;
      readonly revision: number;
      readonly index: number;
      readonly time: number;
      readonly chunk: StreamChunk;
    }
  | {
      readonly type: 'end';
      readonly attemptId: string;
      readonly revision: number;
      readonly index: number;
      readonly outcome:
        | { readonly kind: 'committed'; readonly eventType: string; readonly seq: number }
        | { readonly kind: 'abandoned' };
    };

/** 打开窗口里的一条记录。 */
export interface SessionEventEntry {
  readonly type: 'event';
  readonly event: SessionWireEvent;
}

/** 一次流式尝试的基线。 */
export interface AssistantStreamBaseline {
  readonly revision: number;
  readonly activeAttempt?: {
    readonly attemptId: string;
    readonly revision: number;
    readonly startedAfterSeq: number;
    readonly turn: number;
    readonly step: number;
  };
}

/** 跟随流的一帧。 */
export type FollowFrame =
  | {
      readonly type: 'snapshot';
      readonly cursor: number;
      readonly records: readonly SessionEventEntry[];
      readonly hasMore: boolean;
      readonly assistantStream?: AssistantStreamBaseline;
    }
  | SessionEventEntry
  | { readonly type: 'assistant-stream'; readonly frame: AssistantStreamFrame };

const eventSchema = z.looseObject({
  type: z.string().min(1),
  seq: z.number().int().nonnegative(),
  time: z.number().int().nonnegative(),
  data: z.unknown(),
  ignorable: z.literal(true).optional(),
  sourceEventSeqs: z.unknown().optional(),
  surfaceOp: z.unknown().optional(),
});

const chunkSchema = z.union([
  z.looseObject({ type: z.literal('text-delta'), index: z.number().int().nonnegative(), text: z.string() }),
  z.looseObject({ type: z.literal('reasoning-delta'), index: z.number().int().nonnegative(), text: z.string() }),
  z.looseObject({
    type: z.literal('tool-call-delta'),
    index: z.number().int().nonnegative(),
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    argumentsDelta: z.string(),
  }),
  z.looseObject({ type: z.literal('block-start'), index: z.number().int().nonnegative(), blockType: z.string().min(1) }),
  z.looseObject({ type: z.literal('block-end'), index: z.number().int().nonnegative(), block: z.unknown() }),
  z.looseObject({ type: z.literal('usage'), usage: z.unknown() }),
  z.looseObject({ type: z.literal('finish'), reason: z.unknown() }),
]);

const streamFrameSchema = z.union([
  z.looseObject({
    type: z.literal('start'),
    attemptId: z.string().min(1),
    revision: z.number().int().nonnegative(),
    startedAfterSeq: z.number().int().nonnegative(),
    turn: z.number().int().nonnegative(),
    step: z.number().int().nonnegative(),
  }),
  z.looseObject({
    type: z.literal('chunk'),
    attemptId: z.string().min(1),
    revision: z.number().int().nonnegative(),
    index: z.number().int().nonnegative(),
    time: z.number().int().nonnegative(),
    chunk: chunkSchema,
  }),
  z.looseObject({
    type: z.literal('end'),
    attemptId: z.string().min(1),
    revision: z.number().int().nonnegative(),
    index: z.number().int().nonnegative(),
    outcome: z.union([
      z.looseObject({ kind: z.literal('committed'), eventType: z.string().min(1), seq: z.number().int().nonnegative() }),
      z.looseObject({ kind: z.literal('abandoned') }),
    ]),
  }),
]);

const entrySchema = z.looseObject({ type: z.literal('event'), event: eventSchema });

const snapshotSchema = z.looseObject({
  type: z.literal('snapshot'),
  cursor: z.number().int().nonnegative(),
  records: z.array(entrySchema),
  hasMore: z.boolean(),
  assistantStream: z
    .looseObject({
      revision: z.number().int().nonnegative(),
      activeAttempt: z
        .looseObject({
          attemptId: z.string().min(1),
          revision: z.number().int().nonnegative(),
          startedAfterSeq: z.number().int().nonnegative(),
          turn: z.number().int().nonnegative(),
          step: z.number().int().nonnegative(),
        })
        .optional(),
    })
    .optional(),
});

const frameSchema = z.union([
  snapshotSchema,
  entrySchema,
  z.looseObject({ type: z.literal('assistant-stream'), frame: streamFrameSchema }),
]);

/**
 * 校验并分类一帧跟随帧。
 * @param value - 已解析的 JSON 值。
 * @returns 分类后的帧。
 * @throws 结构不合法时抛出，说明缺少的字段。
 */
export function parseFollowFrame(value: unknown): FollowFrame {
  const parsed = frameSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue === undefined ? '' : issue.path.join('.');
    throw new Error(`跟随帧结构不合法：${path === '' ? '未知字段形状' : path}`);
  }
  return parsed.data as FollowFrame;
}

/**
 * 把值当作对象读取。
 * @param value - 待读取的值。
 * @returns 对象；不是对象时为 `undefined`。
 */
export function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  return value as Record<string, unknown>;
}

/**
 * 读取一个对象字段。
 * @param source - 来源对象。
 * @param key - 字段名。
 * @returns 字段值；不是对象时为 `undefined`。
 */
export function fieldOf(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null) return undefined;
  return (source as Record<string, unknown>)[key];
}

/**
 * 读取一个字符串字段。
 * @param source - 来源对象。
 * @param key - 字段名。
 * @returns 字符串值；字段不是字符串时为 `undefined`。
 */
export function stringOf(source: unknown, key: string): string | undefined {
  const value = fieldOf(source, key);
  return typeof value === 'string' ? value : undefined;
}

/**
 * 读取一个数字字段。
 * @param source - 来源对象。
 * @param key - 字段名。
 * @returns 数字值；字段不是有限数字时为 `undefined`。
 */
export function numberOf(source: unknown, key: string): number | undefined {
  const value = fieldOf(source, key);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * 读取一个布尔字段。
 * @param source - 来源对象。
 * @param key - 字段名。
 * @returns 布尔值；字段不是布尔时为 `undefined`。
 */
export function booleanOf(source: unknown, key: string): boolean | undefined {
  const value = fieldOf(source, key);
  return typeof value === 'boolean' ? value : undefined;
}
