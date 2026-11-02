/**
 * 分享面板的纯逻辑：回合范围、附件候选、状态判定、占用统计与导入校验。
 *
 * 这些函数不接触网络与浏览器环境，输入是控制平面返回的真实数据，输出是界面直接渲染的
 * 结构。回合编号与回合边界的计算方式与宿主侧 `gateway/src/sharing/events.ts` 一致，
 * 界面给出的回合集合因此与服务端解析出的回合是同一批。
 * @module @chatdsh/client-share/share
 */

import type {
  ReplicaEvent,
  ShareAttachmentCandidate,
  ShareExclusion,
  ShareRange,
  ShareRecordView,
  ShareStatus,
} from './types.ts';
import { SHARE_EXCLUSIONS } from './types.ts';

export { SHARE_EXCLUSIONS };

/** 一条待公开的消息。 */
export interface PreviewMessage {
  readonly seq: number;
  readonly role: 'user' | 'assistant';
  readonly time: number;
  readonly text: string;
}

/** 副本里的一个回合。 */
export interface TurnRange {
  readonly index: number;
  /** 回合编号，取自 `turn/start` 的 `data.turn`；缺失时按上一个回合加一。 */
  readonly turn: number;
  readonly startSeq: number;
  /** 回合内最后一条事件的序号。 */
  readonly endSeq: number;
  readonly startedAt: number;
  readonly endedAt?: number;
  /** 回合内出现了 `turn/end` 为真；为假表示回合还在进行。 */
  readonly complete: boolean;
  readonly userText?: string;
  readonly assistantCount: number;
}

/** 有效期选项。 */
export interface TtlOption {
  readonly id: string;
  readonly label: string;
  /** 缺省表示不设期限。 */
  readonly ttlMs?: number;
}

/** 有效期选项。 */
export const TTL_OPTIONS: readonly TtlOption[] = [
  { id: 'none', label: '不设期限' },
  { id: 'hour', label: '1 小时', ttlMs: 60 * 60 * 1000 },
  { id: 'day', label: '24 小时', ttlMs: 24 * 60 * 60 * 1000 },
  { id: 'week', label: '7 天', ttlMs: 7 * 24 * 60 * 60 * 1000 },
  { id: 'month', label: '30 天', ttlMs: 30 * 24 * 60 * 60 * 1000 },
];

/** 取事件的数据段。 */
function dataOf(event: ReplicaEvent): Record<string, unknown> | undefined {
  const payload = event.payload;
  if (typeof payload !== 'object' || payload === null) return undefined;
  const data = (payload as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return undefined;
  return data as Record<string, unknown>;
}

/**
 * 从消息事件里取可见文本。
 * @param event - 用户或助手消息事件。
 * @returns 可见文本；取不到时返回空字符串。
 */
export function textOf(event: ReplicaEvent): string {
  const data = dataOf(event);
  if (data === undefined) return '';
  const text = data['text'];
  if (typeof text === 'string') return text;
  const content = data['content'];
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part);
      continue;
    }
    if (typeof part !== 'object' || part === null) continue;
    const value = (part as { text?: unknown }).text;
    if (typeof value === 'string') parts.push(value);
  }
  return parts.join('');
}

/**
 * 计算回合范围。
 *
 * 回合由 `turn/start` 划出边界，边界之间的全部事件属于同一个回合；`turn/end` 出现表示
 * 回合已经结束。没有 `turn/start` 的会话按一个回合处理，与宿主侧的回合索引一致。
 * @param events - 副本事件，按序号升序。
 * @returns 回合列表，按起始序号升序。
 */
export function turnRangesOf(events: readonly ReplicaEvent[]): TurnRange[] {
  const ranges: TurnRange[] = [];
  let open:
    | {
        turn: number;
        startSeq: number;
        endSeq: number;
        startedAt: number;
        endedAt?: number;
        complete: boolean;
        assistantCount: number;
        userText?: string;
      }
    | undefined;
  let lastTurn = 0;
  const close = (): void => {
    if (open === undefined) return;
    ranges.push({
      index: ranges.length,
      turn: open.turn,
      startSeq: open.startSeq,
      endSeq: open.endSeq,
      startedAt: open.startedAt,
      ...(open.endedAt === undefined ? {} : { endedAt: open.endedAt }),
      complete: open.complete,
      ...(open.userText === undefined ? {} : { userText: open.userText }),
      assistantCount: open.assistantCount,
    });
    open = undefined;
  };
  for (const event of events) {
    if (event.kind === 'turn/start') {
      close();
      const raw = dataOf(event)?.['turn'];
      const explicit = typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : undefined;
      lastTurn = explicit ?? lastTurn + 1;
      open = {
        turn: lastTurn,
        startSeq: event.seq,
        endSeq: event.seq,
        startedAt: event.time,
        complete: false,
        assistantCount: 0,
      };
      continue;
    }
    if (open === undefined) continue;
    open.endSeq = event.seq;
    if (event.kind === 'turn/end') {
      open.complete = true;
      open.endedAt = event.time;
      continue;
    }
    if (event.kind === 'assistant/message') {
      open.assistantCount += 1;
      continue;
    }
    if (event.kind === 'user/message' && open.userText === undefined) {
      open.userText = textOf(event);
    }
  }
  close();
  if (ranges.length === 0) {
    const first = events[0];
    const last = events[events.length - 1];
    if (first !== undefined && last !== undefined) {
      ranges.push({
        index: 0,
        turn: 1,
        startSeq: first.seq,
        endSeq: last.seq,
        startedAt: first.time,
        endedAt: last.time,
        complete: true,
        assistantCount: events.filter((event) => event.kind === 'assistant/message').length,
      });
    }
  }
  return ranges;
}

/** 附件标识允许的字符集，与宿主的附件标识形式一致。 */
const ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** 事件里可能的附件片段列表。 */
function blocksOf(event: ReplicaEvent): readonly unknown[] {
  const data = dataOf(event);
  if (data === undefined) return [];
  const blocks: unknown[] = [];
  const push = (value: unknown): void => {
    if (Array.isArray(value)) blocks.push(...value);
  };
  push(data['content']);
  const message = data['message'];
  if (typeof message === 'object' && message !== null) push((message as { content?: unknown }).content);
  return blocks;
}

/**
 * 从一段片段里读出附件标识与元数据。
 * @param block - 消息内容里的一段，或事件自带的附件清单条目。
 * @param listed - 为真表示这段来自附件清单，条目本身就是附件记录。
 * @returns 附件候选；形状不符合约定时返回空。
 */
function candidateOf(block: unknown, listed = false): ShareAttachmentCandidate | undefined {
  if (typeof block !== 'object' || block === null) return undefined;
  const record = block as Record<string, unknown>;
  const type = record['type'];
  const nested = record['attachment'];
  const source = listed
    ? record
    : (type === 'image' || type === 'file') && typeof nested === 'object' && nested !== null
      ? (nested as Record<string, unknown>)
      : type === 'attachment'
        ? record
        : undefined;
  if (source === undefined) return undefined;
  const rawId = source['attachmentId'] ?? source['id'];
  if (typeof rawId !== 'string' || !ATTACHMENT_ID_PATTERN.test(rawId)) return undefined;
  const filename = source['filename'] ?? source['name'];
  const mimeType = source['mimeType'];
  const size = source['size'];
  return {
    id: rawId,
    filename: typeof filename === 'string' && filename !== '' ? filename : rawId,
    ...(typeof mimeType === 'string' && mimeType !== '' ? { mimeType } : {}),
    ...(typeof size === 'number' && Number.isFinite(size) && size >= 0 ? { size } : {}),
  };
}

/**
 * 列出事件里出现过的附件。
 *
 * 同一条附件在多条事件里出现时保留第一次读到的元数据；顺序按首次出现的先后，
 * 界面因此与消息顺序一致。附件可能出现在消息内容片段里，也可能出现在事件自带的附件
 * 清单里，两处都算候选。
 * @param events - 范围内的副本事件，按序号升序。
 * @returns 附件候选列表。
 */
export function attachmentCandidatesOf(events: readonly ReplicaEvent[]): ShareAttachmentCandidate[] {
  const found = new Map<string, ShareAttachmentCandidate>();
  const add = (candidate: ShareAttachmentCandidate | undefined): void => {
    if (candidate === undefined) return;
    if (!found.has(candidate.id)) found.set(candidate.id, candidate);
  };
  for (const event of events) {
    for (const block of blocksOf(event)) add(candidateOf(block));
    const listed = dataOf(event)?.['attachments'];
    if (Array.isArray(listed)) {
      for (const item of listed) add(candidateOf(item, true));
    }
  }
  return [...found.values()];
}

/**
 * 判定一条分享记录当前的状态。
 * @param record - 分享记录。
 * @param now - 当前时刻的毫秒时间戳。
 * @returns 状态。
 */
export function statusOf(record: ShareRecordView, now: number): ShareStatus {
  if (record.revokedAt !== undefined) return 'revoked';
  if (record.expiresAt !== undefined && record.expiresAt <= now) return 'expired';
  return 'active';
}

/** 状态文案。 */
export const STATUS_LABELS: Readonly<Record<ShareStatus, string>> = {
  active: '有效',
  revoked: '已撤销',
  expired: '已过期',
};

/** 记录能否产生可访问链接的结论。 */
export interface RecordAvailability {
  readonly kind: ShareStatus | 'missing-package' | 'missing-content' | 'no-path';
  readonly label: string;
  readonly detail: string;
  readonly linkable: boolean;
}

/**
 * 判定一条记录的可访问结论。
 *
 * 只有同时满足三个条件的记录才给出链接：状态有效、快照占用大于零、记录声明附件副本齐全
 * 且控制平面给出了公开路径。其余记录在列表里说明原因，复制与打开两个动作都不出现。
 * @param record - 分享记录。
 * @param now - 当前时刻的毫秒时间戳。
 * @returns 可访问结论。
 */
export function availabilityOf(record: ShareRecordView, now: number): RecordAvailability {
  const status = statusOf(record, now);
  if (status === 'revoked') {
    return {
      kind: 'revoked',
      label: STATUS_LABELS.revoked,
      detail: record.revokedAt === undefined ? '链接已撤销，公开页返回失效页面' : `已于 ${formatTime(record.revokedAt)} 撤销，公开页返回失效页面`,
      linkable: false,
    };
  }
  if (status === 'expired') {
    return {
      kind: 'expired',
      label: STATUS_LABELS.expired,
      detail: record.expiresAt === undefined ? '链接已过期' : `已于 ${formatTime(record.expiresAt)} 过期，公开页返回失效页面`,
      linkable: false,
    };
  }
  if (record.bytes <= 0) {
    return {
      kind: 'missing-content',
      label: '快照内容缺失',
      detail: '这条记录没有可读的快照内容，公开页没有正文',
      linkable: false,
    };
  }
  if (!record.scope.attachmentsComplete) {
    return {
      kind: 'missing-package',
      label: '附件副本缺失',
      detail: '记录声明附件副本不完整，公开页的附件读不到',
      linkable: false,
    };
  }
  if (record.path === undefined) {
    return {
      kind: 'no-path',
      label: '缺少公开路径',
      detail: '控制平面没有给出这条记录的公开路径',
      linkable: false,
    };
  }
  return {
    kind: 'active',
    label: STATUS_LABELS.active,
    detail: describeExpiry(record, now),
    linkable: true,
  };
}

/** 分享记录的汇总统计。 */
export interface ShareStats {
  readonly count: number;
  readonly active: number;
  readonly visits: number;
  /** 全部分享占用的字节数，取自控制平面的总量统计。 */
  readonly bytes: number;
}

/**
 * 汇总记录列表。
 * @param records - 分享记录。
 * @param totalBytes - 控制平面给出的占用总量。
 * @param now - 当前时刻。
 * @returns 统计。
 */
export function statsOf(records: readonly ShareRecordView[], totalBytes: number, now: number): ShareStats {
  let visits = 0;
  let active = 0;
  for (const record of records) {
    visits += record.visits;
    if (availabilityOf(record, now).linkable) active += 1;
  }
  return { count: records.length, active, visits, bytes: totalBytes };
}

/**
 * 拼接公开页地址。
 *
 * 路径取自控制平面返回的 `path`，来源地址取浏览器当前地址：拼出来的链接就是本页所在
 * 主机上的真实地址，路径不由界面拼造。
 * @param origin - 当前页面来源，例如 `http://127.0.0.1:3170`。
 * @param path - 记录里的公开路径，例如 `/s/<token>`。
 * @returns 完整地址。
 */
export function shareUrlOf(origin: string, path: string): string {
  const base = new URL(origin);
  if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error(`分享地址需要 http 或 https：${origin}`);
  return `${base.origin}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * 回合编号清单的展示文字。
 * @param turns - 回合编号，升序。
 * @returns 连续时写成区间，否则逐项列出。
 */
export function describeTurns(turns: readonly number[]): string {
  if (turns.length === 0) return '没有回合';
  const contiguous = turns.every((turn, index) => index === 0 || turn === (turns[index - 1] ?? 0) + 1);
  if (contiguous) {
    const first = turns[0];
    const last = turns[turns.length - 1];
    return first === last ? `回合 ${String(first)}` : `回合 ${String(first)} 至 ${String(last)}（共 ${String(turns.length)} 个）`;
  }
  return `回合 ${turns.map((turn) => String(turn)).join('、')}（共 ${String(turns.length)} 个）`;
}

/**
 * 分享范围方式的说明文字。
 * @param range - 分享范围。
 * @returns 说明。
 */
export function describeRangeMode(range: ShareRange): string {
  switch (range.mode) {
    case 'session':
      return '会话全部（截止建立分享时的副本水位）';
    case 'turns':
      return `指定回合集合：${describeTurns(range.turns)}`;
    case 'range':
      return range.turnFrom === range.turnTo ? `完整回合边界：回合 ${String(range.turnFrom)}` : `完整回合边界：回合 ${String(range.turnFrom)} 至 ${String(range.turnTo)}`;
    case 'bound':
      return '截止上界：所选回合及之前的全部完整回合';
  }
}

/**
 * 字节数的展示文字。
 * @param bytes - 字节数。
 * @returns 形如 `1.4 KB` 或 `920 字节` 的文字。
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) throw new Error(`字节数必须是非负有限数值：${String(bytes)}`);
  if (bytes < 1024) return `${String(Math.round(bytes))} 字节`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit] ?? 'KB'}`;
}

/**
 * 占用字节的完整说法：短单位加精确字节数。
 * @param bytes - 字节数。
 * @returns 说明文字。
 */
export function describeBytes(bytes: number): string {
  return bytes < 1024 ? formatBytes(bytes) : `${formatBytes(bytes)}（${String(bytes)} 字节）`;
}

/**
 * 毫秒时间戳的本地展示。
 * @param at - 毫秒时间戳。
 * @returns 形如 `2026-11-01 20:03` 的本地时间。
 */
export function formatTime(at: number | undefined): string {
  if (at === undefined) return '未设置';
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 剩余有效期文案。
 * @param expiresAt - 到期时刻；缺省表示不设期限。
 * @param now - 当前时刻。
 * @returns 说明文字。
 */
export function describeExpiryAt(expiresAt: number | undefined, now: number): string {
  if (expiresAt === undefined) return '不过期';
  if (expiresAt <= now) return `已于 ${formatTime(expiresAt)} 过期`;
  const minutes = Math.max(1, Math.round((expiresAt - now) / 60_000));
  if (minutes < 60) return `${String(minutes)} 分钟后过期（${formatTime(expiresAt)}）`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${String(hours)} 小时后过期（${formatTime(expiresAt)}）`;
  return `${String(Math.round(hours / 24))} 天后过期（${formatTime(expiresAt)}）`;
}

/**
 * 记录的剩余有效期文案。
 * @param record - 分享记录。
 * @param now - 当前时刻。
 * @returns 说明文字。
 */
export function describeExpiry(record: ShareRecordView, now: number): string {
  if (record.revokedAt !== undefined) return `已于 ${formatTime(record.revokedAt)} 撤销`;
  return describeExpiryAt(record.expiresAt, now);
}

/** 导入校验失败的一条结论。 */
export interface ImportFailure {
  readonly index: number;
  readonly code: string;
  readonly message: string;
}

/** 导入校验结论。 */
export interface ImportValidation {
  readonly ok: boolean;
  readonly failures: readonly ImportFailure[];
  readonly events: readonly ReplicaEvent[];
  readonly turns: number;
  readonly characters: number;
}

/**
 * 校验副本事件的形状。
 *
 * 导入把副本原样写进新会话，形状不合法的记录会让新会话在读取时就地崩溃，因此这一步在
 * 提交之前逐条检查：序号严格递增、类型非空、时间是有限数值、载荷里的类型与记录类型一致。
 * @param value - 副本读取结果里的 `events`。
 * @returns 校验结论。
 */
export function validateReplicaEvents(value: unknown): ImportValidation {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      failures: [{ index: -1, code: 'events-not-array', message: '副本事件不是数组，无法导入' }],
      events: [],
      turns: 0,
      characters: 0,
    };
  }
  const failures: ImportFailure[] = [];
  const events: ReplicaEvent[] = [];
  let previous = -1;
  let characters = 0;
  for (let index = 0; index < value.length; index += 1) {
    const raw: unknown = value[index];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      failures.push({ index, code: 'event-not-object', message: `第 ${String(index)} 条事件不是对象` });
      continue;
    }
    const record = raw as Record<string, unknown>;
    const seq = record['seq'];
    const kind = record['kind'];
    const time = record['time'];
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) {
      failures.push({ index, code: 'seq-invalid', message: `第 ${String(index)} 条事件的序号不是非负整数` });
      continue;
    }
    if (seq <= previous) {
      failures.push({ index, code: 'seq-order', message: `第 ${String(index)} 条事件的序号 ${String(seq)} 没有按升序排列` });
      continue;
    }
    if (typeof kind !== 'string' || kind === '') {
      failures.push({ index, code: 'kind-invalid', message: `第 ${String(index)} 条事件的类型为空` });
      continue;
    }
    if (typeof time !== 'number' || !Number.isFinite(time)) {
      failures.push({ index, code: 'time-invalid', message: `第 ${String(index)} 条事件的时间不是有限数值` });
      continue;
    }
    const payload = record['payload'];
    if (payload !== undefined) {
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        failures.push({ index, code: 'payload-invalid', message: `第 ${String(index)} 条事件的载荷不是对象` });
        continue;
      }
      const payloadType = (payload as { type?: unknown }).type;
      if (payloadType !== undefined && payloadType !== kind) {
        failures.push({ index, code: 'payload-type-mismatch', message: `第 ${String(index)} 条事件的载荷类型与记录类型不一致` });
        continue;
      }
    }
    previous = seq;
    const event: ReplicaEvent = {
      seq,
      kind,
      time,
      ...(typeof record['bytes'] === 'number' ? { bytes: record['bytes'] } : {}),
      ...(payload === undefined ? {} : { payload }),
    };
    events.push(event);
    characters += textOf(event).length;
  }
  return {
    ok: failures.length === 0,
    failures,
    events,
    turns: turnRangesOf(events).length,
    characters,
  };
}

/** 排除项。 */
export type { ShareExclusion };
