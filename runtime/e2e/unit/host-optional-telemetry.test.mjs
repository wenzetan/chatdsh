// R02 可选遥测：业务插件在未安装遥测服务时正常激活，迟到安装后遥测照常生效。
//
// 控制平面是完整装配的真实 HTTP 服务与真实 SQLite；设备侧与上报侧各自加载真实
// WebServer、真实会话持久化与业务插件。延迟提供的遥测实例是真实 TelemetryClient，
// 导出端点指向本机未监听端口，诊断环仍按真实记录增长。请求带真实 traceparent 经
// 控制平面进入设备长连接，再落到本机 HTTP 端点，端点记录收到的请求头用于比对。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { ensureDeps } from '../lib/ensure-deps.mjs';

const RUNTIME = resolve(import.meta.dirname, '../..');
const REPO = resolve(RUNTIME, '..');
ensureDeps(RUNTIME);
ensureDeps(resolve(REPO, 'dsh-adapter'));

const { Context } = await import('@deepseek-ai/cordis');
const { default: WebServer } = await import('@deepseek-ai/dsh-host-webserver');
const { default: SessionPlugin } = await import('@deepseek-ai/dsh-session');
const jsonl = await import('@deepseek-ai/dsh-session-persistence-jsonl');
const { ChatdshDeviceLinkService, IDENTITY_PATH } = await import('../../packages/host/device-link/lib/index.js');
const { ChatdshPushService } = await import('../../packages/host/push/lib/index.js');
const { GatewayStore, PushQueue, ReceiptStore, ReplicaStore, SettingsStore } = await import('../../gateway/lib/store.js');
const { createPushHub } = await import('../../gateway/lib/push.js');
const { DeviceLinkHub } = await import('../../gateway/lib/device-link.js');
const { createGatewayServer } = await import('../../gateway/lib/server.js');
const { createTelemetryClient } = await import('../../packages/core/diagnostics/lib/client.js');
const { defaultTelemetryConfig } = await import('../../packages/core/diagnostics/lib/config.js');

/** 等一段时间。 */
function settle(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/** 反复执行一个检查直到成立。 */
async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last.ok) return last.value;
    await settle(60);
  }
  throw new Error(`等待超时：${label}；最后状态 ${JSON.stringify(last?.detail ?? last)}`);
}

/** 起一个完整装配的真实控制平面。 */
async function startGateway(home, pairingCode) {
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const databasePath = join(home, 'gateway.sqlite');
  const telemetry = createTelemetryClient({
    config: defaultTelemetryConfig({ surface: 'gateway' }),
    component: '@chatdsh/gateway',
    env: { CHATDSH_TELEMETRY: 'off' },
  });
  const store = new GatewayStore(databasePath);
  const replica = new ReplicaStore(store.handle());
  const receipts = new ReceiptStore(store.handle());
  const settings = new SettingsStore(store.handle());
  const push = createPushHub({
    queue: new PushQueue(store.handle()),
    devices: store,
    mode: 'all-at-once',
    escalationMs: 1000,
    telemetry: { counter: (name, options) => telemetry.counter(name, options) },
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
      accessMode: 'disabled',
      pwaVersion: 'test',
      pairingCode,
    },
    store,
    replica,
    receipts,
    settings,
    push,
    telemetry,
    deviceLink,
  });
  await server.start();
  return {
    url: server.url(),
    replica,
    deviceLink,
    async close() {
      deviceLink.stop();
      await server.stop();
      await telemetry.shutdown();
      store.close();
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
    },
  };
}

/** 配对一台设备。 */
async function pairDevice(base, name, pairingCode) {
  const response = await fetch(`${base}/chatdsh/gateway/devices/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: pairingCode, name, platform: 'linux', role: 'both', capabilities: ['http'] }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, `配对失败：${JSON.stringify(body)}`);
  return body;
}

/**
 * 装配一台真实设备运行时：真实 WebServer、真实设备长连接插件，容器里没有遥测服务。
 * @param {{ home: string, gatewayUrl: string, deviceId: string, token: string }} options 设备参数。
 */
async function openDeviceStack({ home, gatewayUrl, deviceId, token }) {
  const previousHome = process.env.DSH_HOME;
  const previousToken = process.env.CHATDSH_NODE_TOKEN;
  process.env.DSH_HOME = home;
  process.env.CHATDSH_NODE_TOKEN = token;
  const ctx = new Context();
  const echoes = [];
  try {
    ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
    await waitFor(
      () => ({ ok: ctx.webServer?.getOrigin?.() !== undefined, detail: '本机 HTTP 服务尚未监听' }),
      15_000,
      '本机 HTTP 服务',
    );
    ctx.webServer.register({
      kind: 'exact',
      path: '/r02/echo',
      handler: (request, response) => {
        const body = JSON.stringify({
          traceparent: typeof request.headers.traceparent === 'string' ? request.headers.traceparent : null,
          path: request.url ?? null,
        });
        echoes.push({ traceparent: request.headers.traceparent ?? null, path: request.url ?? null });
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(body),
        });
        response.end(body);
      },
    });
    const fiber = ctx.plugin(ChatdshDeviceLinkService, {
      controlUrl: gatewayUrl,
      deviceId,
      reconnectMaxMs: 1000,
    });
    await waitFor(
      () => ({ ok: ctx.reflect.get('chatdsh-device-link') !== undefined, detail: { state: fiber.state } }),
      15_000,
      'device-link 服务激活',
    );
    return { ctx, fiber, echoes };
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    if (previousToken === undefined) delete process.env.CHATDSH_NODE_TOKEN;
    else process.env.CHATDSH_NODE_TOKEN = previousToken;
  }
}

/**
 * 装配一台真实上报运行时：真实会话持久化、真实补传意图库与上报插件，容器里没有遥测服务。
 * @param {{ home: string, gatewayUrl: string, deviceId: string, token: string }} options 上报参数。
 */
async function openPushStack({ home, gatewayUrl, deviceId, token }) {
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const ctx = new Context();
  try {
    const sessionFiber = ctx.plugin(SessionPlugin);
    const jsonlFiber = ctx.plugin(jsonl, { root: join(home, 'sessions') });
    await waitFor(
      () => ({
        ok: ctx.reflect.get('sessionPersistence') !== undefined,
        detail: { session: sessionFiber.state, jsonl: jsonlFiber.state },
      }),
      20_000,
      '会话持久化服务',
    );
    const fiber = ctx.plugin(ChatdshPushService, {
      enabled: true,
      gatewayUrl,
      flushIntervalMs: 3_600_000,
      deviceId,
      nodeToken: token,
      intentPath: join(home, 'push', 'replica-intents.sqlite'),
    });
    await waitFor(
      () => ({ ok: ctx.reflect.get('chatdshPush') !== undefined, detail: { state: fiber.state } }),
      20_000,
      'push 服务激活',
    );
    return { ctx, fiber };
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
}

/** 创建一段真实会话日志。 */
async function seedSession(ctx, sessionId, cwd, events) {
  const handle = await ctx.sessionPersistence.create({
    id: sessionId,
    version: 4,
    cwd,
    createdAt: Date.now(),
    isSeeded: false,
  });
  await handle.append(events);
  await handle.flush();
  await handle.close();
}

/** 向已有会话继续追加真实事件。 */
async function appendSessionEvents(ctx, sessionId, events) {
  const handle = await ctx.sessionPersistence.open(sessionId, 'write');
  await handle.append(events);
  await handle.flush();
  await handle.close();
}

test('未安装遥测时业务插件激活，迟到提供后转发与上报均产出 span 并贯通 traceparent', { timeout: 180_000 }, async () => {
  const home = allocateIndependentHome('r02-optional-telemetry');
  const pairingCode = randomBytes(9).toString('base64url');
  const stacks = [];
  let gateway;
  let telemetry;
  try {
    gateway = await startGateway(home, pairingCode);
    const paired = await pairDevice(gateway.url, 'device-r02', pairingCode);
    const deviceHome = join(home, 'device');
    const pushHome = join(home, 'push-host');
    mkdirSync(deviceHome, { recursive: true });
    mkdirSync(pushHome, { recursive: true });

    const device = await openDeviceStack({
      home: deviceHome,
      gatewayUrl: gateway.url,
      deviceId: paired.deviceId,
      token: paired.token,
    });
    stacks.push(device);
    assert.equal(device.ctx.reflect.get('chatdshTelemetry'), undefined, '设备容器没有遥测服务');
    assert.equal(device.fiber.state, 2, 'device-link fiber 处于 ACTIVE');
    await waitFor(
      () => ({ ok: gateway.deviceLink.online(paired.deviceId), detail: '设备长连接尚未上线' }),
      20_000,
      '设备长连接上线',
    );

    // 第一次业务动作发生在遥测服务提供之前：身份端点经控制平面转发到本机运行时。
    const identity = await fetch(`${gateway.url}/d/${paired.deviceId}${IDENTITY_PATH}`);
    assert.equal(identity.status, 200);
    assert.equal((await identity.json()).deviceId, paired.deviceId);
    assert.equal(device.echoes.length, 0, '身份请求没有经过自建端点');

    const push = await openPushStack({
      home: pushHome,
      gatewayUrl: gateway.url,
      deviceId: paired.deviceId,
      token: paired.token,
    });
    stacks.push(push);
    assert.equal(push.ctx.reflect.get('chatdshTelemetry'), undefined, '上报容器没有遥测服务');
    assert.equal(push.fiber.state, 2, 'push fiber 处于 ACTIVE');
    const pushService = push.ctx.reflect.get('chatdshPush');
    assert.notEqual(pushService, undefined);

    // 会话标识只含字母：诊断导出会按电话号码规则脱敏长数字串，测试用字母标识避免被替换。
    const sessionId = 'r02-session-alpha';
    const baseTime = Date.now();
    await seedSession(push.ctx, sessionId, join(home, 'workspace'), [
      { type: 'turn/start', seq: 0, time: baseTime, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: baseTime + 1, data: { turn: 1, reason: { kind: 'completed' } } },
    ]);
    await pushService.flush();
    await waitFor(
      () => ({ ok: gateway.replica.read(sessionId).length === 2, detail: gateway.replica.read(sessionId).length }),
      15_000,
      '无遥测时的首次上报',
    );

    telemetry = createTelemetryClient({
      config: defaultTelemetryConfig({
        enabled: true,
        endpoint: 'http://127.0.0.1:1',
        surface: 'runtime',
        exportIntervalMs: 60_000,
        exportIntervalMsMetrics: 60_000,
        exportTimeoutMs: 100,
      }),
      component: '@chatdsh/r02-optional-telemetry',
      env: { CHATDSH_TELEMETRY: 'on' },
    });
    assert.equal(telemetry.enabled, true);
    for (const stack of stacks) {
      stack.ctx.provide('chatdshTelemetry');
      stack.ctx.set('chatdshTelemetry', telemetry);
      assert.equal(stack.ctx.reflect.get('chatdshTelemetry'), telemetry);
    }
    assert.equal(device.fiber.state, 2, '迟到提供遥测后 device-link 仍处于 ACTIVE');
    assert.equal(push.fiber.state, 2, '迟到提供遥测后 push 仍处于 ACTIVE');

    // 第二次转发带真实 traceparent：控制平面把它送进设备长连接，设备再转发到本机端点。
    const traceId = randomBytes(16).toString('hex');
    const parentSpanId = randomBytes(8).toString('hex');
    const traceparent = `00-${traceId}-${parentSpanId}-01`;
    const echoedResponse = await fetch(`${gateway.url}/d/${paired.deviceId}/r02/echo?probe=1`, {
      headers: { traceparent },
    });
    assert.equal(echoedResponse.status, 200);
    const echoed = await echoedResponse.json();
    assert.equal(echoed.path, '/r02/echo?probe=1');
    assert.equal(echoed.traceparent, traceparent, '本机运行时收到的载体与请求载体逐字段一致');
    assert.equal(echoed.traceparent.split('-')[1], traceId);
    assert.equal(device.echoes.at(-1)?.traceparent, traceparent);

    await appendSessionEvents(push.ctx, sessionId, [
      { type: 'turn/start', seq: 2, time: baseTime + 2, data: { turn: 2 } },
    ]);
    await pushService.flush();
    await waitFor(
      () => ({ ok: gateway.replica.read(sessionId).length === 3, detail: gateway.replica.read(sessionId).length }),
      15_000,
      '迟到提供遥测后的上报',
    );

    const spans = await waitFor(
      () => {
        const recorded = telemetry.diagnostics(256).events.filter((event) => event.kind === 'span');
        const forward = recorded.find((event) => event.name === 'chatdsh.runtime.device.forward');
        const pushed = recorded.find((event) => event.name === 'chatdsh.sync.event.push');
        return forward !== undefined && pushed !== undefined
          ? { ok: true, value: { forward, pushed } }
          : { ok: false, detail: recorded.map((event) => event.name) };
      },
      15_000,
      '设备转发 span 与副本上报 span',
    );
    assert.equal(spans.forward.attributes.method, 'GET');
    assert.equal(spans.forward.attributes['http.status_code'], 200);
    assert.equal(spans.forward.attributes.outcome, 'forwarded');
    assert.equal(spans.pushed.attributes['session.id'], sessionId);
    assert.equal(spans.pushed.attributes.seq, 2);
    // 后台扫描与显式 flush 都可能先送达同一批事件，两种结局都来自真实上报。
    assert.ok(
      spans.pushed.attributes.outcome === 'pushed' || spans.pushed.attributes.outcome === 'duplicate',
      `上报 span 的结局是 ${String(spans.pushed.attributes.outcome)}`,
    );

    const watermark = telemetry.diagnostics(256).events.find(
      (event) => event.kind === 'event' && event.name === 'chatdsh.sync.watermark',
    );
    assert.notEqual(watermark, undefined, '副本水位事件已记录');
    assert.equal(watermark.attributes['session.id'], sessionId);
    assert.equal(watermark.attributes['lag.events'], 0);
  } finally {
    for (const stack of stacks) await stack.ctx.fiber.dispose();
    if (telemetry !== undefined) await telemetry.shutdown();
    if (gateway !== undefined) await gateway.close();
    releaseIndependentHome(home);
  }
});
