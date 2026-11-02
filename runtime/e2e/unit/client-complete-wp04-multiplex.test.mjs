// WP04 验收：设备实时通道的多路复用与连接代次。
//
// 控制平面是完整装配的真实 HTTP 服务；设备侧按版本 2 帧协议连上来，按 `channelId` 与
// `generation` 回填每条通道的响应。断言并发通道的正确配对、同设备新代次替换旧连接时旧
// 代次未完成请求的明确失败，以及连接通道数预算之外的开通道失败。
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
  const home = tempHome('wp04-multiplex');
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

  /** 回填响应头。 */
  accept(open, { status = 200, headers = { 'content-type': 'application/json; charset=utf-8' } } = {}) {
    this.send({ type: 'accepted', channelId: open.channelId, generation: open.generation, status, headers });
  }

  /** 回填一段数据；`payloadLength` 可以故意与载荷字节数不符。 */
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

  /** 回填半关闭。 */
  sendEnd(open, lastSeq) {
    this.send({ type: 'end', channelId: open.channelId, generation: open.generation, lastSeq });
  }

  /** 补一段额度。 */
  sendCredit(open, bytes) {
    this.send({ type: 'credit', channelId: open.channelId, generation: open.generation, bytes });
  }

  /** 确认取消。 */
  sendCancelled(open, reason) {
    this.send({ type: 'cancelled', channelId: open.channelId, generation: open.generation, reason });
  }

  /** 一次完整的响应回填：响应头、一段数据、半关闭。 */
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

test('同一连接上的两条通道并发请求，响应按通道标识配对', async () => {
  const gateway = await startGateway();
  let device;
  try {
    const node = await pairNode(gateway, 'device-multiplex');
    device = new LinkDevice(node.token, linkUrl(gateway), node.deviceId);
    await device.opened;
    const welcome = await device.waitFrame((frame) => frame.type === 'welcome');

    const alphaPending = fetch(`${gateway.url}/d/${node.deviceId}/alpha?x=1`);
    const betaPending = fetch(`${gateway.url}/d/${node.deviceId}/beta`, { method: 'POST', body: 'ping' });
    const openAlpha = await device.waitFrame((frame) => frame.type === 'open' && frame.path === '/alpha?x=1');
    const openBeta = await device.waitFrame((frame) => frame.type === 'open' && frame.path === '/beta');

    assert.equal(device.framesOf('open').length, 2, '两条通道各自写一帧开通道');
    assert.notEqual(openAlpha.channelId, openBeta.channelId, '通道标识在连接内唯一');
    assert.match(openAlpha.channelId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(openAlpha.generation, welcome.generation);
    assert.equal(openBeta.generation, welcome.generation);
    assert.equal(openAlpha.kind, 'http');
    assert.equal(openAlpha.method, 'GET');
    assert.equal(openBeta.method, 'POST');
    assert.equal(openAlpha.path, '/alpha?x=1', '查询串随资源路径一起转发');
    assert.notEqual(openAlpha.operationId, openBeta.operationId);

    // 请求体按通道自己的序号发送。
    device.accept(openBeta, { status: 201, headers: { 'content-type': 'application/json', 'x-channel': 'beta' } });
    const betaRequest = await device.waitFrame((frame) => frame.type === 'data' && frame.channelId === openBeta.channelId);
    assert.equal(betaRequest.seq, 0, '每条通道的发送序号都从零开始');
    assert.equal(Buffer.from(betaRequest.payload, 'base64').toString('utf8'), 'ping');

    // 乱序回填：先完成 beta，再完成 alpha。
    device.sendData(openBeta, { seq: 0, payload: JSON.stringify({ channel: 'beta', path: openBeta.path }) });
    device.sendEnd(openBeta, 0);
    device.reply(openAlpha, { body: { channel: 'alpha', path: openAlpha.path } });

    const [alpha, beta] = await Promise.all([alphaPending, betaPending]);
    assert.equal(alpha.status, 200);
    assert.equal(beta.status, 201, '状态码按通道回填');
    assert.equal(beta.headers.get('x-channel'), 'beta', '响应头按通道回填');
    assert.deepEqual(await alpha.json(), { channel: 'alpha', path: '/alpha?x=1' });
    assert.deepEqual(await beta.json(), { channel: 'beta', path: '/beta' });
    assert.equal(gateway.deviceLink.channelCount(node.deviceId), 0, '两条通道都已收尾');
  } finally {
    device?.close();
    await gateway.close();
  }
});

test('同一设备的新代次替换旧连接，旧代次的通道以 device-replaced 明确失败', async () => {
  const gateway = await startGateway();
  let first;
  let second;
  try {
    const node = await pairNode(gateway, 'device-replace');
    first = new LinkDevice(node.token, linkUrl(gateway), node.deviceId);
    await first.opened;
    const firstWelcome = await first.waitFrame((frame) => frame.type === 'welcome');

    // 两条通道都停在响应头之前，替换时它们只能以明确失败收尾。
    const held = gateway.deviceLink.openChannel(node.deviceId, { kind: 'http', method: 'GET', path: '/held' });
    const acceptedOutcome = held.accepted().then(() => undefined, (error) => error);
    const finishedOutcome = held.finished().then((close) => close, (error) => error);
    const heldOpen = await first.waitFrame((frame) => frame.type === 'open' && frame.path === '/held');
    assert.equal(heldOpen.generation, firstWelcome.generation);
    assert.equal(held.state, 'opening');

    second = new LinkDevice(node.token, linkUrl(gateway), node.deviceId);
    await second.opened;
    const secondWelcome = await second.waitFrame((frame) => frame.type === 'welcome');
    assert.equal(secondWelcome.generation, firstWelcome.generation + 1, '新连接拿到更高的代次');

    const acceptedError = await acceptedOutcome;
    const finishedError = await finishedOutcome;
    assert.equal(acceptedError.code, 'device-replaced', '等待响应头的调用方得到替换码');
    assert.equal(finishedError.code, 'device-replaced', '通道结束的等待点同样以替换码失败');
    assert.equal(held.state, 'closed');

    const firstClose = await first.closed;
    assert.equal(firstClose.code, 4000, '旧连接按替换关闭码断开');
    assert.equal(firstClose.reason, 'replaced');
    assert.equal(gateway.deviceLink.generationOf(node.deviceId), secondWelcome.generation);
    assert.deepEqual(gateway.deviceLink.onlineIds(), [node.deviceId]);

    // 新代次照常承接请求。
    const freshPending = fetch(`${gateway.url}/d/${node.deviceId}/fresh`);
    const freshOpen = await second.waitFrame((frame) => frame.type === 'open' && frame.path === '/fresh');
    assert.equal(freshOpen.generation, secondWelcome.generation);
    second.reply(freshOpen, { body: { servedBy: 'second-generation' } });
    const fresh = await freshPending;
    assert.equal(fresh.status, 200);
    assert.deepEqual(await fresh.json(), { servedBy: 'second-generation' });
    assert.deepEqual(first.framesOf('open').map((frame) => frame.path), ['/held'], '旧代次不再收到新请求');
  } finally {
    first?.close();
    second?.close();
    await gateway.close();
  }
});

test('旧代次上的转发请求在连接被替换时回 device-replaced', async () => {
  const gateway = await startGateway();
  let first;
  let second;
  try {
    const node = await pairNode(gateway, 'device-replace-http');
    first = new LinkDevice(node.token, linkUrl(gateway), node.deviceId);
    await first.opened;
    await first.waitFrame((frame) => frame.type === 'welcome');

    const heldPending = fetch(`${gateway.url}/d/${node.deviceId}/hold`);
    await first.waitFrame((frame) => frame.type === 'open' && frame.path === '/hold');

    second = new LinkDevice(node.token, linkUrl(gateway), node.deviceId);
    await second.opened;
    await second.waitFrame((frame) => frame.type === 'welcome');

    const held = await heldPending;
    assert.equal(held.status, 502);
    assert.deepEqual(await held.json(), { error: 'device-replaced' }, '旧代次的未完成请求得到明确失败');
  } finally {
    first?.close();
    second?.close();
    await gateway.close();
  }
});

test('连接通道数预算：超出预算的开通道明确失败，已有通道不受影响', async () => {
  const gateway = await startGateway({ hub: { limits: { maxChannels: 2 } } });
  let device;
  try {
    const node = await pairNode(gateway, 'device-budget');
    device = new LinkDevice(node.token, linkUrl(gateway), node.deviceId);
    await device.opened;
    const welcome = await device.waitFrame((frame) => frame.type === 'welcome');
    assert.equal(welcome.limits.maxChannels, 2, '中枢配置的通道预算随 welcome 下发');

    const firstPending = fetch(`${gateway.url}/d/${node.deviceId}/hold-1`);
    const secondPending = fetch(`${gateway.url}/d/${node.deviceId}/hold-2`);
    const firstOpen = await device.waitFrame((frame) => frame.type === 'open' && frame.path === '/hold-1');
    const secondOpen = await device.waitFrame((frame) => frame.type === 'open' && frame.path === '/hold-2');

    const third = await fetch(`${gateway.url}/d/${node.deviceId}/hold-3`);
    assert.equal(third.status, 502);
    assert.deepEqual(await third.json(), { error: 'device-channel-limit' });
    assert.equal(device.framesOf('open').length, 2, '预算之外不写开通道帧');

    device.reply(firstOpen, { body: { channel: 'hold-1' } });
    device.reply(secondOpen, { body: { channel: 'hold-2' } });
    const [first, second] = await Promise.all([firstPending, secondPending]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(await first.json(), { channel: 'hold-1' });
    assert.deepEqual(await second.json(), { channel: 'hold-2' });
    assert.equal(gateway.deviceLink.channelCount(node.deviceId), 0);
  } finally {
    device?.close();
    await gateway.close();
  }
});
