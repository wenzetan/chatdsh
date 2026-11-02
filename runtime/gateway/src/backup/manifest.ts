/**
 * 备份清单。
 *
 * 清单是备份目录的唯一入口文件：版本、时间、软件与 schema 版本、恢复点、包含与排除清单、
 * 外部服务边界、密钥要求与恢复条件、对象摘要与字节数、保留策略都写在里面。清单正文的
 * SHA-256 也写进清单，读取时先核对正文再使用字段，被改写的清单不会被当作可用备份。
 * @module @chatdsh/gateway/backup/manifest
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../replica-continuity/store.ts';
import { BACKUP_ERROR_CODES, BackupError } from './errors.ts';

/** 备份格式版本。 */
export const BACKUP_FORMAT_VERSION = 1;

/** 备份产物标记。 */
export const BACKUP_PRODUCT = 'chatdsh';

/** 备份目录里的清单文件名。 */
export const MANIFEST_FILENAME = 'manifest.json';

/** 备份目录里的检查点文件名。 */
export const CHECKPOINT_FILENAME = 'checkpoint.json';

/** 备份目录里的对象子目录。 */
export const OBJECTS_DIRECTORY = 'objects';

/** 对象密钥算法。 */
export const BACKUP_ALGORITHM = 'aes-256-gcm';

/** 数据域的存放形态。 */
export type BackupDomainKind = 'sqlite-snapshot' | 'file-tree' | 'embedded';

/** 一个进入备份的数据域。 */
export interface BackupDomainEntry {
  /** 域名。 */
  readonly domain: string;
  /** 存放形态。 */
  readonly kind: BackupDomainKind;
  /** 相对数据根的路径；嵌入控制平面时为控制平面路径。 */
  readonly root: string;
  /** 对象条数。 */
  readonly objects: number;
  /** 明文字节数。 */
  readonly bytes: number;
  /** 说明。 */
  readonly note: string;
}

/** 一个排除在外的数据域及其原因。 */
export interface BackupExcludedEntry {
  /** 域名。 */
  readonly domain: string;
  /** 排除原因。 */
  readonly reason: string;
  /** 需要单独备份时给出去向。 */
  readonly separateBackup: string;
}

/** 外部服务的数据边界。 */
export interface BackupExternalBoundary {
  /** 服务名。 */
  readonly service: 'hindsight' | 'hermes';
  /** 该部署是否接入了这个服务。 */
  readonly configured: boolean;
  /** 是否包含在本次备份内。外部服务数据一律不进入备份。 */
  readonly included: false;
  /** 单独备份结果的引用；未提供时为空。 */
  readonly reference?: string;
  /** 实际恢复边界说明。 */
  readonly boundary: string;
}

/** 一个备份对象。 */
export interface BackupObjectEntry {
  /** 相对备份根的密文路径。 */
  readonly key: string;
  /** 所属数据域。 */
  readonly domain: string;
  /** 恢复后的相对数据根路径。 */
  readonly relativePath: string;
  /** 明文字节数。 */
  readonly bytes: number;
  /** 密文与认证标签的总字节数。 */
  readonly cipherBytes: number;
  /** 明文 SHA-256。 */
  readonly sha256: string;
  /** base64url 写法的 nonce。 */
  readonly nonce: string;
  /** 恢复后的文件权限。 */
  readonly mode: number;
}

/** 一项密钥要求。 */
export interface BackupKeyRequirement {
  /** 用途。 */
  readonly purpose: 'backup-object-encryption' | 'access-credential-envelope';
  /** 密钥版本。 */
  readonly version: string;
  /** 密钥标识；与清单核对是否同一把密钥。 */
  readonly keyId: string;
  /** 期望位置。 */
  readonly location: string;
  /** 恢复步骤。 */
  readonly recovery: readonly string[];
}

/** 保留策略。 */
export interface BackupRetentionPolicy {
  /** 每日保留套数。 */
  readonly daily: number;
  /** 每周保留套数。 */
  readonly weekly: number;
  /** 每月保留套数。 */
  readonly monthly: number;
  /** 目标恢复点间隔，单位小时。 */
  readonly rpoHours: number;
  /** 基准数据量的恢复时间目标，单位分钟。 */
  readonly restoreTargetMinutes: number;
  /** 生成时刻的说明。 */
  readonly schedule: string;
}

/** 软件与 schema 版本，用于恢复时的兼容判定。 */
export interface BackupSoftwareInfo {
  /** 产物标记。 */
  readonly product: string;
  /** 软件版本。 */
  readonly version: string;
  /** 控制平面 schema 版本。 */
  readonly schemaVersion: number;
  /** Node 主版本，恢复端主版本不得更低。 */
  readonly nodeMajor: number;
}

/** 恢复点。 */
export interface BackupRestorePoint {
  /** 备份覆盖到的最新事件时刻。 */
  readonly maxEventTime: number;
  /** 会话条数。 */
  readonly sessions: number;
  /** 副本事件条数。 */
  readonly events: number;
}

/** 清单正文。 */
export interface BackupManifestBody {
  /** 备份格式版本。 */
  readonly manifestVersion: number;
  /** 备份标识。 */
  readonly manifestId: string;
  /** 生成时刻的毫秒时间戳。 */
  readonly createdAt: number;
  /** 产生备份的软件与 schema 版本。 */
  readonly software: BackupSoftwareInfo;
  /** 实际恢复点。 */
  readonly restorePoint: BackupRestorePoint;
  /** 包含清单。 */
  readonly included: readonly BackupDomainEntry[];
  /** 排除清单。 */
  readonly excluded: readonly BackupExcludedEntry[];
  /** 外部服务边界。 */
  readonly external: readonly BackupExternalBoundary[];
  /** 密钥要求与恢复条件。 */
  readonly keys: readonly BackupKeyRequirement[];
  /** 密钥校验向量。 */
  readonly keyCheck: KeyCheckEntry;
  /** 加密说明。 */
  readonly encryption: BackupEncryptionInfo;
  /** 保留策略。 */
  readonly retention: BackupRetentionPolicy;
  /** 对象清单。 */
  readonly objects: readonly BackupObjectEntry[];
  /** 合计。 */
  readonly totals: BackupTotals;
  /** 源数据摘要；同一源同一时刻的对象清单决定该值。 */
  readonly sourceDigest: string;
}

/** 密钥校验向量。 */
export interface KeyCheckEntry {
  /** base64url 写法的 nonce。 */
  readonly nonce: string;
  /** 密文与认证标签。 */
  readonly ciphertext: string;
  /** 记录类型，写入附加认证数据。 */
  readonly recordType: string;
}

/** 加密说明。 */
export interface BackupEncryptionInfo {
  /** 算法。 */
  readonly algorithm: string;
  /** 密钥版本。 */
  readonly keyVersion: string;
  /** 密钥标识。 */
  readonly keyId: string;
  /** 覆盖面。 */
  readonly scope: string;
  /** 主密钥是否随备份保存。 */
  readonly masterKeyIncluded: boolean;
}

/** 合计。 */
export interface BackupTotals {
  /** 对象条数。 */
  readonly objects: number;
  /** 明文字节数。 */
  readonly plaintextBytes: number;
  /** 密文字节数。 */
  readonly cipherBytes: number;
}

/** 清单文件内容：正文加正文摘要。 */
export interface BackupManifest extends BackupManifestBody {
  /** 正文的 SHA-256。 */
  readonly manifestDigest: string;
}

/** 计算清单正文摘要。 */
export function manifestDigestOf(body: BackupManifestBody): string {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

/**
 * 读取并核对一份清单。
 * @param backupRoot - 备份目录。
 * @returns 通过核对与摘要校验的清单。
 */
export function readBackupManifest(backupRoot: string): BackupManifest {
  const path = join(backupRoot, MANIFEST_FILENAME);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException).code ?? 'unknown';
    throw new BackupError(BACKUP_ERROR_CODES.manifestMissing, `备份目录里没有清单：${path}`, { errno });
  }
  const parsed: unknown = JSON.parse(text);
  const manifest = requireManifest(parsed);
  const body: BackupManifestBody = {
    manifestVersion: manifest.manifestVersion,
    manifestId: manifest.manifestId,
    createdAt: manifest.createdAt,
    software: manifest.software,
    restorePoint: manifest.restorePoint,
    included: manifest.included,
    excluded: manifest.excluded,
    external: manifest.external,
    keys: manifest.keys,
    keyCheck: manifest.keyCheck,
    encryption: manifest.encryption,
    retention: manifest.retention,
    objects: manifest.objects,
    totals: manifest.totals,
    sourceDigest: manifest.sourceDigest,
  };
  const digest = manifestDigestOf(body);
  if (digest !== manifest.manifestDigest) {
    throw new BackupError(BACKUP_ERROR_CODES.manifestDigestMismatch, '清单正文与登记的摘要不一致，清单已被改写', {
      expected: manifest.manifestDigest.slice(0, 16),
      actual: digest.slice(0, 16),
    }, ['用同一备份套的原始清单替换后重新校验']);
  }
  if (manifest.manifestVersion !== BACKUP_FORMAT_VERSION) {
    throw new BackupError(BACKUP_ERROR_CODES.formatUnsupported, `备份格式版本 ${manifest.manifestVersion} 不受本程序支持`, {
      version: manifest.manifestVersion,
      supported: BACKUP_FORMAT_VERSION,
    }, ['使用生成该备份的软件版本执行恢复，或按发行说明升级后再恢复']);
  }
  return manifest;
}

/** 逐字段核对清单形状；不合法按清单损坏拒绝。 */
function requireManifest(value: unknown): BackupManifest {
  if (typeof value !== 'object' || value === null) corrupt('清单正文必须是对象');
  const record = value as Record<string, unknown>;
  const manifestVersion = requireInteger(record['manifestVersion'], 'manifestVersion');
  const manifestId = requireText(record['manifestId'], 'manifestId');
  const createdAt = requireInteger(record['createdAt'], 'createdAt');
  const software = requireSoftware(record['software']);
  const restorePoint = requireRestorePoint(record['restorePoint']);
  const included = requireArray(record['included'], 'included').map(requireDomainEntry);
  const excluded = requireArray(record['excluded'], 'excluded').map(requireExcludedEntry);
  const external = requireArray(record['external'], 'external').map(requireExternalBoundary);
  const keys = requireArray(record['keys'], 'keys').map(requireKeyRequirement);
  const keyCheck = requireKeyCheck(record['keyCheck']);
  const encryption = requireEncryption(record['encryption']);
  const retention = requireRetention(record['retention']);
  const objects = requireArray(record['objects'], 'objects').map(requireObjectEntry);
  const totals = requireTotals(record['totals']);
  const sourceDigest = requireText(record['sourceDigest'], 'sourceDigest');
  const manifestDigest = requireText(record['manifestDigest'], 'manifestDigest');
  return {
    manifestVersion,
    manifestId,
    createdAt,
    software,
    restorePoint,
    included,
    excluded,
    external,
    keys,
    keyCheck,
    encryption,
    retention,
    objects,
    totals,
    sourceDigest,
    manifestDigest,
  };
}

/** 以清单损坏拒绝。 */
function corrupt(message: string, details: Record<string, string | number | boolean> = {}): never {
  throw new BackupError(BACKUP_ERROR_CODES.manifestCorrupt, message, details);
}

/** 要求整数。 */
function requireInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) corrupt(`清单字段 ${field} 必须是整数`, { field });
  return value;
}

/** 要求非空文本。 */
function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') corrupt(`清单字段 ${field} 必须是非空文本`, { field });
  return value;
}

/** 要求数组。 */
function requireArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) corrupt(`清单字段 ${field} 必须是数组`, { field });
  return value;
}

/** 要求对象。 */
function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    corrupt(`清单字段 ${field} 必须是对象`, { field });
  }
  return value as Record<string, unknown>;
}

/** 核对软件版本。 */
function requireSoftware(value: unknown): BackupSoftwareInfo {
  const record = requireObject(value, 'software');
  return {
    product: requireText(record['product'], 'software.product'),
    version: requireText(record['version'], 'software.version'),
    schemaVersion: requireInteger(record['schemaVersion'], 'software.schemaVersion'),
    nodeMajor: requireInteger(record['nodeMajor'], 'software.nodeMajor'),
  };
}

/** 核对恢复点。 */
function requireRestorePoint(value: unknown): BackupRestorePoint {
  const record = requireObject(value, 'restorePoint');
  return {
    maxEventTime: requireInteger(record['maxEventTime'], 'restorePoint.maxEventTime'),
    sessions: requireInteger(record['sessions'], 'restorePoint.sessions'),
    events: requireInteger(record['events'], 'restorePoint.events'),
  };
}

/** 核对数据域条目。 */
function requireDomainEntry(value: unknown): BackupDomainEntry {
  const record = requireObject(value, 'included[]');
  const kind = requireText(record['kind'], 'included[].kind');
  if (kind !== 'sqlite-snapshot' && kind !== 'file-tree' && kind !== 'embedded') {
    corrupt(`清单数据域形态不受支持：${kind}`, { kind });
  }
  return {
    domain: requireText(record['domain'], 'included[].domain'),
    kind,
    root: requireText(record['root'], 'included[].root'),
    objects: requireInteger(record['objects'], 'included[].objects'),
    bytes: requireInteger(record['bytes'], 'included[].bytes'),
    note: requireText(record['note'], 'included[].note'),
  };
}

/** 核对排除项。 */
function requireExcludedEntry(value: unknown): BackupExcludedEntry {
  const record = requireObject(value, 'excluded[]');
  return {
    domain: requireText(record['domain'], 'excluded[].domain'),
    reason: requireText(record['reason'], 'excluded[].reason'),
    separateBackup: requireText(record['separateBackup'], 'excluded[].separateBackup'),
  };
}

/** 核对外部边界。 */
function requireExternalBoundary(value: unknown): BackupExternalBoundary {
  const record = requireObject(value, 'external[]');
  const service = requireText(record['service'], 'external[].service');
  if (service !== 'hindsight' && service !== 'hermes') corrupt(`外部服务名不受支持：${service}`, { service });
  if (record['included'] !== false) corrupt('外部服务数据不得标记为包含在备份内');
  const reference = record['reference'];
  if (reference !== undefined && typeof reference !== 'string') corrupt('external[].reference 必须是文本');
  const configured = record['configured'];
  if (typeof configured !== 'boolean') corrupt('external[].configured 必须是布尔值');
  return {
    service,
    configured,
    included: false,
    ...(reference === undefined ? {} : { reference }),
    boundary: requireText(record['boundary'], 'external[].boundary'),
  };
}

/** 核对密钥要求。 */
function requireKeyRequirement(value: unknown): BackupKeyRequirement {
  const record = requireObject(value, 'keys[]');
  const purpose = requireText(record['purpose'], 'keys[].purpose');
  if (purpose !== 'backup-object-encryption' && purpose !== 'access-credential-envelope') {
    corrupt(`密钥用途不受支持：${purpose}`, { purpose });
  }
  return {
    purpose,
    version: requireText(record['version'], 'keys[].version'),
    keyId: requireText(record['keyId'], 'keys[].keyId'),
    location: requireText(record['location'], 'keys[].location'),
    recovery: requireArray(record['recovery'], 'keys[].recovery').map((item) => requireText(item, 'keys[].recovery[]')),
  };
}

/** 核对密钥校验向量。 */
function requireKeyCheck(value: unknown): KeyCheckEntry {
  const record = requireObject(value, 'keyCheck');
  return {
    nonce: requireText(record['nonce'], 'keyCheck.nonce'),
    ciphertext: requireText(record['ciphertext'], 'keyCheck.ciphertext'),
    recordType: requireText(record['recordType'], 'keyCheck.recordType'),
  };
}

/** 核对加密说明。 */
function requireEncryption(value: unknown): BackupEncryptionInfo {
  const record = requireObject(value, 'encryption');
  const included = record['masterKeyIncluded'];
  if (typeof included !== 'boolean') corrupt('encryption.masterKeyIncluded 必须是布尔值');
  return {
    algorithm: requireText(record['algorithm'], 'encryption.algorithm'),
    keyVersion: requireText(record['keyVersion'], 'encryption.keyVersion'),
    keyId: requireText(record['keyId'], 'encryption.keyId'),
    scope: requireText(record['scope'], 'encryption.scope'),
    masterKeyIncluded: included,
  };
}

/** 核对保留策略。 */
function requireRetention(value: unknown): BackupRetentionPolicy {
  const record = requireObject(value, 'retention');
  return {
    daily: requireInteger(record['daily'], 'retention.daily'),
    weekly: requireInteger(record['weekly'], 'retention.weekly'),
    monthly: requireInteger(record['monthly'], 'retention.monthly'),
    rpoHours: requireInteger(record['rpoHours'], 'retention.rpoHours'),
    restoreTargetMinutes: requireInteger(record['restoreTargetMinutes'], 'retention.restoreTargetMinutes'),
    schedule: requireText(record['schedule'], 'retention.schedule'),
  };
}

/** 核对对象条目。 */
function requireObjectEntry(value: unknown): BackupObjectEntry {
  const record = requireObject(value, 'objects[]');
  return {
    key: requireText(record['key'], 'objects[].key'),
    domain: requireText(record['domain'], 'objects[].domain'),
    relativePath: requireText(record['relativePath'], 'objects[].relativePath'),
    bytes: requireInteger(record['bytes'], 'objects[].bytes'),
    cipherBytes: requireInteger(record['cipherBytes'], 'objects[].cipherBytes'),
    sha256: requireText(record['sha256'], 'objects[].sha256'),
    nonce: requireText(record['nonce'], 'objects[].nonce'),
    mode: requireInteger(record['mode'], 'objects[].mode'),
  };
}

/** 核对合计。 */
function requireTotals(value: unknown): BackupTotals {
  const record = requireObject(value, 'totals');
  return {
    objects: requireInteger(record['objects'], 'totals.objects'),
    plaintextBytes: requireInteger(record['plaintextBytes'], 'totals.plaintextBytes'),
    cipherBytes: requireInteger(record['cipherBytes'], 'totals.cipherBytes'),
  };
}
