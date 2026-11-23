// 设备层的单元级验证：帧编解码、节点配对、在线表与心跳超时。
//
// 帧编解码用真实套接字验证：客户端帧带掩码、服务端帧不带掩码、长度按 125、65535 分档。
// 在线状态与转发用真实 WebSocket 客户端按帧协议收发，控制平面是完整装配的真实 HTTP 服务。
import net from 'node:net';
import { createServer } from 'node:http';
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
import { WebSocketConnection, WebSocketHandshake } from '../../gateway/lib/websocket.js';

/** WebSocket 握手用的固定 GUID。 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 起一个完整装配的控制平面。 */
async function startGateway(options = {}) {
  const home = tempHome('device-link');
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
      pairingCode: 'pair-nodes',
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
    body: JSON.stringify({ code: 'pair-nodes', name, platform: 'linux', role: 'both', capabilities: ['shell'] }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok(typeof payload.token === 'string' && payload.token.length > 20);
  return payload;
}

/**
 * 按帧协议连上的设备。
 *
 * 线上真实设备是 dsh 运行时里的插件；这里用同一套帧协议的最小客户端，覆盖在线表、
 * 转发与心跳三类行为。
 */
class TestDevice {
  constructor(deviceId, token, url) {
    this.deviceId = deviceId;
    this.token = token;
    this.url = url;
    this.received = [];
    this.closed = false;
    this.opened = new Promise((resolve, reject) => {
      this.socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
      this.socket.addEventListener('open', () => {
        this.socket.send(JSON.stringify({
          type: 'hello',
          deviceId,
          platform: 'linux',
          role: 'both',
          capabilities: ['shell'],
        }));
        resolve();
      });
      this.socket.addEventListener('error', () => reject(new Error('连接失败')));
      this.socket.addEventListener('message', (event) => {
        const frame = JSON.parse(event.data);
        this.received.push(frame);
        if (frame.type === 'ping') this.socket.send(JSON.stringify({ type: 'pong' }));
        if (frame.type === 'request') {
          const body = Buffer.from(JSON.stringify({ ok: true, path: frame.path }), 'utf8').toString('base64');
          this.socket.send(JSON.stringify({
            type: 'response',
            requestId: frame.requestId,
            status: 200,
            headers: { 'content-type': 'application/json' },
            body,
          }));
        }
      });
      this.socket.addEventListener('close', () => {
        this.closed = true;
      });
    });
  }

  async waitOpen() {
    await this.opened;
  }

  close() {
    this.socket.close();
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

/** 编一帧客户端消息：客户端帧必须带掩码。 */
function clientFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const mask = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);
  const header = [];
  const length = payload.length;
  header.push(0x81);
  if (length < 126) {
    header.push(0x80 | length);
  } else if (length < 65536) {
    header.push(0x80 | 126);
    header.push((length >> 8) & 0xff, length & 0xff);
  } else {
    header.push(0x80 | 127);
    const big = Buffer.alloc(8);
    big.writeBigUInt64BE(BigInt(length), 0);
    header.push(...big);
  }
  header.push(...mask);
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = payload[index] ^ mask[index % 4];
  }
  return Buffer.concat([Buffer.from(header), masked]);
}

test('帧编解码：带掩码的客户端帧按 16 位与 64 位长度分档还原', async () => {
  const received = [];
  let upstreamSocket;
  const server = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  server.on('upgrade', (request, socket) => {
    upstreamSocket = socket;
    const handshake = WebSocketHandshake.accept(socket, request, []);
    handshake.writeHead();
    const connection = new WebSocketConnection(handshake);
    connection.onText((payload) => {
      received.push(payload.length);
      connection.sendText(payload);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  // 升级后的套接字不受 server.close 追踪，这里不让监听句柄拖住进程。
  server.unref();
  const port = server.address().port;
  const socket = net.connect(port, '127.0.0.1');
  let handshakeText = '';
  const upgraded = new Promise((resolve) => {
    socket.on('data', (chunk) => {
      if (handshakeText.includes('\r\n\r\n')) return;
      handshakeText += chunk.toString('utf8');
      if (handshakeText.includes('\r\n\r\n')) resolve();
    });
  });
  socket.on('connect', () => {
    socket.write([
      'GET /wiki HTTP/1.1',
      `Host: 127.0.0.1:${port}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', // gitleaks:allow
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ].join('\r\n'));
  });
  await upgraded;
  assert.match(handshakeText, /^HTTP\/1\.1 101 Switching Protocols/m);
  const expectedAccept = 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=';
  assert.ok(handshakeText.includes(`Sec-WebSocket-Accept: ${expectedAccept}`), `握手接受值应当按 GUID ${WS_GUID} 计算`);

  const small = 'a'.repeat(20);
  const medium = 'b'.repeat(200);
  const large = 'c'.repeat(70000);
  socket.write(clientFrame(small));
  socket.write(clientFrame(medium));
  socket.write(clientFrame(large));

  const echoed = [];
  let buffer = Buffer.alloc(0);
  const done = new Promise((resolve) => {
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 2) return;
        const length7 = buffer[1] & 0x7f;
        let length = length7;
        let offset = 2;
        if (length7 === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length7 === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        if (buffer.length < offset + length) return;
        echoed.push(buffer.subarray(offset, offset + length).toString('utf8'));
        buffer = buffer.subarray(offset + length);
        if (echoed.length === 3) resolve();
      }
    });
  });
  await done;
  socket.destroy();
  upstreamSocket?.destroy();
  server.close();

  assert.deepEqual(received, [20, 200, 70000]);
  assert.equal(echoed[0], small);
  assert.equal(echoed[1], medium);
  assert.equal(echoed[2], large);
});

test('节点配对、设备列表与链路自检', async () => {
  const gateway = await startGateway();
  try {
    const node = await pairNode(gateway, 'device-a');
    assert.ok(typeof node.deviceId === 'string');
    // 令牌只出现这一次：库里存的是摘要，按原始令牌能查到设备。
    assert.equal(gateway.store.nodeByTokenHash('not-the-token'), undefined);

    const initial = await (await fetch(`${gateway.url}/chatdsh/gateway/devices`)).json();
    const listed = initial.devices.find((device) => device.id === node.deviceId);
    assert.ok(listed !== undefined);
    assert.equal(listed.online, false);
    assert.equal(listed.name, 'device-a');
    assert.equal(listed.platform, 'linux');
    assert.equal(listed.role, 'both');
    assert.deepEqual(listed.capabilities, ['shell']);

    const offlineProbe = await fetch(`${gateway.url}/chatdsh/gateway/devices/${node.deviceId}/probe`);
    assert.equal(offlineProbe.status, 409);
    assert.deepEqual(await offlineProbe.json(), { error: 'device-offline' });

    const device = new TestDevice(node.deviceId, node.token, gateway.url.replace(/^http/, 'ws') + '/chatdsh/gateway/device-link');
    await device.waitOpen();
    assert.ok(await waitFor(() => gateway.deviceLink.online(node.deviceId)));

    const online = await (await fetch(`${gateway.url}/chatdsh/gateway/devices`)).json();
    assert.equal(online.devices.find((entry) => entry.id === node.deviceId).online, true);

    const probe = await fetch(`${gateway.url}/chatdsh/gateway/devices/${node.deviceId}/probe`);
    assert.equal(probe.status, 200);
    const probed = await probe.json();
    assert.equal(probed.deviceId, node.deviceId);
    assert.equal(probed.online, true);
    assert.equal(probed.status, 200);
    assert.ok(typeof probed.durationMs === 'number');

    device.close();
    assert.ok(await waitFor(() => !gateway.deviceLink.online(node.deviceId)));
    const afterClose = await (await fetch(`${gateway.url}/chatdsh/gateway/devices/${node.deviceId}/probe`)).json();
    assert.deepEqual(afterClose, { error: 'device-offline' });
  } finally {
    await gateway.close();
  }
});

test('无效节点令牌在握手阶段被拒绝', async () => {
  const gateway = await startGateway();
  try {
    const url = new URL(gateway.url);
    const socket = net.connect(Number.parseInt(url.port, 10), url.hostname);
    const responseText = await new Promise((resolve, reject) => {
      let text = '';
      socket.on('error', reject);
      socket.on('connect', () => {
        socket.write([
          'GET /chatdsh/gateway/device-link HTTP/1.1',
          `Host: ${url.host}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', // gitleaks:allow
          'Sec-WebSocket-Version: 13',
          'Authorization: Bearer wrong-token',
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
    assert.match(responseText, /^HTTP\/1\.1 401 Unauthorized/m);
    assert.ok(responseText.includes('node-token-invalid'));
    assert.deepEqual(gateway.deviceLink.onlineIds(), []);
  } finally {
    await gateway.close();
  }
});

test('同一设备重复连接时旧连接被替换，在线状态不中断', async () => {
  const gateway = await startGateway();
  try {
    const node = await pairNode(gateway, 'device-a');
    const wsUrl = gateway.url.replace(/^http/, 'ws') + '/chatdsh/gateway/device-link';
    const first = new TestDevice(node.deviceId, node.token, wsUrl);
    await first.waitOpen();
    assert.ok(await waitFor(() => gateway.deviceLink.online(node.deviceId)));

    const second = new TestDevice(node.deviceId, node.token, wsUrl);
    await second.waitOpen();
    assert.ok(await waitFor(() => first.closed), '旧连接应当被关闭');
    assert.ok(await waitFor(() => gateway.deviceLink.online(node.deviceId)));
    assert.deepEqual(gateway.deviceLink.onlineIds(), [node.deviceId]);
    second.close();
  } finally {
    await gateway.close();
  }
});

test('心跳超时判定为离线', async () => {
  const gateway = await startGateway({ hub: { heartbeatMs: 40, deadAfterMs: 60 } });
  try {
    const node = await pairNode(gateway, 'device-a');
    const wsUrl = gateway.url.replace(/^http/, 'ws') + '/chatdsh/gateway/device-link';
    const socket = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${node.token}` } });
    const opened = new Promise((resolve, reject) => {
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ type: 'hello', deviceId: node.deviceId, platform: 'linux', role: 'both', capabilities: [] }));
        resolve();
      });
      socket.addEventListener('error', () => reject(new Error('连接失败')));
    });
    // 不回 pong：控制平面按阈值判定失联并断开。
    socket.addEventListener('message', () => undefined);
    await opened;
    assert.ok(await waitFor(() => gateway.deviceLink.online(node.deviceId)));
    assert.ok(await waitFor(() => !gateway.deviceLink.online(node.deviceId), 4000), '超过阈值没有 pong 应当判定离线');
    socket.close();
  } finally {
    await gateway.close();
  }
});
