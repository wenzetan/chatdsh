/**
 * 桌面控制的审计记录。
 *
 * 每次授权、拒绝、动作、暂停、恢复、中断与撤销都追加一行 JSON 记录，包含时间、作用范围、
 * 期限与结果。记录写到真实文件，按行追加，查询时按时间与种类筛选。
 * @module chatdsh-desktop-control/audit
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 记录的种类的取值。 */
export const AUDIT_KINDS = Object.freeze([
  'request',
  'grant',
  'deny',
  'blocked',
  'use',
  'end',
  'pause',
  'resume',
  'interrupt',
  'revoke',
  'expire',
  'capability',
]);

/** 审计记录。 */
export class AuditLog {
  #file;

  #now;

  /**
   * @param options.file - 记录文件路径。
   * @param options.now - 当前时刻的实现。
   */
  constructor({ file, now = () => Date.now() } = {}) {
    if (typeof file !== 'string' || file === '') throw new Error('审计记录需要文件路径');
    this.#file = file;
    this.#now = now;
    mkdirSync(dirname(file), { recursive: true });
  }

  /** 记录文件路径。 */
  get file() {
    return this.#file;
  }

  /**
   * 追加一条记录。
   * @param entry.kind - 记录种类。
   * @param entry.outcome - 结果。
   * @param entry.scope - 作用范围。
   * @param entry.expiresAt - 期限时刻。
   * @param entry.leaseId - 租约标识。
   * @param entry.requestId - 申请标识。
   * @param entry.action - 动作名。
   * @param entry.detail - 说明。
   * @returns 写入的记录。
   */
  record({ kind, outcome, scope, expiresAt, leaseId, requestId, action, detail }) {
    if (!AUDIT_KINDS.includes(kind)) throw new Error(`未登记的审计种类：${kind}`);
    if (typeof outcome !== 'string' || outcome === '') throw new Error('审计记录需要结果');
    const at = this.#now();
    const entry = {
      at,
      time: new Date(at).toISOString(),
      kind,
      outcome,
      leaseId,
      requestId,
      action,
      scope,
      expiresAt,
      expiresAtTime: expiresAt === undefined ? undefined : new Date(expiresAt).toISOString(),
      detail,
    };
    appendFileSync(this.#file, `${JSON.stringify(entry)}\n`);
    return Object.freeze(entry);
  }

  /**
   * 查询记录，最新的在前。
   * @param filter.kind - 只看某个种类。
   * @param filter.since - 起始时刻，毫秒。
   * @param filter.until - 结束时刻，毫秒。
   * @param filter.limit - 最多返回条数。
   * @returns 记录列表。
   */
  query(filter = {}) {
    if (!existsSync(this.#file)) return [];
    const lines = readFileSync(this.#file, 'utf8').split('\n').filter((line) => line !== '');
    const entries = [];
    for (const line of lines) {
      const entry = JSON.parse(line);
      if (filter.kind !== undefined && entry.kind !== filter.kind) continue;
      if (filter.since !== undefined && entry.at < filter.since) continue;
      if (filter.until !== undefined && entry.at > filter.until) continue;
      entries.push(entry);
    }
    entries.reverse();
    const limit = filter.limit === undefined ? entries.length : filter.limit;
    if (!Number.isInteger(limit) || limit < 0) throw new Error('查询条数需要非负整数');
    return entries.slice(0, limit);
  }

  /** 全部记录。 */
  all() {
    return this.query();
  }
}
