// SYS08 背压与公平调度的验收测试。
//
// 真实 SQLite、真实 HTTP 长连接与独立数据根。一条读得慢的订阅不能拖住其他订阅：快订阅在慢
// 订阅被挂起期间照常收完事件，附加延迟在登记门槛之内；慢订阅的排队超过额度时被明确终止并
// 收到带错误码与续读游标的帧，权威副本里的内容不受影响，重连后按游标补齐。导出与备份的并发
// 与队列都满时返回 429 与稍后重试入口，已受理的任务全部完成。事件流连接按访问会话计数，
// 第五条被拒绝并指向复用现有连接。关停时进行中的任务收到中止信号，连接与排队回到基线。
//
// 运行：node --test e2e/unit/client-complete-sys08-backpressure.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { join, resolve } from 'node:path';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { createTelemetryClient } from '../../packages/core/diagnostics/lib/client.js';
import { defaultTelemetryConfig } from '../../packages/core/diagnostics/lib/config.js';
import { GatewayStore, ReplicaStore } from '../../gateway/lib/store.js';
import { startResourceLimitServer } from '../../gateway/lib/resource-limits/server.js';
import { CAPACITY_THRESHOLDS, RESOURCE_LIMITS, summarize } from '../../packages/core/limits/lib/index.js';

/** runtime 根。 */
const RUNTIME = resolve(import.meta.dirname, '../..');

/** 关闭遥测导出的真实遥测客户端。 */
function createTelemetry() {
  return createTelemetryClient({
    config: defaultTelemetryConfig({ surface: 'gateway' }),
    component: '@chatdsh/gateway',
    env: { CHATDSH_TELEMETRY: 'off' },
  });
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

/** 建立真实存储与服务。 */
async function startServer(home, telemetry, jobs = {}) {
  const store = new GatewayStore(join(home, 'gateway', 'gateway.sqlite'));
  const replica = new ReplicaStore(store.handle());
  const now = Date.now();
  store.registerNode({ id: 'device-a', name: 'A 工作站', platform: 'linux', role: 'host', capabilities: ['shell'], tokenHash: 'a'.repeat(64) });
  store.touchDevice({ id: 'device-a', origin: 'cli', platform: 'linux', lastSeenAt: now });
  store.upsertSession({ sessionId: 'sess-alpha', deviceId: 'device-a', cwd: '/work/alpha', kind: 'work', createdAt: now });
  const server = await startResourceLimitServer({
    store,
    replica,
    telemetry,
    jobs: {
      export: jobs.export ?? (async () => ({ jobId: 'export-probe', bytes: 1 })),
      backup: jobs.backup ?? (async () => ({ objects: 1, bytes: 1 })),
    },
  });
  return { store, replica, server };
}

/** 打开一条事件流。 */
function openStream(url, onFrame, onClose) {
  return new Promise((settle, fail) => {
    const request = httpRequest(url, (response) => {
      let buffer = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        buffer += chunk;
        let index = buffer.indexOf('\n\n');
        while (index >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          onFrame(frame);
          index = buffer.indexOf('\n\n');
        }
      });
      response.on('close', onClose);
      response.on('error', onClose);
      const stream = {
        response,
        close: () => {
          request.destroy();
        },
      };
      OPEN_STREAMS.add(stream);
      settle(stream);
    });
    request.on('error', (error) => {
      onClose();
      fail(error);
    });
    request.end();
  });
}

/** 未关闭的事件流，测试失败时也要关闭，避免残留句柄拖住进程。 */
const OPEN_STREAMS = new Set();

/** 关闭本用例打开的全部事件流。 */
function closeAllStreams() {
  for (const stream of OPEN_STREAMS) stream.close();
  OPEN_STREAMS.clear();
}

/** 等待条件成立。 */
async function waitUntil(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((settle) => setTimeout(settle, 20));
  }
  throw new Error(`等待超时：${label}`);
}

/** 上报一条事件。 */
async function postEvent(baseUrl, sessionId, seq, payload) {
  const response = await fetch(`${baseUrl}/chatdsh/gateway/resource/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, events: [{ seq, kind: 'turn/start', time: Date.now(), payload }] }),
  });
  if (response.status !== 200) throw new Error(`事件上报返回 ${String(response.status)}：${await response.text()}`);
  return response.json();
}

test('慢消费不阻塞其他设备，超预算时明确终止并可从游标补齐', async () => {
  await withHome('sys08-backpressure-fair', async (home, telemetry) => {
    const { server } = await startServer(home, telemetry);
    try {
      const devices = ['dev-fast-1', 'dev-fast-2', 'dev-fast-3', 'dev-slow'];
      const target = 'sess-fair';
      const frames = new Map(devices.map((device) => [device, 0]));
      const slowFrames = [];
      const streams = [];
      for (const device of devices.slice(0, 3)) {
        streams.push(await openStream(
          `${server.url}/chatdsh/gateway/fanout/${device}?session=${target}&since=-1`,
          (frame) => {
            if (frame.startsWith('data:')) frames.set(device, frames.get(device) + 1);
          },
          () => undefined,
        ));
      }
      const slowStream = await openStream(
        `${server.url}/chatdsh/gateway/fanout/dev-slow?session=${target}&since=-1`,
        (frame) => {
          slowFrames.push(frame);
        },
        () => undefined,
      );
      slowStream.response.pause();
      await waitUntil(() => server.fanout.subscriberCount === 4, 5000, '订阅登记');
      server.fanout.resetSamples();
      const burst = 500;
      const published = [];
      for (let index = 0; index < burst; index += 1) {
        await postEvent(server.url, target, index, { text: 'y'.repeat(32 * 1024) });
        published.push(index);
      }
      await waitUntil(() => devices.slice(0, 3).every((device) => frames.get(device) >= burst), 20_000, '快订阅收帧');
      const latency = summarize([...server.fanout.dispatchSamplesMs()]);
      assert.ok(
        latency.p95 <= CAPACITY_THRESHOLDS.deviceEventAttachMs,
        `事件附加延迟 p95 ${latency.p95.toFixed(2)} 毫秒超过门槛 ${CAPACITY_THRESHOLDS.deviceEventAttachMs}`,
      );
      const snapshot = server.fanout.snapshot();
      const slowState = snapshot.find((entry) => entry.id === 'dev-slow');
      assert.ok(slowState === undefined || slowState.terminated === true, '慢订阅必须被终止并摘除');
      for (const device of devices.slice(0, 3)) {
        const state = snapshot.find((entry) => entry.id === device);
        assert.ok(state !== undefined, `快订阅 ${device} 必须仍在分发状态里`);
        assert.equal(state.terminated, false, `快订阅 ${device} 必须保持在线`);
        assert.equal(state.suspended, false, `快订阅 ${device} 不得被挂起`);
      }

      slowStream.response.resume();
      await waitUntil(() => slowFrames.some((frame) => frame.includes('backpressure-exceeded')), 20_000, '慢订阅终止帧');
      const errorFrame = slowFrames.find((frame) => frame.includes('backpressure-exceeded'));
      const errorData = JSON.parse(errorFrame.split('\ndata: ')[1]);
      assert.equal(errorData.error, 'backpressure-exceeded');
      assert.equal(errorData.entry, 'resume-cursor');
      assert.equal(typeof errorData.sinceSeq, 'number');
      assert.equal(errorData.kind, 'sse-buffer');
      assert.equal(errorData.limit, RESOURCE_LIMITS['sse-buffer'].value);

      let seen = 0;
      let after = -1;
      for (let page = 0; page < 100; page += 1) {
        const body = await (await fetch(`${server.url}/chatdsh/gateway/sessions/${target}/events?after=${String(after)}&limit=200`)).json();
        seen += body.count;
        if (body.nextAfter === null) break;
        after = body.nextAfter;
      }
      assert.equal(seen, burst, '权威事件不得因为背压丢失');

      let lastSeq = -1;
      for (const frame of slowFrames) {
        if (!frame.startsWith('data:')) continue;
        const parsed = JSON.parse(frame.slice('data:'.length).trim());
        if (typeof parsed.seq === 'number') lastSeq = Math.max(lastSeq, parsed.seq);
      }
      const resumeFrom = lastSeq;
      const replayed = [];
      const resumeStream = await openStream(
        `${server.url}/chatdsh/gateway/fanout/dev-slow?session=${target}&since=${String(resumeFrom)}`,
        (frame) => {
          if (!frame.startsWith('data:')) return;
          const parsed = JSON.parse(frame.slice('data:'.length).trim());
          if (typeof parsed.seq === 'number') replayed.push(parsed.seq);
        },
        () => undefined,
      );
      await waitUntil(() => replayed.length > 0, 10_000, '慢订阅续读首帧');
      let stable = -1;
      while (stable !== replayed.length) {
        stable = replayed.length;
        await new Promise((settle) => setTimeout(settle, 150));
      }
      assert.ok(replayed.length <= 200, '补发条数必须受分页上限约束');
      assert.ok(replayed[0] >= lastSeq + 1, '续读不得重复已经收到的序号');
      assert.ok(replayed[0] <= errorData.sinceSeq + 1, '续读不得跳过尚未收到的事件');
      for (let index = 0; index < replayed.length; index += 1) {
        assert.equal(replayed[index], replayed[0] + index, '续读必须按序号连续');
      }
      resumeStream.close();
      for (const stream of streams) stream.close();
      slowStream.close();
      await waitUntil(() => server.fanout.subscriberCount === 0, 5000, '订阅清空');
      assert.equal(server.fanout.totalQueuedItems(), 0, '终止与断开之后排队必须清空');
    } finally {
      closeAllStreams();
      await server.close();
    }
  });
});

test('并发与队列都满时明确拒绝，已受理任务全部完成', async () => {
  await withHome('sys08-backpressure-queue', async (home, telemetry) => {
    let running = 0;
    let peakRunning = 0;
    let releaseExports;
    let releaseBackups;
    const exportGate = new Promise((settle) => {
      releaseExports = settle;
    });
    const backupGate = new Promise((settle) => {
      releaseBackups = settle;
    });
    const { server } = await startServer(home, telemetry, {
      export: async () => {
        running += 1;
        peakRunning = Math.max(peakRunning, running);
        await exportGate;
        running -= 1;
        return { jobId: `job-${String(Date.now())}`, bytes: 128 };
      },
      backup: async () => {
        await backupGate;
        return { objects: 1, bytes: 64 };
      },
    });
    try {
      const accepted = RESOURCE_LIMITS['export-concurrency'].value + RESOURCE_LIMITS['export-queue'].value;
      const attempts = accepted + 3;
      const pending = Array.from({ length: attempts }, () => fetch(`${server.url}/chatdsh/gateway/resource/export`, { method: 'POST' }));
      await waitUntil(
        () => server.snapshot().exportAdmission.running === RESOURCE_LIMITS['export-concurrency'].value
          && server.snapshot().exportAdmission.queued === RESOURCE_LIMITS['export-queue'].value,
        5000,
        '导出并发与队列占满',
      );
      releaseExports();
      const responses = await Promise.all(pending);
      const statuses = responses.map((response) => response.status);
      assert.equal(statuses.filter((status) => status === 200).length, accepted, `受理数量必须是 ${String(accepted)}：${statuses.join(',')}`);
      assert.equal(statuses.filter((status) => status === 429).length, attempts - accepted, `拒绝数量必须是 ${String(attempts - accepted)}`);
      for (const response of responses) {
        if (response.status !== 429) {
          await response.text();
          continue;
        }
        assert.equal(response.headers.get('retry-after'), '1', '限流拒绝必须带重试间隔');
        const body = await response.json();
        assert.equal(body.error, 'queue-full');
        assert.equal(body.entry, 'queued-retry');
        assert.equal(body.kind, 'export-queue');
        assert.equal(body.limit, RESOURCE_LIMITS['export-queue'].value);
        assert.ok(body.guidance.length > 0);
      }
      await server.governor.exportQueue.idle();
      const stats = server.stats();
      assert.equal(stats.exportsCompleted, accepted, '已受理的导出必须全部完成');
      assert.equal(peakRunning, RESOURCE_LIMITS['export-concurrency'].value, '同时执行的导出不得超过并发上限');
      const snapshot = server.snapshot();
      assert.equal(snapshot.exportAdmission.running, 0);
      assert.equal(snapshot.exportAdmission.queued, 0);

      const backupAccepted = RESOURCE_LIMITS['backup-concurrency'].value + RESOURCE_LIMITS['backup-queue'].value;
      const pendingBackups = Array.from({ length: backupAccepted + 1 }, () => fetch(`${server.url}/chatdsh/gateway/resource/backup`, { method: 'POST' }));
      await waitUntil(
        () => server.snapshot().backupAdmission.running === RESOURCE_LIMITS['backup-concurrency'].value
          && server.snapshot().backupAdmission.queued === RESOURCE_LIMITS['backup-queue'].value,
        5000,
        '备份并发与队列占满',
      );
      releaseBackups();
      const backups = await Promise.all(pendingBackups);
      const backupStatuses = backups.map((response) => response.status);
      assert.equal(backupStatuses.filter((status) => status === 200).length, backupAccepted);
      assert.equal(backupStatuses.filter((status) => status === 429).length, 1);
      for (const response of backups) await response.text();
      await server.governor.backupQueue.idle();
      assert.equal(server.stats().backupsCompleted, backupAccepted);
    } finally {
      closeAllStreams();
      await server.close();
    }
  });
});

test('事件流连接按访问会话计数，第五条被拒绝并指向复用', async () => {
  await withHome('sys08-backpressure-sse', async (home, telemetry) => {
    const { server } = await startServer(home, telemetry);
    try {
      const streams = [];
      for (let index = 0; index < RESOURCE_LIMITS['sse-connection'].value; index += 1) {
        streams.push(await openStream(`${server.url}/chatdsh/gateway/resource/stream?session=access-a`, () => undefined, () => undefined));
      }
      await waitUntil(() => server.snapshot().sseConnections === RESOURCE_LIMITS['sse-connection'].value, 5000, '事件流登记');
      const fifth = await fetch(`${server.url}/chatdsh/gateway/resource/stream?session=access-a`);
      assert.equal(fifth.status, 429);
      const body = await fifth.json();
      assert.equal(body.error, 'subscription-limit');
      assert.equal(body.kind, 'sse-connection');
      assert.equal(body.unit, 'items');
      assert.equal(body.limit, RESOURCE_LIMITS['sse-connection'].value);
      assert.equal(body.observed, RESOURCE_LIMITS['sse-connection'].value + 1);
      assert.equal(body.entry, 'existing-connection');
      assert.equal(body.open, RESOURCE_LIMITS['sse-connection'].value);

      const other = await openStream(`${server.url}/chatdsh/gateway/resource/stream?session=access-b`, () => undefined, () => undefined);
      await waitUntil(() => server.snapshot().sseConnections === RESOURCE_LIMITS['sse-connection'].value + 1, 5000, '另一会话登记');
      other.close();
      await waitUntil(() => server.snapshot().sseConnections === RESOURCE_LIMITS['sse-connection'].value, 5000, '另一会话断开');

      streams[0].close();
      await waitUntil(() => server.snapshot().sseConnections === RESOURCE_LIMITS['sse-connection'].value - 1, 5000, '释放配额');
      const replaced = await openStream(`${server.url}/chatdsh/gateway/resource/stream?session=access-a`, () => undefined, () => undefined);
      await waitUntil(() => server.snapshot().sseConnections === RESOURCE_LIMITS['sse-connection'].value, 5000, '重新占满配额');
      replaced.close();
      for (const stream of streams.slice(1)) stream.close();
      await waitUntil(() => server.snapshot().sseConnections === 0, 5000, '事件流清空');
      assert.equal(server.snapshot().sseSessions, 0, '断开之后访问会话计数必须回到零');
    } finally {
      closeAllStreams();
      await server.close();
    }
  });
});

test('关停中止进行中的任务并释放连接与排队', async () => {
  await withHome('sys08-backpressure-cancel', async (home, telemetry) => {
    let aborted = false;
    let started = false;
    const { server } = await startServer(home, telemetry, {
      export: async (signal) => {
        started = true;
        await new Promise((settle) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            settle();
          }, { once: true });
          setTimeout(settle, 5000);
        });
        return { jobId: 'job-cancelled', bytes: 0 };
      },
    });
    const streams = [];
    const pending = fetch(`${server.url}/chatdsh/gateway/resource/export`, { method: 'POST' }).catch(() => undefined);
    try {
      await waitUntil(() => started, 5000, '导出开始');
      streams.push(await openStream(`${server.url}/chatdsh/gateway/resource/stream?session=access-cancel`, () => undefined, () => undefined));
      await waitUntil(() => server.snapshot().sseConnections === 1, 5000, '关停前连接');
      await server.close();
      await pending;
      assert.equal(aborted, true, '关停必须让进行中的任务收到中止信号');
      assert.equal(server.snapshot().sseConnections, 0);
      assert.equal(server.snapshot().exportAdmission.running, 0);
      assert.equal(server.fanout.subscriberCount, 0);
    } finally {
      closeAllStreams();
      await server.close();
      for (const stream of streams) stream.close();
    }
  });
});
