// WP04 验收：通道取消与事件去重。
//
// 控制平面是完整装配的真实 HTTP 服务；设备侧按版本 2 帧协议连上来，用中枢公开的通道接口
// 打开事件订阅，断言取消帧的传播、`cancelled` 确认之后不再投递数据，以及同一事件标识重复
// 回填时只投递一次、重复序号不产生重复投递。
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
  const home = tempHome('wp04-cancel');
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

/** 等一个条件成立。 */
async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((settle) => setTimeout(settle, 20));
  }
  throw new Error('条件在超时之内没有成立');
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

  sendData(open, { seq, payload = '', eventId }) {
    const bytes = Buffer.from(payload, 'utf8');
    this.send({
      type: 'data',
      channelId: open.channelId,
      generation: open.generation,
      seq,
      payloadLength: bytes.length,
      payload: bytes.toString('base64'),
      ...(eventId === undefined ? {} : { eventId }),
    });
  }

  sendEnd(open, lastSeq) {
    this.send({ type: 'end', channelId: open.channelId, generation: open.generation, lastSeq });
  }

  sendCancelled(open, reason) {
    this.send({ type: 'cancelled', channelId: open.channelId, generation: open.generation, reason });
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

test('取消沿通道传播，设备确认 cancelled 之后不再投递该通道数据', async () => {
  const gateway = await startGateway();
  let device;
  try {
    const node = await pairNode(gateway, 'device-cancel');
    device = new LinkDevice(node.token, linkUrl(gateway), node.deviceId);
    await device.opened;
    const welcome = await device.waitFrame((frame) => frame.type === 'welcome');

    const channel = gateway.deviceLink.openChannel(node.deviceId, { kind: 'events', method: 'GET', path: '/events' });
    const open = await device.waitFrame((frame) => frame.type === 'open' && frame.path === '/events');
    assert.equal(open.kind, 'events');
    assert.equal(open.channelId, channel.channelId);
    assert.equal(open.generation, welcome.generation);

    device.accept(open);
    const acceptance = await channel.accepted();
    assert.equal(acceptance.status, 200);

    const chunks = [];
    channel.onChunk((chunk, eventId) => {
      chunks.push({ text: chunk.toString('utf8'), eventId });
    });
    device.sendData(open, { seq: 0, payload: 'first', eventId: 'event-1' });
    await waitFor(() => chunks.length === 1);
    assert.deepEqual(chunks, [{ text: 'first', eventId: 'event-1' }]);

    channel.cancel('user-aborted');
    assert.equal(channel.state, 'cancelling', '取消之后的通道进入取消中');
    const cancelFrame = await device.waitFrame(
      (frame) => frame.type === 'cancel' && frame.channelId === channel.channelId
    );
    assert.equal(cancelFrame.reason, 'user-aborted', '取消原因原样传给设备');
    assert.equal(cancelFrame.generation, welcome.generation);

    device.sendCancelled(open, 'user-aborted');
    const finished = await channel.finished();
    assert.deepEqual(finished, { code: 'cancelled' }, '设备确认之后通道以 cancelled 收尾');
    assert.equal(channel.state, 'closed');
    assert.equal(gateway.deviceLink.channelCount(node.deviceId), 0);

    // 确认之后设备再回填这一段数据也不得投递。
    device.sendData(open, { seq: 1, payload: 'late', eventId: 'event-2' });
    await new Promise((settle) => setTimeout(settle, 200));
    assert.deepEqual(chunks, [{ text: 'first', eventId: 'event-1' }], '取消确认之后不再接收该通道数据');
    assert.ok(gateway.deviceLink.online(node.deviceId), '取消只终止该通道，连接保持在线');
  } finally {
    device?.close();
    await gateway.close();
  }
});

test('事件按标识去重：重复标识只投递一次，重复序号不产生重复投递', async () => {
  const gateway = await startGateway();
  let device;
  try {
    const node = await pairNode(gateway, 'device-dedup');
    device = new LinkDevice(node.token, linkUrl(gateway), node.deviceId);
    await device.opened;
    await device.waitFrame((frame) => frame.type === 'welcome');

    const channel = gateway.deviceLink.openChannel(node.deviceId, { kind: 'events', method: 'GET', path: '/stream' });
    const open = await device.waitFrame((frame) => frame.type === 'open' && frame.path === '/stream');
    device.accept(open);
    await channel.accepted();

    const chunks = [];
    channel.onChunk((chunk, eventId) => {
      chunks.push({ text: chunk.toString('utf8'), eventId });
    });

    device.sendData(open, { seq: 0, payload: '{"n":1}', eventId: 'event-1' });
    device.sendData(open, { seq: 1, payload: '{"n":1}', eventId: 'event-1' });
    device.sendData(open, { seq: 2, payload: '{"n":2}', eventId: 'event-2' });

    await waitFor(() => chunks.length === 2);
    await new Promise((settle) => setTimeout(settle, 100));
    assert.deepEqual(
      chunks,
      [{ text: '{"n":1}', eventId: 'event-1' }, { text: '{"n":2}', eventId: 'event-2' }],
      '同一事件标识只投递一次，后续不同标识照常投递'
    );
    assert.deepEqual(device.framesOf('reset'), [], '重复标识不终止通道');

    // 三段数据都补回了额度，被丢弃的那一段同样补回，设备侧不会因此被卡住。
    await waitFor(
      () => device.framesOf('credit').filter((frame) => frame.channelId === channel.channelId).length === 3
    );
    const credits = device.framesOf('credit').filter((frame) => frame.channelId === channel.channelId);
    assert.equal(credits.reduce((sum, frame) => sum + frame.bytes, 0), 21, '三段各 7 字节的额度都补回');

    channel.sendEnd();
    device.sendEnd(open, 2);
    const finished = await channel.finished();
    assert.deepEqual(finished, { code: 'ended' }, '去重之后通道正常结束');
  } finally {
    device?.close();
    await gateway.close();
  }
});
