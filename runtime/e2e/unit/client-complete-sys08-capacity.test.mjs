// SYS08 容量报告与资源回收的验收测试。
//
// 真实 SQLite（一万个会话摘要与五万事件的长会话）、真实 HTTP、真实导出与备份任务、真实独立
// 服务进程。阈值在测量之前登记并冻结；容量场景覆盖冷启动、静态壳与业务激活、长会话分页、
// 同时流式会话、事件流订阅、超限上传、慢消费、断线重连、队列恢复、连续副本追赶、导出与备份，
// 逐项保留原始采样、p50、p95、p99、常驻内存峰值、文件描述符、子进程与订阅计数。控制平面的
// 常驻内存与文件描述符从独立进程的 /proc 读取，客户端缓冲区不计入它的预算。
//
// 运行：node --test e2e/unit/client-complete-sys08-capacity.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { createTelemetryClient } from '../../packages/core/diagnostics/lib/client.js';
import { defaultTelemetryConfig } from '../../packages/core/diagnostics/lib/config.js';
import { GatewayStore, ReplicaStore } from '../../gateway/lib/store.js';
import { createRemoteProbe } from '../../gateway/lib/resource-limits/remote.js';
import { call, runCapacityScenarios } from '../../gateway/lib/resource-limits/capacity.js';
import {
  CAPACITY_THRESHOLDS,
  CapacityRecorder,
  sampleProcess,
  SCENARIO_GATES,
} from '../../packages/core/limits/lib/index.js';

/** runtime 根。 */
const RUNTIME = resolve(import.meta.dirname, '../..');
const MiB = 1024 * 1024;
const PROBE = resolve(RUNTIME, 'gateway', 'lib', 'resource-limits', 'probe.js');

/** 关闭遥测导出的真实遥测客户端。 */
function createTelemetry() {
  return createTelemetryClient({
    config: defaultTelemetryConfig({ surface: 'gateway' }),
    component: '@chatdsh/gateway',
    env: { CHATDSH_TELEMETRY: 'off' },
  });
}

/** 用真实 SQLite 事务写入容量基准数据。 */
function seedCapacityData(store) {
  const db = store.handle();
  const now = Date.now();
  db.exec('begin');
  try {
    const insertSession = db.prepare(
      'insert or replace into sessions (session_id, workspace_id, device_id, cwd, kind, created_at, deleted_at) values (?, ?, ?, ?, ?, ?, null)',
    );
    const insertEvent = db.prepare(
      'insert or replace into replica_events (session_id, seq, kind, time, bytes, payload) values (?, ?, ?, ?, ?, ?)',
    );
    const insertWatermark = db.prepare(
      'insert or replace into replica_watermarks (session_id, watermark, updated_at) values (?, ?, ?)',
    );
    for (let index = 0; index < 10_000; index += 1) {
      const sessionId = `sum-${String(index).padStart(4, '0')}`;
      insertSession.run(sessionId, null, index % 2 === 0 ? 'device-a' : 'device-b', `/work/sum/${String(index)}`, 'work', now - index * 1000);
      const payload = JSON.stringify({ type: 'session/title', seq: 0, time: now - index * 1000, data: { title: `会话 ${String(index)}` } });
      insertEvent.run(sessionId, 0, 'session/title', now - index * 1000, Buffer.byteLength(payload), payload);
      insertWatermark.run(sessionId, 0, now);
    }
    insertSession.run('sess-long', null, 'device-a', '/work/long', 'work', now - 86_400_000);
    for (let seq = 0; seq < 50_000; seq += 1) {
      const kind = seq % 2 === 0 ? 'turn/start' : 'turn/end';
      const payload = JSON.stringify({
        type: kind,
        seq,
        time: now - 86_400_000 + seq,
        data: { turn: Math.floor(seq / 2) + 1, reason: { kind: 'completed' } },
      });
      insertEvent.run('sess-long', seq, kind, now - 86_400_000 + seq, Buffer.byteLength(payload), payload);
    }
    insertWatermark.run('sess-long', 49_999, now);
    insertSession.run('sess-export', null, 'device-a', '/work/export', 'work', now - 3_600_000);
    for (let seq = 0; seq < 2000; seq += 1) {
      const kind = seq % 2 === 0 ? 'turn/start' : 'turn/end';
      const payload = JSON.stringify({
        type: kind,
        seq,
        time: now - 3_600_000 + seq,
        data: { turn: Math.floor(seq / 2) + 1, reason: { kind: 'completed' } },
      });
      insertEvent.run('sess-export', seq, kind, now - 3_600_000 + seq, Buffer.byteLength(payload), payload);
    }
    insertWatermark.run('sess-export', 1999, now);
    db.exec('commit');
  } catch (error) {
    db.exec('rollback');
    throw error;
  }
}

/** 读一个进程的常驻内存与文件描述符数。 */
function sampleProcessOf(pid) {
  const status = readFileSync(`/proc/${String(pid)}/status`, 'utf8');
  const match = status.match(/VmRSS:\s+(\d+)\s+kB/);
  const rssBytes = match === null ? 0 : Number.parseInt(match[1], 10) * 1024;
  const fileDescriptors = readdirSync(`/proc/${String(pid)}/fd`).length;
  return { at: Date.now(), rssBytes, heapUsedBytes: 0, externalBytes: 0, fileDescriptors, childProcesses: 0 };
}

/** 起一个真实服务子进程并等它就绪。 */
async function startServerProcess(args) {
  const child = spawn(process.execPath, [PROBE, '--mode=server', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const deadline = Date.now() + 60_000;
  while (!stdout.includes('ready') && child.exitCode === null && Date.now() < deadline) {
    await new Promise((settle) => setTimeout(settle, 30));
  }
  if (!stdout.includes('ready')) {
    child.kill('SIGKILL');
    throw new Error(`服务子进程没有就绪：${stdout}${stderr}`);
  }
  const ready = JSON.parse(stdout.trim().split('\n').pop());
  return { child, ready, stderrOf: () => stderr };
}

/** 让子进程退出。 */
function stopServerProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode });
  return new Promise((settle) => {
    child.once('exit', (code) => settle({ code }));
    child.kill('SIGTERM');
  });
}

/** 等一个进程的文件描述符回落到限值以内。 */
async function waitForDescriptors(pid, limit, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let sample = sampleProcessOf(pid);
  while (sample.fileDescriptors > limit && Date.now() < deadline) {
    await new Promise((settle) => setTimeout(settle, 100));
    sample = sampleProcessOf(pid);
  }
  return sample;
}

/** 在独立数据根里运行一个测试。 */
async function withHome(prefix, run) {
  const home = allocateIndependentHome(prefix);
  const telemetry = createTelemetry();
  try {
    return await run(home, telemetry);
  } finally {
    await telemetry.shutdown();
    releaseIndependentHome(home);
  }
}

test('容量报告逐项满足登记阈值并保留原始采样', async () => {
  await withHome('sys08-capacity', async (home, telemetry) => {
    const store = new GatewayStore(join(home, 'gateway', 'gateway.sqlite'));
    const replica = new ReplicaStore(store.handle());
    store.registerNode({ id: 'device-a', name: 'A 工作站', platform: 'linux', role: 'host', capabilities: ['shell'], tokenHash: 'a'.repeat(64) });
    store.registerNode({ id: 'device-b', name: 'B 笔记本', platform: 'darwin', role: 'executor', capabilities: ['shell'], tokenHash: 'b'.repeat(64) });
    store.touchDevice({ id: 'device-a', origin: 'cli', platform: 'linux', lastSeenAt: Date.now() });
    store.touchDevice({ id: 'device-b', origin: 'desktop', platform: 'darwin', lastSeenAt: Date.now() });
    seedCapacityData(store);
    const keyPath = join(home, 'backup-master.key');
    writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
    chmodSync(keyPath, 0o600);

    const { child, ready } = await startServerProcess([
      `--root=${home}`,
      '--export-session=sess-export',
      '--export-turn-to=1000',
      `--backup-key=${keyPath}`,
    ]);
    const remote = createRemoteProbe(ready.url);
    // 基线在预热之后取：先建立一次真实请求与一次状态轮询，让常驻连接进入基线。
    const warmup = await call(`${ready.url}/healthz`);
    assert.equal(warmup.status, 200);
    await remote.refresh();
    await new Promise((settle) => setTimeout(settle, 300));
    const baseline = sampleProcessOf(child.pid);
    const recorder = new CapacityRecorder({
      thresholds: CAPACITY_THRESHOLDS,
      sample: () => sampleProcessOf(child.pid),
    });
    try {
      assert.equal(Object.isFrozen(CAPACITY_THRESHOLDS), true, '阈值必须在测量之前冻结');
      assert.ok(recorder.registeredAt <= Date.now(), '阈值登记时刻必须早于测量');
      const deviceIds = Array.from({ length: 100 }, (_unused, index) => `dev-${String(index).padStart(3, '0')}`);
      const reports = await runCapacityScenarios({
        baseUrl: ready.url,
        dataRoot: home,
        recorder,
        sessionId: 'sess-long',
        deviceIds,
        dispatchSamplesMs: () => remote.dispatchSamplesMs(),
        resetDispatchSamples: () => remote.resetDispatchSamples(),
        subscriptionCount: () => remote.subscriptionCount(),
        repeats: 5,
      });

      assert.equal(reports.length, 12, '十二个场景都必须产出报告');
      assert.deepEqual(
        reports.map((report) => report.scenario).sort(),
        [...new Set(SCENARIO_GATES.map((gate) => gate.scenario))].sort(),
        '场景必须覆盖登记门槛的全部场景',
      );
      const lines = [];
      for (const report of reports) {
        assert.ok(report.samplesMs.length > 0, `${report.scenario} 缺少原始采样`);
        assert.equal(report.distribution.count, report.samplesMs.length);
        for (const key of ['p50', 'p95', 'p99']) {
          assert.equal(Number.isFinite(report.distribution[key]), true, `${report.scenario} 缺少 ${key}`);
        }
        assert.ok(Number.isFinite(report.process.rssPeakBytes) && report.process.rssPeakBytes > 0);
        assert.ok(Number.isInteger(report.process.fileDescriptorPeak) && report.process.fileDescriptorPeak > 0);
        assert.ok(Number.isInteger(report.process.childProcessPeak));
        assert.ok(Number.isInteger(report.subscriptions.peak));
        assert.ok(report.startedAt >= recorder.registeredAt, `${report.scenario} 的测量必须晚于阈值登记`);
        assert.equal(report.passed, true, `${report.scenario} 未满足登记阈值：${JSON.stringify(report.breaches)}`);
        lines.push([
          report.scenario,
          `样本 ${String(report.distribution.count)}`,
          `p50 ${report.distribution.p50.toFixed(2)}ms`,
          `p95 ${report.distribution.p95.toFixed(2)}ms`,
          `p99 ${report.distribution.p99.toFixed(2)}ms`,
          `RSS 峰值 ${(report.process.rssPeakBytes / MiB).toFixed(1)}MiB`,
          `描述符 ${String(report.process.fileDescriptorBaseline)}→${String(report.process.fileDescriptorPeak)}`,
          `订阅 ${String(report.subscriptions.peak)}→${String(report.subscriptions.final)}`,
        ].join(' | '));
      }
      console.log('容量报告（阈值取系统完成设计第九节，测量之前登记；控制平面为独立进程）');
      for (const line of lines) console.log(`  ${line}`);

      const reconnect = reports.find((report) => report.scenario === 'reconnect');
      assert.equal(reconnect.subscriptions.final, 0, '一百次切换之后订阅必须回到基线');
      const slow = reports.find((report) => report.scenario === 'slow-consumer');
      assert.ok(
        slow.distribution.p95 <= CAPACITY_THRESHOLDS.deviceEventAttachMs,
        `慢消费期间其他设备的事件附加延迟 p95 ${slow.distribution.p95.toFixed(2)} 毫秒超过门槛`,
      );
      const shell = reports.find((report) => report.scenario === 'shell-static');
      assert.ok(shell.distribution.p95 <= CAPACITY_THRESHOLDS.staticShellColdLoadMs);
      const list = reports.find((report) => report.scenario === 'business-activation');
      assert.ok(list.distribution.p95 <= CAPACITY_THRESHOLDS.listFirstScreenMs);
      const history = reports.find((report) => report.scenario === 'long-session-pagination');
      assert.ok(history.distribution.p95 <= CAPACITY_THRESHOLDS.largeHistoryFirstSegmentMs);

      await remote.refresh();
      const state = remote.state();
      assert.equal(state.subscribers, 0, '全部场景结束后不得残留订阅');
      assert.equal(state.sseConnections, 0, '全部场景结束后不得残留事件流连接');
      assert.equal(state.queuedItems, 0, '全部场景结束后分发队列必须清空');

      // 轮询与长连接都要收起，等描述符回落到登记容差以内再判定。
      remote.close();
      const after = await waitForDescriptors(
        child.pid,
        baseline.fileDescriptors + CAPACITY_THRESHOLDS.fileDescriptorTolerance,
        15_000,
      );
      assert.ok(
        after.fileDescriptors <= baseline.fileDescriptors + CAPACITY_THRESHOLDS.fileDescriptorTolerance,
        `文件描述符没有回到基线：${String(baseline.fileDescriptors)} → ${String(after.fileDescriptors)}`,
      );
      // 全部负载之后控制平面仍在绝对预算内；切换风暴的增长率由 reconnect 场景单独判定。
      assert.ok(
        after.rssBytes <= CAPACITY_THRESHOLDS.controlPlaneRssBytes,
        `控制平面常驻内存 ${(after.rssBytes / MiB).toFixed(1)}MiB 超过登记预算 ${(CAPACITY_THRESHOLDS.controlPlaneRssBytes / MiB).toFixed(0)}MiB`,
      );
      const reconnectGrowth = (reconnect.process.rssPeakBytes - reconnect.process.rssBaselineBytes) / reconnect.process.rssBaselineBytes;
      assert.ok(
        reconnectGrowth <= CAPACITY_THRESHOLDS.rssGrowthRatio,
        `一百次切换期间常驻内存增长 ${(reconnectGrowth * 100).toFixed(1)}% 超过登记容差`,
      );

      assert.throws(
        () => recorder.assertSafeLoad(CAPACITY_THRESHOLDS.controlPlaneRssBytes + 1, 20),
        (error) => {
          assert.equal(error.rejection.code, 'resource-budget-exceeded');
          assert.equal(error.rejection.status, 503);
          assert.equal(error.rejection.entry, 'later-retry');
          return true;
        },
        '超出安全资源预算时必须拒绝开始验证',
      );
    } finally {
      remote.close();
      await stopServerProcess(child);
    }
  });
});

test('终止真实子进程之后资源回到登记容差内', async () => {
  await withHome('sys08-capacity-recovery', async (home) => {
    const baseline = sampleProcess();
    const child = spawn(process.execPath, [PROBE, '--mode=load', `--root=${home}`, '--streams=12', '--uploads=20'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    try {
      const deadline = Date.now() + 60_000;
      while (!stdout.includes('ready') && Date.now() < deadline) {
        await new Promise((settle) => setTimeout(settle, 50));
      }
      assert.ok(stdout.includes('ready'), `负载子进程没有就绪：${stdout}`);
      const ready = JSON.parse(stdout.trim().split('\n').pop());
      assert.equal(ready.ready, true);
      assert.ok(ready.rss > 0);
      const loaded = sampleProcessOf(child.pid);
      assert.ok(loaded.rssBytes >= 8 * MiB, `负载子进程常驻内存异常：${String(loaded.rssBytes)}`);
      assert.ok(loaded.fileDescriptors >= 12, `负载子进程必须持有打开的事件流：${String(loaded.fileDescriptors)}`);

      const result = await stopServerProcess(child);
      assert.equal(result.code, 0, `负载子进程必须以零退出码结束：${JSON.stringify(result)}`);

      let restored = sampleProcess();
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (restored.fileDescriptors <= baseline.fileDescriptors + CAPACITY_THRESHOLDS.fileDescriptorTolerance) break;
        await new Promise((settle) => setTimeout(settle, 100));
        restored = sampleProcess();
      }
      assert.ok(
        restored.fileDescriptors <= baseline.fileDescriptors + CAPACITY_THRESHOLDS.fileDescriptorTolerance,
        `父进程文件描述符没有回到容差内：${String(baseline.fileDescriptors)} → ${String(restored.fileDescriptors)}`,
      );
      assert.equal(restored.childProcesses, baseline.childProcesses, '父进程不得残留子进程');
      const growth = (restored.rssBytes - baseline.rssBytes) / baseline.rssBytes;
      assert.ok(
        growth <= CAPACITY_THRESHOLDS.rssGrowthRatio,
        `父进程常驻内存增长 ${(growth * 100).toFixed(1)}% 超过登记容差`,
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });
});
