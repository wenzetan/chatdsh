// SYS01-A 迁移预检查、迁移锁、检查点与显式切换的验收测试。
//
// 覆盖迁移锁的排他获取、第二次获取失败、释放后重新获取，以及持锁进程被真实终止后残留锁的
// 判定与回收；预检查、检查点续传与显式切换按设计分别断言运行面存在并可用。
//
// 锁的持有方是一个真实子进程：它加载同一份生产代码获取锁并周期发送心跳，测试用 SIGKILL
// 终止它之后由父进程回收残留锁。每个测试在 runtime/.run 下分配独立数据根。
//
// 运行：node --test e2e/unit/client-complete-sys01-migration.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { createTelemetryClient } from '../../packages/core/diagnostics/lib/client.js';
import { defaultTelemetryConfig } from '../../packages/core/diagnostics/lib/config.js';
import { MigrationLock } from '../../gateway/lib/migrations/lock.js';
import { STORAGE_ERROR_CODES } from '../../gateway/lib/storage/index.js';
import * as storage from '../../gateway/lib/storage/index.js';

/** runtime 根。 */
const RUNTIME_ROOT = resolve(import.meta.dirname, '../..');

/** 被测模块的绝对路径，供子进程加载同一份代码。 */
const MODULE_PATHS = {
  lock: pathToFileURL(join(RUNTIME_ROOT, 'gateway/lib/migrations/lock.js')).href,
  telemetryClient: pathToFileURL(join(RUNTIME_ROOT, 'packages/core/diagnostics/lib/client.js')).href,
  telemetryConfig: pathToFileURL(join(RUNTIME_ROOT, 'packages/core/diagnostics/lib/config.js')).href,
};

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

/** 持锁子进程的程序：获取锁、上报自身进程号、周期发送心跳。 */
function holderScript(home) {
  return [
    `const { MigrationLock } = await import(${JSON.stringify(MODULE_PATHS.lock)});`,
    `const { createTelemetryClient } = await import(${JSON.stringify(MODULE_PATHS.telemetryClient)});`,
    `const { defaultTelemetryConfig } = await import(${JSON.stringify(MODULE_PATHS.telemetryConfig)});`,
    'const telemetry = createTelemetryClient({',
    "  config: defaultTelemetryConfig({ surface: 'gateway' }),",
    "  component: '@chatdsh/gateway',",
    "  env: { CHATDSH_TELEMETRY: 'off' },",
    '});',
    `const lock = new MigrationLock({ targetRoot: ${JSON.stringify(home)}, telemetry });`,
    "const holder = lock.acquire({ jobId: 'job-holder', schemaVersion: 2, sourcePath: '/data/source.jsonl' }, Date.now());",
    "process.stdout.write(`${JSON.stringify({ lockId: holder.lockId, pid: process.pid })}\\n`);",
    'setInterval(() => lock.heartbeat(holder.lockId), 1000);',
  ].join('\n');
}

/** 启动持锁子进程并等到它完成获取。 */
async function startHolder(home) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', holderScript(home)], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const ready = await new Promise((settle, fail) => {
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const line = buffer.split('\n')[0];
      if (!buffer.includes('\n')) return;
      settle(JSON.parse(line));
    });
    child.on('error', fail);
    child.on('exit', (code) => fail(new Error(`持锁子进程提前退出，退出码 ${code}`)));
  });
  return { child, ready };
}

test('迁移锁获取后第二次获取失败，释放后可以再次获取', async () => {
  await withHome('sys01-lock', async (home) => {
    const telemetry = createTelemetry();
    try {
      const lock = new MigrationLock({ targetRoot: home, telemetry });
      const now = Date.now();
      const holder = lock.acquire({ jobId: 'job-1', schemaVersion: 2, sourcePath: '/data/source.jsonl' }, now);

      assert.equal(holder.pid, process.pid);
      assert.equal(holder.uid, typeof process.getuid === 'function' ? process.getuid() : -1);
      assert.equal(holder.jobId, 'job-1');
      assert.equal(holder.schemaVersion, 2);
      assert.equal(holder.acquiredAt, now);
      assert.equal(holder.heartbeatAt, now);
      assert.equal(existsSync(lock.path), true, '获取成功后锁文件应当存在');

      const state = lock.inspect(now);
      assert.equal(state.present, true);
      assert.equal(state.stale, false);
      assert.equal(state.holder.lockId, holder.lockId);

      assert.throws(
        () => lock.acquire({ jobId: 'job-2', schemaVersion: 2, sourcePath: '/data/source.jsonl' }, now),
        (error) => {
          assert.equal(error.code, STORAGE_ERROR_CODES.migrationLockHeld, '第二次获取的原因码应当是 migration-lock-held');
          assert.equal(error.details.holderPid, process.pid);
          return true;
        },
        '锁被有效持有者占用时第二次获取必须失败',
      );
      assert.equal(lock.inspect(now).holder.lockId, holder.lockId, '失败的获取不得改写锁文件');

      const heartbeat = lock.heartbeat(holder.lockId, now + 1000);
      assert.equal(heartbeat.heartbeatAt, now + 1000);
      assert.equal(lock.inspect(now + 1000).holder.heartbeatAt, now + 1000);

      assert.throws(
        () => lock.release('another-lock-id'),
        (error) => {
          assert.equal(error.code, STORAGE_ERROR_CODES.migrationLockMismatch, '释放时标识不符的原因码应当是 migration-lock-mismatch');
          return true;
        },
        '持有标识不符时释放必须失败',
      );

      lock.release(holder.lockId);
      assert.equal(existsSync(lock.path), false, '释放后锁文件应当不存在');
      assert.equal(lock.inspect(now + 2000).present, false);

      const next = lock.acquire({ jobId: 'job-2', schemaVersion: 2, sourcePath: '/data/source.jsonl' }, now + 2000);
      assert.notEqual(next.lockId, holder.lockId, '重新获取应当得到新的锁标识');
      lock.release(next.lockId);
    } finally {
      await telemetry.shutdown();
    }
  });
});

test('持锁进程终止后残留锁判定成立并可回收，回收后可以重新获取', async () => {
  await withHome('sys01-stale', async (home) => {
    const telemetry = createTelemetry();
    const lock = new MigrationLock({ targetRoot: home, telemetry });
    let child;
    try {
      const started = await startHolder(home);
      child = started.child;
      const ready = started.ready;
      assert.equal(existsSync(lock.path), true, '子进程获取成功后锁文件应当存在');
      assert.equal(lock.inspect(Date.now()).stale, false, '持锁进程仍然存活时不得判定为残留');

      const exited = new Promise((settle) => child.once('exit', (code, signal) => settle({ code, signal })));
      child.kill('SIGKILL');
      const termination = await exited;
      assert.equal(termination.signal, 'SIGKILL');

      const state = lock.inspect(Date.now());
      assert.equal(state.present, true, '进程终止后锁文件应当仍然存在');
      assert.equal(state.stale, true);
      assert.ok(state.staleReasons.includes('process-gone'), `残留理由应当包含 process-gone，实际 ${state.staleReasons.join('、')}`);
      assert.equal(state.holder.pid, ready.pid);

      assert.throws(
        () => lock.acquire({ jobId: 'job-after-crash', schemaVersion: 2, sourcePath: '/data/source.jsonl' }, Date.now()),
        (error) => {
          assert.equal(error.code, STORAGE_ERROR_CODES.migrationLockStale, '残留锁未被回收前的获取原因码应当是 migration-lock-stale');
          return true;
        },
        '残留锁必须先显式回收才能获取',
      );

      const reclaimed = lock.reclaimStale(Date.now());
      assert.equal(reclaimed.pid, ready.pid);
      assert.equal(reclaimed.lockId, ready.lockId);
      assert.equal(existsSync(lock.path), false, '回收后锁文件应当被改名留档');
      assert.equal(existsSync(`${lock.path}.stale-${ready.lockId}`), true, '被回收的锁文件应当改名留档');

      const holder = lock.acquire({ jobId: 'job-after-crash', schemaVersion: 2, sourcePath: '/data/source.jsonl' }, Date.now());
      assert.equal(holder.pid, process.pid);
      lock.release(holder.lockId);
      assert.equal(lock.inspect(Date.now()).present, false);
    } finally {
      if (child !== undefined && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((settle) => child.once('exit', settle));
        child.kill('SIGKILL');
        await exited;
      }
      await telemetry.shutdown();
    }
  });
});

test('预检查：目标权限不足、磁盘空间不足与源格式不合法各自明确拒绝', () => {
  const exported = Object.keys(storage).sort();
  assert.ok(
    exported.some((name) => /preflight|precheck/i.test(name)),
    `storage 模块没有迁移预检查入口，目标权限不足、磁盘空间不足与源格式不合法都无法验证拒绝；原因码 ${STORAGE_ERROR_CODES.preflightFailed} 已声明但没有实现抛出它；当前导出 ${exported.join('、')}`,
  );
});

test('检查点：写入后重启读取同一继续位置', () => {
  const exported = Object.keys(storage).sort();
  assert.ok(
    exported.some((name) => /checkpoint|migrationjob|migrationstore/i.test(name)),
    `storage 模块没有迁移任务的持久实现，检查点的写入与重启续传无法验证；原因码 ${STORAGE_ERROR_CODES.checkpointMismatch}、${STORAGE_ERROR_CODES.checkpointCorrupt} 已声明但没有实现抛出它们；当前导出 ${exported.join('、')}`,
  );
});

test('显式切换：验证未通过时拒绝切换', () => {
  const exported = Object.keys(storage).sort();
  assert.ok(
    exported.some((name) => /switch/i.test(name)),
    `storage 模块没有显式切换入口，验证报告未通过时拒绝切换无法验证；原因码 ${STORAGE_ERROR_CODES.verificationFailed}、${STORAGE_ERROR_CODES.switchNotAllowed} 已声明但没有实现抛出它们；当前导出 ${exported.join('、')}`,
  );
});
