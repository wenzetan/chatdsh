// WP23 验收：设备配对、分组、撤销与链路检查宿主。
//
// 控制平面是完整装配的真实 HTTP 服务：真实 SQLite、真实 WebSocket 升级与真实 SSE 流。
// 设备侧按版本 2 的帧协议接入长连接，访问客户端与管理请求走真实 HTTP。每个用例使用独立
// 数据根，退出时释放。
//
// 运行：node --test e2e/unit/client-complete-wp23-devices.test.mjs

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { GatewayStore, ReplicaStore } from '../../gateway/lib/store.js';
import { DeviceLinkHub } from '../../gateway/lib/device-link.js';
import {
  DeviceLifecycle,
  DeviceTransportRegistry,
  PairingService,
  createDeviceHost,
  DEVICE_LINK_CHECK_PATH,
  DEVICE_LIST_PATH,
  DEVICE_PAIR_PATH,
  DEVICE_PAIRING_PATH,
  DEVICE_REVOKE_PATH,
  DEVICE_SOCKET_PATH,
  DEVICE_STREAM_PATH,
  DEVICE_WAIT_PATH,
} from '../../gateway/lib/devices/index.js';
import { createTelemetryClient } from '../../packages/core/diagnostics/lib/client.js';
import { defaultTelemetryConfig } from '../../packages/core/diagnostics/lib/config.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');

/** 关闭遥测的客户端；需要观察遥测的用例传入自己的实例。 */
function silentTelemetry() {
  return createTelemetryClient({
    config: defaultTelemetryConfig({ surface: 'gateway' }),
    component: '@chatdsh/gateway',
    env: { CHATDSH_TELEMETRY: 'off' },
  });
}

/** 认证头。 */
function authHeaders(token) {
  return { authorization: `Bearer ${token}` };
}

/** 直接登记一台访问客户端，返回它的令牌。 */
function seedAccess(store, id, name = id) {
  const token = randomBytes(32).toString('base64url');
  store.registerMobileDevice({ id, name, platform: 'linux', tokenHash: hash(token) });
  return token;
}

/** 直接登记一台执行节点，返回它的令牌。 */
function seedNode(store, id, role = 'both') {
  const token = randomBytes(32).toString('base64url');
  store.registerNode({ id, name: id, platform: 'linux', role, capabilities: [], tokenHash: hash(token) });
  return token;
}

/** 等待一个条件成立。 */
async function waitFor(predicate, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (predicate() === false) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('等待条件超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 读一次 SSE；流结束时返回真。 */
async function streamEnded(reader) {
  try {
    const next = await reader.read();
    return next.done === true;
  } catch {
    return true;
  }
}

/** 发一次配对请求。 */
function pair(app, code, overrides = {}) {
  return fetch(`${app.origin}${DEVICE_PAIR_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      controlUrl: app.origin,
      code,
      name: '节点',
      platform: 'linux',
      role: 'both',
      ...overrides,
    }),
  });
}

/** 收纳 OTLP 请求体的本机接收端。 */
async function startCollector() {
  const bodies = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{}');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    bodies,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

/** 起一个真实装配的控制平面。 */
async function startApp(options = {}) {
  const home = allocateIndependentHome('wp23-devices');
  const store = new GatewayStore(join(home, 'gateway.sqlite'));
  const replica = new ReplicaStore(store.handle());
  const telemetry = options.telemetry ?? silentTelemetry();
  const transports = new DeviceTransportRegistry();
  const deviceLink = new DeviceLinkHub({
    store,
    telemetry,
    heartbeatMs: 1000,
    deadAfterMs: 5000,
    requestTimeoutMs: 3000,
  });
  const pairing = new PairingService(options.pairing ?? {});
  const state = { lifecycle: undefined };
  const upgraded = new Set();
  let host;

  const server = createServer(async (request, response) => {
    if (host !== undefined && await host.handle(request, response)) return;
    response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ error: 'object-not-found' }));
  });
  server.on('upgrade', (request, socket, head) => {
    upgraded.add(socket);
    socket.once('close', () => upgraded.delete(socket));
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    if (path === '/chatdsh/gateway/device-link') {
      deviceLink.handleUpgrade(request, socket);
      return;
    }
    if (host !== undefined && host.handleUpgrade(request, socket, head)) return;
    socket.destroy();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const lifecycle = new DeviceLifecycle({
    store,
    telemetry,
    deviceLink,
    transports,
    pairing,
    controlUrl: origin,
    ...(options.currentExecutorId === undefined ? {} : { currentExecutorId: options.currentExecutorId }),
    linkCheckTimeoutMs: options.linkCheckTimeoutMs ?? 2000,
  });
  state.lifecycle = lifecycle;
  host = createDeviceHost({
    lifecycle,
    telemetry,
    transports,
    controlUrl: origin,
    streamHeartbeatMs: options.streamHeartbeatMs ?? 30,
    waitTimeoutMs: options.waitTimeoutMs ?? 5000,
  });
  const controlId = options.controlId ?? 'control';
  const controlToken = seedAccess(store, controlId, '验收访问客户端');
  return {
    home,
    origin,
    store,
    replica,
    telemetry,
    transports,
    deviceLink,
    pairing,
    lifecycle,
    controlId,
    controlToken,
    headers: authHeaders(controlToken),
    async close() {
      host.stop();
      deviceLink.stop();
      for (const socket of [...upgraded]) socket.destroy();
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await telemetry.shutdown();
      store.close();
      releaseIndependentHome(home);
    },
  };
}

/** 按版本 2 帧协议接入的执行节点。 */
class TestDevice {
  constructor(app, token, deviceId) {
    this.frames = [];
    this.waiters = new Set();
    const url = `${app.origin.replace(/^http/, 'ws')}/chatdsh/gateway/device-link`;
    this.socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    this.closed = new Promise((resolve) => {
      this.socket.addEventListener('close', (event) => resolve(event));
    });
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => {
        this.send({ type: 'hello', version: 2, deviceId, platform: 'linux', role: 'both', capabilities: ['shell'] });
        resolve();
      });
      this.socket.addEventListener('error', () => reject(new Error('设备长连接失败')));
      this.socket.addEventListener('message', (event) => {
        const frame = JSON.parse(event.data);
        this.frames.push(frame);
        if (frame.type === 'ping') this.send({ type: 'pong', generation: frame.generation, nonce: frame.nonce });
        if (frame.type === 'open') {
          this.send({ type: 'accepted', channelId: frame.channelId, generation: frame.generation, status: 200, headers: {} });
          this.send({ type: 'end', channelId: frame.channelId, generation: frame.generation, lastSeq: 0 });
        }
        if (frame.type === 'cancel') {
          this.send({ type: 'cancelled', channelId: frame.channelId, generation: frame.generation, reason: frame.reason });
        }
        for (const waiter of [...this.waiters]) waiter(frame);
      });
    });
    void this.opened.catch(() => undefined);
  }

  send(frame) {
    this.socket.send(JSON.stringify(frame));
  }

  waitFrame(predicate, timeoutMs = 3000) {
    const seen = this.frames.find((frame) => predicate(frame));
    if (seen !== undefined) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`等待帧超时，已收到：${this.frames.map((frame) => frame.type).join('、')}`));
      }, timeoutMs);
      const waiter = (frame) => {
        if (!predicate(frame)) return;
        clearTimeout(timer);
        this.waiters.delete(waiter);
        resolve(frame);
      };
      this.waiters.add(waiter);
    });
  }

  close() {
    this.socket.close();
  }
}

test('配对码一次使用：返回设备与访问凭据，令牌只存摘要', async () => {
  const app = await startApp({ currentExecutorId: 'host-node' });
  try {
    seedNode(app.store, 'host-node', 'host');
    const issuedResponse = await fetch(`${app.origin}${DEVICE_PAIRING_PATH}`, { headers: app.headers });
    assert.equal(issuedResponse.status, 200);
    assert.equal(issuedResponse.headers.get('cache-control'), 'no-store');
    const issued = await issuedResponse.json();
    assert.equal(issued.kind, 'manual');
    assert.equal(issued.controlUrl, app.origin);
    assert.match(issued.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.ok(issued.expiresAt > Date.now());
    const decoded = JSON.parse(Buffer.from(issued.encoded, 'base64url').toString('utf8'));
    assert.equal(decoded.pairingCode, issued.code);
    assert.equal(decoded.controlUrl, app.origin);
    const qr = await (await fetch(`${app.origin}${DEVICE_PAIRING_PATH}?kind=qr`, { headers: app.headers })).json();
    assert.equal(qr.kind, 'qr');
    assert.equal((await fetch(`${app.origin}${DEVICE_PAIRING_PATH}`)).status, 401);

    const wrong = await pair(app, 'AAAA-AAAA-AAAA-AAAA');
    assert.equal(wrong.status, 401);
    assert.equal((await wrong.json()).error, 'pairing-code-invalid');

    const paired = await pair(app, issued.code, { name: '节点甲' });
    assert.equal(paired.status, 200);
    assert.equal(paired.headers.get('cache-control'), 'no-store');
    const body = await paired.json();
    assert.equal(body.role, 'both');
    assert.equal(body.device.name, '节点甲');
    assert.equal(body.device.online, false);
    assert.equal(body.device.currentExecutor, false);
    assert.deepEqual(body.device.capabilities, []);
    assert.equal(body.deviceId, body.device.id);
    assert.ok(body.nodeToken.length >= 32);
    assert.ok(body.pairedAt > 0);

    const reused = await pair(app, issued.code, { name: '节点乙' });
    assert.equal(reused.status, 403);
    assert.equal((await reused.json()).error, 'pairing-code-expired');
    assert.equal(app.store.listNodes().some((record) => record.name === '节点乙'), false);

    const row = app.store.handle().prepare('select token_hash from node_devices where id = ?').get(body.device.id);
    assert.equal(row.token_hash, hash(body.nodeToken));
    assert.notEqual(row.token_hash, body.nodeToken);
    assert.equal(app.store.nodeByTokenHash(hash(body.nodeToken)).id, body.device.id);

    const asAccess = await (await fetch(`${app.origin}${DEVICE_LIST_PATH}`, { headers: app.headers })).json();
    assert.deepEqual(asAccess.accessClients.find((client) => client.id === 'control').current, true);
    assert.equal(asAccess.nodes.find((node) => node.id === body.device.id).currentExecutor, false);
    assert.equal(asAccess.nodes.find((node) => node.id === 'host-node').currentExecutor, true);
    assert.equal(JSON.stringify(asAccess).includes(body.nodeToken), false);
    assert.equal(JSON.stringify(asAccess).includes(hash(body.nodeToken)), false);

    const asNode = await (await fetch(`${app.origin}${DEVICE_LIST_PATH}`, { headers: authHeaders(body.nodeToken) })).json();
    assert.equal(asNode.nodes.find((node) => node.id === body.device.id).currentExecutor, true);
    assert.equal(asNode.nodes.find((node) => node.id === 'host-node').currentExecutor, false);
    assert.equal(asNode.accessClients.find((client) => client.id === 'control').current, false);
  } finally {
    await app.close();
  }
});

test('配对码过期、失败尝试上限与等待期、目标地址核对', async () => {
  const app = await startApp({ pairing: { ttlMs: 800, attemptLimit: 3, lockoutMs: 150 } });
  try {
    const issue = async () => (await (await fetch(`${app.origin}${DEVICE_PAIRING_PATH}`, { headers: app.headers })).json());
    const shortLived = await issue();
    await new Promise((resolve) => setTimeout(resolve, 900));
    const expired = await pair(app, shortLived.code, { name: '过期节点' });
    assert.equal(expired.status, 403);
    assert.equal((await expired.json()).error, 'pairing-code-expired');

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const failed = await pair(app, 'BBBB-BBBB-BBBB-BBBB', { name: '错误节点' });
      assert.equal(failed.status, 401);
      assert.equal((await failed.json()).error, 'pairing-code-invalid');
    }
    const duringLock = await issue();
    const limited = await pair(app, duringLock.code, { name: '限流节点' });
    assert.equal(limited.status, 429);
    const limitedBody = await limited.json();
    assert.equal(limitedBody.error, 'pairing-rate-limited');
    assert.ok(limitedBody.retryAfterMs > 0);
    assert.equal(limited.headers.get('retry-after'), '1');

    await new Promise((resolve) => setTimeout(resolve, 220));
    const afterWait = await pair(app, duringLock.code, { name: '等待结束节点' });
    assert.equal(afterWait.status, 200);

    const mismatch = await issue();
    const rejected = await pair(app, mismatch.code, { controlUrl: 'http://127.0.0.1:1', name: '错址节点' });
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).error, 'origin-rejected');
    assert.equal(app.pairing.pendingCount(), 1);
  } finally {
    await app.close();
  }
});

test('访问客户端与执行节点分组展示，普通设备标识头不能当作认证凭据', async () => {
  const app = await startApp();
  try {
    const onlyIdentity = await fetch(`${app.origin}${DEVICE_LIST_PATH}`, {
      headers: { 'x-chatdsh-device-id': app.controlId },
    });
    assert.equal(onlyIdentity.status, 401);
    assert.equal((await onlyIdentity.json()).error, 'device-token-required');

    const forged = await fetch(`${app.origin}${DEVICE_LIST_PATH}`, {
      headers: { authorization: `Bearer ${randomBytes(32).toString('base64url')}` },
    });
    assert.equal(forged.status, 401);
    assert.equal((await forged.json()).error, 'device-token-invalid');

    const identityWithToken = await fetch(`${app.origin}${DEVICE_LIST_PATH}`, {
      headers: { ...app.headers, 'x-chatdsh-device-id': 'another-device' },
    });
    const list = await identityWithToken.json();
    assert.equal(list.accessClients.find((client) => client.id === 'control').current, true);
    assert.equal(list.accessClients.some((client) => client.id === 'another-device'), false);

    const viaTokenHeader = await fetch(`${app.origin}${DEVICE_LIST_PATH}`, {
      headers: { 'x-chatdsh-device-token': app.controlToken },
    });
    assert.equal(viaTokenHeader.status, 200);

    const revokedAccessToken = seedAccess(app.store, 'reader', '第二客户端');
    await fetch(`${app.origin}${DEVICE_REVOKE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...app.headers },
      body: JSON.stringify({ deviceId: 'reader', reason: 'lost' }),
    });
    const revokedList = await fetch(`${app.origin}${DEVICE_LIST_PATH}`, { headers: authHeaders(revokedAccessToken) });
    assert.equal(revokedList.status, 401);
    assert.equal((await revokedList.json()).error, 'device-token-invalid');

    const wrongMethod = await fetch(`${app.origin}${DEVICE_LIST_PATH}`, { method: 'POST', headers: app.headers });
    assert.equal(wrongMethod.status, 405);
    assert.equal((await wrongMethod.json()).error, 'request-invalid');
  } finally {
    await app.close();
  }
});

test('撤销立即关闭 HTTP 请求、WebSocket、SSE 与设备长连接，会话与副本保留', async () => {
  const app = await startApp();
  try {
    const issued = await (await fetch(`${app.origin}${DEVICE_PAIRING_PATH}`, { headers: app.headers })).json();
    const paired = await (await pair(app, issued.code, { name: '执行节点' })).json();
    const nodeId = paired.deviceId;
    const nodeToken = paired.nodeToken;
    app.store.upsertSession({ sessionId: 'session-wp23', deviceId: nodeId, cwd: '/workspace/project', kind: 'work', createdAt: 1 });
    app.replica.append('session-wp23', [{ seq: 0, kind: 'user/message', time: 1, bytes: 4, payload: { data: { text: '保留' } } }]);

    const device = new TestDevice(app, nodeToken, nodeId);
    try {
      await device.opened;
      await device.waitFrame((frame) => frame.type === 'welcome');
      assert.equal(app.deviceLink.online(nodeId), true);

      const streamResponse = await fetch(`${app.origin}${DEVICE_STREAM_PATH}`, { headers: authHeaders(nodeToken) });
      assert.equal(streamResponse.status, 200);
      assert.match(streamResponse.headers.get('content-type'), /text\/event-stream/);
      const reader = streamResponse.body.getReader();
      const ready = new TextDecoder().decode((await reader.read()).value);
      assert.match(ready, /event: ready/);

      const waitOutcome = fetch(`${app.origin}${DEVICE_WAIT_PATH}?timeoutMs=15000`, {
        headers: authHeaders(nodeToken),
      }).then(() => 'resolved', () => 'rejected');

      const socket = new WebSocket(`${app.origin.replace(/^http/, 'ws')}${DEVICE_SOCKET_PATH}`, {
        headers: authHeaders(nodeToken),
      });
      const socketReady = new Promise((resolve, reject) => {
        socket.addEventListener('message', (event) => resolve(JSON.parse(event.data)));
        socket.addEventListener('error', () => reject(new Error('设备通道升级失败')));
      });
      const socketClosed = new Promise((resolve) => socket.addEventListener('close', resolve));
      assert.equal((await socketReady).deviceId, nodeId);

      await waitFor(() => {
        const counts = app.transports.counts(nodeId);
        return counts.sse === 1 && counts.http === 1 && counts.websocket === 1;
      });

      const revoke = await fetch(`${app.origin}${DEVICE_REVOKE_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...app.headers },
        body: JSON.stringify({ deviceId: nodeId, reason: 'lost' }),
      });
      assert.equal(revoke.status, 200);
      const revokeBody = await revoke.json();
      assert.equal(revokeBody.deviceId, nodeId);
      assert.equal(revokeBody.sessionsPreserved, true);
      assert.ok(revokeBody.closedLinks >= 4, `关闭的通道数量：${revokeBody.closedLinks}`);
      assert.ok(revokeBody.revokedAt > 0);

      assert.equal(await streamEnded(reader), true);
      assert.equal(await waitOutcome, 'rejected');
      await socketClosed;
      await device.closed;
      await waitFor(() => app.deviceLink.online(nodeId) === false);

      assert.equal(app.store.listSessions().length, 1);
      assert.equal(app.store.listSessions()[0].sessionId, 'session-wp23');
      assert.equal(app.replica.read('session-wp23').length, 1);
      assert.equal(app.replica.watermarkOf('session-wp23'), 0);

      const afterRevoke = await fetch(`${app.origin}${DEVICE_LIST_PATH}`, { headers: authHeaders(nodeToken) });
      assert.equal(afterRevoke.status, 401);
      assert.equal((await afterRevoke.json()).error, 'device-token-revoked');

      const rejectedSocket = new WebSocket(`${app.origin.replace(/^http/, 'ws')}${DEVICE_SOCKET_PATH}`, {
        headers: authHeaders(nodeToken),
      });
      const rejectedOutcome = await new Promise((resolve) => {
        rejectedSocket.addEventListener('open', () => resolve('open'));
        rejectedSocket.addEventListener('error', () => resolve('error'));
        rejectedSocket.addEventListener('close', () => resolve('closed'));
      });
      assert.notEqual(rejectedOutcome, 'open');

      const again = await fetch(`${app.origin}${DEVICE_REVOKE_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...app.headers },
        body: JSON.stringify({ deviceId: nodeId, reason: 'lost' }),
      });
      assert.equal(again.status, 409);
      assert.equal((await again.json()).error, 'already-handled');

      const check = await fetch(`${app.origin}${DEVICE_LINK_CHECK_PATH}?deviceId=${encodeURIComponent(nodeId)}`, { headers: app.headers });
      const checkBody = await check.json();
      assert.equal(checkBody.reachable, false);
      assert.equal(checkBody.code, 'device-token-revoked');

      const listed = await (await fetch(`${app.origin}${DEVICE_LIST_PATH}`, { headers: app.headers })).json();
      assert.ok(listed.nodes.find((node) => node.id === nodeId).revokedAt > 0);

      const rejectedDevice = new TestDevice(app, nodeToken, nodeId);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(app.deviceLink.online(nodeId), false);
      rejectedDevice.close();
    } finally {
      device.close();
    }
  } finally {
    await app.close();
  }
});

test('链路检查给出在线状态、往返耗时与不可达原因', async () => {
  const app = await startApp();
  try {
    const issued = await (await fetch(`${app.origin}${DEVICE_PAIRING_PATH}`, { headers: app.headers })).json();
    const node = await (await pair(app, issued.code, { name: '检查组节点' })).json();

    const unknown = await fetch(`${app.origin}${DEVICE_LINK_CHECK_PATH}?deviceId=missing`, { headers: app.headers });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error, 'device-unknown');

    const offline = await (await fetch(`${app.origin}${DEVICE_LINK_CHECK_PATH}?deviceId=${encodeURIComponent(node.deviceId)}`, { headers: app.headers })).json();
    assert.equal(offline.reachable, false);
    assert.equal(offline.code, 'device-offline');
    assert.equal(offline.latencyMs, undefined);

    const accessTarget = await fetch(`${app.origin}${DEVICE_LINK_CHECK_PATH}?deviceId=${app.controlId}`, { headers: app.headers });
    assert.equal(accessTarget.status, 400);
    assert.equal((await accessTarget.json()).error, 'device-role-mismatch');

    const duplicated = await fetch(`${app.origin}${DEVICE_LINK_CHECK_PATH}?deviceId=${encodeURIComponent(node.deviceId)}&deviceId=other`, { headers: app.headers });
    assert.equal(duplicated.status, 400);
    assert.equal((await duplicated.json()).error, 'request-invalid');

    assert.equal((await fetch(`${app.origin}${DEVICE_LINK_CHECK_PATH}?deviceId=${encodeURIComponent(node.deviceId)}`)).status, 401);

    const device = new TestDevice(app, node.nodeToken, node.deviceId);
    try {
      await device.opened;
      await device.waitFrame((frame) => frame.type === 'welcome');
      const online = await (await fetch(`${app.origin}${DEVICE_LINK_CHECK_PATH}?deviceId=${encodeURIComponent(node.deviceId)}`, { headers: app.headers })).json();
      assert.equal(online.reachable, true);
      assert.ok(Number.isInteger(online.latencyMs));
      assert.ok(online.latencyMs >= 0);
      assert.equal(online.code, undefined);
      device.close();
      await device.closed;
      await waitFor(() => app.deviceLink.online(node.deviceId) === false);
      const afterClose = await (await fetch(`${app.origin}${DEVICE_LINK_CHECK_PATH}?deviceId=${encodeURIComponent(node.deviceId)}`, { headers: app.headers })).json();
      assert.equal(afterClose.reachable, false);
      assert.equal(afterClose.code, 'device-offline');
    } finally {
      device.close();
    }
  } finally {
    await app.close();
  }
});

test('配对、撤销与链路检查的 span、事件与计数进入真实导出管道', async () => {
  const collector = await startCollector();
  const telemetry = createTelemetryClient({
    config: defaultTelemetryConfig({
      surface: 'gateway',
      endpoint: collector.url,
      exportIntervalMs: 200,
      exportIntervalMsMetrics: 200,
      exportTimeoutMs: 100,
    }),
    component: '@chatdsh/gateway',
    env: {
      CHATDSH_TELEMETRY_ENDPOINT: collector.url,
      CHATDSH_TELEMETRY_USER: 'probe',
      CHATDSH_TELEMETRY_PASSWORD: 'probe',
    },
  });
  const app = await startApp({ telemetry });
  try {
    const issued = await (await fetch(`${app.origin}${DEVICE_PAIRING_PATH}`, { headers: app.headers })).json();
    await pair(app, 'CCCC-CCCC-CCCC-CCCC', { name: '错误节点' });
    const paired = await (await pair(app, issued.code, { name: '遥测节点' })).json();
    await fetch(`${app.origin}${DEVICE_LINK_CHECK_PATH}?deviceId=${encodeURIComponent(paired.deviceId)}`, { headers: app.headers });
    await fetch(`${app.origin}${DEVICE_REVOKE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...app.headers },
      body: JSON.stringify({ deviceId: paired.deviceId, reason: 'rotate' }),
    });
    await telemetry.flush(3000);
    const text = collector.bodies.join('\n');
    for (const name of [
      'chatdsh.gateway.device.pair',
      'chatdsh.gateway.device.request',
      'chatdsh.gateway.mobile.devices',
      'chatdsh.gateway.mobile.pairing',
    ]) {
      assert.equal(text.includes(name), true, `缺少 span ${name}`);
    }
    assert.equal(text.includes('chatdsh.gateway.device.rejected'), true);
    for (const metric of [
      'chatdsh_gateway_device_pairs_total',
      'chatdsh_gateway_device_requests_total',
      'chatdsh_mobile_devices_total',
    ]) {
      assert.equal(text.includes(metric), true, `缺少计数 ${metric}`);
    }
    assert.equal(text.includes(paired.nodeToken), false, '遥测不携带节点令牌');
  } finally {
    await app.close();
    await collector.close();
  }
});
