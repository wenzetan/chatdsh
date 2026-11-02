/**
 * 隔离恢复。
 *
 * 恢复只写入一个全新的目录，全程不接触现有数据根。写入顺序：核对目标为空 → 核对软件与 schema
 * 兼容 → 核对密钥 → 核对剩余空间 → 逐对象解密并复核摘要 → 核对会话归属与事件连续性 → 核对
 * 附件字节与加密凭据可解密 → 写入恢复门禁与恢复报告。任何一步失败都删除本次建立的目录并就地
 * 抛出，失败的分支带重新配置条件。恢复端在此之后默认关闭外部自动化与通知发送，直到设备令牌与
 * 推送订阅逐项处置。
 * @module @chatdsh/gateway/backup/restore
 */

import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, openSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deriveAccessKey, openAccessSecret, parseAccessEnvelope } from '../access/keys.ts';
import { backupKeyIdOf, deriveBackupKey, objectAad, openKeyCheck, openObject, readBackupKeyFile } from './crypto.ts';
import { BACKUP_ERROR_CODES, BackupError } from './errors.ts';
import {
  FILE_MODE,
  assertFreeBytes,
  containedPath,
  digestFile,
  directoryEmptyOrAbsent,
  ensureDirectory,
  writeJsonAtomic,
} from './files.ts';
import { readRestorePoint } from './domains.ts';
import {
  BACKUP_FORMAT_VERSION,
  BACKUP_PRODUCT,
  readBackupManifest,
  type BackupExternalBoundary,
  type BackupManifest,
} from './manifest.ts';
import { BACKUP_EVENTS, BACKUP_SPANS, BackupRecorder, type BackupTelemetry } from './telemetry.ts';

/** 恢复门禁文件名。 */
export const RESTORE_GATE_FILENAME = 'restore-gate.json';

/** 恢复报告文件名。 */
export const RESTORE_REPORT_FILENAME = 'restore-report.json';

/** 恢复目录里保留的清单文件名。 */
export const RESTORED_MANIFEST_FILENAME = 'backup-manifest.json';

/** 恢复出来的数据根里的控制平面数据库相对路径。 */
const RESTORED_DATABASE = 'gateway/gateway.sqlite';

/** 恢复端安装的部署主密钥相对路径。 */
const RESTORED_KEY = 'access/master.key';

/** 一条待处置项。 */
export interface RestoreDisposition {
  /** 处置种类。 */
  readonly kind: 'device-token' | 'push-subscription' | 'automation' | 'access-credential';
  /** 对象标识；恢复时按恢复副本里的真实标识写入。 */
  readonly id: string;
  /** 状态；恢复时一律为待处置。 */
  readonly state: 'pending';
}

/** 恢复门禁。 */
export interface RestoreGate {
  /** 门禁版本。 */
  readonly gateVersion: number;
  /** 来源清单标识。 */
  readonly manifestId: string;
  /** 恢复时刻的毫秒时间戳。 */
  readonly restoredAt: number;
  /** 外部自动化开关。 */
  readonly externalAutomation: 'disabled' | 'enabled';
  /** 通知发送开关。 */
  readonly notificationSending: 'disabled' | 'enabled';
  /** 待处置项。 */
  readonly dispositions: readonly RestoreDisposition[];
  /** 恢复后必须满足的条件，按顺序展示。 */
  readonly conditions: readonly string[];
}

/** 恢复输入。 */
export interface RestoreBackupInput {
  /** 备份目录。 */
  readonly backupRoot: string;
  /** 恢复目标目录，必须不存在或为空。 */
  readonly targetRoot: string;
  /** 部署主密钥文件路径。 */
  readonly keyPath: string;
  /** 当前软件版本。 */
  readonly currentSoftware: { readonly version: string; readonly schemaVersion: number };
  /** 遥测出口。 */
  readonly telemetry: BackupTelemetry;
  /** 恢复时刻，缺省取当前时刻。 */
  readonly now?: number;
}

/** 恢复报告。 */
export interface RestoreReport {
  /** 来源清单标识。 */
  readonly manifestId: string;
  /** 恢复目标目录。 */
  readonly targetRoot: string;
  /** 完成时刻的毫秒时间戳。 */
  readonly restoredAt: number;
  /** 耗时，单位毫秒。 */
  readonly durationMs: number;
  /** 实际恢复点。 */
  readonly restorePoint: { readonly at: number; readonly iso: string; readonly sessions: number; readonly events: number };
  /** 逐项核对结果。 */
  readonly items: {
    readonly manifest: { readonly objects: number; readonly plaintextBytes: number; readonly cipherBytes: number };
    readonly compatibility: {
      readonly compatible: true;
      readonly manifestVersion: number;
      readonly currentVersion: string;
      readonly schemaVersion: number;
    };
    readonly ownership: { readonly valid: true; readonly sessions: number; readonly devices: number };
    readonly continuity: {
      readonly valid: true;
      readonly sessions: number;
      readonly events: number;
      readonly maxSeq: number;
    };
    readonly attachments: { readonly valid: true; readonly files: number; readonly bytes: number };
    readonly encryption: {
      readonly valid: true;
      readonly keyId: string;
      readonly credentialRecords: number;
      readonly decrypted: number;
    };
  };
  /** 外部服务边界。 */
  readonly external: readonly BackupExternalBoundary[];
  /** 恢复门禁。 */
  readonly gate: RestoreGate;
}

/**
 * 把一份备份恢复到全新目录。
 * @param input - 备份目录、目标目录、密钥与当前软件版本。
 * @returns 恢复报告，含实际恢复点与耗时。
 */
export function restoreBackup(input: RestoreBackupInput): Promise<RestoreReport> {
  const recorder = new BackupRecorder(input.telemetry);
  const started = Date.now();
  return recorder.measure(
    BACKUP_SPANS.restore,
    'restore.stage',
    BACKUP_EVENTS.restoreRejected,
    {},
    async (span) => {
      if (!directoryEmptyOrAbsent(input.targetRoot)) {
        throw new BackupError(BACKUP_ERROR_CODES.restoreTargetExists, `恢复目标已经存在且非空：${input.targetRoot}`, {}, [
          '换一个全新的目录执行恢复，或先由用户处置该目录',
        ]);
      }
      const manifest = readBackupManifest(input.backupRoot);
      const compatibility = requireCompatible(manifest, input.currentSoftware);
      const masterKey = readBackupKeyFile(input.keyPath);
      const keyId = backupKeyIdOf(masterKey);
      if (keyId !== manifest.encryption.keyId) {
        throw new BackupError(
          BACKUP_ERROR_CODES.keyMismatch,
          '提供的密钥与清单登记的密钥标识不一致',
          { expected: manifest.encryption.keyId, actual: keyId },
          ['提供生成该备份时使用的部署主密钥文件后重新执行恢复'],
        );
      }
      const objectKey = deriveBackupKey(masterKey);
      openKeyCheck(objectKey, manifest.keyCheck);
      assertFreeBytes(input.targetRoot, manifest.totals.plaintextBytes + 1024 * 1024);

      const created = !existsSync(input.targetRoot);
      try {
        ensureDirectory(input.targetRoot);
        for (const object of manifest.objects) {
          const target = containedPath(input.targetRoot, object.relativePath);
          ensureDirectory(dirname(target));
          const opened = await openObject({
            objectPath: join(input.backupRoot, object.key),
            key: objectKey,
            nonce: object.nonce,
            aad: objectAad(manifest.manifestVersion, object.domain, object.relativePath),
            targetPath: target,
          });
          if (opened.sha256 !== object.sha256 || opened.bytes !== object.bytes) {
            throw new BackupError(BACKUP_ERROR_CODES.objectDigestMismatch, '恢复写入的对象与清单摘要不一致', {
              object: object.relativePath,
            });
          }
        }
        installCredentialKey(input.targetRoot, masterKey);
        const databasePath = join(input.targetRoot, RESTORED_DATABASE);
        if (!existsSync(databasePath)) {
          throw new BackupError(BACKUP_ERROR_CODES.objectMissing, `恢复后的控制平面数据库缺失：${RESTORED_DATABASE}`);
        }
        const ownership = verifyOwnership(databasePath);
        const continuity = verifyContinuity(databasePath);
        const attachments = await verifyAttachmentBytes(input.targetRoot, manifest);
        const encryption = verifyCredentialEnvelopes(databasePath, masterKey);
        const now = input.now ?? Date.now();
        const changed = prepareRestoredRoot(databasePath, now);
        const restorePoint = readRestorePoint(databasePath);
        const maxSeq = readMaxSeq(databasePath);
        const gate = buildGate(manifest, now, changed, encryption);
        const report: RestoreReport = {
          manifestId: manifest.manifestId,
          targetRoot: input.targetRoot,
          restoredAt: now,
          durationMs: Date.now() - started,
          restorePoint: {
            at: restorePoint.maxEventTime,
            iso: new Date(restorePoint.maxEventTime).toISOString(),
            sessions: restorePoint.sessions,
            events: restorePoint.events,
          },
          items: {
            manifest: {
              objects: manifest.totals.objects,
              plaintextBytes: manifest.totals.plaintextBytes,
              cipherBytes: manifest.totals.cipherBytes,
            },
            compatibility,
            ownership,
            continuity: { ...continuity, maxSeq },
            attachments,
            encryption,
          },
          external: manifest.external,
          gate,
        };
        writeJsonAtomic(join(input.targetRoot, RESTORE_GATE_FILENAME), gate);
        writeJsonAtomic(join(input.targetRoot, RESTORED_MANIFEST_FILENAME), manifest);
        writeJsonAtomic(join(input.targetRoot, RESTORE_REPORT_FILENAME), {
          ...report,
          restoredAtIso: new Date(report.restoredAt).toISOString(),
        });
        recorder.objects('restore.stage', manifest.totals.objects);
        recorder.bytes('restore.stage', manifest.totals.plaintextBytes);
        recorder.restoreDuration((Date.now() - started) / 1000, 'ok');
        span.setAttribute('objects', manifest.totals.objects);
        span.setAttribute('bytes', manifest.totals.plaintextBytes);
        input.telemetry.event(BACKUP_EVENTS.restoreCompleted, {
          action: 'restore.stage',
          outcome: 'ok',
          objects: manifest.totals.objects,
        });
        return report;
      } catch (error) {
        if (created && existsSync(input.targetRoot)) rmSync(input.targetRoot, { recursive: true, force: true });
        recorder.restoreDuration((Date.now() - started) / 1000, 'failed');
        throw error;
      }
    },
  );
}

/** 核对软件与 schema 兼容。 */
function requireCompatible(
  manifest: BackupManifest,
  current: { readonly version: string; readonly schemaVersion: number },
): RestoreReport['items']['compatibility'] {
  if (manifest.software.product !== BACKUP_PRODUCT) {
    throw new BackupError(BACKUP_ERROR_CODES.restoreVersionIncompatible, '备份不是本产品生成的产物', {
      product: manifest.software.product,
    });
  }
  if (manifest.manifestVersion !== BACKUP_FORMAT_VERSION) {
    throw new BackupError(BACKUP_ERROR_CODES.formatUnsupported, '备份格式版本不受支持', {
      version: manifest.manifestVersion,
      supported: BACKUP_FORMAT_VERSION,
    }, ['使用生成该备份的软件版本执行恢复，或按发行说明升级本程序']);
  }
  if (manifest.software.schemaVersion > current.schemaVersion) {
    throw new BackupError(
      BACKUP_ERROR_CODES.restoreVersionIncompatible,
      `备份的 schema 版本 ${manifest.software.schemaVersion} 高于当前支持的 ${current.schemaVersion}`,
      { schemaVersion: manifest.software.schemaVersion, supported: current.schemaVersion },
      ['升级到不低于备份来源的软件版本后重新恢复'],
    );
  }
  const nodeMajor = Number(process.versions.node.split('.')[0] ?? '0');
  if (manifest.software.nodeMajor > nodeMajor) {
    throw new BackupError(
      BACKUP_ERROR_CODES.restoreVersionIncompatible,
      `备份要求 Node 主版本不低于 ${manifest.software.nodeMajor}，当前为 ${nodeMajor}`,
      { required: manifest.software.nodeMajor, current: nodeMajor },
      ['在满足 Node 主版本的运行环境里重新恢复'],
    );
  }
  return {
    compatible: true,
    manifestVersion: manifest.manifestVersion,
    currentVersion: current.version,
    schemaVersion: manifest.software.schemaVersion,
  };
}

/** 把部署主密钥装进恢复出来的数据根，权限 0600。 */
function installCredentialKey(targetRoot: string, masterKey: Buffer): void {
  const path = join(targetRoot, RESTORED_KEY);
  ensureDirectory(dirname(path));
  const descriptor = openSync(path, 'wx', FILE_MODE);
  try {
    writeSync(descriptor, masterKey);
  } finally {
    closeSync(descriptor);
  }
  const installed = readBackupKeyFile(path);
  if (!installed.equals(masterKey)) {
    throw new BackupError(BACKUP_ERROR_CODES.restoreCredentialUndecryptable, '恢复端安装的主密钥与提供的密钥不一致');
  }
}

/**
 * 核对会话归属：每个会话的设备必须存在于恢复后的设备记录里，分享必须指向存在的会话。
 * @param databasePath - 恢复后的控制平面数据库。
 * @returns 核对结果。
 */
export function verifyOwnership(databasePath: string): RestoreReport['items']['ownership'] {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const devices = new Set<string>();
    for (const table of ['devices', 'node_devices', 'mobile_devices']) {
      if (!tableExists(database, table)) continue;
      for (const row of database.prepare(`select id from ${table}`).all() as unknown as { id: string }[]) devices.add(row.id);
    }
    const sessions = tableExists(database, 'sessions')
      ? (database.prepare('select session_id, device_id from sessions where deleted_at is null').all() as unknown as {
        session_id: string;
        device_id: string;
      }[])
      : [];
    let sessionsChecked = 0;
    const unknown: string[] = [];
    for (const row of sessions) {
      sessionsChecked += 1;
      if (!devices.has(row.device_id)) unknown.push(`${row.session_id}@${row.device_id}`);
    }
    if (unknown.length > 0) {
      throw new BackupError(
        BACKUP_ERROR_CODES.restoreOwnershipInvalid,
        `恢复后有 ${unknown.length} 个会话的归属设备不存在于设备记录里`,
        { sessions: unknown.length, devices: devices.size },
        ['核对备份是否来自同一部署，或先恢复该设备的配对记录'],
      );
    }
    if (tableExists(database, 'shares')) {
      const orphan = database
        .prepare(`select count(*) as total from shares where session_id not in (select session_id from sessions)`)
        .get() as { total: number } | undefined;
      const orphanShares = Number(orphan?.total ?? 0);
      if (orphanShares > 0) {
        throw new BackupError(BACKUP_ERROR_CODES.restoreOwnershipInvalid, `恢复后有 ${orphanShares} 条分享指向不存在的会话`, {
          shares: orphanShares,
        }, ['用上一份完整备份重新恢复，或先恢复缺失的会话归属']);
      }
    }
    return { valid: true, sessions: sessionsChecked, devices: devices.size };
  } finally {
    database.close();
  }
}

/** 事件连续性核对结果。 */
export interface ContinuityCheck {
  /** 通过。 */
  readonly valid: true;
  /** 会话条数。 */
  readonly sessions: number;
  /** 事件条数。 */
  readonly events: number;
  /** 最大事件序号。 */
  readonly maxSeq: number;
}

/**
 * 核对事件连续性：每个会话的事件序号从 0 开始严格连续。
 * @param databasePath - 恢复后的控制平面数据库。
 * @returns 核对结果。
 */
export function verifyContinuity(databasePath: string): ContinuityCheck {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    if (!tableExists(database, 'replica_events')) return { valid: true, sessions: 0, events: 0, maxSeq: -1 };
    const rows = database
      .prepare('select session_id, seq from replica_events order by session_id asc, seq asc')
      .all() as unknown as { session_id: string; seq: number }[];
    let currentSession = '';
    let expected = 0;
    let sessions = 0;
    let maxSeq = -1;
    for (const row of rows) {
      if (row.session_id !== currentSession) {
        currentSession = row.session_id;
        expected = 0;
        sessions += 1;
      }
      const seq = Number(row.seq);
      if (seq !== expected) {
        throw new BackupError(
          BACKUP_ERROR_CODES.restoreEventGap,
          `恢复后会话 ${row.session_id} 的事件序号不连续：期望 ${expected}，实际 ${seq}`,
          { sessionId: row.session_id, expected, actual: seq },
          ['用上一份完整备份重新恢复，或重新从设备侧获取该会话的副本'],
        );
      }
      expected += 1;
      if (seq > maxSeq) maxSeq = seq;
    }
    if (tableExists(database, 'replica_watermarks')) {
      const watermarks = database.prepare('select session_id, watermark from replica_watermarks').all() as unknown as {
        session_id: string;
        watermark: number;
      }[];
      for (const row of watermarks) {
        const latest = database.prepare('select coalesce(max(seq), -1) as latest from replica_events where session_id = ?')
          .get(row.session_id) as { latest: number } | undefined;
        const latestSeq = Number(latest?.latest ?? -1);
        if (Number(row.watermark) !== latestSeq) {
          throw new BackupError(
            BACKUP_ERROR_CODES.restoreEventGap,
            `恢复后会话 ${row.session_id} 的水位与最新事件序号不一致`,
            { watermark: Number(row.watermark), latest: latestSeq },
            ['用上一份完整备份重新恢复'],
          );
        }
      }
    }
    return { valid: true, sessions, events: rows.length, maxSeq };
  } finally {
    database.close();
  }
}

/**
 * 核对附件与分享包里的字节与清单摘要一致。
 * @param targetRoot - 恢复出来的数据根。
 * @param manifest - 清单。
 * @returns 核对结果。
 */
async function verifyAttachmentBytes(
  targetRoot: string,
  manifest: BackupManifest,
): Promise<RestoreReport['items']['attachments']> {
  let files = 0;
  let bytes = 0;
  for (const object of manifest.objects) {
    if (object.domain !== 'attachments' && object.domain !== 'share-packages') continue;
    const path = containedPath(targetRoot, object.relativePath);
    if (!existsSync(path)) {
      throw new BackupError(BACKUP_ERROR_CODES.restoreAttachmentMismatch, `恢复后缺少附件字节：${object.relativePath}`, {
        object: object.relativePath,
      }, ['用上一份完整备份重新恢复']);
    }
    const digest = await digestFile(path);
    if (digest.sha256 !== object.sha256 || digest.bytes !== object.bytes) {
      throw new BackupError(BACKUP_ERROR_CODES.restoreAttachmentMismatch, `恢复后的附件字节与清单摘要不一致：${object.relativePath}`, {
        object: object.relativePath,
      }, ['用上一份完整备份重新恢复']);
    }
    files += 1;
    bytes += digest.bytes;
  }
  return { valid: true, files, bytes };
}

/**
 * 用安装好的主密钥解开恢复后的访问凭据信封。
 * @param databasePath - 恢复后的控制平面数据库。
 * @param masterKey - 部署主密钥。
 * @returns 核对结果。
 */
function verifyCredentialEnvelopes(
  databasePath: string,
  masterKey: Buffer,
): RestoreReport['items']['encryption'] {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    if (!tableExists(database, 'settings')) return { valid: true, keyId: backupKeyIdOf(masterKey), credentialRecords: 0, decrypted: 0 };
    const rows = database
      .prepare("select key, value from settings where namespace = 'access'")
      .all() as unknown as { key: string; value: string }[];
    const envelopeKey = deriveAccessKey(masterKey, 'envelope');
    let decrypted = 0;
    const failed: string[] = [];
    for (const row of rows) {
      try {
        const envelope = parseAccessEnvelope(row.value);
        openAccessSecret(envelopeKey, envelope, row.key);
        decrypted += 1;
      } catch {
        failed.push(row.key);
      }
    }
    if (failed.length > 0) {
      throw new BackupError(
        BACKUP_ERROR_CODES.restoreCredentialUndecryptable,
        `恢复后有 ${failed.length} 条加密凭据无法用提供的密钥解开`,
        { credentials: failed.length },
        [
          '提供与原部署一致的部署主密钥文件后重新恢复',
          '主密钥已经丢失时以新密钥重建：重新配置一次性密码、通行密钥与恢复码，并重新配对全部设备',
        ],
      );
    }
    return { valid: true, keyId: backupKeyIdOf(masterKey), credentialRecords: rows.length, decrypted };
  } finally {
    database.close();
  }
}

/** 恢复端在对外服务前的处置结果。 */
export interface RestorePrepared {
  /** 已失效的设备令牌，按 `表名:设备标识` 列出。 */
  readonly deviceTokens: readonly string[];
  /** 置为待确认的推送订阅标识。 */
  readonly pushSubscriptions: readonly string[];
  /** 被停用的外部自动化标识。 */
  readonly externalAutomations: readonly string[];
}

/**
 * 处置恢复出来的控制平面：失效设备令牌、停用外部自动化、把推送订阅置为待确认。
 * @param databasePath - 恢复后的控制平面数据库。
 * @param now - 处置时刻的毫秒时间戳。
 * @returns 各项处置清单。
 */
export function prepareRestoredRoot(databasePath: string, now: number): RestorePrepared {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('begin immediate');
    try {
      const deviceTokens: string[] = [];
      for (const table of ['node_devices', 'mobile_devices']) {
        if (!tableExists(database, table)) continue;
        const rows = database.prepare(`select id from ${table}`).all() as unknown as { id: string }[];
        const update = database.prepare(`update ${table} set token_hash = ? where id = ?`);
        for (const row of rows) {
          update.run(`restored-${row.id}-${String(deviceTokens.length)}-${String(now)}`, row.id);
          deviceTokens.push(`${table}:${row.id}`);
        }
      }
      const externalAutomations: string[] = [];
      if (tableExists(database, 'automations')) {
        const enabled = database.prepare('select id from automations where enabled <> 0 order by id').all() as unknown as { id: string }[];
        database.prepare('update automations set enabled = 0, revision = revision + 1, updated_at = ? where enabled <> 0').run(now);
        for (const row of enabled) externalAutomations.push(row.id);
      }
      const pushSubscriptions: string[] = [];
      if (tableExists(database, 'push_subscriptions')) {
        const subscribed = database
          .prepare("select id from push_subscriptions where state = 'subscribed' order by id")
          .all() as unknown as { id: string }[];
        database
          .prepare("update push_subscriptions set state = 'unsubscribed', code = 'restore-pending-confirmation', updated_at = ? where state = 'subscribed'")
          .run(now);
        for (const row of subscribed) pushSubscriptions.push(row.id);
      }
      database.exec('commit');
      return { deviceTokens, pushSubscriptions, externalAutomations };
    } catch (error) {
      database.exec('rollback');
      throw error;
    }
  } finally {
    database.close();
  }
}

/** 读恢复后的事件最大序号。 */
function readMaxSeq(databasePath: string): number {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    if (!tableExists(database, 'replica_events')) return -1;
    const row = database.prepare('select coalesce(max(seq), -1) as latest from replica_events').get() as { latest: number } | undefined;
    return Number(row?.latest ?? -1);
  } finally {
    database.close();
  }
}

/** 组出恢复门禁。 */
function buildGate(
  manifest: BackupManifest,
  now: number,
  prepared: RestorePrepared,
  encryption: RestoreReport['items']['encryption'],
): RestoreGate {
  const dispositions: RestoreDisposition[] = [];
  for (const id of prepared.deviceTokens) dispositions.push({ kind: 'device-token', id, state: 'pending' });
  for (const id of prepared.pushSubscriptions) dispositions.push({ kind: 'push-subscription', id, state: 'pending' });
  for (const id of prepared.externalAutomations) dispositions.push({ kind: 'automation', id, state: 'pending' });
  dispositions.push({ kind: 'access-credential', id: encryption.keyId, state: 'pending' });
  return {
    gateVersion: 1,
    manifestId: manifest.manifestId,
    restoredAt: now,
    externalAutomation: 'disabled',
    notificationSending: 'disabled',
    dispositions,
    conditions: [
      `${String(prepared.deviceTokens.length)} 条设备令牌已在恢复副本里失效，逐台设备重新配对或轮换后才能恢复访问`,
      `${String(prepared.pushSubscriptions.length)} 条推送订阅已置为待确认，逐条重新确认或退订后才能恢复通知发送`,
      `${String(prepared.externalAutomations.length)} 条外部自动化已停用，逐条核对触发来源与目标设备后再启用`,
      '部署主密钥需要在恢复端更换，并用新密钥重新加密既有凭据',
    ],
  };
}

/** 判断表是否存在。 */
function tableExists(database: DatabaseSync, table: string): boolean {
  const row = database
    .prepare("select name from sqlite_master where type = 'table' and name = ?")
    .get(table) as { name: string } | undefined;
  return row !== undefined;
}
