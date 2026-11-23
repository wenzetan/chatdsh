// 设备长连接版本 2 的端到端验证：真实 SQLite、真实中继服务、真实设备端客户端。
//
// 本机运行时是一个真实 HTTP 服务：HTTP 端点覆盖分块上传、大响应与取消；WebSocket 端点
// 使用控制平面同一套握手与帧实现，验证 `/api/remote.mux` 的原始帧双向转发。
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempHome } from '../../scripts/lib/cleanup.mjs';
import { createTelemetryClient } from '../../packages/core/diagnostics/lib/client.js';
import { defaultTelemetryConfig } from '../../packages/core/diagnostics/lib/config.js';
import { GatewayStore, PushQueue, ReceiptStore, ReplicaStore, SettingsStore } from '../../gateway/lib/store.js';
import { createPushHub } from '../../gateway/lib/push.js';
import { DeviceLinkHub } from '../../gateway/lib/device-link.js';
import { createGatewayServer } from '../../gateway/lib/server.js';
import { WebSocketConnection, WebSocketHandshake } from '../../gateway/lib/websocket.js';
import { DeviceLinkClient } from '../../packages/host/device-link/lib/index.js';

const PAIRING_CODE = 'pair-device-link-v2';
const LARGE_BYTES = 300 * 1024;
const API_COOKIE = 'dsh-auth-api=api-token';
const PAGE_COOKIE = 'dsh-auth-page=page-token';

/** 起一个完整装配的真实中继服务。 */
async function startGateway(options = {}) {
  const home = tempHome('device-link-v2');
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
    telemetry: { counter: (name, config) => telemetry.counter(name, config) },
  });
  const deviceLink = new DeviceLinkHub({ store, telemetry, ...options.hub });
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
      pairingCode: PAIRING_CODE,
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
    store,
    deviceLink,
    telemetry,
    async close() {
      deviceLink.stop();
      await server.stop();
      await telemetry.shutdown();
      store.close();
    },
  };
}

/** 配对一台设备。 */
async function pairNode(gateway, name) {
  const response = await fetch(`${gateway.url}/chatdsh/gateway/devices/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: PAIRING_CODE, name, platform: 'linux', role: 'both', capabilities: ['shell'] }),
  });
  assert.equal(response.status, 200);
  return await response.json();
}

/** 等一个条件成立。 */
async function waitFor(check, timeoutMs = 5000, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((settle) => setTimeout(settle, intervalMs));
  }
  return false;
}

/** 起一个真实的本机运行时替身：HTTP 与 WebSocket 都按真实协议处理。 */
async function startLocalRuntime() {
  const state = {
    upgrade: undefined,
    wsClosed: false,
    slowStarted: false,
    slowAborted: false,
  };
  const sockets = new Set();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/echo') {
      const body = JSON.stringify({
        method: request.method,
        path: `${url.pathname}${url.search}`,
        cookie: request.headers.cookie ?? null,
        host: request.headers.host ?? null,
        origin: request.headers.origin ?? null,
      });
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(body);
      return;
    }
    if (url.pathname === '/api/whoami') {
      const body = JSON.stringify({
        cookie: request.headers.cookie ?? null,
        host: request.headers.host ?? null,
        origin: request.headers.origin ?? null,
      });
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(body);
      return;
    }
    if (url.pathname === '/large') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('x'.repeat(LARGE_BYTES));
      return;
    }
    if (url.pathname === '/upload') {
      let bytes = 0;
      request.on('data', (chunk) => { bytes += chunk.length; });
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ bytes }));
      });
      return;
    }
    if (url.pathname === '/slow') {
      state.slowStarted = true;
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      const timer = setInterval(() => response.write('chunk'), 20);
      response.on('close', () => {
        clearInterval(timer);
        state.slowAborted = true;
      });
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<html><body>runtime</body></html>');
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (request, socket) => {
    state.upgrade = {
      host: request.headers.host,
      origin: request.headers.origin,
      cookie: request.headers.cookie,
      path: request.url,
    };
    if (typeof request.headers.cookie !== 'string' || !request.headers.cookie.includes(API_COOKIE)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const handshake = WebSocketHandshake.accept(socket, request, []);
    handshake.writeHead();
    const connection = new WebSocketConnection(handshake);
    connection.sendText('ready');
    connection.onText((text) => connection.sendText(`echo:${text}`));
    connection.onBinary((payload) => connection.sendBinary(payload));
    connection.onClose(() => { state.wsClosed = true; });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    authority: `127.0.0.1:${port}`,
    state,
    sockets,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** 造一个设备端客户端。 */
function createClient(gateway, node, local, options = {}) {
  const credential = { origin: local.origin, page: PAGE_COOKIE, api: API_COOKIE };
  return new DeviceLinkClient({
    controlUrl: gateway.url,
    token: node.token,
    deviceId: node.deviceId,
    platform: 'linux',
    role: 'both',
    capabilities: ['http', 'websocket'],
    localOrigin: local.origin,
    credentials: {
      get: async () => credential,
      refresh: async () => credential,
    },
    heartbeatMs: options.heartbeatMs ?? 200,
    deadAfterMs: options.deadAfterMs ?? 3000,
    handshakeTimeoutMs: options.handshakeTimeoutMs ?? 2000,
    headerTimeoutMs: options.headerTimeoutMs ?? 2000,
    idleTimeoutMs: options.idleTimeoutMs ?? 5000,
    reconnectMaxMs: options.reconnectMaxMs ?? 1000,
  });
}

/** 发一次原始升级请求，读取状态与响应体。 */
async function upgradeStatus(url, headers = {}) {
  const target = new URL(url);
  const transport = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return await new Promise((resolve, reject) => {
    const request = transport({
      host: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13',
        ...headers,
      },
      agent: false,
    });
    request.on('upgrade', (response, socket) => {
      socket.destroy();
      resolve({ status: response.statusCode, body: '' });
    });
    request.on('response', (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('版本 2 握手、HTTP 分块与额度窗口、凭据与 Host/Origin 改写', async () => {
  const gateway = await startGateway();
  const local = await startLocalRuntime();
  const node = await pairNode(gateway, 'device-v2');
  const client = createClient(gateway, node, local);
  try {
    client.start();
    const welcome = await client.waitForWelcome(5000);
    assert.equal(welcome.version, 2);
    assert.equal(welcome.deviceId, node.deviceId);
    assert.ok(welcome.generation >= 1);
    assert.equal(welcome.limits.dataPayloadMaxBytes, 32 * 1024);
    assert.ok(await waitFor(() => gateway.deviceLink.online(node.deviceId)));

    const echo = await fetch(`${gateway.url}/d/${node.deviceId}/echo?x=1`);
    assert.equal(echo.status, 200);
    const echoBody = await echo.json();
    assert.equal(echoBody.method, 'GET');
    assert.equal(echoBody.path, '/echo?x=1');
    assert.equal(echoBody.host, local.authority);
    assert.equal(echoBody.origin, local.origin);

    const whoami = await fetch(`${gateway.url}/d/${node.deviceId}/api/whoami`);
    assert.equal(whoami.status, 200);
    const whoamiBody = await whoami.json();
    assert.equal(whoamiBody.cookie, API_COOKIE);
    assert.equal(whoamiBody.host, local.authority);
    assert.equal(whoamiBody.origin, local.origin);

    const large = await fetch(`${gateway.url}/d/${node.deviceId}/large`);
    assert.equal(large.status, 200);
    assert.equal((await large.text()).length, LARGE_BYTES);

    const upload = await fetch(`${gateway.url}/d/${node.deviceId}/upload`, {
      method: 'POST',
      body: 'y'.repeat(LARGE_BYTES),
    });
    assert.equal(upload.status, 200);
    assert.deepEqual(await upload.json(), { bytes: LARGE_BYTES });

    assert.ok(client.stats.maxPayloadBytesSent <= 32 * 1024, '响应分片不超过 32 KiB');
    assert.ok(client.stats.maxPayloadBytesReceived <= 32 * 1024, '请求分片不超过 32 KiB');
    assert.ok(client.stats.dataFramesSent >= 10, '大响应按多帧发送');
    assert.ok(client.stats.dataFramesReceived >= 10, '大请求按多帧接收');
    assert.ok(client.stats.creditFramesSent > 0, '接收方向补充过额度');
    assert.ok(client.stats.creditFramesReceived > 0, '发送方向等待过额度');
  } finally {
    client.stop();
    await local.close();
    await gateway.close();
  }
});

test('取消传播：中继 cancel 中止本机请求并回 cancelled', async () => {
  const gateway = await startGateway();
  const local = await startLocalRuntime();
  const node = await pairNode(gateway, 'device-cancel');
  const client = createClient(gateway, node, local);
  try {
    client.start();
    await client.waitForWelcome(5000);
    assert.ok(await waitFor(() => gateway.deviceLink.online(node.deviceId)));

    const channel = gateway.deviceLink.openChannel(node.deviceId, { kind: 'http', method: 'GET', path: '/slow' });
    channel.sendEnd();
    const accepted = await channel.accepted();
    assert.equal(accepted.status, 200);
    assert.ok(await waitFor(() => local.state.slowStarted));

    channel.cancel('client-closed');
    const finished = await channel.finished();
    assert.equal(finished.code, 'cancelled');
    assert.ok(await waitFor(() => local.state.slowAborted), '本机请求被中止');
    assert.ok(await waitFor(() => gateway.deviceLink.channelCount(node.deviceId) === 0));
  } finally {
    client.stop();
    await local.close();
    await gateway.close();
  }
});

test('WebSocket 隧道：/api/remote.mux 双向收发与断开清理', async () => {
  const gateway = await startGateway();
  const local = await startLocalRuntime();
  const node = await pairNode(gateway, 'device-ws');
  const client = createClient(gateway, node, local);
  try {
    client.start();
    await client.waitForWelcome(5000);
    assert.ok(await waitFor(() => gateway.deviceLink.online(node.deviceId)));

    const url = `${gateway.url.replace(/^http/, 'ws')}/d/${node.deviceId}/api/remote.mux`;
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    const received = [];
    socket.addEventListener('message', (event) => { received.push(event.data); });
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve);
      socket.addEventListener('error', () => reject(new Error('浏览器侧 WebSocket 升级失败')));
    });

    assert.ok(await waitFor(() => received.includes('ready')), '升级后立即下发的数据被转发');
    socket.send('hello');
    assert.ok(await waitFor(() => received.includes('echo:hello')));
    socket.send(Buffer.from([1, 2, 3, 4]));
    assert.ok(await waitFor(() => received.some((value) => typeof value !== 'string'
      && Buffer.from(value).equals(Buffer.from([1, 2, 3, 4])))));

    assert.equal(local.state.upgrade.host, local.authority);
    assert.equal(local.state.upgrade.origin, local.origin);
    assert.equal(local.state.upgrade.cookie, API_COOKIE);
    assert.equal(local.state.upgrade.path, '/api/remote.mux');

    socket.close();
    assert.ok(await waitFor(() => local.state.wsClosed), '本机 WebSocket 已关闭');
    assert.ok(await waitFor(() => gateway.deviceLink.channelCount(node.deviceId) === 0), '中继通道已释放');
    assert.ok(gateway.deviceLink.online(node.deviceId), '设备连接仍然在线');
  } finally {
    client.stop();
    await local.close();
    await gateway.close();
  }
});

test('设备离线回 409 device-offline，非白名单路径回 403 path-invalid', async () => {
  const gateway = await startGateway();
  const local = await startLocalRuntime();
  const offline = await pairNode(gateway, 'device-offline');
  const online = await pairNode(gateway, 'device-online');
  const client = createClient(gateway, online, local);
  try {
    const offlineResult = await upgradeStatus(`${gateway.url}/d/${offline.deviceId}/api/remote.mux`);
    assert.equal(offlineResult.status, 409);
    assert.deepEqual(JSON.parse(offlineResult.body), { error: 'device-offline' });

    client.start();
    await client.waitForWelcome(5000);
    assert.ok(await waitFor(() => gateway.deviceLink.online(online.deviceId)));

    const pathResult = await upgradeStatus(`${gateway.url}/d/${online.deviceId}/other`);
    assert.equal(pathResult.status, 403);
    assert.deepEqual(JSON.parse(pathResult.body), { error: 'path-invalid' });

    const acceptedResult = await upgradeStatus(`${gateway.url}/d/${online.deviceId}/api/remote.mux`);
    assert.equal(acceptedResult.status, 101);
  } finally {
    client.stop();
    await local.close();
    await gateway.close();
  }
});

test('welcome 版本不为 2 时按协议违规断开', async () => {
  let closeInfo;
  const server = createServer();
  server.on('upgrade', (request, socket) => {
    const handshake = WebSocketHandshake.accept(socket, request, []);
    handshake.writeHead();
    const connection = new WebSocketConnection(handshake);
    connection.onText((text) => {
      const frame = JSON.parse(text);
      if (frame.type !== 'hello') return;
      connection.sendText(JSON.stringify({
        type: 'welcome',
        version: 3,
        deviceId: 'probe',
        generation: 1,
        limits: {
          maxChannels: 128,
          sendBufferBytes: 8 * 1024 * 1024,
          initialCreditBytes: 256 * 1024,
          dataPayloadMaxBytes: 32 * 1024,
          frameMaxBytes: 64 * 1024,
        },
      }));
    });
    connection.onClose((info) => { closeInfo = info; });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const client = new DeviceLinkClient({
    controlUrl: `http://127.0.0.1:${port}`,
    token: 'probe-token',
    deviceId: 'probe',
    platform: 'linux',
    role: 'both',
    capabilities: ['http', 'websocket'],
    localOrigin: 'http://127.0.0.1:1',
    credentials: {
      get: async () => ({ origin: 'http://127.0.0.1:1', page: PAGE_COOKIE, api: API_COOKIE }),
      refresh: async () => ({ origin: 'http://127.0.0.1:1', page: PAGE_COOKIE, api: API_COOKIE }),
    },
    heartbeatMs: 1000,
    deadAfterMs: 5000,
    handshakeTimeoutMs: 2000,
    reconnectMaxMs: 60_000,
  });
  try {
    client.start();
    assert.ok(await waitFor(() => closeInfo !== undefined, 3000));
    assert.equal(closeInfo.code, 4003);
    assert.match(closeInfo.reason ?? '', /protocol-version-unsupported/);
    assert.equal(client.online, false);
  } finally {
    client.stop();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('心跳：设备按间隔发 ping，收到 pong 后保持在线；失联按阈值断开', async () => {
  const gateway = await startGateway({ hub: { heartbeatMs: 40, deadAfterMs: 500 } });
  const local = await startLocalRuntime();
  const node = await pairNode(gateway, 'device-heartbeat');
  const client = createClient(gateway, node, local, { heartbeatMs: 40, deadAfterMs: 500 });
  try {
    client.start();
    await client.waitForWelcome(5000);
    await new Promise((settle) => setTimeout(settle, 300));
    assert.ok(client.stats.pingsSent > 0, '设备发出过心跳');
    assert.ok(client.stats.pongsReceived > 0, '中继回应过心跳');
    assert.ok(client.stats.pingsReceived > 0, '设备收到过中继心跳');
    assert.equal(client.online, true);
  } finally {
    client.stop();
    await local.close();
    await gateway.close();
  }

  let pings = 0;
  let closeInfo;
  const server = createServer();
  server.on('upgrade', (request, socket) => {
    const handshake = WebSocketHandshake.accept(socket, request, []);
    handshake.writeHead();
    const connection = new WebSocketConnection(handshake);
    connection.onText((text) => {
      const frame = JSON.parse(text);
      if (frame.type === 'hello') {
        connection.sendText(JSON.stringify({
          type: 'welcome',
          version: 2,
          deviceId: 'probe',
          generation: 1,
          limits: {
            maxChannels: 128,
            sendBufferBytes: 8 * 1024 * 1024,
            initialCreditBytes: 256 * 1024,
            dataPayloadMaxBytes: 32 * 1024,
            frameMaxBytes: 64 * 1024,
          },
        }));
      }
      if (frame.type === 'ping') pings += 1;
    });
    connection.onClose((info) => { closeInfo = info; });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const silent = new DeviceLinkClient({
    controlUrl: `http://127.0.0.1:${port}`,
    token: 'probe-token',
    deviceId: 'probe',
    platform: 'linux',
    role: 'both',
    capabilities: ['http', 'websocket'],
    localOrigin: 'http://127.0.0.1:1',
    credentials: {
      get: async () => ({ origin: 'http://127.0.0.1:1', page: PAGE_COOKIE, api: API_COOKIE }),
      refresh: async () => ({ origin: 'http://127.0.0.1:1', page: PAGE_COOKIE, api: API_COOKIE }),
    },
    heartbeatMs: 30,
    deadAfterMs: 90,
    handshakeTimeoutMs: 2000,
    reconnectMaxMs: 60_000,
  });
  try {
    silent.start();
    assert.ok(await waitFor(() => closeInfo !== undefined, 3000));
    assert.equal(closeInfo.code, 4002);
    assert.ok(pings > 0, '设备在失联前发出过心跳');
    assert.equal(silent.online, false);
  } finally {
    silent.stop();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('设备断开后浏览器隧道关闭，设备回到离线状态', async () => {
  const gateway = await startGateway();
  const local = await startLocalRuntime();
  const node = await pairNode(gateway, 'device-disconnect');
  const client = createClient(gateway, node, local);
  try {
    client.start();
    await client.waitForWelcome(5000);
    assert.ok(await waitFor(() => gateway.deviceLink.online(node.deviceId)));

    const url = `${gateway.url.replace(/^http/, 'ws')}/d/${node.deviceId}/api/remote.mux`;
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve);
      socket.addEventListener('error', () => reject(new Error('浏览器侧 WebSocket 升级失败')));
    });
    const closed = new Promise((resolve) => socket.addEventListener('close', resolve));

    client.stop();
    await closed;
    assert.ok(await waitFor(() => !gateway.deviceLink.online(node.deviceId)), '设备已离线');
    assert.equal(gateway.deviceLink.channelCount(node.deviceId), 0);
    assert.ok(await waitFor(() => local.state.wsClosed), '本机 WebSocket 已释放');
  } finally {
    client.stop();
    await local.close();
    await gateway.close();
  }
});
