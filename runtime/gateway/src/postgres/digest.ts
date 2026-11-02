/**
 * 迁移前后的摘要比对。
 *
 * 三类摘要共用一套规范化：对象键按字典序排列后序列化，再逐条累加进 SHA-256。这样源侧
 * （JSONL 行或 SQLite 行）与目标侧（Postgres 的 jsonb）即使键顺序不同也能算出同一个摘要，
 * 摘要相同即代表逐条内容一致，摘要不同就拒绝宣布迁移完成。
 * @module @chatdsh/gateway/postgres/digest
 */

import { createHash } from 'node:crypto';

/** 参与日志摘要的事件。 */
export interface DigestEvent {
  /** 事件序号。 */
  readonly seq: number;
  /** 事件种类。 */
  readonly type: string;
  /** 事件时刻的毫秒时间戳。 */
  readonly time: number;
  /** 事件正文。 */
  readonly payload: unknown;
}

/** 参与日志摘要的会话。 */
export interface DigestSession {
  /** 会话标识。 */
  readonly id: string;
  /** 事件列表，按序号升序。 */
  readonly events: readonly DigestEvent[];
}

/** 参与索引摘要的文档。 */
export interface DigestDocument {
  /** 会话标识。 */
  readonly sessionId: string;
  /** 事件序号。 */
  readonly seq: number;
  /** 事件种类。 */
  readonly kind: string;
  /** 检索文本。 */
  readonly content: string;
}

/** 参与用量摘要的记录。 */
export interface DigestUsage {
  /** 会话标识。 */
  readonly sessionId: string;
  /** 轮次。 */
  readonly turn: number;
  /** 输入 token 数。 */
  readonly inputTokens: number;
  /** 输出 token 数。 */
  readonly outputTokens: number;
  /** 缓存命中 token 数。 */
  readonly cachedTokens: number;
  /** 推理 token 数。 */
  readonly reasoningTokens: number;
}

/** 把值规范化成稳定的 JSON 文本：对象键按字典序，数组保持顺序。 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`摘要不接受非有限数值：${String(value)}`);
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  throw new Error(`摘要不接受 ${typeof value} 类型的值`);
}

/** 全日志摘要：会话标识、序号、种类、时刻与规范化正文。 */
export function logDigest(sessions: readonly DigestSession[]): string {
  const hash = createHash('sha256');
  const ordered = [...sessions].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  for (const session of ordered) {
    hash.update(`session\u0000${session.id}\u0000${session.events.length}\u0001`);
    for (const event of session.events) {
      hash.update(
        `${event.seq}\u0000${event.type}\u0000${event.time}\u0000${canonicalJson(event.payload)}\u0001`,
      );
    }
  }
  return hash.digest('hex');
}

/** 索引摘要：会话标识、序号、种类与检索文本。 */
export function indexDigest(documents: readonly DigestDocument[]): string {
  const hash = createHash('sha256');
  const ordered = [...documents].sort((left, right) => {
    if (left.sessionId !== right.sessionId) return left.sessionId < right.sessionId ? -1 : 1;
    return left.seq - right.seq;
  });
  for (const document of ordered) {
    hash.update(`${document.sessionId}\u0000${document.seq}\u0000${document.kind}\u0000${document.content}\u0001`);
  }
  return hash.digest('hex');
}

/** 用量摘要：会话标识、轮次与四类 token 计数。 */
export function usageDigest(rows: readonly DigestUsage[]): string {
  const hash = createHash('sha256');
  const ordered = [...rows].sort((left, right) => {
    if (left.sessionId !== right.sessionId) return left.sessionId < right.sessionId ? -1 : 1;
    return left.turn - right.turn;
  });
  for (const row of ordered) {
    hash.update(
      `${row.sessionId}\u0000${row.turn}\u0000${row.inputTokens}\u0000${row.outputTokens}\u0000${row.cachedTokens}\u0000${row.reasoningTokens}\u0001`,
    );
  }
  return hash.digest('hex');
}

/** 三类摘要的一组结果。 */
export interface MigrationDigests {
  /** 全日志摘要。 */
  readonly log: string;
  /** 索引摘要。 */
  readonly index: string;
  /** 用量摘要。 */
  readonly usage: string;
  /** 会话数。 */
  readonly sessions: number;
  /** 事件数。 */
  readonly events: number;
  /** 索引文档数。 */
  readonly documents: number;
  /** 用量行数。 */
  readonly usageRows: number;
}

/** 汇总一组摘要。 */
export function summarize(input: {
  readonly sessions: readonly DigestSession[];
  readonly documents: readonly DigestDocument[];
  readonly usage: readonly DigestUsage[];
}): MigrationDigests {
  return {
    log: logDigest(input.sessions),
    index: indexDigest(input.documents),
    usage: usageDigest(input.usage),
    sessions: input.sessions.length,
    events: input.sessions.reduce((total, session) => total + session.events.length, 0),
    documents: input.documents.length,
    usageRows: input.usage.length,
  };
}
