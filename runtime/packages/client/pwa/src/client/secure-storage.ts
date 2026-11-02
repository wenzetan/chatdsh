/**
 * 设备凭据的安全存储。
 *
 * 配对得到的设备令牌只在内存里以明文存在；需要跨刷新保留时，改用 WebCrypto 的 AES-GCM
 * 加密后写入 IndexedDB，密钥是生成时即标记为不可导出的 `CryptoKey`，同样只存在浏览器存储里。
 * 本模块不写本地存储，也不把令牌写进任何其它键。浏览器缺少 WebCrypto 或 IndexedDB 时退回
 * 只存内存，并给出退回来的原因。
 * @module @chatdsh/client-pwa/secure-storage
 */

import type { PwaTelemetry } from './telemetry.ts';

/** 凭据库名称。 */
export const CREDENTIAL_DB_NAME = 'chatdsh-pwa-credentials';

/** 凭据库版本。 */
export const CREDENTIAL_DB_VERSION = 1;

/** 存放加密密钥的对象存储。 */
export const KEY_STORE = 'keys';

/** 存放密文记录的对象存储。 */
export const CREDENTIAL_STORE = 'credentials';

/** 密钥记录的标识。 */
export const KEY_ID = 'device-credentials';

/** 一份设备凭据。 */
export interface DeviceCredential {
  /** 设备标识。 */
  readonly deviceId: string;
  /** 设备令牌明文；只在内存与解密结果里出现。 */
  readonly token: string;
  /** 签发时刻的毫秒时间戳。 */
  readonly issuedAt: number;
  /** 过期时刻的毫秒时间戳。 */
  readonly expiresAt?: number;
}

/** 凭据的存储方式。 */
export type CredentialStorageKind = 'indexeddb' | 'memory';

/** 凭据存储。 */
export interface CredentialStore {
  /** 实际生效的存储方式。 */
  readonly kind: CredentialStorageKind;
  /** 退回内存存储的原因。 */
  readonly reason?: string;
  /** 保存一份凭据。 */
  save(credential: DeviceCredential): Promise<void>;
  /** 按设备读取凭据。 */
  load(deviceId: string): Promise<DeviceCredential | undefined>;
  /** 判断内存里是否有该设备的凭据。 */
  has(deviceId: string): boolean;
  /** 清空全部凭据与密钥。 */
  clear(): Promise<void>;
}

/** 凭据存储的构造依赖。 */
export interface CredentialStoreOptions {
  /** IndexedDB 工厂；传 `null` 表示这一能力不可用。 */
  readonly indexedDB?: IDBFactory | null;
  /** WebCrypto 实现；传 `null` 表示这一能力不可用。 */
  readonly crypto?: Crypto | null;
  /** 遥测面。 */
  readonly telemetry?: PwaTelemetry;
}

/** 加密记录的形状。 */
interface EncryptedRecord {
  readonly deviceId: string;
  readonly iv: ArrayBuffer;
  readonly ciphertext: ArrayBuffer;
  readonly issuedAt: number;
  readonly savedAt: number;
}

/**
 * 把一次 IndexedDB 请求转成 Promise。
 * @param request - 请求对象。
 * @returns 请求结果。
 */
function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败'));
  });
}

/**
 * 等待一次事务完成。
 * @param transaction - 事务对象。
 * @returns 完成时兑现。
 */
function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB 事务失败'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB 事务被终止'));
  });
}

/**
 * 打开凭据库并建好两个对象存储。
 * @param factory - IndexedDB 工厂。
 * @returns 数据库连接。
 */
function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(CREDENTIAL_DB_NAME, CREDENTIAL_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(KEY_STORE)) database.createObjectStore(KEY_STORE, { keyPath: 'id' });
      if (!database.objectStoreNames.contains(CREDENTIAL_STORE)) {
        database.createObjectStore(CREDENTIAL_STORE, { keyPath: 'deviceId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('凭据库打开失败'));
  });
}

/**
 * 读取对象存储里的一条记录。
 * @param database - 数据库连接。
 * @param storeName - 对象存储名。
 * @param key - 主键。
 * @returns 记录；不存在时为 `undefined`。
 */
async function readRecord<T>(database: IDBDatabase, storeName: string, key: string): Promise<T | undefined> {
  const transaction = database.transaction(storeName, 'readonly');
  const request = transaction.objectStore(storeName).get(key);
  const result = await requestResult(request);
  await transactionDone(transaction);
  return result as T | undefined;
}

/**
 * 写入一条记录。
 * @param database - 数据库连接。
 * @param storeName - 对象存储名。
 * @param value - 记录内容。
 */
async function writeRecord(database: IDBDatabase, storeName: string, value: unknown): Promise<void> {
  const transaction = database.transaction(storeName, 'readwrite');
  transaction.objectStore(storeName).put(value);
  await transactionDone(transaction);
}

/**
 * 清空一个对象存储。
 * @param database - 数据库连接。
 * @param storeName - 对象存储名。
 */
async function clearStore(database: IDBDatabase, storeName: string): Promise<void> {
  const transaction = database.transaction(storeName, 'readwrite');
  transaction.objectStore(storeName).clear();
  await transactionDone(transaction);
}

/** 校验凭据形状。 */
function assertCredential(credential: DeviceCredential): void {
  if (credential.deviceId === '' || credential.token === '') throw new Error('设备凭据需要设备标识与令牌');
  if (!Number.isFinite(credential.issuedAt)) throw new Error('设备凭据需要签发时刻');
}

/** 从解密结果里取出凭据并校验。 */
function credentialOf(parsed: unknown): DeviceCredential | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const deviceId = record['deviceId'];
  const token = record['token'];
  const issuedAt = record['issuedAt'];
  const expiresAt = record['expiresAt'];
  if (typeof deviceId !== 'string' || deviceId === '') return undefined;
  if (typeof token !== 'string' || token === '') return undefined;
  if (typeof issuedAt !== 'number' || !Number.isFinite(issuedAt)) return undefined;
  if (expiresAt !== undefined && (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt))) return undefined;
  return expiresAt === undefined ? { deviceId, token, issuedAt } : { deviceId, token, issuedAt, expiresAt };
}

/**
 * 打开凭据存储。
 *
 * 有 WebCrypto 与 IndexedDB 时使用加密持久化；缺任意一项或者数据库打不开时退回只存内存，
 * `reason` 说明退回的原因。解密失败按数据损坏上抛，不静默丢弃。
 * @param options - IndexedDB 工厂、WebCrypto 与遥测面。
 * @returns 凭据存储。
 */
export async function openCredentialStore(options: CredentialStoreOptions = {}): Promise<CredentialStore> {
  const factory = options.indexedDB === null ? undefined : (options.indexedDB ?? globalThis.indexedDB);
  const webCrypto = options.crypto === null ? undefined : (options.crypto ?? globalThis.crypto);
  const telemetry = options.telemetry;
  const memory = new Map<string, DeviceCredential>();

  /**
   * 建立只存内存的凭据存储。
   * @param reason - 退回内存存储的原因。
   * @returns 凭据存储。
   */
  const memoryStore = (reason: string): CredentialStore => {
    telemetry?.action('credential-open', 'unavailable');
    return {
      kind: 'memory',
      reason,
      save: async (credential) => {
        assertCredential(credential);
        memory.set(credential.deviceId, credential);
      },
      load: async (deviceId) => memory.get(deviceId),
      has: (deviceId) => memory.has(deviceId),
      clear: async () => memory.clear(),
    };
  };

  if (webCrypto?.subtle === undefined) return memoryStore('crypto-unavailable');
  if (factory === undefined) return memoryStore('indexeddb-unavailable');

  let database: IDBDatabase;
  try {
    database = await openDatabase(factory);
  } catch {
    return memoryStore('indexeddb-unavailable');
  }
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  /**
   * 取不可导出的加密密钥；第一次调用时生成并写入 IndexedDB。
   * @returns 加密密钥。
   */
  const encryptionKey = async (): Promise<CryptoKey> => {
    const stored = await readRecord<{ readonly id: string; readonly key: CryptoKey }>(database, KEY_STORE, KEY_ID);
    if (stored !== undefined && stored.key instanceof CryptoKey) return stored.key;
    const created = await webCrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await writeRecord(database, KEY_STORE, { id: KEY_ID, key: created });
    return created;
  };

  telemetry?.action('credential-open', 'ok');
  return {
    kind: 'indexeddb',

    async save(credential: DeviceCredential): Promise<void> {
      assertCredential(credential);
      memory.set(credential.deviceId, credential);
      const key = await encryptionKey();
      const iv = webCrypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await webCrypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        encoder.encode(JSON.stringify(credential))
      );
      const record: EncryptedRecord = {
        deviceId: credential.deviceId,
        iv: iv.buffer.slice(0) as ArrayBuffer,
        ciphertext,
        issuedAt: credential.issuedAt,
        savedAt: Date.now(),
      };
      await writeRecord(database, CREDENTIAL_STORE, record);
    },

    async load(deviceId: string): Promise<DeviceCredential | undefined> {
      const cached = memory.get(deviceId);
      if (cached !== undefined) return cached;
      const record = await readRecord<EncryptedRecord>(database, CREDENTIAL_STORE, deviceId);
      if (record === undefined) return undefined;
      const key = await encryptionKey();
      const plaintext = await webCrypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv }, key, record.ciphertext);
      const credential = credentialOf(JSON.parse(decoder.decode(plaintext)));
      if (credential === undefined) throw new Error('凭据记录损坏，无法还原设备标识与令牌');
      memory.set(deviceId, credential);
      return credential;
    },

    has(deviceId: string): boolean {
      return memory.has(deviceId);
    },

    async clear(): Promise<void> {
      memory.clear();
      await clearStore(database, CREDENTIAL_STORE);
      await clearStore(database, KEY_STORE);
    },
  };
}
