/**
 * 分叉计划：把控制平面的会话副本裁成一段可交给本地会话创建的种子。
 *
 * 分叉只复制完整回合构成的前缀，前缀从第 1 回合连续到用户选择的回合。种子必须从序号 0 起
 * 连续，因此裁剪只发生在尾部：尾部未结束的回合（含仍在运行的工具调用与审批等待）不进种子，
 * 源会话继续在自己的设备上执行。活动工具因此在分叉里没有对应的执行起点；计划里的校验记录
 * 给出重放的工具调用数与定时任务数，两者恒为 0。
 *
 * 压缩复制会把工具调用与工具结果整对移出种子，并重新编号剩余事件，计划的 `lossy` 标记与
 * 损失计数记录这次移除。附件按我们自己的标记语法从复制的文本里提取，缺失的附件标识逐项返回。
 * @module @chatdsh/host-import/fork
 */

import { buildSeed, type ReplicaRecord, type SessionSeedEvent } from './seed.ts';

/** 复制历史的方式。 */
export const FORK_IMPORT_MODES = ['full-prefix', 'compressed'] as const;

/** 复制历史方式的取值。 */
export type ForkImportMode = (typeof FORK_IMPORT_MODES)[number];

/** 复制内容范围，按完整回合编号表达。 */
export interface ForkContentScope {
  /** 起始回合编号，从 1 开始。 */
  readonly turnFrom: number;
  /** 结束回合编号，含该回合。 */
  readonly turnTo: number;
  /** 范围内的事件条数。 */
  readonly eventCount: number;
  /** 范围内的字符数。 */
  readonly charCount: number;
  /** 复制时把工具输出替换成摘要则为真。 */
  readonly compressed: boolean;
  /** 范围内的附件是否全部可用。 */
  readonly attachmentsComplete: boolean;
}

/** 写入新会话的导入声明。 */
export interface ForkImportRecord {
  /** 记录种类标识。 */
  readonly kind: 'import';
  /** 源会话标识。 */
  readonly sourceSessionId: string;
  /** 源会话所在设备。 */
  readonly sourceDeviceId: string;
  /** 导入时源会话副本的同步水位。 */
  readonly sourceWatermark: number;
  /** 导入粒度。 */
  readonly mode: ForkImportMode;
  /** 复制的事件条数。 */
  readonly eventCount: number;
  /** 复制的字符数。 */
  readonly charCount: number;
  /** 压缩导入时为真，表示工具输出已替换成摘要。 */
  readonly lossy: boolean;
  /** 导入时刻的毫秒时间戳。 */
  readonly importedAt: number;
}

/** 分叉的校验记录：约定哪些东西不会被重放。 */
export interface ForkReplayRecord {
  /** 重放的工具调用数，恒为 0。 */
  readonly toolCalls: 0;
  /** 重放的定时任务数，恒为 0。 */
  readonly scheduledTasks: 0;
  /** 留在源会话、没有被复制过来的定时任务数。 */
  readonly retainedScheduledTasks: number;
  /** 前缀里未结束的工具调用数；连续前缀必须为 0。 */
  readonly unresolvedToolCalls: number;
  /** 压缩复制移出的工具调用数。 */
  readonly droppedToolCalls: number;
  /** 压缩复制移出的工具结果数。 */
  readonly droppedToolResults: number;
}

/** 分叉预估，与跨组件契约的形状一致。 */
export interface ForkEstimate {
  /** 复制方式。 */
  readonly importMode: ForkImportMode;
  /** 目标历史范围。 */
  readonly scope: ForkContentScope;
  /** 预估复制的事件条数。 */
  readonly eventCount: number;
  /** 预估复制的字符数。 */
  readonly charCount: number;
  /** 缺失的附件标识。 */
  readonly missingAttachmentIds: string[];
  /** 压缩复制会丢失工具输出原文。 */
  readonly compressionLoss: boolean;
}

/** 分叉计划的输入。 */
export interface ForkPlanInput {
  /** 源会话的副本记录，按序号升序。 */
  readonly records: readonly ReplicaRecord[];
  /** 源会话标识。 */
  readonly sourceSessionId: string;
  /** 源会话所在设备。 */
  readonly sourceDeviceId: string;
  /** 复制的历史范围结束回合，含该回合。 */
  readonly turnTo: number;
  /** 复制方式。 */
  readonly importMode: ForkImportMode;
  /** 源会话当前可用的附件标识；复制范围内引用到不在其中的附件时逐项报告缺失。 */
  readonly availableAttachmentIds: readonly string[];
  /** 入口从调度服务读到的源会话定时任务数；分叉不复制它们。 */
  readonly scheduledTasks: number;
  /** 分叉时刻的毫秒时间戳；缺省取当前时刻。 */
  readonly now?: number;
}

/** 分叉计划的结果。 */
export interface ForkPlan {
  /** 可直接交给会话创建的种子。 */
  readonly seed: SessionSeedEvent[];
  /** 写入新会话的导入声明。 */
  readonly importRecord: ForkImportRecord;
  /** 不重放的校验记录。 */
  readonly replay: ForkReplayRecord;
  /** 分叉预估。 */
  readonly estimate: ForkEstimate;
}

/** 一次复制范围里的事件统计。 */
interface PrefixStats {
  readonly records: ReplicaRecord[];
  readonly turnTo: number;
  readonly eventCount: number;
  readonly charCount: number;
  readonly toolCalls: number;
  readonly toolResults: number;
}

/** 附件标记的识别式，与附件包的 `attachmentMarker` 语法一致。 */
const ATTACHMENT_MARKER = /\[附件 ([^\s\]]+)/g;

/** 一条事件的数据字符数。 */
function charCountOf(record: ReplicaRecord): number {
  const payload = record.payload as { readonly data?: unknown } | null;
  if (payload === null || payload === undefined) return 0;
  const data = payload.data;
  if (data === undefined) return 0;
  return JSON.stringify(data).length;
}

/** 取一条事件里的工具调用标识。 */
function callIdOf(record: ReplicaRecord): string | undefined {
  const data = (record.payload as { readonly data?: unknown } | null)?.data;
  if (typeof data !== 'object' || data === null) return undefined;
  const callId = (data as { readonly callId?: unknown }).callId;
  return typeof callId === 'string' && callId !== '' ? callId : undefined;
}

/**
 * 取出从第 1 回合到指定回合的完整前缀。
 * @param records - 副本记录，按序号升序。
 * @param turnTo - 结束回合编号。
 * @returns 前缀与统计。
 * @throws 记录不连续、回合不存在或该回合尚未结束。
 */
function completePrefix(records: readonly ReplicaRecord[], turnTo: number): PrefixStats {
  if (records.length === 0) throw new Error('副本为空，没有可分叉的内容');
  if (!Number.isInteger(turnTo) || turnTo < 1) throw new Error(`分叉结束回合必须是正整数：${String(turnTo)}`);
  for (const [index, record] of records.entries()) {
    if (record.seq !== index) throw new Error(`副本记录不连续：位置 ${index} 的序号是 ${record.seq}`);
  }
  let turn = 0;  let boundary = -1;
  for (const [index, record] of records.entries()) {
    if (record.kind === 'turn/start') turn += 1;
    if (record.kind === 'turn/end' && turn === turnTo) {
      boundary = index;
      break;
    }
  }
  if (boundary < 0) throw new Error(`副本里没有第 ${turnTo} 回合的结束事件，不能在该回合一刀切`);
  const prefix = records.slice(0, boundary + 1);
  let charCount = 0;
  let toolCalls = 0;
  let toolResults = 0;
  for (const record of prefix) {
    charCount += charCountOf(record);
    if (record.kind === 'tool/call') toolCalls += 1;
    if (record.kind === 'tool/result') toolResults += 1;
  }
  return { records: prefix, turnTo, eventCount: prefix.length, charCount, toolCalls, toolResults };
}

/**
 * 统计前缀里没有结果的工具调用。
 * @param prefix - 连续前缀。
 * @returns 未结束的工具调用条数。
 */
function unresolvedToolCalls(prefix: readonly ReplicaRecord[]): number {
  const answered = new Set<string>();
  for (const record of prefix) {
    if (record.kind !== 'tool/result') continue;
    const callId = callIdOf(record);
    if (callId !== undefined) answered.add(callId);
  }
  let count = 0;
  for (const record of prefix) {
    if (record.kind !== 'tool/call') continue;
    const callId = callIdOf(record);
    if (callId === undefined || !answered.has(callId)) count += 1;
  }
  return count;
}

/**
 * 提取一段前缀里引用到的附件标识。
 * @param prefix - 连续前缀。
 * @returns 按出现顺序去重的附件标识。
 */
function attachmentIdsOf(prefix: readonly ReplicaRecord[]): string[] {
  const seen = new Set<string>();
  for (const record of prefix) {
    const text = JSON.stringify(record.payload ?? null);
    for (const match of text.matchAll(ATTACHMENT_MARKER)) {
      const id = match[1];
      if (id !== undefined) seen.add(id);
    }
  }
  return [...seen];
}

/**
 * 压缩复制：移出工具调用与工具结果，并把剩余事件重新编号。
 * @param prefix - 连续前缀。
 * @param seed - 前缀还原出的种子。
 * @returns 压缩后的种子与被移出的条数。
 */
function compress(prefix: readonly ReplicaRecord[], seed: readonly SessionSeedEvent[]): { seed: SessionSeedEvent[]; droppedToolCalls: number; droppedToolResults: number } {
  const kept: SessionSeedEvent[] = [];
  let droppedToolCalls = 0;
  let droppedToolResults = 0;
  for (const [index, event] of seed.entries()) {
    const kind = prefix[index]?.kind;
    if (kind === 'tool/call') {
      droppedToolCalls += 1;
      continue;
    }
    if (kind === 'tool/result') {
      droppedToolResults += 1;
      continue;
    }
    kept.push({ ...event, seq: kept.length });
  }
  if (kept.length === 0) throw new Error('压缩分叉没有留下任何事件');
  return { seed: kept, droppedToolCalls, droppedToolResults };
}

/**
 * 构造一次分叉计划。
 * @param input - 分叉输入。
 * @returns 种子、导入声明、校验记录与预估。
 * @throws 副本不连续、回合未结束、前缀里仍有未结束的工具调用，或输入不合法。
 */
export function planFork(input: ForkPlanInput): ForkPlan {
  if (input.sourceSessionId.trim() === '') throw new Error('分叉需要源会话标识');
  if (input.sourceDeviceId.trim() === '') throw new Error('分叉需要源设备标识');
  if (!FORK_IMPORT_MODES.includes(input.importMode)) throw new Error(`未知的复制方式：${String(input.importMode)}`);
  if (!Number.isInteger(input.scheduledTasks) || input.scheduledTasks < 0) {
    throw new Error(`定时任务数必须是非负整数：${String(input.scheduledTasks)}`);
  }
  const prefix = completePrefix(input.records, input.turnTo);
  const unresolved = unresolvedToolCalls(prefix.records);
  if (unresolved > 0) {
    throw new Error(`第 ${prefix.turnTo} 回合里还有 ${unresolved} 个没有结果的工具调用，不能作为分叉边界`);
  }
  const fullSeed = buildSeed(prefix.records);
  const compressed = input.importMode === 'compressed';
  const result = compressed
    ? compress(prefix.records, fullSeed)
    : { seed: fullSeed, droppedToolCalls: 0, droppedToolResults: 0 };
  const charCount = compressed
    ? result.seed.reduce((sum, event) => sum + (event.data === undefined ? 0 : JSON.stringify(event.data).length), 0)
    : prefix.charCount;
  const referenced = attachmentIdsOf(prefix.records);
  const available = new Set(input.availableAttachmentIds);
  const missingAttachmentIds = referenced.filter((id) => !available.has(id));
  const now = input.now ?? Date.now();
  const scope: ForkContentScope = {
    turnFrom: 1,
    turnTo: prefix.turnTo,
    eventCount: result.seed.length,
    charCount,
    compressed,
    attachmentsComplete: missingAttachmentIds.length === 0,
  };
  const importRecord: ForkImportRecord = {
    kind: 'import',
    sourceSessionId: input.sourceSessionId,
    sourceDeviceId: input.sourceDeviceId,
    sourceWatermark: prefix.records.length === 0 ? 0 : (prefix.records[prefix.records.length - 1] as ReplicaRecord).seq,
    mode: input.importMode,
    eventCount: result.seed.length,
    charCount,
    lossy: compressed,
    importedAt: now,
  };
  const replay: ForkReplayRecord = {
    toolCalls: 0,
    scheduledTasks: 0,
    retainedScheduledTasks: input.scheduledTasks,
    unresolvedToolCalls: unresolved,
    droppedToolCalls: result.droppedToolCalls,
    droppedToolResults: result.droppedToolResults,
  };
  return {
    seed: result.seed,
    importRecord,
    replay,
    estimate: {
      importMode: input.importMode,
      scope,
      eventCount: result.seed.length,
      charCount,
      missingAttachmentIds,
      compressionLoss: compressed && result.droppedToolResults > 0,
    },
  };
}
