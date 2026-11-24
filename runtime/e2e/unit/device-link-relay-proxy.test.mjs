// 本机同源中继代理的验收测试。
//
// 控制平面是完整装配的真实 HTTP 服务与真实 SQLite；本机代理装在真实 Cordis 容器
// 与真实 WebServer 上；浏览器请求、上游目标、超时目标与遥测接收端都是真实进程内
// HTTP 服务。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { tempHome } from '../../scripts/lib/cleanup.mjs';
import { useHome } from '../lib/environment.mjs';
import { createTelemetryClient } from '../../packages/core/diagnostics/lib/client.js';
import { defaultTelemetryConfig } from '../../packages/core/diagnostics/lib/config.js';
import { GatewayStore, PushQueue, ReceiptStore, ReplicaStore, SettingsStore } from '../../gateway/lib/store.js';
import { createPushHub } from '../../gateway/lib/push.js';
import { DeviceLinkHub } from '../../gateway/lib/device-link.js';
import { createGatewayServer } from '../../gateway/lib/server.js';
import {
  RELAY_DEVICES_PATH,
  RELAY_PAIR_PATH,
  RELAY_REPLICA_PATH,
  RELAY_SESSIONS_PATH,
  isLoopbackAddress,
  registerRelayProxy,
} from '../../packages/host/device-link/lib/relay-proxy.js';
import { ChatdshDeviceLinkService } from '../../packages/host/device-link/lib/index.js';

const { Context } = await import('@deepseek-ai/cordis');
const { default: WebServer } = await import('@deepseek-ai/dsh-host-webserver');

const PAIRING_CODE = 'pair-relay-proxy';
const TRACE = '00-33333333333333333333333333333333-4444444444444444-01';

/** 等一段时间。 */
function settle(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * 反复执行一个检查直到成立。
 * @param {() => Promise<{ ok: boolean, value?: unknown, detail?: unknown }>} check - 检查函数。
 * @param {number} timeoutMs - 超时毫秒数。
 * @param {string} label - 失败时报告的等待对象。
 */
async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last.ok) return last.value;
    await settle(40);
  }
  throw new Error(`等待超时：${label}；最后状态 ${JSON.stringify(last?.detail ?? last)}`);
}

/** 起一个完整装配的控制平面。 */
async function startGateway() {
  const home = tempHome('device-link-relay-proxy');
  const restoreHome = useHome(home);
  const databasePath = join(home, 'gateway.sqlite');
  const telemetry = createTelemetryClient({
    config: defaultTelemetryConfig({ surface: 'gateway' }),
    component: '@chatdsh/gateway',
    env: { CHATDSH_TELEMETRY: 'off' },
  });
  const store = new GatewayStore(databasePath);
  const replica = new ReplicaStore(store.handle());
  const receipts = new ReceiptStore(store.handle());
  const push = createPushHub({
    queue: new PushQueue(store.handle()),
    devices: store,
    mode: 'all-at-once',
    escalationMs: 1000,
    telemetry: { counter: (name, config) => telemetry.counter(name, config) },
  });
  const deviceLink = new DeviceLinkHub({ store, telemetry });
  const server = createGatewayServer({
    config: {
      host: '127.0.0.1',
      port: 0,
      databasePath,
      environment: 'test',
      version: '0.0.0',
      pushMode: 'all-at-once',
      pushEscalationMs: 1000,
      pairingCode: PAIRING_CODE,
    },
    store,
    replica,
    receipts,
    settings: new SettingsStore(store.handle()),
    push,
    telemetry,
    deviceLink,
  });
  await server.start();
  return {
    url: server.url(),
    store,
    replica,
    async close() {
      deviceLink.stop();
      await server.stop();
      await telemetry.shutdown();
      store.close();
      restoreHome();
    },
  };
}

/** 配对一台节点。 */
async function pairNode(gateway, name) {
  const response = await fetch(`${gateway.url}/chatdsh/gateway/devices/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: PAIRING_CODE, name, platform: 'linux', role: 'both', capabilities: ['http'] }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

/** 读取一个成功响应的 JSON。 */
async function jsonOf(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200, `读取 ${url} 失败`);
  return response.json();
}

/** 在一个真实 Cordis 容器里注册四个代理端点。 */
async function openProxy({ fallback = '', telemetry = () => undefined, timeoutMs } = {}) {
  const ctx = new Context();
  ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  const origin = await waitFor(async () => {
    try {
      return { ok: true, value: ctx.webServer.getOrigin() };
    } catch {
      return { ok: false, detail: '服务尚未监听' };
    }
  }, 10_000, '本机代理服务');
  const release = registerRelayProxy({
    webServer: ctx.webServer,
    fallbackControlUrl: () => fallback,
    telemetry,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return {
    origin,
    async close() {
      release();
      await ctx.fiber.dispose();
    },
  };
}

/** 起一个记录请求的真实 HTTP 目标。 */
async function startRecorder(delayMs = 0) {
  const records = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      records.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      const reply = () => {
        if (response.destroyed) return;
        const body = JSON.stringify({ ok: true });
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
        response.end(body);
      };
      if (delayMs === 0) reply();
      else setTimeout(reply, delayMs).unref();
    });
    response.on('error', () => undefined);
  });
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    records,
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}

/** 取一个当前未监听的端口。 */
async function closedPort() {
  const server = net.createServer();
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise((done) => server.close(done));
  return port;
}

test('来源判定只接受本机回环地址', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('0:0:0:0:0:0:0:1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::ffff:7f00:1'), true);
  assert.equal(isLoopbackAddress('0:0:0:0:0:ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('[::1]'), true);
  assert.equal(isLoopbackAddress('10.0.0.1'), false); // gitleaks:allow
  assert.equal(isLoopbackAddress('8.8.8.8'), false);
  assert.equal(isLoopbackAddress('localhost'), false);
  assert.equal(isLoopbackAddress(undefined), false);
});

test('四个白名单端点经本机代理转发真实中继', { timeout: 120_000 }, async () => {
  const gateway = await startGateway();
  const proxies = [];
  try {
    const node = await pairNode(gateway, 'node-through-relay');
    const sessionId = 'session relay/一';
    const appended = await fetch(`${gateway.url}/chatdsh/gateway/replica`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-chatdsh-node-id': node.deviceId },
      body: JSON.stringify({
        sessionId,
        events: [{ seq: 0, kind: 'session/title', time: 1, bytes: 16, payload: { data: { title: '代理会话' } } }],
      }),
    });
    assert.equal(appended.status, 200);

    const directDevices = await jsonOf(`${gateway.url}/chatdsh/gateway/devices`);
    const directSessions = await jsonOf(`${gateway.url}/chatdsh/gateway/sessions`);
    const directReplica = await jsonOf(`${gateway.url}/chatdsh/gateway/replica?sessionId=${encodeURIComponent(sessionId)}`);

    const proxy = await openProxy({ fallback: gateway.url });
    proxies.push(proxy);

    const devices = await fetch(`${proxy.origin}${RELAY_DEVICES_PATH}`);
    assert.equal(devices.status, 200);
    assert.deepEqual(await devices.json(), directDevices);

    const sessions = await fetch(`${proxy.origin}${RELAY_SESSIONS_PATH}`, {
      headers: { 'x-chatdsh-control-url': gateway.url },
    });
    assert.equal(sessions.status, 200);
    assert.deepEqual(await sessions.json(), directSessions);

    const replica = await fetch(`${proxy.origin}${RELAY_REPLICA_PATH}?sessionId=${encodeURIComponent(sessionId)}`, {
      headers: { 'x-chatdsh-control-url': gateway.url },
    });
    assert.equal(replica.status, 200);
    assert.deepEqual(await replica.json(), directReplica);

    const paired = await fetch(`${proxy.origin}${RELAY_PAIR_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-chatdsh-csrf': '1',
        'x-chatdsh-control-url': gateway.url,
      },
      body: JSON.stringify({
        code: PAIRING_CODE,
        name: 'paired-through-proxy',
        platform: 'linux',
        role: 'both',
        capabilities: ['http'],
      }),
    });
    assert.equal(paired.status, 200);
    const pairPayload = await paired.json();
    assert.ok(typeof pairPayload.deviceId === 'string' && pairPayload.deviceId !== node.deviceId);
    assert.ok(typeof pairPayload.token === 'string' && pairPayload.token.length > 20);
    const afterPair = await jsonOf(`${gateway.url}/chatdsh/gateway/devices`);
    const registered = afterPair.devices.find((device) => device.id === pairPayload.deviceId);
    assert.equal(registered?.name, 'paired-through-proxy');

    const withoutCsrf = await fetch(`${proxy.origin}${RELAY_PAIR_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-chatdsh-control-url': gateway.url },
      body: '{}',
    });
    assert.equal(withoutCsrf.status, 403);
    assert.deepEqual(await withoutCsrf.json(), { error: 'csrf-required' });

    const emptyProxy = await openProxy();
    proxies.push(emptyProxy);
    const missingTarget = await fetch(`${emptyProxy.origin}${RELAY_PAIR_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-chatdsh-csrf': '1' },
      body: '{}',
    });
    assert.equal(missingTarget.status, 400);
    assert.deepEqual(await missingTarget.json(), { error: 'control-url-required' });

    for (const target of ['ftp://relay.example', 'http://user@relay.example', 'http://relay.example/?q=1', 'http://relay.example/#part']) {
      const invalid = await fetch(`${emptyProxy.origin}${RELAY_DEVICES_PATH}`, {
        headers: { 'x-chatdsh-control-url': target },
      });
      assert.equal(invalid.status, 400, `目标 ${target} 应当被拒绝`);
      assert.deepEqual(await invalid.json(), { error: 'control-url-invalid' });
    }

    const missingSession = await fetch(`${proxy.origin}${RELAY_REPLICA_PATH}`);
    assert.equal(missingSession.status, 400);
    assert.deepEqual(await missingSession.json(), { error: 'session-id-required' });
    const emptySession = await fetch(`${proxy.origin}${RELAY_REPLICA_PATH}?sessionId=`);
    assert.equal(emptySession.status, 400);
    assert.deepEqual(await emptySession.json(), { error: 'session-id-required' });

    const tooLarge = await fetch(`${proxy.origin}${RELAY_PAIR_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-chatdsh-csrf': '1',
        'x-chatdsh-control-url': gateway.url,
      },
      body: JSON.stringify({ code: 'x'.repeat(65 * 1024) }),
    });
    assert.equal(tooLarge.status, 413);
    assert.deepEqual(await tooLarge.json(), { error: 'payload-too-large' });

    const chunked = await fetch(`${proxy.origin}${RELAY_PAIR_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-chatdsh-csrf': '1',
        'x-chatdsh-control-url': gateway.url,
      },
      body: Readable.from([Buffer.alloc(40 * 1024, 0x61), Buffer.alloc(40 * 1024, 0x62)]),
      duplex: 'half',
    });
    assert.equal(chunked.status, 413);
    assert.deepEqual(await chunked.json(), { error: 'payload-too-large' });

    const unreachable = await fetch(`${proxy.origin}${RELAY_DEVICES_PATH}`, {
      headers: { 'x-chatdsh-control-url': `http://127.0.0.1:${await closedPort()}` },
    });
    assert.equal(unreachable.status, 502);
    assert.deepEqual(await unreachable.json(), { error: 'relay-unreachable' });

    const slow = await startRecorder(250);
    proxies.push(slow);
    const fast = await openProxy({ timeoutMs: 1 });
    proxies.push(fast);
    const timedOut = await fetch(`${fast.origin}${RELAY_DEVICES_PATH}`, {
      headers: { 'x-chatdsh-control-url': slow.url },
    });
    assert.equal(timedOut.status, 504);
    assert.deepEqual(await timedOut.json(), { error: 'relay-timeout' });
  } finally {
    for (const proxy of proxies.reverse()) await proxy.close();
    await gateway.close();
  }
});

test('没有节点令牌时设备链路服务仍然注册代理端点', { timeout: 60_000 }, async () => {
  const gateway = await startGateway();
  const previousToken = process.env.CHATDSH_NODE_TOKEN;
  delete process.env.CHATDSH_NODE_TOKEN;
  const ctx = new Context();
  try {
    ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
    const origin = await waitFor(async () => {
      try {
        return { ok: true, value: ctx.webServer.getOrigin() };
      } catch {
        return { ok: false, detail: '服务尚未监听' };
      }
    }, 10_000, '设备运行时服务');
    ctx.plugin(ChatdshDeviceLinkService, { controlUrl: gateway.url, deviceId: 'dev-identity-check', reconnectMaxMs: 1000 });
    const response = await waitFor(async () => {
      const reply = await fetch(`${origin}${RELAY_DEVICES_PATH}`).catch(() => undefined);
      return { ok: reply?.status === 200, value: reply, detail: reply?.status ?? '不可达' };
    }, 30_000, '无令牌时的代理端点');
    assert.deepEqual(await response.json(), await jsonOf(`${gateway.url}/chatdsh/gateway/devices`));
    const identityRes = await fetch(`${origin}/chatdsh/device/identity`);
    assert.equal(identityRes.status, 200);
    assert.deepEqual(await identityRes.json(), { deviceId: 'dev-identity-check', controlUrl: gateway.url });
  } finally {
    await ctx.fiber.dispose();
    if (previousToken === undefined) delete process.env.CHATDSH_NODE_TOKEN;
    else process.env.CHATDSH_NODE_TOKEN = previousToken;
    await gateway.close();
  }
});

test('链路上下文按遥测开关透传并产出已登记信号', { timeout: 60_000 }, async () => {
  const target = await startRecorder();
  const otlp = await startRecorder();
  let telemetry;
  let proxy;
  try {
    telemetry = createTelemetryClient({
      config: defaultTelemetryConfig({
        surface: 'runtime',
        endpoint: otlp.url,
        exportIntervalMs: 50,
        exportIntervalMsMetrics: 50,
        exportTimeoutMs: 40,
      }),
      component: '@chatdsh/host-device-link',
      env: {},
    });
    proxy = await openProxy({ fallback: target.url, telemetry: () => telemetry });
    assert.equal(telemetry.enabled, true);
    const response = await fetch(`${proxy.origin}${RELAY_DEVICES_PATH}`, {
      headers: {
        traceparent: TRACE,
        tracestate: 'chatdsh=relay',
        cookie: 'secret=cookie',
        authorization: 'Bearer secret-token',
      },
    });
    assert.equal(response.status, 200);
    const forwarded = target.records.find((record) => record.url === '/chatdsh/gateway/devices');
    assert.ok(forwarded !== undefined);
    assert.equal(forwarded.headers.traceparent, TRACE);
    assert.equal(forwarded.headers.tracestate, 'chatdsh=relay');
    assert.equal(forwarded.headers.cookie, undefined);
    assert.equal(forwarded.headers.authorization, undefined);

    const rejected = await fetch(`${proxy.origin}${RELAY_DEVICES_PATH}`, {
      headers: { 'x-chatdsh-control-url': 'ftp://relay.example' },
    });
    assert.equal(rejected.status, 400);
    await telemetry.flush(2000);
    const payloads = otlp.records.map((record) => JSON.parse(record.body));
    const spanNames = payloads
      .flatMap((payload) => payload.resourceSpans ?? [])
      .flatMap((resource) => resource.scopeSpans ?? [])
      .flatMap((scope) => scope.spans ?? [])
      .map((span) => span.name);
    assert.ok(spanNames.includes('chatdsh.runtime.device.forward'));
    const metricNames = payloads
      .flatMap((payload) => payload.resourceMetrics ?? [])
      .flatMap((resource) => resource.scopeMetrics ?? [])
      .flatMap((scope) => scope.metrics ?? [])
      .map((metric) => metric.name);
    assert.ok(metricNames.includes('chatdsh_runtime_device_forwards_total'));
    const logNames = payloads
      .flatMap((payload) => payload.resourceLogs ?? [])
      .flatMap((resource) => resource.scopeLogs ?? [])
      .flatMap((scope) => scope.logRecords ?? [])
      .map((record) => record.body?.stringValue);
    assert.ok(logNames.includes('chatdsh.runtime.device.forward.failed'));
  } finally {
    if (proxy !== undefined) await proxy.close();
    if (telemetry !== undefined) await telemetry.shutdown();
    await target.close();
    await otlp.close();
  }
});

test('遥测关闭时不传播链路上下文', { timeout: 60_000 }, async () => {
  const target = await startRecorder();
  const telemetry = createTelemetryClient({
    config: defaultTelemetryConfig({ surface: 'runtime' }),
    component: '@chatdsh/host-device-link',
    env: { CHATDSH_TELEMETRY: 'off' },
  });
  const proxy = await openProxy({ fallback: target.url, telemetry: () => telemetry });
  try {
    assert.equal(telemetry.enabled, false);
    const response = await fetch(`${proxy.origin}${RELAY_DEVICES_PATH}`, {
      headers: { traceparent: TRACE, tracestate: 'chatdsh=relay' },
    });
    assert.equal(response.status, 200);
    const forwarded = target.records.find((record) => record.url === '/chatdsh/gateway/devices');
    assert.ok(forwarded !== undefined);
    assert.equal(forwarded.headers.traceparent, undefined);
    assert.equal(forwarded.headers.tracestate, undefined);
  } finally {
    await proxy.close();
    await telemetry.shutdown();
    await target.close();
  }
});
