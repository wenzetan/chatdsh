/**
 * 校验一份备份。
 *
 * 校验项各自独立失败：清单缺失或损坏、清单摘要被改写、密钥缺失或与清单不符、对象缺失、
 * 对象密文损坏、解密后字节摘要不一致、剩余空间不足、外部服务数据边界不完整。每项失败都带
 * 稳定的原因码与计数，调用方据此给出补齐或替换的具体动作。
 * @module @chatdsh/gateway/backup/verify
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { backupKeyIdOf, deriveBackupKey, objectAad, openKeyCheck, openObject, readBackupKeyFile } from './crypto.ts';
import { BACKUP_ERROR_CODES, BackupError } from './errors.ts';
import { assertFreeBytes } from './files.ts';
import { BACKUP_FORMAT_VERSION, readBackupManifest, type BackupExternalBoundary } from './manifest.ts';
import { BACKUP_EVENTS, BACKUP_SPANS, BackupRecorder, type BackupTelemetry } from './telemetry.ts';

/** 校验输入。 */
export interface VerifyBackupInput {
  /** 备份目录。 */
  readonly backupRoot: string;
  /** 部署主密钥文件路径。 */
  readonly keyPath: string;
  /** 遥测出口。 */
  readonly telemetry: BackupTelemetry;
  /** 调用方要求的剩余空间下限，单位字节。 */
  readonly requiredFreeBytes?: number;
}

/** 校验报告。 */
export interface BackupVerificationReport {
  /** 清单标识。 */
  readonly manifestId: string;
  /** 校验时刻的毫秒时间戳。 */
  readonly checkedAt: number;
  /** 核对通过的对象条数。 */
  readonly objects: number;
  /** 明文字节数合计。 */
  readonly plaintextBytes: number;
  /** 密文字节数合计。 */
  readonly cipherBytes: number;
  /** 清单记录的密钥标识。 */
  readonly keyId: string;
  /** 清单记录的 schema 版本。 */
  readonly schemaVersion: number;
  /** 清单记录的软件版本。 */
  readonly softwareVersion: string;
  /** 外部服务边界；接入服务时给出单独备份结果引用。 */
  readonly external: readonly BackupExternalBoundary[];
  /** 实际恢复点。 */
  readonly restorePoint: { readonly maxEventTime: number; readonly sessions: number; readonly events: number };
  /** 耗时，单位毫秒。 */
  readonly elapsedMs: number;
}

/**
 * 校验一份备份。
 * @param input - 备份目录、密钥、遥测与可选的剩余空间要求。
 * @returns 通过时的校验报告。
 */
export function verifyBackup(input: VerifyBackupInput): Promise<BackupVerificationReport> {
  const recorder = new BackupRecorder(input.telemetry);
  const started = Date.now();
  return recorder.measure(
    BACKUP_SPANS.verify,
    'backup.verify',
    BACKUP_EVENTS.verifyRejected,
    {},
    async (span) => {
      const manifest = readBackupManifest(input.backupRoot);
      if (manifest.manifestVersion !== BACKUP_FORMAT_VERSION) {
        throw new BackupError(BACKUP_ERROR_CODES.formatUnsupported, '备份格式版本不受支持', {
          version: manifest.manifestVersion,
        });
      }
      for (const boundary of manifest.external) {
        if (boundary.configured && (boundary.reference === undefined || boundary.reference.trim() === '')) {
          throw new BackupError(
            BACKUP_ERROR_CODES.externalScopeIncomplete,
            `外部服务 ${boundary.service} 已接入，备份里没有它的单独备份结果引用`,
            { service: boundary.service },
            [`在 ${boundary.service} 侧执行导出并把结果引用补齐后重新生成备份`],
          );
        }
      }
      const masterKey = readBackupKeyFile(input.keyPath);
      const keyId = backupKeyIdOf(masterKey);
      if (keyId !== manifest.encryption.keyId) {
        throw new BackupError(
          BACKUP_ERROR_CODES.keyMismatch,
          '提供的密钥与清单登记的密钥标识不一致',
          { expected: manifest.encryption.keyId, actual: keyId },
          ['提供生成该备份时使用的部署主密钥文件后重新校验'],
        );
      }
      const objectKey = deriveBackupKey(masterKey);
      openKeyCheck(objectKey, manifest.keyCheck);
      if (input.requiredFreeBytes !== undefined) assertFreeBytes(input.backupRoot, input.requiredFreeBytes);

      let missing = 0;
      let corrupt = 0;
      let mismatch = 0;
      for (const object of manifest.objects) {
        const path = join(input.backupRoot, object.key);
        if (!existsSync(path)) {
          missing += 1;
          continue;
        }
        let opened: { bytes: number; sha256: string };
        try {
          opened = await openObject({
            objectPath: path,
            key: objectKey,
            nonce: object.nonce,
            aad: objectAad(manifest.manifestVersion, object.domain, object.relativePath),
          });
        } catch (error) {
          if (error instanceof BackupError && error.code === BACKUP_ERROR_CODES.objectCorrupt) {
            corrupt += 1;
            continue;
          }
          throw error;
        }
        if (opened.sha256 !== object.sha256 || opened.bytes !== object.bytes) {
          mismatch += 1;
        }
      }
      if (missing > 0) {
        throw new BackupError(BACKUP_ERROR_CODES.objectMissing, `备份缺少 ${missing} 个对象`, { missing }, [
          '用上一份完整备份替换缺失的对象，或从源数据根重新生成备份',
        ]);
      }
      if (corrupt > 0) {
        throw new BackupError(BACKUP_ERROR_CODES.objectCorrupt, `备份里有 ${corrupt} 个对象的密文认证失败`, { corrupt }, [
          '用上一份完整备份替换损坏的对象，或从源数据根重新生成备份',
        ]);
      }
      if (mismatch > 0) {
        throw new BackupError(BACKUP_ERROR_CODES.objectDigestMismatch, `备份里有 ${mismatch} 个对象解密后的摘要与清单不一致`, {
          mismatch,
        }, ['用上一份完整备份替换这些对象，或从源数据根重新生成备份']);
      }

      const report: BackupVerificationReport = {
        manifestId: manifest.manifestId,
        checkedAt: Date.now(),
        objects: manifest.objects.length,
        plaintextBytes: manifest.totals.plaintextBytes,
        cipherBytes: manifest.totals.cipherBytes,
        keyId: manifest.encryption.keyId,
        schemaVersion: manifest.software.schemaVersion,
        softwareVersion: manifest.software.version,
        external: manifest.external,
        restorePoint: manifest.restorePoint,
        elapsedMs: Date.now() - started,
      };
      recorder.objects('backup.verify', report.objects);
      recorder.bytes('backup.verify', report.plaintextBytes);
      span.setAttribute('objects', report.objects);
      span.setAttribute('bytes', report.plaintextBytes);
      return report;
    },
  );
}
