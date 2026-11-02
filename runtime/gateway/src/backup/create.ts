/**
 * 生成一套备份。
 *
 * 顺序固定：列出数据域 → 核对外部服务边界 → 核对剩余空间 → 读取部署主密钥 → 逐对象加密并写
 * 检查点（控制平面先做一致性快照）→ 写入清单。检查点在每个对象写完之后更新，进程被终止时
 * 已完成的对象不再重复加密；续跑前核对源摘要，换了源就拒绝续跑。
 * @module @chatdsh/gateway/backup/create
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONTROL_PLANE_DATABASE,
  BACKUP_EXCLUDED_DOMAINS,
  planBackup,
  readRestorePoint,
  readSchemaVersion,
  snapshotControlPlane,
  type BackupPlan,
  type PlannedObject,
} from './domains.ts';
import { BACKUP_ERROR_CODES, BackupError } from './errors.ts';
import { assertFreeBytes, ensureDirectory, removeFile, temporaryPath, writeJsonAtomic, FILE_MODE } from './files.ts';
import { backupKeyIdOf, deriveBackupKey, objectAad, readBackupKeyFile, sealKeyCheck, sealObject } from './crypto.ts';
import {
  BACKUP_ALGORITHM,
  BACKUP_FORMAT_VERSION,
  BACKUP_PRODUCT,
  CHECKPOINT_FILENAME,
  MANIFEST_FILENAME,
  OBJECTS_DIRECTORY,
  manifestDigestOf,
  readBackupManifest,
  type BackupDomainEntry,
  type BackupExcludedEntry,
  type BackupExternalBoundary,
  type BackupKeyRequirement,
  type BackupManifest,
  type BackupObjectEntry,
  type BackupRestorePoint,
  type BackupSoftwareInfo,
  type BackupTotals,
} from './manifest.ts';
import { BACKUP_RETENTION } from './retention.ts';
import { BACKUP_EVENTS, BACKUP_SPANS, BackupRecorder, type BackupTelemetry } from './telemetry.ts';

/** 检查点版本。 */
export const CHECKPOINT_VERSION = 1;

/** 已完成的检查点对象。 */
export interface CheckpointObject {
  /** 明文字节数。 */
  readonly bytes: number;
  /** 密文与认证标签的字节数。 */
  readonly cipherBytes: number;
  /** 明文摘要。 */
  readonly sha256: string;
  /** base64url 写法的 nonce。 */
  readonly nonce: string;
}

/** 检查点内容。 */
export interface BackupCheckpoint {
  /** 检查点版本。 */
  readonly checkpointVersion: number;
  /** 源数据根。 */
  readonly sourceRoot: string;
  /** 源摘要。 */
  readonly sourceDigest: string;
  /** 开始时刻的毫秒时间戳。 */
  readonly startedAt: number;
  /** 控制平面快照里的恢复点；快照完成后写入。 */
  readonly restorePoint?: BackupRestorePoint;
  /** 已完成的对象，键为恢复后的相对路径。 */
  readonly objects: Readonly<Record<string, CheckpointObject>>;
}

/** 一个外部服务的数据边界输入。 */
export interface ExternalServiceInput {
  /** 服务名。 */
  readonly service: 'hindsight' | 'hermes';
  /** 该部署是否接入了这个服务。 */
  readonly configured: boolean;
  /** 单独备份结果的引用。 */
  readonly reference?: string;
}

/** 生成备份的输入。 */
export interface CreateBackupInput {
  /** 数据根。 */
  readonly sourceRoot: string;
  /** 备份目录，本次生成的所有文件都落在它下面。 */
  readonly backupRoot: string;
  /** 当前软件版本。 */
  readonly software: { readonly version: string };
  /** 部署主密钥文件路径。 */
  readonly keyPath: string;
  /** 外部服务边界；未接入的服务也要显式声明。 */
  readonly external: readonly ExternalServiceInput[];
  /** 遥测出口。 */
  readonly telemetry: BackupTelemetry;
  /** 生成时刻，缺省取当前时刻。 */
  readonly now?: number;
  /** 调用方要求的额外剩余空间下限，单位字节。 */
  readonly requiredFreeBytes?: number;
  /** 每个对象完成之后的进度回调，供界面与演练观测。 */
  readonly onProgress?: (progress: BackupProgress) => void;
}

/** 一条进度。 */
export interface BackupProgress {
  /** 已完成对象数。 */
  readonly completed: number;
  /** 计划对象总数。 */
  readonly total: number;
  /** 刚完成的相对路径。 */
  readonly relativePath: string;
  /** 该对象的明文字节数。 */
  readonly bytes: number;
}

/** 生成结果。 */
export interface CreateBackupResult {
  /** 清单标识。 */
  readonly manifestId: string;
  /** 备份目录。 */
  readonly backupRoot: string;
  /** 清单。 */
  readonly manifest: BackupManifest;
  /** 续跑时跳过的对象数。 */
  readonly resumedObjects: number;
  /** 耗时，单位毫秒。 */
  readonly elapsedMs: number;
}

/**
 * 生成一套备份。
 * @param input - 源、备份目录、密钥、外部边界与遥测。
 * @returns 清单与耗时。
 */
export function createBackup(input: CreateBackupInput): Promise<CreateBackupResult> {
  const recorder = new BackupRecorder(input.telemetry);
  const started = Date.now();
  return recorder.measure(
    BACKUP_SPANS.create,
    'backup.create',
    BACKUP_EVENTS.createRejected,
    {},
    async (span) => {
      if (!existsSync(input.sourceRoot)) {
        throw new BackupError(BACKUP_ERROR_CODES.sourceMissing, `数据根不存在：${input.sourceRoot}`, {}, [
          '确认 DSH_HOME 指向要备份的数据根后重新执行',
        ]);
      }
      const databasePath = join(input.sourceRoot, CONTROL_PLANE_DATABASE);
      if (!existsSync(databasePath)) {
        throw new BackupError(BACKUP_ERROR_CODES.sourceMissing, `数据根里没有控制平面数据库：${databasePath}`, {}, [
          '先启动控制平面生成数据库，或确认 DSH_HOME 指向正确的数据根',
        ]);
      }
      const external = requireExternalBoundary(input.external);
      const plan = planBackup(input.sourceRoot);
      const masterKey = readBackupKeyFile(input.keyPath);
      const objectKey = deriveBackupKey(masterKey);
      const keyId = backupKeyIdOf(masterKey);
      const software: BackupSoftwareInfo = {
        product: BACKUP_PRODUCT,
        version: input.software.version,
        schemaVersion: readSchemaVersion(databasePath),
        nodeMajor: Number(process.versions.node.split('.')[0] ?? '0'),
      };
      const plannedBytes = plan.objects.reduce((sum, object) => sum + object.bytes, 0);
      const requiredFreeBytes = Math.max(plannedBytes * 2, input.requiredFreeBytes ?? 0);
      assertFreeBytes(input.backupRoot, requiredFreeBytes);
      ensureDirectory(input.backupRoot);
      ensureDirectory(join(input.backupRoot, OBJECTS_DIRECTORY));

      const checkpointPath = join(input.backupRoot, CHECKPOINT_FILENAME);
      const checkpoint = loadCheckpoint(checkpointPath, input.sourceRoot, plan.sourceDigest, started);
      const stagingDirectory = join(input.backupRoot, '.staging');
      ensureDirectory(stagingDirectory);

      const encrypted = new Map<string, CheckpointObject>();
      let resumedObjects = 0;
      let restorePoint = checkpoint.restorePoint;
      let completed = 0;
      for (const object of plan.objects) {
        const previous = checkpoint.objects[object.relativePath];
        if (previous !== undefined && existsSync(join(input.backupRoot, objectKeyOf(object.relativePath)))) {
          encrypted.set(object.relativePath, previous);
          resumedObjects += 1;
          completed += 1;
          input.onProgress?.({ completed, total: plan.objects.length, relativePath: object.relativePath, bytes: previous.bytes });
          continue;
        }
        const staged = await stageSource(object, input.sourceRoot, stagingDirectory);
        const targetPath = join(input.backupRoot, objectKeyOf(object.relativePath));
        // 上一次中断可能留下没有登记进检查点的半截对象；它不可信，重新生成。
        if (existsSync(targetPath)) removeFile(targetPath);
        const sealed = await sealObject({
          sourcePath: staged.path,
          targetPath,
          key: objectKey,
          aad: objectAad(BACKUP_FORMAT_VERSION, object.domain, object.relativePath),
        });
        if (staged.snapshot) {
          restorePoint = readRestorePoint(staged.path);
          removeFile(staged.path);
        }
        writeJsonAtomic(checkpointPath, {
          ...checkpoint,
          ...(restorePoint === undefined ? {} : { restorePoint }),
          objects: { ...checkpoint.objects, [object.relativePath]: sealed },
        });
        encrypted.set(object.relativePath, {
          bytes: sealed.bytes,
          cipherBytes: sealed.cipherBytes,
          sha256: sealed.sha256,
          nonce: sealed.nonce,
        });
        completed += 1;
        input.onProgress?.({ completed, total: plan.objects.length, relativePath: object.relativePath, bytes: sealed.bytes });
      }
      if (readdirSync(stagingDirectory).length === 0) rmdirSync(stagingDirectory);

      const now = input.now ?? Date.now();
      const manifest = assembleManifest({
        now,
        software,
        plan,
        external,
        encrypted,
        keyId,
        keyCheck: sealKeyCheck(objectKey),
        restorePoint: restorePoint ?? { maxEventTime: 0, sessions: 0, events: 0 },
      });
      writeJsonAtomic(join(input.backupRoot, MANIFEST_FILENAME), manifest);
      removeFile(checkpointPath);

      recorder.objects('backup.create', manifest.totals.objects);
      recorder.bytes('backup.create', manifest.totals.plaintextBytes);
      span.setAttribute('objects', manifest.totals.objects);
      span.setAttribute('bytes', manifest.totals.plaintextBytes);
      return {
        manifestId: manifest.manifestId,
        backupRoot: input.backupRoot,
        manifest: readBackupManifest(input.backupRoot),
        resumedObjects,
        elapsedMs: Date.now() - started,
      };
    },
  );
}

/**
 * 读取一份检查点。
 * @param path - 检查点路径。
 * @param sourceRoot - 当前源数据根。
 * @param sourceDigest - 当前源摘要。
 * @param startedAt - 新检查点的开始时刻。
 * @returns 检查点；不存在时建立新的。
 */
export function loadCheckpoint(
  path: string,
  sourceRoot: string,
  sourceDigest: string,
  startedAt: number,
): BackupCheckpoint {
  if (!existsSync(path)) {
    return { checkpointVersion: CHECKPOINT_VERSION, sourceRoot, sourceDigest, startedAt, objects: {} };
  }
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) {
    throw new BackupError(BACKUP_ERROR_CODES.checkpointCorrupt, `检查点内容不是对象：${path}`);
  }
  const record = parsed as Record<string, unknown>;
  if (record['checkpointVersion'] !== CHECKPOINT_VERSION) {
    throw new BackupError(BACKUP_ERROR_CODES.checkpointCorrupt, '检查点版本与当前程序不一致', {
      version: Number(record['checkpointVersion'] ?? 0),
    });
  }
  if (record['sourceRoot'] !== sourceRoot || record['sourceDigest'] !== sourceDigest) {
    throw new BackupError(
      BACKUP_ERROR_CODES.checkpointMismatch,
      '检查点记录的源与当前源不一致，拒绝在另一个源上续跑备份',
      { expected: String(record['sourceDigest'] ?? ''), actual: sourceDigest },
      ['把检查点与已生成的对象移到别处，或对同一份源重新开始一套备份'],
    );
  }
  const objects = record['objects'];
  if (typeof objects !== 'object' || objects === null) {
    throw new BackupError(BACKUP_ERROR_CODES.checkpointCorrupt, '检查点缺少对象登记');
  }
  const restorePoint = record['restorePoint'];
  return {
    checkpointVersion: CHECKPOINT_VERSION,
    sourceRoot,
    sourceDigest,
    startedAt: Number(record['startedAt'] ?? startedAt),
    ...(typeof restorePoint === 'object' && restorePoint !== null
      ? { restorePoint: restorePointOf(restorePoint as Record<string, unknown>) }
      : {}),
    objects: objects as Record<string, CheckpointObject>,
  };
}

/** 校验并转换检查点里的恢复点。 */
function restorePointOf(record: Record<string, unknown>): BackupRestorePoint {
  return {
    maxEventTime: Number(record['maxEventTime'] ?? 0),
    sessions: Number(record['sessions'] ?? 0),
    events: Number(record['events'] ?? 0),
  };
}

/**
 * 备份根里的对象密文路径；由相对路径摘要决定，续跑与恢复时位置稳定。
 * @param relativePath - 恢复后的相对数据根路径。
 * @returns 相对备份根的对象路径。
 */
export function objectKeyOf(relativePath: string): string {
  return `${OBJECTS_DIRECTORY}/${createHash('sha256').update(relativePath).digest('hex').slice(0, 40)}.enc`;
}

/**
 * 准备一个对象的明文来源：控制平面先做一致性快照，其余直接用源文件。
 * @param object - 计划对象。
 * @param sourceRoot - 数据根。
 * @param stagingDirectory - 暂存目录。
 * @returns 可加密的路径与是否快照。
 */
async function stageSource(
  object: PlannedObject,
  sourceRoot: string,
  stagingDirectory: string,
): Promise<{ readonly path: string; readonly snapshot: boolean }> {
  if (!object.snapshot) return { path: object.sourcePath, snapshot: false };
  const staged = temporaryPath(stagingDirectory, 'control-plane');
  snapshotControlPlane(join(sourceRoot, CONTROL_PLANE_DATABASE), staged);
  return { path: staged, snapshot: true };
}

/**
 * 组出清单。
 * @param options - 本次生成的全部读数。
 * @returns 清单。
 */
function assembleManifest(options: {
  readonly now: number;
  readonly software: BackupSoftwareInfo;
  readonly plan: BackupPlan;
  readonly external: readonly BackupExternalBoundary[];
  readonly encrypted: ReadonlyMap<string, CheckpointObject>;
  readonly keyId: string;
  readonly keyCheck: { readonly nonce: string; readonly ciphertext: string };
  readonly restorePoint: BackupRestorePoint;
}): BackupManifest {
  const included: BackupDomainEntry[] = options.plan.domains.map((domain) => ({
    domain: domain.domain,
    kind: domain.kind,
    root: domain.root,
    objects: domain.objects,
    bytes: domain.bytes,
    note: domain.note,
  }));
  const objects: BackupObjectEntry[] = [...options.encrypted.entries()]
    .map(([relativePath, entry]) => {
      const planned = options.plan.objects.find((object) => object.relativePath === relativePath);
      if (planned === undefined) {
        throw new BackupError(BACKUP_ERROR_CODES.checkpointCorrupt, `检查点里的对象不在本次计划内：${relativePath}`);
      }
      return {
        key: objectKeyOf(relativePath),
        domain: planned.domain,
        relativePath,
        bytes: entry.bytes,
        cipherBytes: entry.cipherBytes,
        sha256: entry.sha256,
        nonce: entry.nonce,
        mode: FILE_MODE,
      };
    })
    .sort((left, right) => (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0));
  const totals: BackupTotals = {
    objects: objects.length,
    plaintextBytes: objects.reduce((sum, object) => sum + object.bytes, 0),
    cipherBytes: objects.reduce((sum, object) => sum + object.cipherBytes, 0),
  };
  const keys: BackupKeyRequirement[] = [
    {
      purpose: 'backup-object-encryption',
      version: 'v1',
      keyId: options.keyId,
      location: '部署主密钥文件（权限 0600，32 字节），默认位于 <数据根>/access/master.key',
      recovery: [
        '主密钥单独离线保管，不随备份保存',
        '恢复时把原主密钥文件放回恢复端可读路径，并用同一路径执行解包',
        '主密钥丢失时只能以新密钥恢复，并重新配对全部设备、重新确认推送订阅',
      ],
    },
    {
      purpose: 'access-credential-envelope',
      version: 'v1',
      keyId: options.keyId,
      location: '与备份对象密钥同源的部署主密钥，恢复后用于解开访问凭据信封',
      recovery: [
        '恢复端以原主密钥启动，才能解开一次性密码、通行密钥与恢复码等信封',
        '无法解开时恢复流程停止，并列出需要重新配置的凭据项目',
      ],
    },
  ];
  const body = {
    manifestVersion: BACKUP_FORMAT_VERSION,
    manifestId: manifestIdOf(options.now),
    createdAt: options.now,
    software: options.software,
    restorePoint: options.restorePoint,
    included,
    excluded: BACKUP_EXCLUDED_DOMAINS as readonly BackupExcludedEntry[],
    external: options.external,
    keys,
    keyCheck: { ...options.keyCheck, recordType: 'backup-key-check' },
    encryption: {
      algorithm: BACKUP_ALGORITHM,
      keyVersion: 'v1',
      keyId: options.keyId,
      scope: '每个对象独立 nonce 与认证标签，附加认证数据绑定格式版本、数据域与相对路径',
      masterKeyIncluded: false,
    },
    retention: BACKUP_RETENTION,
    objects,
    totals,
    sourceDigest: options.plan.sourceDigest,
  };
  return { ...body, manifestDigest: manifestDigestOf(body) };
}

/** 生成清单标识。 */
function manifestIdOf(now: number): string {
  const stamp = new Date(now).toISOString().replaceAll(/[-:]/g, '').replace(/\..*$/u, '');
  return `backup-${stamp}-${randomBytes(3).toString('hex')}`;
}

/**
 * 组装外部服务边界，接入服务却没有单独备份结果时拒绝。
 * @param inputs - 调用方声明的外部服务。
 * @returns 两个外部服务的边界。
 */
export function requireExternalBoundary(inputs: readonly ExternalServiceInput[]): readonly BackupExternalBoundary[] {
  const boundaries: BackupExternalBoundary[] = [];
  for (const service of ['hindsight', 'hermes'] as const) {
    const input = inputs.find((item) => item.service === service);
    const configured = input?.configured ?? false;
    const reference = input?.reference;
    if (configured && (reference === undefined || reference.trim() === '')) {
      throw new BackupError(
        BACKUP_ERROR_CODES.externalScopeIncomplete,
        `外部服务 ${service} 已接入，但备份里没有它的单独备份结果引用，恢复边界不完整`,
        { service },
        [
          `在 ${service} 侧执行导出并把结果保存到独立位置`,
          '把该导出的引用传给备份，使清单记录实际恢复边界',
        ],
      );
    }
    boundaries.push({
      service,
      configured,
      included: false,
      ...(reference === undefined ? {} : { reference }),
      boundary: configured
        ? `不包含在本次备份内；恢复后需按引用 ${reference} 单独恢复该服务的数据`
        : '本次部署未接入该服务，恢复后不涉及它的数据',
    });
  }
  return boundaries;
}
