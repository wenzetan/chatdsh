// SYS08 资源限制与背压的遥测验收。
//
// 用真实的 OTLP/HTTP 收集器接收控制平面遥测客户端导出的信号。先跑一遍真实限制动作（受额度
// 通过的读取、超限拒绝、并发与队列拒绝、慢消费终止、容量场景），检查 span、失败事件、计数
// 与直方图都存在，且属性里没有请求体原文、会话标识与文件路径。随后关闭遥测再跑同样的拒绝，
// 确认限制语义不依赖遥测、且没有任何新信号离开进程。
//
// 运行：node --test e2e/unit/client-complete-sys08-telemetry.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { join, resolve } from 'node:path';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { createTelemetryClient } from '../../packages/core/diagnostics/lib/client.js';
import { defaultTelemetryConfig } from '../../packages/core/diagnostics/lib/config.js';
import { GatewayStore, ReplicaStore } from '../../gateway/lib/store.js';
import { startResourceLimitServer } from '../../gateway/lib/resource-limits/server.js';
import { CapacityRecorder, CAPACITY_THRESHOLDS, RESOURCE_LIMITS } from '../../packages/core/limits/lib/index.js';
import { measureShellStatic } from '../../gateway/lib/resource-limits/capacity.js';

/** runtime 根。 */
const RUNTIME = resolve(import.meta.dirname, '../..');
const MiB = 1024 * 1024;

/** 真实接收 OTLP/HTTP 请求的收集器。 */
async function startCollector() {
  const bodies = { logs: [], traces: [], metrics: [] };
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const signal = request.url?.includes('/v1/logs') ? 'logs' : request.url?.includes('/v1/traces') ? 'traces' : 'metrics';
      if (text !== '') bodies[signal].push(JSON.parse(text));
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{}');
    });
  });
  await new Promise((settle) => server.listen(0, '127.0.0.1', settle));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    records: () => bodies,
    close: () => new Promise((settle) => server.close(settle)),
  };
}

/** 属性列表转对象。 */
function attributesOf(entries) {
  const attributes = {};
  for (const entry of entries ?? []) {
    const value = entry.value ?? {};
    attributes[entry.key] = value.stringValue ?? value.intValue ?? value.boolValue ?? value.doubleValue;
  }
  return attributes;
}

/** 摊平日志。 */
function flattenLogs(payloads) {
  const out = [];
  for (const payload of payloads) {
    for (const resource of payload.resourceLogs ?? []) {
      for (const scope of resource.scopeLogs ?? []) {
        for (const record of scope.logRecords ?? []) {
          out.push({ name: record.body?.stringValue ?? '', attributes: attributesOf(record.attributes), raw: JSON.stringify(record) });
        }
      }
    }
  }
  return out;
}

/** 摊平追踪。 */
function flattenTraces(payloads) {
  const out = [];
  for (const payload of payloads) {
    for (const resource of payload.resourceSpans ?? []) {
      for (const scope of resource.scopeSpans ?? []) {
        for (const span of scope.spans ?? []) {
          out.push({ name: span.name, attributes: attributesOf(span.attributes), raw: JSON.stringify(span) });
        }
      }
    }
  }
  return out;
}

/** 摊平指标。 */
function flattenMetrics(payloads) {
  const out = [];
  for (const payload of payloads) {
    for (const resource of payload.resourceMetrics ?? []) {
      for (const scope of resource.scopeMetrics ?? []) {
        for (const metric of scope.metrics ?? []) {
          const points = metric.sum?.dataPoints ?? metric.gauge?.dataPoints ?? metric.histogram?.dataPoints ?? [];
          for (const point of points) {
            out.push({ name: metric.name, attributes: attributesOf(point.attributes), raw: JSON.stringify(point) });
          }
        }
      }
    }
  }
  return out;
}

/** 建立真实存储与服务。 */
async function startServer(home, telemetry) {
  const store = new GatewayStore(join(home, 'gateway', 'gateway.sqlite'));
  const replica = new ReplicaStore(store.handle());
  const now = Date.now();
  store.registerNode({ id: 'device-a', name: 'A 工作站', platform: 'linux', role: 'host', capabilities: ['shell'], tokenHash: 'a'.repeat(64) });
  store.touchDevice({ id: 'device-a', origin: 'cli', platform: 'linux', lastSeenAt: now });
  store.upsertSession({ sessionId: 'sess-alpha', deviceId: 'device-a', cwd: '/work/alpha', kind: 'work', createdAt: now });
  replica.append('sess-alpha', Array.from({ length: 10 }, (_unused, seq) => ({
    seq,
    kind: 'turn/start',
    time: now + seq,
    bytes: 64,
    payload: { turn: seq + 1, text: 'a'.repeat(40) },
  })));
  const server = await startResourceLimitServer({
    store,
    replica,
    telemetry,
    jobs: {
      export: async () => ({ jobId: 'export-probe', bytes: 1 }),
      backup: async () => ({ objects: 1, bytes: 1 }),
    },
  });
  return { store, replica, server };
}

/** 打开一条事件流。 */
function openStream(url, onFrame) {
  return new Promise((settle, fail) => {
    const request = httpRequest(url, (response) => {
      let buffer = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        buffer += chunk;
        let index = buffer.indexOf('\n\n');
        while (index >= 0) {
          onFrame(buffer.slice(0, index));
          buffer = buffer.slice(index + 2);
          index = buffer.indexOf('\n\n');
        }
      });
      response.on('close', () => undefined);
      response.on('error', () => undefined);
      settle({
        response,
        close: () => {
          request.destroy();
        },
      });
    });
    request.on('error', fail);
    request.end();
  });
}

/** 在独立数据根里运行一个测试。 */
async function withHome(prefix, run) {
  const home = allocateIndependentHome(prefix);
  try {
    return await run(home);
  } finally {
    releaseIndependentHome(home);
  }
}

test('资源拒绝、背压与容量报告都产生 span、事件、计数与直方图', async () => {
  await withHome('sys08-telemetry', async (home) => {
    const collector = await startCollector();
    const telemetry = createTelemetryClient({
      config: defaultTelemetryConfig({
        endpoint: collector.url,
        exportIntervalMs: 100,
        exportIntervalMsMetrics: 100,
        exportTimeoutMs: 50,
      }),
      component: '@chatdsh/gateway',
      env: {},
    });
    const { server } = await startServer(home, telemetry);
    const marker = 'payload-marker-sys08';
    try {
      const accepted = await fetch(`${server.url}/chatdsh/gateway/resource/upload?scope=request-body`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: Buffer.from(marker.repeat(64)),
      });
      assert.equal(accepted.status, 200);
      await accepted.text();

      const rejected = await fetch(`${server.url}/chatdsh/gateway/resource/upload?scope=preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: Buffer.alloc(RESOURCE_LIMITS.preview.value + 1, 0x41),
      });
      assert.equal(rejected.status, 413);
      await rejected.text();

      let releaseExports;
      const gate = new Promise((settle) => {
        releaseExports = settle;
      });
      const exportStore = new GatewayStore(join(home, 'gateway', 'export.sqlite'));
      const slowServer = await startResourceLimitServer({
        store: exportStore,
        replica: new ReplicaStore(exportStore.handle()),
        telemetry,
        jobs: {
          export: async () => {
            await gate;
            return { jobId: 'export-slow', bytes: 1 };
          },
          backup: async () => ({ objects: 1, bytes: 1 }),
        },
      });
      const attempts = Array.from(
        { length: RESOURCE_LIMITS['export-concurrency'].value + RESOURCE_LIMITS['export-queue'].value + 2 },
        () => fetch(`${slowServer.url}/chatdsh/gateway/resource/export`, { method: 'POST' }),
      );
      await new Promise((settle) => setTimeout(settle, 200));
      releaseExports();
      for (const response of await Promise.all(attempts)) await response.text();
      await slowServer.close();

      const frames = [];
      const target = 'sess-telemetry';
      const fast = await openStream(`${server.url}/chatdsh/gateway/fanout/dev-fast?session=${target}&since=-1`, () => undefined);
      const slow = await openStream(`${server.url}/chatdsh/gateway/fanout/dev-slow?session=${target}&since=-1`, (frame) => frames.push(frame));
      slow.response.pause();
      await new Promise((settle) => setTimeout(settle, 120));
      for (let index = 0; index < 500; index += 1) {
        const response = await fetch(`${server.url}/chatdsh/gateway/resource/events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: target,
            events: [{ seq: index, kind: 'turn/end', time: Date.now(), payload: { text: 'z'.repeat(32 * 1024) } }],
          }),
        });
        if (response.status !== 200) throw new Error(`事件上报返回 ${String(response.status)}`);
        await response.text();
      }
      slow.response.resume();
      for (let attempt = 0; attempt < 200 && !frames.some((frame) => frame.includes('backpressure-exceeded')); attempt += 1) {
        await new Promise((settle) => setTimeout(settle, 20));
      }
      assert.ok(frames.some((frame) => frame.includes('backpressure-exceeded')), '慢订阅必须被终止');
      fast.close();
      slow.close();

      const recorder = new CapacityRecorder({ thresholds: CAPACITY_THRESHOLDS });
      const report = await measureShellStatic({ baseUrl: server.url, dataRoot: home, recorder, sessionId: 'sess-alpha', deviceIds: [], dispatchSamplesMs: () => [], resetDispatchSamples: () => undefined, subscriptionCount: () => 0, repeats: 3 });
      server.resourceTelemetry.capacityScenario(report);
      server.resourceTelemetry.gaugeConnections(0);

      await telemetry.flush(4000);
      await new Promise((settle) => setTimeout(settle, 400));
      await telemetry.flush(4000);

      const logs = flattenLogs(collector.records().logs);
      const spans = flattenTraces(collector.records().traces);
      const metrics = flattenMetrics(collector.records().metrics);

      const spanNames = new Set(spans.map((span) => span.name));
      const eventNames = new Set(logs.map((log) => log.name));
      const metricNames = new Set(metrics.map((metric) => metric.name));
      const seen = `span=${[...spanNames].join('|')} 事件=${[...eventNames].join('|')} 指标=${[...metricNames].join('|')}`;
      for (const name of ['chatdsh.gateway.resource.guard', 'chatdsh.gateway.resource.backpressure', 'chatdsh.gateway.capacity.report']) {
        assert.ok(spanNames.has(name), `缺少 span：${name}；实际 ${seen}`);
      }
      for (const name of ['chatdsh.gateway.resource.rejected', 'chatdsh.gateway.resource.backpressure.rejected', 'chatdsh.gateway.capacity.scenario']) {
        assert.ok(eventNames.has(name), `缺少事件：${name}；实际 ${seen}`);
      }
      for (const name of [
        'chatdsh_gateway_resource_checks_total',
        'chatdsh_gateway_resource_rejections_total',
        'chatdsh_gateway_resource_bytes',
        'chatdsh_gateway_resource_backpressure_total',
        'chatdsh_gateway_resource_pending_bytes',
        'chatdsh_gateway_resource_inflight',
        'chatdsh_gateway_resource_queue_depth',
        'chatdsh_gateway_resource_connections',
        'chatdsh_gateway_capacity_scenarios_total',
        'chatdsh_gateway_capacity_duration_seconds',
        'chatdsh_gateway_capacity_rss_bytes',
        'chatdsh_gateway_capacity_file_descriptors',
        'chatdsh_gateway_capacity_subscriptions',
      ]) {
        assert.ok(metricNames.has(name), `缺少指标：${name}`);
      }
      const rejection = logs.find((log) => log.name === 'chatdsh.gateway.resource.rejected');
      assert.equal(rejection.attributes['error.code'], 'payload-too-large');
      assert.equal(rejection.attributes['error.type'], 'resource');
      assert.equal(rejection.attributes.outcome, 'rejected');
      assert.equal(rejection.attributes.kind, 'preview');

      const backpressure = logs.find((log) => log.name === 'chatdsh.gateway.resource.backpressure.rejected');
      assert.equal(backpressure.attributes['error.code'], 'backpressure-exceeded');
      assert.equal(backpressure.attributes.reason, 'resume-cursor');

      const rejectedPoints = metrics.filter((metric) => metric.name === 'chatdsh_gateway_resource_rejections_total');
      assert.ok(
        rejectedPoints.some((point) => point.attributes.kind === 'preview' && point.attributes['error.code'] === 'payload-too-large'),
        '拒绝计数必须按资源种类与错误码分组',
      );
      const queuePoints = metrics.filter((metric) => metric.name === 'chatdsh_gateway_resource_rejections_total'
        && metric.attributes['error.code'] === 'queue-full');
      assert.ok(queuePoints.length > 0, '并发与队列拒绝必须计入指标');

      // 内容边界：不得出现请求体标记、会话标识或文件路径。
      for (const record of [...logs, ...spans, ...metrics]) {
        assert.ok(!record.raw.includes(marker), `${record.name} 携带了请求体原文`);
        assert.ok(!record.raw.includes('sess-alpha'), `${record.name} 携带了会话标识`);
        assert.ok(!record.raw.includes('/work/'), `${record.name} 携带了文件路径`);
      }
      for (const metric of metrics) {
        assert.ok(!Object.hasOwn(metric.attributes, 'session.id'), `指标 ${metric.name} 带上了会话标识`);
      }
    } finally {
      await server.close();
      await telemetry.shutdown();
      await collector.close();
    }
  });
});

/** 取一个指标点的错误码属性。 */
function pointErrorCode(point) {
  return point.attributes['error.code'];
}

test('关闭遥测后限制语义不变且没有信号出网', async () => {
  await withHome('sys08-telemetry-off', async (home) => {
    const collector = await startCollector();
    const telemetry = createTelemetryClient({
      config: defaultTelemetryConfig({ endpoint: collector.url, exportIntervalMs: 100, exportIntervalMsMetrics: 100 }),
      component: '@chatdsh/gateway',
      env: { CHATDSH_TELEMETRY: 'off' },
    });
    const { server } = await startServer(home, telemetry);
    try {
      assert.equal(telemetry.enabled, false);
      const rejected = await fetch(`${server.url}/chatdsh/gateway/resource/upload?scope=request-body`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: Buffer.alloc(RESOURCE_LIMITS['request-body'].value + 1, 0x42),
      });
      assert.equal(rejected.status, 413);
      const body = await rejected.json();
      assert.equal(body.error, 'payload-too-large');
      await telemetry.flush(1000);
       await new Promise((settle) => setTimeout(settle, 300));
      const records = collector.records();
      assert.equal(records.logs.length, 0, '关闭遥测后不得导出日志');
      assert.equal(records.traces.length, 0, '关闭遥测后不得导出追踪');
      assert.equal(records.metrics.length, 0, '关闭遥测后不得导出指标');
    } finally {
      await server.close();
      await telemetry.shutdown();
      await collector.close();
    }
  });
});
