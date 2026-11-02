/**
 * 版本化 schema 迁移登记。
 *
 * 每条迁移有连续的版本号、名称与语句集合，校验和按定义内容计算。启动时把登记表与
 * `schema_migrations` 的实际记录比对，版本与校验和必须逐条一致。
 * @module @chatdsh/gateway/storage/schema-registry
 */

import { createHash } from 'node:crypto';
import { StorageError, STORAGE_ERROR_CODES } from './errors.ts';

/** 一条迁移登记。 */
export interface SchemaMigrationEntry {
  /** 版本号，从 1 开始连续递增。 */
  readonly version: number;
  /** 迁移名称，稳定不变，用于排错。 */
  readonly name: string;
  /** 单独执行时幂等的语句，按顺序应用。 */
  readonly statements: readonly string[];
}

/** 计算过校验和的迁移登记。 */
export interface RegisteredMigration extends SchemaMigrationEntry {
  /** 定义内容的 SHA-256 摘要。 */
  readonly checksum: string;
}

/**
 * 计算一条迁移的校验和。
 *
 * 输入是版本号、名称与全部语句的规范化拼接，改动定义内容必然改变校验和。
 * @param entry - 迁移登记。
 * @returns 十六进制摘要。
 */
export function migrationChecksum(entry: SchemaMigrationEntry): string {
  const canonical = [String(entry.version), entry.name, ...entry.statements].join('\u0000');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** 迁移登记表。 */
export class MigrationRegistry {
  /** 全部登记，按版本号升序。 */
  readonly migrations: readonly RegisteredMigration[];
  private readonly byVersion: ReadonlyMap<number, RegisteredMigration>;

  constructor(entries: readonly SchemaMigrationEntry[]) {
    if (entries.length === 0) throw new Error('迁移登记不能为空');
    const sorted = [...entries].sort((left, right) => left.version - right.version);
    const seen = new Set<number>();
    const migrations: RegisteredMigration[] = [];
    for (const [index, entry] of sorted.entries()) {
      const expected = index + 1;
      if (entry.version !== expected) {
        throw new Error(`迁移版本必须从 1 连续递增：期望 ${expected}，实际 ${entry.version}`);
      }
      if (seen.has(entry.version)) throw new Error(`迁移版本重复：${entry.version}`);
      if (entry.name.trim() === '') throw new Error(`迁移 ${entry.version} 缺少名称`);
      if (entry.statements.length === 0) throw new Error(`迁移 ${entry.version} 没有语句`);
      seen.add(entry.version);
      migrations.push({ ...entry, checksum: migrationChecksum(entry) });
    }
    this.migrations = migrations;
    this.byVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  }

  /** 登记的最高版本，也是目标版本。 */
  get targetVersion(): number {
    const last = this.migrations[this.migrations.length - 1];
    if (last === undefined) throw new Error('迁移登记不能为空');
    return last.version;
  }

  /** 取一条登记。 */
  entryFor(version: number): RegisteredMigration | undefined {
    return this.byVersion.get(version);
  }

  /** 取一条登记的校验和；未登记时返回空。 */
  checksumFor(version: number): string | undefined {
    return this.byVersion.get(version)?.checksum;
  }

  /** 取一条登记；未登记时抛出，避免静默跳过。 */
  require(version: number): RegisteredMigration {
    const entry = this.byVersion.get(version);
    if (entry === undefined) {
      throw new StorageError(STORAGE_ERROR_CODES.schemaVersionUnknown, `迁移版本 ${version} 没有登记`, {
        version,
        registered: this.targetVersion,
      });
    }
    return entry;
  }
}
