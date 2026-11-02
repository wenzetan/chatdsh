/**
 * 分享范围的解析。
 *
 * 三种范围按完整回合取内容：会话全部、指定回合集合、完整回合边界。第四种是兼容旧请求
 * 的上界：上界落在某个回合中间时，整段该回合都算进快照，保证快照永远从回合边界开始与
 * 结束。解析失败按请求不合法拒绝，并给出稳定原因。
 * @module @chatdsh/gateway/sharing/range
 */

import { CHATDSH_ERROR_CODES } from '@chatdsh/core-contracts';
import { ShareError, type ShareRange } from './types.ts';
import type { TurnIndex, TurnSpan } from './events.ts';

/** 解析后的范围。 */
export interface ResolvedRange {
  readonly turns: readonly TurnSpan[];
  readonly turnNumbers: readonly number[];
  readonly turnFrom: number;
  readonly turnTo: number;
  readonly eventCount: number;
  /** 范围上界的事件序号，只用于读副本与存储，不进入任何响应。 */
  readonly boundSeq: number;
}

/** 一次范围允许的回合条数上限。 */
const MAX_TURNS = 512;

/** 校验正整数。 */
function positiveInteger(value: unknown, reason: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ShareError(CHATDSH_ERROR_CODES.requestInvalid, reason, '回合编号必须是正整数');
  }
  return value;
}

/** 组装解析结果。 */
function assemble(turns: readonly TurnSpan[]): ResolvedRange {
  if (turns.length === 0) {
    throw new ShareError(CHATDSH_ERROR_CODES.requestInvalid, 'empty', '这个范围里没有可公开的回合');
  }
  const numbers = [...new Set(turns.map((turn) => turn.turn))].sort((left, right) => left - right);
  const first = numbers[0];
  const last = numbers[numbers.length - 1];
  if (first === undefined || last === undefined) {
    throw new ShareError(CHATDSH_ERROR_CODES.requestInvalid, 'empty', '这个范围里没有可公开的回合');
  }
  return {
    turns,
    turnNumbers: numbers,
    turnFrom: first,
    turnTo: last,
    eventCount: turns.reduce((total, turn) => total + turn.events.length, 0),
    boundSeq: turns.reduce((max, turn) => Math.max(max, turn.endSeq), 0),
  };
}

/**
 * 把范围解析成完整回合。
 * @param index - 回合索引。
 * @param range - 范围。
 * @returns 选中的完整回合与边界。
 */
export function resolveRange(index: TurnIndex, range: ShareRange): ResolvedRange {
  switch (range.mode) {
    case 'session':
      return assemble(index.turns);
    case 'turns': {
      if (!Array.isArray(range.turns) || range.turns.length === 0) {
        throw new ShareError(CHATDSH_ERROR_CODES.requestInvalid, 'turns-empty', '指定回合集合不能为空');
      }
      if (range.turns.length > MAX_TURNS) {
        throw new ShareError(CHATDSH_ERROR_CODES.requestInvalid, 'turns-too-many', `一次最多指定 ${String(MAX_TURNS)} 个回合`);
      }
      const wanted = new Set(range.turns.map((turn) => positiveInteger(turn, 'turn-invalid')));
      const known = new Set(index.turns.map((turn) => turn.turn));
      for (const turn of wanted) {
        if (!known.has(turn)) {
          throw new ShareError(CHATDSH_ERROR_CODES.requestInvalid, 'turn-unknown', `会话里没有第 ${String(turn)} 回合`);
        }
      }
      return assemble(index.turns.filter((turn) => wanted.has(turn.turn)));
    }
    case 'range': {
      const from = positiveInteger(range.turnFrom, 'turn-from-invalid');
      const to = positiveInteger(range.turnTo, 'turn-to-invalid');
      if (to < from) {
        throw new ShareError(CHATDSH_ERROR_CODES.requestInvalid, 'range-order', '结束回合必须不小于起始回合');
      }
      if (to - from + 1 > MAX_TURNS) {
        throw new ShareError(CHATDSH_ERROR_CODES.requestInvalid, 'turns-too-many', `一次最多指定 ${String(MAX_TURNS)} 个回合`);
      }
      const selected = index.turns.filter((turn) => turn.turn >= from && turn.turn <= to);
      if (selected.length === 0) {
        throw new ShareError(CHATDSH_ERROR_CODES.requestInvalid, 'range-empty', `会话里没有第 ${String(from)} 到第 ${String(to)} 回合的内容`);
      }
      return assemble(selected);
    }
    case 'bound': {
      if (typeof range.upToSeq !== 'number' || !Number.isInteger(range.upToSeq) || range.upToSeq < 0) {
        throw new ShareError(CHATDSH_ERROR_CODES.requestInvalid, 'bound-invalid', '上界必须是非负整数');
      }
      const selected = index.turns.filter((turn) => turn.startSeq <= range.upToSeq);
      if (selected.length === 0) {
        throw new ShareError(CHATDSH_ERROR_CODES.requestInvalid, 'bound-empty', '上界之前没有完整回合');
      }
      return assemble(selected);
    }
  }
}
