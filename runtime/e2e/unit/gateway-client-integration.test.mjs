// 客户端经控制平面接入的端到端测试。
import net from 'node:net';
//
// 覆盖三件事：桌面壳用启动口令换取运行时路径、反代改写 Host 与 Origin 并保留两份
// cookie、自动化面板的启停请求落到控制平面存储。运行时不参与这些断言，用真实 HTTP
// 服务记录收到的头部。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tempHome } from '../../scripts/lib/cleanup.mjs';
import { createTelemetryClient } from '../../packages/core/diagnostics/lib/client.js';
import { defaultTelemetryConfig } from '../../packages/core/diagnostics/lib/config.js';
import { GatewayStore, PushQueue, ReceiptStore, ReplicaStore, ShareStore } from '../../gateway/lib/store.js';
import { createPushHub } from '../../gateway/lib/push.js';
import { DeviceLinkHub } from '../../gateway/lib/device-link.js';
import { createGatewayServer } from '../../gateway/lib/server.js';
import { AutomationStore } from '../../gateway/lib/automation.js';

/** 起一个记录请求头的替身运行时。 */
async function startUpstream() {
  const received = [];
  const server = createServer((request, response) => {
    received.push({ url: request.url, headers: request.headers });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 起一个完整装配的控制平面。 */
async function startGateway(upstreamUrl) {
  const home = tempHome('gateway-client');
  const databasePath = join(home, 'gateway.sqlite');
  const telemetry = createTelemetryClient({
    config: defaultTelemetryConfig({ surface: 'gateway' }),
    component: '@chatdsh/gateway',
    env: { CHATDSH_TELEMETRY: 'off' },
  });
  const store = new GatewayStore(databasePath);
  const replica = new ReplicaStore(store.handle());
  const share = new ShareStore(store.handle());
  const receipts = new ReceiptStore(store.handle());
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
      runtimeUrl: upstreamUrl,
      databasePath,
      environment: 'test',
      version: '0.0.0',
      pushMode: 'all-at-once',
      pushEscalationMs: 1000,
      llmGateway: { quota: {} },
      pairingCode: 'pair-me',
    },
    store,
    replica,
    share,
    receipts,
    push,
    telemetry,
    deviceLink,
    runtime: {
      url: () => upstreamUrl,
      bootPath: () => '/?token=test-token',
      ready: () => true,
    },
    bootstrapSecret: 'launch-secret',
  });
  await server.start();
  return {
    url: server.url(),
    store,
    deviceLink,
    async close() {
      deviceLink.stop();
      await server.stop();
      await telemetry.shutdown();
      store.close();
    },
  };
}

test('启动路径、反代头部与设备 cookie 一起接通', async () => {
  const upstream = await startUpstream();
  const gateway = await startGateway(upstream.url);
  try {
    const denied = await fetch(`${gateway.url}/chatdsh/gateway/bootstrap`);
    assert.equal(denied.status, 404);

    const issued = await fetch(`${gateway.url}/chatdsh/gateway/bootstrap`, {
      headers: { 'x-chatdsh-bootstrap': 'launch-secret' },
    });
    assert.equal(issued.status, 200);
    assert.deepEqual((await issued.json()).path, '/?token=test-token');

    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const first = await fetch(`${gateway.url}/api/probe?x=1`, {
      headers: { origin: `http://127.0.0.1:${new URL(gateway.url).port}`, traceparent },
    });
    assert.equal(first.status, 200);
    const cookies = first.headers.getSetCookie();
    const deviceCookie = cookies.find((value) => value.startsWith('chatdsh-device='));
    assert.ok(deviceCookie, '控制平面应当下发设备 cookie');

    const forwarded = upstream.received.at(-1);
    assert.equal(forwarded.headers.host, new URL(upstream.url).host);
    assert.equal(forwarded.headers.origin, upstream.url);
    assert.equal(forwarded.headers['x-forwarded-host'], new URL(gateway.url).host);
    assert.equal(forwarded.headers.traceparent, traceparent);

    const deviceId = deviceCookie.split(';')[0].split('=')[1];
    const devices = await fetch(`${gateway.url}/chatdsh/gateway/devices`, {
      headers: { cookie: `chatdsh-device=${deviceId}` },
    });
    const listed = await devices.json();
    assert.deepEqual(listed.devices, [], '还没有节点配对时设备列表为空');

    assert.ok(gateway.store.listDevices().some((device) => device.id === deviceId), '设备列表应当包含本次请求的设备');

    const automations = new AutomationStore(gateway.store.handle());
    automations.create({
      id: 'auto-1',
      name: '构建完成通知',
      trigger: { kind: 'webhook', secretEnv: 'HOOK_SECRET' },
      action: { kind: 'start-session', prompt: '总结构建' },
      enabled: true,
      createdAt: 1,
    });

    const toggled = await fetch(`${gateway.url}/chatdsh/gateway/automations`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-chatdsh-csrf': '1', cookie: `chatdsh-device=${deviceId}` },
      body: JSON.stringify({ id: 'auto-1', enabled: false }),
    });
    assert.equal(toggled.status, 200);
    assert.equal((await toggled.json()).enabled, false);
    assert.equal(automations.get('auto-1').enabled, false);
  } finally {
    await gateway.close();
    await upstream.close();
  }
});

test('WebSocket 升级经控制平面转发到运行时', async () => {
  const received = [];
  const upgraded = new Set();
  const upstreamServer = createServer();
  upstreamServer.on('upgrade', (request, socket) => {
    received.push(request.headers);
    upgraded.add(socket);
    socket.once('close', () => upgraded.delete(socket));
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (chunk) => socket.write(chunk));
  });
  await new Promise((resolve, reject) => {
    upstreamServer.once('error', reject);
    upstreamServer.listen(0, '127.0.0.1', resolve);
  });
  const address = upstreamServer.address();
  const upstreamPort = typeof address === 'object' && address !== null ? address.port : 0;
  const gateway = await startGateway(`http://127.0.0.1:${upstreamPort}`);
  try {
    const gatewayUrl = new URL(gateway.url);
    const socket = net.connect(Number.parseInt(gatewayUrl.port, 10), gatewayUrl.hostname);
    const chunks = [];
    let response = '';
    const connected = new Promise((resolve, reject) => {
      socket.on('error', reject);
      socket.on('connect', () => {
        socket.write([
          'GET /api/remote.mux HTTP/1.1',
          `Host: ${gatewayUrl.host}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', // gitleaks:allow
          'Sec-WebSocket-Version: 13',
          `Origin: ${gatewayUrl.origin}`,
          '',
          '',
        ].join('\r\n'));
      });
      socket.on('data', (chunk) => {
        if (response.includes('\r\n\r\n')) {
          chunks.push(chunk);
          resolve(undefined);
          return;
        }
        response += chunk.toString('utf8');
        if (response.includes('\r\n\r\n')) resolve(undefined);
      });
    });
    await connected;
    assert.match(response, /^HTTP\/1\.1 101 Switching Protocols/m);
    assert.equal(received.length, 1);
    assert.equal(received[0].host, `127.0.0.1:${upstreamPort}`);
    assert.equal(received[0].origin, `http://127.0.0.1:${upstreamPort}`);

    const echoed = new Promise((resolve) => socket.once('data', (chunk) => resolve(chunk.toString('utf8'))));
    socket.write('ping-frame');
    assert.equal(await echoed, 'ping-frame');
    socket.destroy();
  } finally {
    await gateway.close();
    upstreamServer.closeAllConnections();
    for (const socket of upgraded) socket.destroy();
    await new Promise((resolve) => upstreamServer.close(resolve));
  }
});

test('手机配对换取设备令牌，再取运行时启动路径', async () => {
  const upstream = await startUpstream();
  const gateway = await startGateway(upstream.url);
  try {
    const rejected = await fetch(`${gateway.url}/chatdsh/gateway/mobile/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'wrong', deviceName: 'Pixel' }),
    });
    assert.equal(rejected.status, 401);

    const paired = await fetch(`${gateway.url}/chatdsh/gateway/mobile/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'pair-me', deviceName: 'Pixel 9', platform: 'android' }),
    });
    assert.equal(paired.status, 200);
    const pairing = await paired.json();
    assert.ok(typeof pairing.token === 'string' && pairing.token.length > 20);
    assert.equal(pairing.bootPath, '/?token=test-token');

    const session = await fetch(`${gateway.url}/chatdsh/gateway/mobile/session`, {
      headers: { 'x-chatdsh-device-token': pairing.token },
    });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).deviceId, pairing.deviceId);

    const missing = await fetch(`${gateway.url}/chatdsh/gateway/mobile/session`);
    assert.equal(missing.status, 401);

    const devices = await (await fetch(`${gateway.url}/chatdsh/gateway/mobile/devices`)).json();
    assert.ok(devices.devices.some((device) => device.id === pairing.deviceId && device.platform === 'android'));
  } finally {
    await gateway.close();
    await upstream.close();
  }
});
