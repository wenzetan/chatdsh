// 按设备路由的单元级验证：归属写入的设备绑定与离线失败、/d/ 前缀反代的转发细节。
//
// 控制平面是完整装配的真实 HTTP 服务；设备侧按帧协议实现最小客户端，覆盖转发的方法、
// 路径、查询串、请求体与响应头回填。整机链路（真实 dsh 运行时）由
// scripts/verify-device-routing.mjs 覆盖。
import net from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempHome } from '../../scripts/lib/cleanup.mjs';
import { useHome } from '../lib/environment.mjs';
import { createTelemetryClient } from '../../packages/core/diagnostics/lib/client.js';
import { defaultTelemetryConfig } from '../../packages/core/diagnostics/lib/config.js';
import { GatewayStore, PushQueue, ReceiptStore, ReplicaStore, SettingsStore } from '../../gateway/lib/store.js';
import { createPushHub } from '../../gateway/lib/push.js';
import { DeviceLinkHub } from '../../gateway/lib/device-link.js';
import { createGatewayServer } from '../../gateway/lib/server.js';

/** 起一个完整装配的控制平面。 */
async function startGateway() {
  const home = tempHome('device-routing');
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
      pairingCode: 'pair-routing',
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
    deviceLink,
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'pair-routing', name, platform: 'linux', role: 'both', capabilities: [] }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  return { deviceId: payload.deviceId, token: payload.token };
}

/** 回显请求的测试设备：把方法、路径、请求头与请求体原样回填。 */
class EchoDevice {
  constructor(deviceId, token, url) {
    this.deviceId = deviceId;
    this.frames = [];
    this.opened = new Promise((resolve, reject) => {
      this.socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
      this.socket.addEventListener('open', () => {
        this.socket.send(JSON.stringify({ type: 'hello', deviceId, platform: 'linux', role: 'both', capabilities: [] }));
        resolve();
      });
      this.socket.addEventListener('error', () => reject(new Error('连接失败')));
      this.socket.addEventListener('message', (event) => {
        const frame = JSON.parse(event.data);
        if (frame.type === 'ping') {
          this.socket.send(JSON.stringify({ type: 'pong' }));
          return;
        }
        if (frame.type !== 'request') return;
        this.frames.push(frame);
        const payload = Buffer.from(JSON.stringify({
          method: frame.method,
          path: frame.path,
          probeHeader: frame.headers?.['x-probe'] ?? null,
          requestBody: frame.body ?? '',
        }), 'utf8');
        this.socket.send(JSON.stringify({
          type: 'response',
          requestId: frame.requestId,
          status: 201,
          headers: { 'content-type': 'application/json', 'x-from-device': 'echo' },
          body: payload.toString('base64'),
        }));
      });
    });
  }

  async waitOpen() {
    await this.opened;
  }
}

/** 等一个条件成立。 */
async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((settle) => setTimeout(settle, 20));
  }
  return false;
}

test('会话归属写入绑定 deviceId，重复写另一台设备被拒绝', async () => {
  const gateway = await startGateway();
  try {
    const nodeA = await pairNode(gateway, 'device-a');
    const nodeB = await pairNode(gateway, 'device-b');
    const wsUrl = gateway.url.replace(/^http/, 'ws') + '/chatdsh/gateway/device-link';
    const deviceA = new EchoDevice(nodeA.deviceId, nodeA.token, wsUrl);
    await deviceA.waitOpen();
    assert.ok(await waitFor(() => gateway.deviceLink.online(nodeA.deviceId)));

    const write = await fetch(`${gateway.url}/chatdsh/gateway/ownership`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-1', deviceId: nodeA.deviceId, cwd: '/work', kind: 'work' }),
    });
    assert.equal(write.status, 200);
    const created = await write.json();
    assert.equal(created.created, true);
    assert.equal(created.deviceId, nodeA.deviceId);
    assert.equal(created.cwd, '/work');
    assert.equal(created.kind, 'work');

    const again = await fetch(`${gateway.url}/chatdsh/gateway/ownership`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-1', deviceId: nodeA.deviceId, cwd: '/other', kind: 'chat' }),
    });
    assert.equal(again.status, 200);
    const idempotent = await again.json();
    assert.equal(idempotent.created, false);
    assert.equal(idempotent.cwd, '/work', '先写入的目录保留');

    const locked = await fetch(`${gateway.url}/chatdsh/gateway/ownership`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-1', deviceId: nodeB.deviceId, cwd: '/work' }),
    });
    assert.equal(locked.status, 409);
    assert.deepEqual(await locked.json(), { error: 'ownership-device-locked' });

    const listed = await (await fetch(`${gateway.url}/chatdsh/gateway/ownership`)).json();
    const record = listed.sessions.find((entry) => entry.sessionId === 'session-1');
    assert.equal(record.deviceId, nodeA.deviceId);

    const unknown = await fetch(`${gateway.url}/chatdsh/gateway/ownership`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-2', deviceId: 'not-a-device', cwd: '/work' }),
    });
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { error: 'device-not-found' });

    const missing = await fetch(`${gateway.url}/chatdsh/gateway/ownership`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-3', cwd: '/work' }),
    });
    assert.equal(missing.status, 400);
    assert.deepEqual(await missing.json(), { error: 'device-id-required' });

    const offline = await fetch(`${gateway.url}/chatdsh/gateway/ownership`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-4', deviceId: nodeB.deviceId, cwd: '/work' }),
    });
    assert.equal(offline.status, 409);
    assert.deepEqual(await offline.json(), { error: 'device-offline' });

    deviceA.socket.close();
  } finally {
    await gateway.close();
  }
});

test('未登记的设备按不存在处理', async () => {
  const gateway = await startGateway();
  try {
    const ownership = await fetch(`${gateway.url}/chatdsh/gateway/ownership`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-x', deviceId: 'node-other', cwd: '/work' }),
    });
    assert.equal(ownership.status, 404);
    assert.deepEqual(await ownership.json(), { error: 'device-not-found' });

    const probe = await fetch(`${gateway.url}/chatdsh/gateway/devices/node-other/probe`);
    assert.equal(probe.status, 404);
  } finally {
    await gateway.close();
  }
});

test('副本上报不改写已有归属的 deviceId', async () => {
  const gateway = await startGateway();
  try {
    const nodeA = await pairNode(gateway, 'device-a');
    const wsUrl = gateway.url.replace(/^http/, 'ws') + '/chatdsh/gateway/device-link';
    const deviceA = new EchoDevice(nodeA.deviceId, nodeA.token, wsUrl);
    await deviceA.waitOpen();
    assert.ok(await waitFor(() => gateway.deviceLink.online(nodeA.deviceId)));

    const write = await fetch(`${gateway.url}/chatdsh/gateway/ownership`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-rep', deviceId: nodeA.deviceId, cwd: '/work' }),
    });
    assert.equal(write.status, 200);

    const replica = await fetch(`${gateway.url}/chatdsh/gateway/replica`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-chatdsh-node-id': 'browser-device' },
      body: JSON.stringify({
        sessionId: 'session-rep',
        events: [{ seq: 0, kind: 'session/created', time: 1, bytes: 2, payload: {} }],
      }),
    });
    assert.equal(replica.status, 200);

    const listed = await (await fetch(`${gateway.url}/chatdsh/gateway/ownership`)).json();
    const record = listed.sessions.find((entry) => entry.sessionId === 'session-rep');
    assert.equal(record.deviceId, nodeA.deviceId, '上报路径不得改写已有归属的 deviceId');

    deviceA.socket.close();
  } finally {
    await gateway.close();
  }
});

test('/d/ 前缀反代保留方法、路径、查询串与请求体', async () => {
  const gateway = await startGateway();
  try {
    const node = await pairNode(gateway, 'device-a');
    const wsUrl = gateway.url.replace(/^http/, 'ws') + '/chatdsh/gateway/device-link';
    const device = new EchoDevice(node.deviceId, node.token, wsUrl);
    await device.waitOpen();
    assert.ok(await waitFor(() => gateway.deviceLink.online(node.deviceId)));

    const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x41]);
    const response = await fetch(`${gateway.url}/d/${node.deviceId}/api/echo?x=1&y=two`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', 'x-probe': 'marker-1' },
      body: bytes,
    });
    assert.equal(response.status, 201, '设备的状态码原样回填');
    assert.equal(response.headers.get('x-from-device'), 'echo');
    const echoed = await response.json();
    assert.equal(echoed.method, 'PUT');
    assert.equal(echoed.path, '/api/echo?x=1&y=two', '路径与查询串原样转发');
    assert.equal(echoed.probeHeader, 'marker-1', '请求头原样转发');
    assert.deepEqual(Buffer.from(echoed.requestBody, 'base64'), bytes, '请求体按字节转发');

    const frame = device.frames.at(-1);
    assert.equal(frame.headers.host, undefined, '不转发 host 头');
    assert.equal(frame.headers['content-type'], 'application/octet-stream', '其余请求头原样转发');

    device.socket.close();
  } finally {
    await gateway.close();
  }
});

test('/d/ 前缀的设备不存在、离线与 WebSocket 升级的拒绝', async () => {
  const gateway = await startGateway();
  try {
    const missing = await fetch(`${gateway.url}/d/not-a-device/healthz`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'device-not-found' });

    const node = await pairNode(gateway, 'device-a');
    const offlineRead = await fetch(`${gateway.url}/d/${node.deviceId}/healthz`);
    assert.equal(offlineRead.status, 409);
    assert.deepEqual(await offlineRead.json(), { error: 'device-offline' });

    const offlineWrite = await fetch(`${gateway.url}/d/${node.deviceId}/api/session/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: {} }),
    });
    assert.equal(offlineWrite.status, 409);
    assert.deepEqual(await offlineWrite.json(), { error: 'device-offline' });

    const url = new URL(gateway.url);
    const socket = net.connect(Number.parseInt(url.port, 10), url.hostname);
    const responseText = await new Promise((resolve, reject) => {
      let text = '';
      socket.on('error', reject);
      socket.on('connect', () => {
        socket.write([
          `GET /d/${node.deviceId}/api/remote.mux HTTP/1.1`,
          `Host: ${url.host}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', // gitleaks:allow
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ].join('\r\n'));
      });
      socket.on('data', (chunk) => {
        text += chunk.toString('utf8');
        if (text.includes('\r\n\r\n')) resolve(text);
      });
    });
    socket.destroy();
    assert.match(responseText, /^HTTP\/1\.1 409 Conflict/m);
    const upgradeBody = JSON.parse(responseText.slice(responseText.indexOf('\r\n\r\n') + 4));
    assert.deepEqual(upgradeBody, { error: 'device-offline' });
  } finally {
    await gateway.close();
  }
});
