/**
 * 会话分页的累积与过期读取的判定。
 *
 * 私有读取入口按「更新时间 + 会话标识」游标分页；界面把多页合并成一份列表，并按
 * 「设备 + 会话」去重。读取带代次：切换设备或改变筛选时开启新代次，旧代次的响应到达后
 * 不得写入新设备的页面。
 * @module @chatdsh/client-shell/pages
 */

import { isSessionItem, type SessionItem } from './sessions.ts';

/** 一页读取结果。 */
export interface SessionPage {
  /** 本页的会话。 */
  readonly items: readonly SessionItem[];
  /** 分页信息。 */
  readonly page: {
    /** 后面还有更多。 */
    readonly hasMore: boolean;
    /** 下一页游标；没有更多时缺省。 */
    readonly nextCursor?: string;
  };
}

/**
 * 校验一页读取结果。
 * @param value - 响应体。
 * @returns 形状合法时为真。
 */
export function isSessionPage(value: unknown): value is SessionPage {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const items = record['items'];
  const page = record['page'];
  if (!Array.isArray(items) || !items.every(isSessionItem)) return false;
  if (typeof page !== 'object' || page === null) return false;
  const pageRecord = page as Record<string, unknown>;
  if (typeof pageRecord['hasMore'] !== 'boolean') return false;
  const cursor = pageRecord['nextCursor'];
  if (cursor !== undefined && (typeof cursor !== 'string' || cursor === '')) return false;
  if (pageRecord['hasMore'] === true && cursor === undefined) return false;
  return true;
}

/**
 * 一页的合并键：设备与会话共同确定一条记录。
 * @param item - 会话。
 * @returns 合并键。
 */
function keyOf(item: SessionItem): string {
  return `${item.deviceId}\u0000${item.sessionId}`;
}

/** 多页累积的会话列表。 */
export class SessionPages {
  private readonly keys = new Set<string>();
  private accumulated: SessionItem[] = [];
  private cursor: string | undefined;
  private more = false;

  /** 当前列表。 */
  get items(): readonly SessionItem[] {
    return this.accumulated;
  }

  /** 是否还有更多。 */
  get hasMore(): boolean {
    return this.more;
  }

  /** 下一页游标。 */
  get nextCursor(): string | undefined {
    return this.cursor;
  }

  /**
   * 用一页结果替换全部累积。
   * @param page - 第一页。
   */
  reset(page: SessionPage): void {
    this.keys.clear();
    this.accumulated = [];
    this.cursor = undefined;
    this.more = false;
    this.append(page);
  }

  /**
   * 追加一页结果。已经出现过的「设备 + 会话」保留第一次出现的记录。
   * @param page - 后续页。
   * @returns 实际新增的条数。
   */
  append(page: SessionPage): number {
    let added = 0;
    for (const item of page.items) {
      const key = keyOf(item);
      if (this.keys.has(key)) continue;
      this.keys.add(key);
      this.accumulated.push(item);
      added += 1;
    }
    this.more = page.page.hasMore;
    this.cursor = page.page.hasMore ? page.page.nextCursor : undefined;
    return added;
  }
}

/**
 * 过期读取的判定。
 *
 * 每次开始读取取一个代次号；响应到达时用 `isCurrent` 判断它是否仍然属于最新一次读取。
 * 设备切换、筛选变化与手动刷新都会开启新代次，因此旧响应不会污染新页面。
 */
export class ReadGeneration {
  private value = 0;

  /** 当前代次号。 */
  get current(): number {
    return this.value;
  }

  /**
   * 开启新代次。
   * @returns 新代次号。
   */
  next(): number {
    this.value += 1;
    return this.value;
  }

  /**
   * 判断一个代次是否仍然是最新的。
   * @param ticket - 开始读取时取得的代次号。
   * @returns 仍然最新时为真。
   */
  isCurrent(ticket: number): boolean {
    return ticket === this.value;
  }
}
