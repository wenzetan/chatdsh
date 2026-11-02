// SYS01-A 存储 schema 登记与写入许可的验收测试。
//
// 覆盖迁移登记表的写入与读回、校验和的独立计算与不一致拒绝、未知较新版本的写入拒绝、
// 待迁移与失败行的写入拒绝。每个测试在 runtime/.run 下分配独立数据根，使用真实 SQLite
// 文件；校验和由测试按定义内容重新计算 SHA-256 后与库里的记录逐字节比对。
//
// 运行：node --test e2e/unit/client-complete-sys01-schema.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { createTelemetryClient } from '../../packages/core/diagnostics/lib/client.js';
import { defaultTelemetryConfig } from '../../packages/core/diagnostics/lib/config.js';
import {
  MigrationRegistry,
  STORAGE_ERROR_CODES,
  SchemaLedger,
  SqliteDatabase,
  StorageError,
  assertSchemaWritable,
  decideSchemaWrites,
  migrationChecksum,
} from '../../gateway/lib/storage/index.js';

/** 固定的写入时刻。 */
const NOW = 1_700_000_000_000;

/** 两份迁移定义：第一份建表，第二份加列。 */
const MIGRATIONS = [
  { version: 1, name: 'initial', statements: ['create table note (id integer primary key, body text not null)'] },
  { version: 2, name: 'note-owner', statements: ['alter table note add column owner text'] },
];

/** 建立关闭遥测导出的真实遥测客户端。 */
function createTelemetry() {
  return createTelemetryClient({
    config: defaultTelemetryConfig({ surface: 'gateway' }),
    component: '@chatdsh/gateway',
    env: { CHATDSH_TELEMETRY: 'off' },
  });
}

/**
 * 在独立数据根里运行一个测试。
 * @param {string} prefix - 数据根前缀。
 * @param {(home: string) => Promise<void> | void} run - 测试主体。
 */
async function withHome(prefix, run) {
  const home = allocateIndependentHome(prefix);
  try {
    await run(home);
  } finally {
    releaseIndependentHome(home);
  }
}

/** 按定义内容重新计算校验和，用于与库里的记录比对。 */
function checksumOf(entry) {
  return createHash('sha256').update([String(entry.version), entry.name, ...entry.statements].join('\u0000'), 'utf8').digest('hex');
}

/** 断言写入许可检查以指定原因码拒绝。 */
function rejectsWithCode(fn, code, label) {
  assert.throws(
    fn,
    (error) => {
      assert.equal(error instanceof StorageError, true, `${label} 应当抛出 StorageError`);
      assert.equal(error.code, code, `${label} 的原因码应当是 ${code}，实际 ${String(error.code)}`);
      return true;
    },
    label,
  );
}

test('schema 登记：写入的版本与校验和可以读回，重启后仍然一致', async () => {
  await withHome('sys01-schema', async (home) => {
    const path = join(home, 'gateway.sqlite');
    const database = new SqliteDatabase(path);
    const ledger = new SchemaLedger(database);
    const registry = new MigrationRegistry(MIGRATIONS);

    assert.equal(registry.targetVersion, 2, '登记的目标版本是最高版本');
    assert.equal(registry.checksumFor(1), checksumOf(MIGRATIONS[0]), '登记表的校验和应当等于定义内容的 SHA-256');
    assert.equal(migrationChecksum(MIGRATIONS[1]), checksumOf(MIGRATIONS[1]));

    const applied = ledger.applyAll(registry, { now: () => NOW });
    assert.deepEqual(applied.map((record) => record.version), [1, 2], '两条迁移按版本顺序应用');
    assert.deepEqual(applied.map((record) => record.checksum), [registry.checksumFor(1), registry.checksumFor(2)]);

    const inspection = ledger.inspect(registry);
    assert.equal(inspection.state, 'current');
    assert.equal(inspection.appliedVersion, 2);
    assert.equal(inspection.registeredVersion, 2);
    assert.deepEqual(inspection.unknownVersions, []);
    assert.deepEqual(inspection.checksumConflicts, []);
    assert.deepEqual(decideSchemaWrites(inspection), { allowed: true, state: 'current' });

    const records = ledger.records();
    assert.deepEqual(
      records.map((record) => [record.version, record.name, record.status]),
      [
        [1, 'initial', 'applied'],
        [2, 'note-owner', 'applied'],
      ],
      '登记表应当逐条记录版本、名称与状态',
    );
    assert.equal(records[0].checksum, checksumOf(MIGRATIONS[0]), '库里的校验和应当与独立计算一致');
    assert.equal(records[1].checksum, checksumOf(MIGRATIONS[1]));
    assert.equal(records[0].appliedAt, NOW);

    // 迁移实际生效：表与列都存在。
    const columns = database.all('select name from pragma_table_info(?)', ['note']);
    assert.deepEqual(columns.map((column) => column.name), ['id', 'body', 'owner']);

    database.close();
    const reopened = new SqliteDatabase(path);
    try {
      const reloaded = new SchemaLedger(reopened).records();
      assert.deepEqual(reloaded, records, '重启后读回的登记记录应当与写入时完全一致');
      assert.equal(new SchemaLedger(reopened).inspect(registry).state, 'current');
    } finally {
      reopened.close();
    }
  });
});

test('校验和与登记不一致时拒绝写入', async () => {
  await withHome('sys01-checksum', async (home) => {
    const telemetry = createTelemetry();
    const database = new SqliteDatabase(join(home, 'gateway.sqlite'));
    try {
      const ledger = new SchemaLedger(database);
      const registry = new MigrationRegistry([MIGRATIONS[0]]);
      ledger.applyAll(registry, { now: () => NOW });
      assert.equal(assertSchemaWritable({ ledger, registry, telemetry }).state, 'current');

      const changed = new MigrationRegistry([
        { version: 1, name: 'initial', statements: ['create table note (id integer primary key, body text not null, tag text)'] },
      ]);
      assert.notEqual(changed.checksumFor(1), registry.checksumFor(1), '定义内容改变必然改变校验和');

      const inspection = ledger.inspect(changed);
      assert.equal(inspection.state, 'checksum-mismatch');
      assert.deepEqual(inspection.checksumConflicts, [
        { version: 1, registered: changed.checksumFor(1), applied: registry.checksumFor(1) },
      ]);

      rejectsWithCode(
        () => assertSchemaWritable({ ledger, registry: changed, telemetry }),
        STORAGE_ERROR_CODES.schemaChecksumMismatch,
        '校验和不一致时的写入许可检查',
      );
      const decision = decideSchemaWrites(inspection);
      assert.equal(decision.allowed, false);
      assert.equal(decision.reason, STORAGE_ERROR_CODES.schemaChecksumMismatch);
    } finally {
      database.close();
      await telemetry.shutdown();
    }
  });
});

test('未知较新 schema 拒绝写入', async () => {
  await withHome('sys01-newer', async (home) => {
    const telemetry = createTelemetry();
    const database = new SqliteDatabase(join(home, 'gateway.sqlite'));
    try {
      const ledger = new SchemaLedger(database);
      const registry = new MigrationRegistry([MIGRATIONS[0]]);
      ledger.applyAll(registry, { now: () => NOW });

      // 由更高版本的程序写入一条本程序没有登记的迁移记录。
      database.run(
        `insert into schema_migrations (version, name, checksum, status, started_at, applied_at, failure_reason)
         values (?, ?, ?, 'applied', ?, ?, null)`,
        [3, 'from-newer-release', 'b'.repeat(64), NOW, NOW],
      );

      const inspection = ledger.inspect(registry);
      assert.equal(inspection.state, 'newer-unknown');
      assert.deepEqual(inspection.unknownVersions, [3], '未登记且高于目标版本的记录应当被列出');
      assert.equal(inspection.appliedVersion, 3);

      rejectsWithCode(
        () => assertSchemaWritable({ ledger, registry, telemetry }),
        STORAGE_ERROR_CODES.schemaVersionUnknown,
        '未知较新 schema 的写入许可检查',
      );
      rejectsWithCode(() => registry.require(3), STORAGE_ERROR_CODES.schemaVersionUnknown, '按版本取未登记的迁移');
    } finally {
      database.close();
      await telemetry.shutdown();
    }
  });
});

test('尚未迁移到登记版本与上一次迁移失败都拒绝写入', async () => {
  await withHome('sys01-pending', async (home) => {
    const telemetry = createTelemetry();
    const registry = new MigrationRegistry(MIGRATIONS);

    const emptyDatabase = new SqliteDatabase(join(home, 'empty.sqlite'));
    try {
      const ledger = new SchemaLedger(emptyDatabase);
      ledger.ensureTable();
      const empty = ledger.inspect(registry);
      assert.equal(empty.state, 'empty');
      assert.deepEqual(decideSchemaWrites(empty), {
        allowed: false,
        state: 'empty',
        reason: STORAGE_ERROR_CODES.schemaVersionPending,
      });
      rejectsWithCode(
        () => assertSchemaWritable({ ledger, registry, telemetry }),
        STORAGE_ERROR_CODES.schemaVersionPending,
        '空库的写入许可检查',
      );
    } finally {
      emptyDatabase.close();
    }

    const pendingDatabase = new SqliteDatabase(join(home, 'pending.sqlite'));
    try {
      const ledger = new SchemaLedger(pendingDatabase);
      ledger.ensureTable();
      ledger.apply(registry.require(1), NOW);
      const pending = ledger.inspect(registry);
      assert.equal(pending.state, 'pending');
      assert.equal(pending.appliedVersion, 1);
      assert.equal(pending.registeredVersion, 2);
      rejectsWithCode(
        () => assertSchemaWritable({ ledger, registry, telemetry }),
        STORAGE_ERROR_CODES.schemaVersionPending,
        '待迁移版本的写入许可检查',
      );

      ledger.fail(registry.require(2), '磁盘空间不足', NOW + 1);
      const failedInspection = ledger.inspect(registry);
      assert.equal(failedInspection.state, 'migration-failed');
      assert.deepEqual(failedInspection.failedVersions, [2]);
      rejectsWithCode(
        () => assertSchemaWritable({ ledger, registry, telemetry }),
        STORAGE_ERROR_CODES.schemaMigrationFailed,
         '存在失败迁移行时的写入许可检查',
      );
    } finally {
      pendingDatabase.close();
      await telemetry.shutdown();
    }
  });
});
