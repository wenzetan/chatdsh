/**
 * 备份的数据域与 SQLite 一致性快照。
 *
 * 数据域按数据根的目录布局声明：控制平面数据库、每台设备的会话日志（JSONL）、附件对象、
 * 分享包、导出包，以及加密凭据所在的目录（主密钥本身排除在外）。控制平面数据库用 SQLite 的
 * `VACUUM INTO` 生成一致副本，生成前后各做一次完整性检查；其余数据域按文件逐个列出尺寸与
 * 修改时刻，作为受控检查点的续跑依据。
 * @module @chatdsh/gateway/backup/domains
 */

import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BACKUP_ERROR_CODES, BackupError } from './errors.ts';
import { listTree, type TreeFile } from './files.ts';
import type { BackupRestorePoint } from './manifest.ts';

/** 一个数据域的声明。 */
export interface BackupDomainSpec {
  /** 域名。 */
  readonly domain: string;
  /** 存放形态。 */
  readonly kind: 'sqlite-snapshot' | 'file-tree';
  /** 相对数据根的路径。 */
  readonly root: string;
  /** 源里缺少这个数据域时是否拒绝备份。 */
  readonly required: boolean;
  /** 相对该数据域根目录的排除路径。 */
  readonly exclude: readonly string[];
  /** 清单里的说明。 */
  readonly note: string;
}

/** 控制平面数据库在数据根里的相对路径。 */
export const CONTROL_PLANE_DATABASE = 'gateway/gateway.sqlite';

/** 数据域声明，顺序即清单顺序。 */
export const BACKUP_DOMAINS: readonly BackupDomainSpec[] = [
  {
    domain: 'control-plane',
    kind: 'sqlite-snapshot',
    root: CONTROL_PLANE_DATABASE,
    required: true,
    exclude: [],
    note: '会话归属、设备、副本、分享、通知订阅、自动化、设置与额度；用 VACUUM INTO 生成一致副本',
  },
  {
    domain: 'device-logs',
    kind: 'file-tree',
    root: 'sessions',
    required: false,
    exclude: [],
    note: '每台设备的权威会话日志，按完整提交边界固定文件内容',
  },
  {
    domain: 'attachments',
    kind: 'file-tree',
    root: 'attachments',
    required: false,
    exclude: [],
    note: '附件内容字节，按内容摘要固定',
  },
  {
    domain: 'share-packages',
    kind: 'file-tree',
    root: 'shares',
    required: false,
    exclude: [],
    note: '有效分享的独立不可变快照与逐项授权的附件副本',
  },
  {
    domain: 'exports',
    kind: 'file-tree',
    root: 'exports',
    required: false,
    exclude: [],
    note: '导出包文件，可重新生成，随备份保留以维持既有下载链接',
  },
  {
    domain: 'access-credentials',
    kind: 'file-tree',
    root: 'access',
    required: false,
    exclude: ['master.key'],
    note: '加密凭据信封；主密钥排除在备份之外，按密钥恢复条件单独保存',
  },
];

/** 排除清单：这些数据不属于控制平面备份。 */
export const BACKUP_EXCLUDED_DOMAINS = [
  {
    domain: 'hindsight-memory',
    reason: 'Hindsight 记忆库位于外部服务，备份过程不读取它的数据库',
    separateBackup: '在 Hindsight 侧执行导出，把导出结果引用写入设置后再生成备份',
  },
  {
    domain: 'hermes-history',
    reason: 'Hermes 历史位于外部服务或独立数据根，不属于控制平面的数据域',
    separateBackup: '按 Hermes 部署的备份方式单独导出，生成备份时提供结果引用',
  },
  {
    domain: 'master-key',
    reason: '部署主密钥是备份的解密前提，放进备份等于把锁和钥匙放在一处',
    separateBackup: '主密钥离线保管，恢复时由操作者提供权限 0600 的独立文件',
  },
  {
    domain: 'workspace-files',
    reason: '工作区文件与版本库属于用户项目，不受控制平面备份管理',
    separateBackup: '按项目自身的版本管理或文件备份方式处理',
  },
  {
    domain: 'process-secrets',
    reason: '模型密钥、Webhook 密钥等来自环境变量，不写入磁盘也不进入备份',
    separateBackup: '按部署清单在恢复端重新配置环境变量',
  },
] as const;

/** 计划复制的一个对象。 */
export interface PlannedObject {
  /** 所属数据域。 */
  readonly domain: string;
  /** 恢复后的相对数据根路径。 */
  readonly relativePath: string;
  /** 源文件绝对路径；控制平面数据库在快照阶段改写。 */
  readonly sourcePath: string;
  /** 源字节数。 */
  readonly bytes: number;
  /** 源修改时刻，参与源摘要。 */
  readonly mtimeMs: number;
  /** 是否需要先做一致性快照。 */
  readonly snapshot: boolean;
}

/** 计划结果。 */
export interface BackupPlan {
  /** 计划复制的对象，按路径升序。 */
  readonly objects: readonly PlannedObject[];
  /** 每个数据域的对象数与字节数。 */
  readonly domains: readonly {
    readonly domain: string;
    readonly kind: 'sqlite-snapshot' | 'file-tree';
    readonly root: string;
    readonly objects: number;
    readonly bytes: number;
    readonly note: string;
  }[];
  /** 源数据摘要。 */
  readonly sourceDigest: string;
}

/**
 * 列出源数据里要备份的对象。
 * @param sourceRoot - 数据根。
 * @param sourceDigestOf - 计算源摘要的函数，由调用方给出以复用同一算法。
 * @returns 计划结果。
 */
export function planBackup(sourceRoot: string): BackupPlan {
  const objects: PlannedObject[] = [];
  const domains: {
    domain: string;
    kind: 'sqlite-snapshot' | 'file-tree';
    root: string;
    objects: number;
    bytes: number;
    note: string;
  }[] = [];
  for (const spec of BACKUP_DOMAINS) {
    if (spec.kind === 'sqlite-snapshot') {
      const absolutePath = join(sourceRoot, spec.root);
      const bytes = requireControlPlane(absolutePath);
      objects.push({
        domain: spec.domain,
        relativePath: spec.root,
        sourcePath: absolutePath,
        bytes,
        mtimeMs: statSync(absolutePath).mtimeMs,
        snapshot: true,
      });
      domains.push({ domain: spec.domain, kind: spec.kind, root: spec.root, objects: 1, bytes, note: spec.note });
      continue;
    }
    const root = join(sourceRoot, spec.root);
    const files: readonly TreeFile[] = listTree(root, spec.exclude);
    let bytes = 0;
    for (const file of files) {
      bytes += file.bytes;
      objects.push({
        domain: spec.domain,
        relativePath: `${spec.root}/${file.relativePath}`,
        sourcePath: file.absolutePath,
        bytes: file.bytes,
        mtimeMs: file.mtimeMs,
        snapshot: false,
      });
    }
    domains.push({ domain: spec.domain, kind: spec.kind, root: spec.root, objects: files.length, bytes, note: spec.note });
  }
  objects.sort((left, right) => (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0));
  return { objects, domains, sourceDigest: sourceDigestOf(objects) };
}

/**
 * 计算源摘要：对象路径、字节数与修改时刻共同决定，续跑前用它确认还是同一个源。
 * @param objects - 计划复制的对象。
 * @returns 十六进制摘要。
 */
export function sourceDigestOf(objects: readonly PlannedObject[]): string {
  const hash = createHash('sha256');
  for (const object of objects) {
    hash.update(`${object.domain}\t${object.relativePath}\t${String(object.bytes)}\t${String(object.mtimeMs)}\n`);
  }
  return hash.digest('hex');
}

/** 核对控制平面数据库存在且是普通文件，返回字节数。 */
function requireControlPlane(path: string): number {
  if (!existsSync(path)) {
    throw new BackupError(BACKUP_ERROR_CODES.sourceMissing, `数据根里没有控制平面数据库：${path}`, {}, [
      '确认 DSH_HOME 指向要备份的数据根，或先启动控制平面生成数据库后重新执行',
    ]);
  }
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new BackupError(BACKUP_ERROR_CODES.sourceMissing, `控制平面数据库不是普通文件：${path}`);
  }
  return info.size;
}

/**
 * 用 SQLite 的一致性备份接口生成控制平面副本。
 *
 * 源库以只读连接打开，先做一次快速完整性检查；`VACUUM INTO` 在一个读事务里写出完整副本，
 * 生成后再用独立连接做一次完整完整性检查，两项都通过才交给加密阶段。
 * @param sourcePath - 源数据库。
 * @param targetPath - 副本路径，必须不存在。
 * @returns 副本字节数与表条数。
 */
export function snapshotControlPlane(sourcePath: string, targetPath: string): { readonly bytes: number; readonly tables: number } {
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const quick = source.prepare('pragma quick_check').get() as { quick_check?: string } | undefined;
    if (quick?.quick_check !== 'ok') {
      throw new BackupError(BACKUP_ERROR_CODES.objectCorrupt, '源控制平面数据库未通过快速完整性检查', {
        result: String(quick?.quick_check ?? 'unknown'),
      }, ['用上一份可用备份恢复控制平面，或从设备侧重新获取副本后重新备份']);
    }
    source.prepare('vacuum into ?').run(targetPath);
  } finally {
    source.close();
  }
  if (!existsSync(targetPath)) {
    throw new BackupError(BACKUP_ERROR_CODES.objectCorrupt, `一致性副本没有生成：${targetPath}`);
  }
  const snapshot = new DatabaseSync(targetPath, { readOnly: true });
  try {
    const check = snapshot.prepare('pragma integrity_check').get() as { integrity_check?: string } | undefined;
    if (check?.integrity_check !== 'ok') {
      throw new BackupError(BACKUP_ERROR_CODES.objectCorrupt, '生成的一致性副本未通过完整性检查', {
        result: String(check?.integrity_check ?? 'unknown'),
      });
    }
    const tableRow = snapshot.prepare("select count(*) as total from sqlite_master where type = 'table'").get() as
      | { total: number }
      | undefined;
    return { bytes: statSync(targetPath).size, tables: Number(tableRow?.total ?? 0) };
  } finally {
    snapshot.close();
  }
}

/**
 * 读控制平面里的恢复点：最新事件时刻、会话条数与事件条数。
 * @param databasePath - 数据库路径。
 * @returns 恢复点。
 */
export function readRestorePoint(databasePath: string): BackupRestorePoint {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    if (!tableExists(database, 'replica_events')) return { maxEventTime: 0, sessions: countOf(database, 'sessions'), events: 0 };
    const latest = database.prepare('select coalesce(max(time), 0) as latest, count(*) as total from replica_events').get() as
      | { latest: number; total: number }
      | undefined;
    return {
      maxEventTime: Number(latest?.latest ?? 0),
      sessions: countOf(database, 'sessions'),
      events: Number(latest?.total ?? 0),
    };
  } finally {
    database.close();
  }
}

/**
 * 读控制平面的 schema 版本。
 * @param databasePath - 数据库路径。
 * @returns 已应用的最高版本；没有登记表时为 0。
 */
export function readSchemaVersion(databasePath: string): number {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    if (!tableExists(database, 'schema_migrations')) return 0;
    const row = database
      .prepare("select coalesce(max(version), 0) as version from schema_migrations where status = 'applied'")
      .get() as { version: number } | undefined;
    return Number(row?.version ?? 0);
  } finally {
    database.close();
  }
}

/** 统计一张表里的行数；表不存在时为 0。 */
function countOf(database: DatabaseSync, table: string): number {
  if (!tableExists(database, table)) return 0;
  const row = database.prepare(`select count(*) as total from ${table}`).get() as { total: number } | undefined;
  return Number(row?.total ?? 0);
}

/** 判断表是否存在。 */
function tableExists(database: DatabaseSync, table: string): boolean {
  const row = database
    .prepare("select name from sqlite_master where type = 'table' and name = ?")
    .get(table) as { name: string } | undefined;
  return row !== undefined;
}
