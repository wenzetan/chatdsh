// WP04 验收：设备实时通道的协议版本 2 握手。
//
// 控制平面是完整装配的真实 HTTP 服务与真实 WebSocket 升级；设备侧按同一条连接上的 JSON
// 文本帧协议连上来，断言 welcome 的版本、设备标识、连接代次与五项固定预算，以及未知版本、
// 自报设备标识不符在握手阶段的拒绝与关闭。
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempHome } from '../../scripts/lib/cleanup.mjs';
import { createTelemetryClient } from '../../packages/core/diagnostics/lib/client.js';
import { defaultTelemetryConfig } from '../../packages/core/diagnostics/lib/config.js';
import { GatewayStore, PushQueue, ReceiptStore, ReplicaStore, ShareStore } from '../../gateway/lib/store.js';
import { createPushHub } from '../../gateway/lib/push.js';
import { DeviceLinkHub } from '../../gateway/lib/device-link.js';
import { createGatewayServer } from '../../gateway/lib/server.js';

/** 起一个完整装配的控制平面。 */
async function startGateway(options = {}) {
  const home = tempHome('wp04-handshake');
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
    telemetry: { counter: (name, config) => telemetry.counter(name, config) },
  });
  const deviceLink = new DeviceLinkHub({ store, telemetry, ...options.hub });
  const server = createGatewayServer({
    config: {
      host: '127.0.0.1',
      port: 0,
      runtimeUrl: 'http://127.0.0.1:9',
      databasePath,
      environment: 'test',
      version: '0.0.0',
      pushMode: 'all-at-once',
      pushEscalationMs: 1000,
      llmGateway: { quota: {} },
      pairingCode: 'pair-wp04',
    },
    store,
    replica,
    share,
    receipts,
    push,
    telemetry,
    deviceLink,
    runtime: {
      url: () => 'http://127.0.0.1:9',
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

/** 配对一台节点。 */
async function pairNode(gateway, name) {
  const response = await fetch(`${gateway.url}/chatdsh/gateway/devices/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'pair-wp04', name, platform: 'linux', role: 'both', capabilities: ['shell'] }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok(typeof payload.token === 'string' && payload.token.length > 20);
  return payload;
}

/** 设备长连接的升级地址。 */
function linkUrl(gateway) {
  return `${gateway.url.replace(/^http/, 'ws')}/chatdsh/gateway/device-link`;
}

/** 按版本 2 帧协议连上的设备。 */
class LinkDevice {
  constructor(token, url, hello = {}) {
    this.frames = [];
    this.waiters = new Set();
    this.closeInfo = undefined;
    this.hello = {
      type: 'hello',
      version: 2,
      deviceId: hello.deviceId ?? '',
      generation: 0,
      platform: 'linux',
      role: 'both',
      capabilities: ['shell'],
      ...hello,
    };
    this.socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    this.closed = new Promise((resolve) => {
      this.socket.addEventListener('close', (event) => {
        this.closeInfo = { code: event.code, reason: event.reason };
        resolve(this.closeInfo);
      });
    });
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => {
        this.send(this.hello);
        resolve();
      });
      this.socket.addEventListener('error', () => reject(new Error('设备连接失败')));
      this.socket.addEventListener('message', (event) => {
        const frame = JSON.parse(event.data);
        this.frames.push(frame);
        if (frame.type === 'ping') this.send({ type: 'pong', generation: frame.generation, nonce: frame.nonce });
        for (const waiter of [...this.waiters]) waiter(frame);
      });
    });
  }

  send(frame) {
    this.socket.send(JSON.stringify(frame));
  }

  /** 再发一次握手帧：未知版本与设备标识不符按违规次数累计。 */
  sendHello() {
    this.send(this.hello);
  }

  waitFrame(predicate, timeoutMs = 5000) {
    const seen = this.frames.find((frame) => predicate(frame));
    if (seen !== undefined) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`等待帧超时，已收到的帧类型：${this.frames.map((frame) => frame.type).join('、')}`));
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

  framesOf(type) {
    return this.frames.filter((frame) => frame.type === type);
  }

  close() {
    this.socket.close();
  }
}

test('协议版本 2 握手：hello 带版本、设备标识与代次，welcome 下发代次与五项连接预算', async () => {
  const gateway = await startGateway();
  let device;
  try {
    const node = await pairNode(gateway, 'device-handshake');
    device = new LinkDevice(node.token, linkUrl(gateway), { deviceId: node.deviceId });
    await device.opened;
    const welcome = await device.waitFrame((frame) => frame.type === 'welcome');

    assert.equal(welcome.version, 2, 'welcome 声明的协议版本');
    assert.equal(welcome.deviceId, node.deviceId, 'welcome 回的设备标识取自令牌对应的记录');
    assert.equal(welcome.generation, 1, '首次连接由服务端签发代次 1');
    assert.deepEqual(welcome.limits, {
      maxChannels: 128,
      sendBufferBytes: 8 * 1024 * 1024,
      initialCreditBytes: 256 * 1024,
      dataPayloadMaxBytes: 32 * 1024,
      frameMaxBytes: 64 * 1024,
    });
    assert.equal(device.hello.version, 2);
    assert.equal(device.hello.deviceId, node.deviceId);
    assert.equal(device.hello.generation, 0, 'hello 里的代次是设备自报的上一代次');
    assert.equal(gateway.deviceLink.generationOf(node.deviceId), 1);
    assert.ok(gateway.deviceLink.online(node.deviceId));

    device.close();
    await device.closed;
    device = undefined;

    const again = new LinkDevice(node.token, linkUrl(gateway), { deviceId: node.deviceId });
    try {
      await again.opened;
      const second = await again.waitFrame((frame) => frame.type === 'welcome');
      assert.equal(second.generation, 2, '同一设备重连后代次递增');
      assert.equal(gateway.deviceLink.generationOf(node.deviceId), 2);
    } finally {
      again.close();
      await again.closed;
    }
  } finally {
    device?.close();
    await gateway.close();
  }
});

test('未知协议版本：拒绝并关闭连接，不下发 welcome', async () => {
  const gateway = await startGateway();
  try {
    const node = await pairNode(gateway, 'device-version');
    const device = new LinkDevice(node.token, linkUrl(gateway), { deviceId: node.deviceId, version: 3 });
    await device.opened;
    // 单次违规不关闭连接，累计到协议违规上限才断开；这里连续三次同一条非法握手。
    device.sendHello();
    device.sendHello();
    const closeInfo = await device.closed;
    assert.equal(closeInfo.code, 1008, '协议违规按 1008 关闭');
    assert.equal(closeInfo.reason, 'protocol-version-unsupported', '关闭原因写明未知版本');
    assert.deepEqual(device.framesOf('welcome'), [], '未知版本的连接不进入通道协议');
    assert.equal(gateway.deviceLink.online(node.deviceId), false);
    assert.deepEqual(gateway.deviceLink.onlineIds(), []);
  } finally {
    await gateway.close();
  }
});

test('自报设备标识与令牌不符：按协议违规关闭连接', async () => {
  const gateway = await startGateway();
  try {
    const node = await pairNode(gateway, 'device-mismatch');
    const device = new LinkDevice(node.token, linkUrl(gateway), { deviceId: 'another-device' });
    await device.opened;
    device.sendHello();
    device.sendHello();
    const closeInfo = await device.closed;
    assert.equal(closeInfo.code, 1008);
    assert.equal(closeInfo.reason, 'device-mismatch');
    assert.deepEqual(device.framesOf('welcome'), []);
    assert.equal(gateway.deviceLink.online(node.deviceId), false);
  } finally {
    await gateway.close();
  }
});
