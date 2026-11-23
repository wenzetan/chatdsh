/**
 * 中继 PWA 的 IndexedDB 离线草稿。
 *
 * 草稿按会话标识隔离，键带固定前缀，数据库版本与升级步骤在纯函数里判定。页面脚本使用
 * 这里的 IndexedDB 实现，单元测试使用同一套键、记录校验与迁移函数的内存实现。草稿只保存
 * 文本与修订号，不保存令牌、请求头或工具结果。
 * @module @chatdsh/gateway/pwa-drafts
 */

/** 草稿数据库名。 */
export const DRAFT_DB_NAME = 'chatdsh-pwa-drafts';

/** 草稿数据库版本；从 1 升到 2 时把旧 `draft` 仓库迁到 `drafts`。 */
export const DRAFT_DB_VERSION = 2;

/** 当前对象仓库名。 */
export const DRAFT_STORE_NAME = 'drafts';

/** 旧版对象仓库名。 */
export const DRAFT_LEGACY_STORE_NAME = 'draft';

/** 草稿键前缀。 */
export const DRAFT_KEY_PREFIX = 'session:';

/** 单条草稿文本长度上限。 */
export const DRAFT_TEXT_MAX = 262144;

/** 会话标识长度上限。 */
export const DRAFT_SESSION_MAX = 200;

/** 一条草稿记录。 */
export interface DraftRecord {
  readonly key: string;
  readonly sessionId: string;
  readonly text: string;
  readonly revision: number;
  readonly updatedAt: number;
}

/** 草稿存储接口；页面与测试共用。 */
export interface DraftStore {
  load(sessionId: string): Promise<DraftRecord | undefined>;
  save(sessionId: string, text: string, now?: number): Promise<DraftRecord | undefined>;
  clear(sessionId: string): Promise<void>;
  listSessionIds(): Promise<string[]>;
}

/** 数据库升级步骤。 */
export interface DraftUpgradePlan {
  readonly createStore: boolean;
  readonly migrateLegacy: boolean;
  readonly dropLegacy: boolean;
}

/**
 * 取草稿的存储键。
 * @param sessionId - 会话标识。
 * @returns `session:<sessionId>`。
 */
export function draftKeyOf(sessionId: string): string {
  if (typeof sessionId !== 'string' || sessionId.trim() === '' || sessionId.length > DRAFT_SESSION_MAX) {
    throw new Error('草稿需要非空的会话标识');
  }
  return `${DRAFT_KEY_PREFIX}${sessionId}`;
}

/**
 * 校验并还原一条草稿记录。
 * @param value - 来自 IndexedDB 或旧版仓库的值。
 * @param textMax - 文本长度上限。
 * @returns 合法记录；字段缺失或类型不符时为 `undefined`。
 */
export function normalizeDraftRecord(value: unknown, textMax = DRAFT_TEXT_MAX): DraftRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const sessionId = record.sessionId;
  const text = record.text;
  const revision = record.revision;
  const updatedAt = record.updatedAt;
  if (typeof sessionId !== 'string' || sessionId.trim() === '' || sessionId.length > DRAFT_SESSION_MAX) return undefined;
  if (typeof text !== 'string') return undefined;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) return undefined;
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return undefined;
  return {
    key: draftKeyOf(sessionId),
    sessionId,
    text: text.slice(0, textMax),
    revision,
    updatedAt,
  };
}

/**
 * 生成下一次保存的草稿记录。
 * @param sessionId - 会话标识。
 * @param text - 输入框内容。
 * @param previous - 已有记录。
 * @param now - 当前时刻。
 * @returns 新记录；只有空白内容时返回 `undefined`，表示删除草稿。
 */
export function draftRecordOf(
  sessionId: string,
  text: string,
  previous: DraftRecord | undefined,
  now: number,
): DraftRecord | undefined {
  const key = draftKeyOf(sessionId);
  const trimmed = text.slice(0, DRAFT_TEXT_MAX);
  if (trimmed.trim() === '') return undefined;
  return {
    key,
    sessionId,
    text: trimmed,
    revision: (previous?.revision ?? 0) + 1,
    updatedAt: now,
  };
}

/**
 * 旧版记录的迁移。
 * @param value - 旧版仓库里的一条记录。
 * @param textMax - 文本长度上限。
 * @returns 新记录；不合法时为 `undefined`。
 */
export function migrateLegacyDraft(value: unknown, textMax = DRAFT_TEXT_MAX): DraftRecord | undefined {
  return normalizeDraftRecord(value, textMax);
}

/**
 * 判定数据库升级要做的步骤。
 * @param oldVersion - 打开前的数据库版本；新库为 0。
 * @returns 创建仓库、迁移旧仓库与删除旧仓库三项。
 */
export function draftUpgradePlan(oldVersion: number): DraftUpgradePlan {
  if (!Number.isInteger(oldVersion) || oldVersion < 0) throw new Error('草稿数据库版本必须是非负整数');
  if (oldVersion < 1) return { createStore: true, migrateLegacy: false, dropLegacy: false };
  if (oldVersion < DRAFT_DB_VERSION) return { createStore: true, migrateLegacy: true, dropLegacy: true };
  return { createStore: false, migrateLegacy: false, dropLegacy: false };
}

/**
 * 真实的内存草稿存储。
 *
 * 与 IndexedDB 实现共用键、记录校验与修订号规则，用于单元测试和没有 IndexedDB 的宿主。
 */
export class MemoryDraftStore implements DraftStore {
  private readonly records = new Map<string, DraftRecord>();

  async load(sessionId: string): Promise<DraftRecord | undefined> {
    return this.records.get(draftKeyOf(sessionId));
  }

  async save(sessionId: string, text: string, now = Date.now()): Promise<DraftRecord | undefined> {
    const key = draftKeyOf(sessionId);
    const next = draftRecordOf(sessionId, text, this.records.get(key), now);
    if (next === undefined) this.records.delete(key);
    else this.records.set(key, next);
    return next;
  }

  async clear(sessionId: string): Promise<void> {
    this.records.delete(draftKeyOf(sessionId));
  }

  async listSessionIds(): Promise<string[]> {
    return [...this.records.values()].map((record) => record.sessionId);
  }
}

/** IndexedDB 草稿存储的构造选项。 */
export interface IndexedDbDraftOptions {
  readonly databaseName: string;
  readonly version: number;
  readonly storeName: string;
  readonly legacyStoreName: string;
  readonly textMax: number;
}

/** IndexedDB 请求的最小结构；浏览器实现与测试实现共用。 */
export interface IdbRequestLike<T> {
  readonly result: T;
  readonly error: unknown;
  onsuccess: ((this: unknown, event: unknown) => void) | null;
  onerror: ((this: unknown, event: unknown) => void) | null;
}

/** IndexedDB 游标的最小结构。 */
export interface IdbCursorLike {
  readonly value: unknown;
  continue(): void;
}

/** IndexedDB 对象仓库的最小结构。 */
export interface IdbObjectStoreLike {
  createIndex(name: string, keyPath: string, options: { unique: boolean }): unknown;
  get(key: string): IdbRequestLike<unknown>;
  put(value: unknown): IdbRequestLike<unknown>;
  delete(key: string): IdbRequestLike<unknown>;
  getAll(): IdbRequestLike<unknown[]>;
  openCursor(): IdbRequestLike<IdbCursorLike | null>;
}

/** IndexedDB 事务的最小结构。 */
export interface IdbTransactionLike {
  readonly error: unknown;
  objectStore(name: string): IdbObjectStoreLike;
  onabort: ((this: unknown, event: unknown) => void) | null;
}

/** IndexedDB 仓库名集合的最小结构。 */
export interface IdbObjectStoreNamesLike {
  contains(name: string): boolean;
}

/** IndexedDB 数据库的最小结构。 */
export interface IdbDatabaseLike {
  readonly objectStoreNames: IdbObjectStoreNamesLike;
  createObjectStore(name: string, options: { keyPath: string }): IdbObjectStoreLike;
  deleteObjectStore(name: string): void;
  transaction(name: string, mode: 'readonly' | 'readwrite'): IdbTransactionLike;
}

/** IndexedDB 版本变化事件的最小结构。 */
export interface IdbVersionChangeEventLike {
  readonly oldVersion: number;
}

/** IndexedDB 打开请求的最小结构。 */
export interface IdbOpenRequestLike {
  readonly result: IdbDatabaseLike;
  readonly transaction: IdbTransactionLike | null;
  readonly error: unknown;
  onupgradeneeded: ((this: unknown, event: IdbVersionChangeEventLike) => void) | null;
  onsuccess: ((this: unknown, event: unknown) => void) | null;
  onerror: ((this: unknown, event: unknown) => void) | null;
  onblocked: ((this: unknown, event: unknown) => void) | null;
}

/** IndexedDB 工厂的最小结构。 */
export interface IdbFactoryLike {
  open(name: string, version: number): IdbOpenRequestLike;
}

/**
 * 建立 IndexedDB 草稿存储。
 *
 * 升级在 `onupgradeneeded` 里完成：旧版 `draft` 仓库逐条迁移到带 `key` 主键的 `drafts`
 * 仓库，再删除旧仓库。任何打开或写入失败都直接拒绝，由界面显示失败状态。
 * @param factory - `indexedDB` 对象。
 * @param options - 数据库名、版本与仓库名。
 * @returns 草稿存储。
 */
export function createIndexedDbDraftStore(factory: IdbFactoryLike, options: IndexedDbDraftOptions): DraftStore {
  let opening: Promise<IdbDatabaseLike> | undefined;

  function open(): Promise<IdbDatabaseLike> {
    if (opening !== undefined) return opening;
    opening = new Promise<IdbDatabaseLike>((resolve, reject) => {
      const request = factory.open(options.databaseName, options.version);
      request.onupgradeneeded = (event) => {
        const database = request.result;
        const transaction = request.transaction;
        if (transaction === null) throw new Error('草稿数据库升级缺少事务');
        const plan = draftUpgradePlan(event.oldVersion);
        if (plan.createStore && !database.objectStoreNames.contains(options.storeName)) {
          const store = database.createObjectStore(options.storeName, { keyPath: 'key' });
          store.createIndex('bySession', 'sessionId', { unique: true });
        }
        if (plan.migrateLegacy && database.objectStoreNames.contains(options.legacyStoreName)) {
          const legacy = transaction.objectStore(options.legacyStoreName);
          const target = transaction.objectStore(options.storeName);
          const cursorRequest = legacy.openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (cursor === null) return;
            const migrated = migrateLegacyDraft(cursor.value, options.textMax);
            if (migrated !== undefined) target.put(migrated);
            cursor.continue();
          };
        }
        if (plan.dropLegacy && database.objectStoreNames.contains(options.legacyStoreName)) {
          database.deleteObjectStore(options.legacyStoreName);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('草稿数据库打开失败'));
      request.onblocked = () => reject(new Error('草稿数据库被其他页面占用'));
    });
    return opening;
  }

  async function withStore<T>(
    mode: 'readonly' | 'readwrite',
    operation: (store: IdbObjectStoreLike) => IdbRequestLike<T>,
  ): Promise<T> {
    const database = await open();
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(options.storeName, mode);
      const request = operation(transaction.objectStore(options.storeName));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('草稿数据库操作失败'));
      transaction.onabort = () => reject(transaction.error ?? new Error('草稿数据库事务中止'));
    });
  }

  return {
    async load(sessionId: string): Promise<DraftRecord | undefined> {
      const key = draftKeyOf(sessionId);
      const value = await withStore<unknown>('readonly', (store) => store.get(key));
      return normalizeDraftRecord(value, options.textMax);
    },

    async save(sessionId: string, text: string, now = Date.now()): Promise<DraftRecord | undefined> {
      const key = draftKeyOf(sessionId);
      const current = await withStore<unknown>('readonly', (store) => store.get(key));
      const next = draftRecordOf(sessionId, text, normalizeDraftRecord(current, options.textMax), now);
      if (next === undefined) {
        await withStore('readwrite', (store) => store.delete(key));
        return undefined;
      }
      await withStore('readwrite', (store) => store.put(next));
      return next;
    },

    async clear(sessionId: string): Promise<void> {
      const key = draftKeyOf(sessionId);
      await withStore('readwrite', (store) => store.delete(key));
    },

    async listSessionIds(): Promise<string[]> {
      const values = await withStore<unknown[]>('readonly', (store) => store.getAll());
      const ids: string[] = [];
      for (const value of values) {
        const record = normalizeDraftRecord(value, options.textMax);
        if (record !== undefined && !ids.includes(record.sessionId)) ids.push(record.sessionId);
      }
      return ids;
    },
  };
}
