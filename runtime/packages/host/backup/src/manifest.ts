/**
 * 备份清单的宿主侧核对。
 *
 * 恢复目录里保留一份原清单。宿主重新读一遍：清单正文的摘要要与登记的摘要一致，每个非控制平面
 * 数据域的对象要在磁盘上存在，且字节数与明文摘要都要与清单一致。控制平面数据库在恢复后会被
 * 有意改写（失效设备令牌、停用外部自动化、置推送订阅为待确认），因此不参与这一轮字节核对，
 * 它的对象在校验与恢复阶段已经逐字节核对过。
 * @module @chatdsh/host-backup/manifest
 */

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { RESTORE_ARTIFACT_ERROR_CODES, RestoreArtifactError } from './artifact.ts';

/** 恢复目录里保留的清单文件名。 */
export const RESTORED_MANIFEST_FILENAME = 'backup-manifest.json';

/** 不参与宿主字节核对的数据域。 */
export const MUTABLE_DOMAINS = ['control-plane'] as const;

/** 对象的 schema。 */
export const backupObjectSchema = z.object({
  key: z.string().min(1),
  domain: z.string().min(1),
  relativePath: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  cipherBytes: z.number().int().nonnegative(),
  sha256: z.string().min(1),
  nonce: z.string().min(1),
  mode: z.number().int().nonnegative(),
});

/** 数据域条目的 schema。 */
export const backupDomainSchema = z.object({
  domain: z.string().min(1),
  kind: z.enum(['sqlite-snapshot', 'file-tree', 'embedded']),
  root: z.string().min(1),
  objects: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  note: z.string().min(1),
});

/** 清单正文的 schema。 */
export const backupManifestBodySchema = z.object({
  manifestVersion: z.number().int().nonnegative(),
  manifestId: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  software: z.object({
    product: z.string().min(1),
    version: z.string().min(1),
    schemaVersion: z.number().int().nonnegative(),
    nodeMajor: z.number().int().nonnegative(),
  }),
  restorePoint: z.object({
    maxEventTime: z.number().int().nonnegative(),
    sessions: z.number().int().nonnegative(),
    events: z.number().int().nonnegative(),
  }),
  included: z.array(backupDomainSchema),
  excluded: z.array(z.object({
    domain: z.string().min(1),
    reason: z.string().min(1),
    separateBackup: z.string().min(1),
  })),
  external: z.array(z.object({
    service: z.enum(['hindsight', 'hermes']),
    configured: z.boolean(),
    included: z.literal(false),
    reference: z.string().optional(),
    boundary: z.string().min(1),
  })),
  keys: z.array(z.object({
    purpose: z.enum(['backup-object-encryption', 'access-credential-envelope']),
    version: z.string().min(1),
    keyId: z.string().min(1),
    location: z.string().min(1),
    recovery: z.array(z.string()),
  })),
  keyCheck: z.object({
    nonce: z.string().min(1),
    ciphertext: z.string().min(1),
    recordType: z.string().min(1),
  }),
  encryption: z.object({
    algorithm: z.string().min(1),
    keyVersion: z.string().min(1),
    keyId: z.string().min(1),
    scope: z.string().min(1),
    masterKeyIncluded: z.boolean(),
  }),
  retention: z.object({
    daily: z.number().int().nonnegative(),
    weekly: z.number().int().nonnegative(),
    monthly: z.number().int().nonnegative(),
    rpoHours: z.number().int().nonnegative(),
    restoreTargetMinutes: z.number().int().nonnegative(),
    schedule: z.string().min(1),
  }),
  objects: z.array(backupObjectSchema),
  totals: z.object({
    objects: z.number().int().nonnegative(),
    plaintextBytes: z.number().int().nonnegative(),
    cipherBytes: z.number().int().nonnegative(),
  }),
  sourceDigest: z.string().min(1),
});

/** 清单的 schema。 */
export const backupManifestSchema = backupManifestBodySchema.extend({
  manifestDigest: z.string().min(1),
});

/** 清单。 */
export type BackupManifest = z.infer<typeof backupManifestSchema>;

/** 一个对象的核对结果。 */
export interface RestoredFileCheck {
  /** 恢复后的相对路径。 */
  readonly relativePath: string;
  /** 所属数据域。 */
  readonly domain: string;
  /** 字节数。 */
  readonly bytes: number;
  /** 明文摘要。 */
  readonly sha256: string;
}

/** 文件核对报告。 */
export interface RestoredFilesReport {
  /** 恢复根。 */
  readonly root: string;
  /** 核对的文件数。 */
  readonly files: number;
  /** 核对的字节数。 */
  readonly bytes: number;
  /** 逐数据域的文件数。 */
  readonly byDomain: Readonly<Record<string, number>>;
  /** 未参与核对的数据域。 */
  readonly skipped: readonly string[];
  /** 逐文件结果。 */
  readonly checked: readonly RestoredFileCheck[];
  /** 通过。 */
  readonly valid: boolean;
}

/**
 * 读取恢复目录里保留的清单并核对正文摘要。
 * @param restoredRoot - 恢复出来的数据根。
 * @returns 清单。
 */
export function readRestoredManifest(restoredRoot: string): BackupManifest {
  const path = join(restoredRoot, RESTORED_MANIFEST_FILENAME);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException).code ?? 'unknown';
    throw new RestoreArtifactError(RESTORE_ARTIFACT_ERROR_CODES.reportMissing, `恢复目录里没有备份清单：${path}`, { errno });
  }
  const result = backupManifestSchema.safeParse(JSON.parse(text));
  if (!result.success) {
    throw new RestoreArtifactError(RESTORE_ARTIFACT_ERROR_CODES.reportCorrupt, `备份清单形状不合法：${result.error.message}`, {
      issues: result.error.issues.length,
    });
  }
  const manifest = result.data;
  const body = {
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
  const digest = createHash('sha256').update(canonicalJson(body)).digest('hex');
  if (digest !== manifest.manifestDigest) {
    throw new RestoreArtifactError(RESTORE_ARTIFACT_ERROR_CODES.artifactMismatch, '恢复目录里的清单正文与登记的摘要不一致', {
      expected: manifest.manifestDigest.slice(0, 16),
      actual: digest.slice(0, 16),
    });
  }
  return manifest;
}

/**
 * 按清单核对恢复出来的文件字节。
 * @param restoredRoot - 恢复出来的数据根。
 * @param manifest - 恢复目录里的清单。
 * @returns 核对报告；不一致或缺失时就地拒绝。
 */
export async function verifyRestoredFiles(restoredRoot: string, manifest: BackupManifest): Promise<RestoredFilesReport> {
  const byDomain: Record<string, number> = {};
  const checked: RestoredFileCheck[] = [];
  let bytes = 0;
  for (const object of manifest.objects) {
    if (MUTABLE_DOMAINS.includes(object.domain as (typeof MUTABLE_DOMAINS)[number])) continue;
    const path = containedPath(restoredRoot, object.relativePath);
    if (!existsSync(path)) {
      throw new RestoreArtifactError(RESTORE_ARTIFACT_ERROR_CODES.logGap, `恢复后缺少文件：${object.relativePath}`, {
        domain: object.domain,
      });
    }
    const info = statSync(path);
    if (info.size !== object.bytes) {
      throw new RestoreArtifactError(RESTORE_ARTIFACT_ERROR_CODES.artifactMismatch, `恢复后文件字节数不一致：${object.relativePath}`, {
        expected: object.bytes,
        actual: info.size,
      });
    }
    const digest = await digestFile(path);
    if (digest !== object.sha256) {
      throw new RestoreArtifactError(RESTORE_ARTIFACT_ERROR_CODES.artifactMismatch, `恢复后文件摘要不一致：${object.relativePath}`, {
        domain: object.domain,
      });
    }
    byDomain[object.domain] = (byDomain[object.domain] ?? 0) + 1;
    bytes += info.size;
    checked.push({ relativePath: object.relativePath, domain: object.domain, bytes: info.size, sha256: digest });
  }
  return {
    root: restoredRoot,
    files: checked.length,
    bytes,
    byDomain,
    skipped: [...MUTABLE_DOMAINS],
    checked,
    valid: true,
  };
}

/** 计算一个文件的 SHA-256。 */
async function digestFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path, { highWaterMark: 1 << 20 });
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** 把相对路径解析到恢复根之下，拒绝穿越。 */
function containedPath(root: string, relativePath: string): string {
  const absolute = resolve(root, relativePath);
  const lexical = relative(resolve(root), absolute);
  if (lexical === '' || lexical === '..' || lexical.startsWith(`..${sep}`) || lexical.startsWith(sep)) {
    throw new RestoreArtifactError(RESTORE_ARTIFACT_ERROR_CODES.artifactMismatch, '清单里的对象路径越出恢复根', {
      path: relativePath,
    });
  }
  return absolute;
}

/** 规范化 JSON：对象键排序，数组保持顺序。与写入清单时的规范化方式一致。 */
function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
