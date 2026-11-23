// WP04 验收：通道序号校验与背压终止。
//
// 控制平面是完整装配的真实 HTTP 服务；设备侧按版本 2 帧协议连上来，故意回填跳跃或重复的
// 序号、与载荷字节数不符的长度、非正数的额度补充。断言每条通道被终止时的稳定错误码、控制
// 平面回给设备的中止帧，以及同一条连接上另一条通道照常完成。
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
async function startGateway(options = {}) {
  const home = tempHome('wp04-channel');
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
      pairingCode: 'pair-wp04',
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
  constructor(token, url, deviceId) {
    this.frames = [];
    this.waiters = new Set();
    this.closeInfo = undefined;
    this.socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    this.closed = new Promise((resolve) => {
      this.socket.addEventListener('close', (event) => {
        this.closeInfo = { code: event.code, reason: event.reason };
        resolve(this.closeInfo);
      });
    });
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => {
        this.send({ type: 'hello', version: 2, deviceId, generation: 0, platform: 'linux', role: 'both', capabilities: ['shell'] });
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

  accept(open, { status = 200, headers = { 'content-type': 'application/json; charset=utf-8' } } = {}) {
    this.send({ type: 'accepted', channelId: open.channelId, generation: open.generation, status, headers });
  }

  /** 回填一段数据；`payloadLength` 缺省取载荷的真实字节数。 */
  sendData(open, { seq, payload = '', eventId, payloadLength }) {
    const bytes = Buffer.from(payload, 'utf8');
    this.send({
      type: 'data',
      channelId: open.channelId,
      generation: open.generation,
      seq,
      payloadLength: payloadLength ?? bytes.length,
      payload: bytes.toString('base64'),
      ...(eventId === undefined ? {} : { eventId }),
    });
  }

  sendEnd(open, lastSeq) {
    this.send({ type: 'end', channelId: open.channelId, generation: open.generation, lastSeq });
  }

  /** 补一段额度。 */
  sendCredit(open, bytes) {
    this.send({ type: 'credit', channelId: open.channelId, generation: open.generation, bytes });
  }

  reply(open, { status = 200, headers, body = {} } = {}) {
    const text = JSON.stringify(body);
    this.accept(open, headers === undefined ? { status } : { status, headers });
    this.sendData(open, { seq: 0, payload: text });
    this.sendEnd(open, 0);
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

/** 发一个转发请求，等设备写出的开通道帧。 */
async function openThrough(gateway, device, deviceId, path) {
  const pending = fetch(`${gateway.url}/d/${deviceId}${path}`);
  const open = await device.waitFrame((frame) => frame.type === 'open' && frame.path === path);
  return { pending, open };
}

test('序号跳跃：终止该通道并回 seq-out-of-order', async () => {
  const gateway = await startGateway();
  let device;
  try {
    const node = await pairNode(gateway, 'device-seq-jump');
    device = new LinkDevice(node.token, linkUrl(gateway), node.deviceId);
    await device.opened;
    const welcome = await device.waitFrame((frame) => frame.type === 'welcome');

    const { pending, open } = await openThrough(gateway, device, node.deviceId, '/jump');
    device.accept(open);
    device.sendData(open, { seq: 3, payload: 'first' });

    const reset = await device.waitFrame((frame) => frame.type === 'reset' && frame.channelId === open.channelId);
    assert.equal(reset.code, 'seq-out-of-order', '首段数据就跳跃时按序号越序终止');
    assert.equal(reset.generation, welcome.generation, '中止帧带当前代次');

    const response = await pending;
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'device-channel-reset' });
    assert.equal(gateway.deviceLink.channelCount(node.deviceId), 0, '被终止的通道从连接上移除');
    assert.ok(gateway.deviceLink.online(node.deviceId), '单条通道终止不影响连接');
  } finally {
    device?.close();
    await gateway.close();
  }
});

test('序号重复：终止该通道并回稳定的 seq-duplicate', async () => {
  const gateway = await startGateway();
  let device;
  try {
    const node = await pairNode(gateway, 'device-seq-duplicate');
    device = new LinkDevice(node.token, linkUrl(gateway), node.deviceId);
    await device.opened;
    await device.waitFrame((frame) => frame.type === 'welcome');

    const codes = [];
    for (const path of ['/duplicate-1', '/duplicate-2']) {
      const { pending, open } = await openThrough(gateway, device, node.deviceId, path);
      device.accept(open);
      device.sendData(open, { seq: 0, payload: 'first' });
      device.sendData(open, { seq: 0, payload: 'first' });

      const reset = await device.waitFrame(
        (frame) => frame.type === 'reset' && frame.channelId === open.channelId
      );
      codes.push(reset.code);
      const response = await pending;
      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), { error: 'device-channel-reset' });
    }
    assert.deepEqual(codes, ['seq-duplicate', 'seq-duplicate'], '同类错误两次都是同一个稳定错误码');
    assert.equal(gateway.deviceLink.channelCount(node.deviceId), 0);
    assert.ok(gateway.deviceLink.online(node.deviceId));
  } finally {
    device?.close();
    await gateway.close();
  }
});

test('连接发送缓冲预算：超出预算的帧终止该通道，另一条通道照常完成', async () => {
  const gateway = await startGateway({ hub: { limits: { sendBufferBytes: 8192 } } });
  let device;
  try {
    const node = await pairNode(gateway, 'device-buffer');
    device = new LinkDevice(node.token, linkUrl(gateway), node.deviceId);
    await device.opened;
    const welcome = await device.waitFrame((frame) => frame.type === 'welcome');
    assert.equal(welcome.limits.sendBufferBytes, 8192, '中枢配置的发送缓冲预算随 welcome 下发');

    const plain = await openThrough(gateway, device, node.deviceId, '/plain');

    // 一整帧的请求体编码之后远大于连接的发送缓冲预算。
    const uploadPending = fetch(`${gateway.url}/d/${node.deviceId}/upload`, {
      method: 'POST',
      body: 'x'.repeat(32 * 1024),
    });
    const uploadOpen = await device.waitFrame((frame) => frame.type === 'open' && frame.path === '/upload');
    device.accept(uploadOpen);

    const reset = await device.waitFrame(
      (frame) => frame.type === 'reset' && frame.channelId === uploadOpen.channelId
    );
    assert.equal(reset.code, 'buffer-exceeded', '超出连接发送缓冲预算的帧按预算越界终止该通道');

    device.reply(plain.open, { body: { channel: 'plain' } });
    const plainResponse = await plain.pending;
    assert.equal(plainResponse.status, 200, '另一条通道不受影响');
    assert.deepEqual(await plainResponse.json(), { channel: 'plain' });

    const uploadResponse = await uploadPending;
    assert.equal(uploadResponse.status, 502);
    assert.deepEqual(await uploadResponse.json(), { error: 'device-channel-reset' });
    assert.ok(gateway.deviceLink.online(node.deviceId), '连接始终保持在线');
  } finally {
    device?.close();
    await gateway.close();
  }
});

test('额度越界只终止该通道，同连接的另一条通道照常完成', async () => {
  const gateway = await startGateway();
  let device;
  try {
    const node = await pairNode(gateway, 'device-credit');
    device = new LinkDevice(node.token, linkUrl(gateway), node.deviceId);
    await device.opened;
    await device.waitFrame((frame) => frame.type === 'welcome');

    const broken = await openThrough(gateway, device, node.deviceId, '/credit-mismatch');
    const healthy = await openThrough(gateway, device, node.deviceId, '/healthy');

    // 声明的载荷长度远大于真实字节数，超出本条通道的额度。
    device.accept(broken.open);
    device.sendData(broken.open, { seq: 0, payload: 'abc', payloadLength: 4096 });

    const reset = await device.waitFrame(
      (frame) => frame.type === 'reset' && frame.channelId === broken.open.channelId
    );
    assert.equal(reset.code, 'credit-exceeded', '长度与真实字节不符按额度越界终止');

    device.reply(healthy.open, { body: { channel: 'healthy' } });
    const healthyResponse = await healthy.pending;
    assert.equal(healthyResponse.status, 200, '另一条通道不受影响');
    assert.deepEqual(await healthyResponse.json(), { channel: 'healthy' });

    const brokenResponse = await broken.pending;
    assert.equal(brokenResponse.status, 502);
    assert.deepEqual(await brokenResponse.json(), { error: 'device-channel-reset' });
    assert.deepEqual(
      device.framesOf('reset').map((frame) => frame.channelId),
      [broken.open.channelId],
      '只有越界的通道被终止'
    );

    // 额度补充必须为正数，零或负数同样按额度越界终止。
    const zeroCredit = await openThrough(gateway, device, node.deviceId, '/credit-zero');
    device.accept(zeroCredit.open);
    device.sendCredit(zeroCredit.open, 0);
    const zeroReset = await device.waitFrame(
      (frame) => frame.type === 'reset' && frame.channelId === zeroCredit.open.channelId
    );
    assert.equal(zeroReset.code, 'credit-exceeded', '非正数的额度补充按额度越界终止');
    const zeroResponse = await zeroCredit.pending;
    assert.equal(zeroResponse.status, 502);
    assert.deepEqual(await zeroResponse.json(), { error: 'device-channel-reset' });
    assert.ok(gateway.deviceLink.online(node.deviceId), '连接始终保持在线');
  } finally {
    device?.close();
    await gateway.close();
  }
});
