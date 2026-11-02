// WP04 验收：设备前缀路径的校验与切分。
//
// `validateDeviceTargetPath` 与 `resolveDeviceResourcePath` 直接取构建产物里的真实实现，
// 逐条断言接受与拒绝的取值。设备前缀的路由行为用完整装配的真实 HTTP 服务验证：资源路径
// 与查询串原样转给设备，路径穿越在写开通道帧之前就被拒绝，未知设备与离线设备明确失败，
// 不落到默认运行时。
import net from 'node:net';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempHome } from '../../scripts/lib/cleanup.mjs';
import { createTelemetryClient } from '../../packages/core/diagnostics/lib/client.js';
import { defaultTelemetryConfig } from '../../packages/core/diagnostics/lib/config.js';
import { GatewayStore, PushQueue, ReceiptStore, ReplicaStore, ShareStore } from '../../gateway/lib/store.js';
import { createPushHub } from '../../gateway/lib/push.js';
import { DeviceLinkHub, resolveDeviceResourcePath, validateDeviceTargetPath } from '../../gateway/lib/device-link.js';
import { createGatewayServer } from '../../gateway/lib/server.js';

/** 起一个完整装配的控制平面。 */
async function startGateway(options = {}) {
  const home = tempHome('wp04-paths');
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

/** 按原样发出一个请求，不做路径规范化。 */
function rawRequest(url, path) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      { host: target.hostname, port: target.port, path, method: 'GET' },
      (incoming) => {
        let text = '';
        incoming.setEncoding('utf8');
        incoming.on('data', (chunk) => {
          text += chunk;
        });
        incoming.on('end', () => resolve({ status: incoming.statusCode, text }));
      }
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}

/** 发一次前缀 WebSocket 升级，收完整响应文本。 */
function upgradeAttempt(url, path) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number.parseInt(target.port, 10), target.hostname);
    let text = '';
    socket.on('error', reject);
    socket.on('close', () => resolve(text));
    socket.on('connect', () => {
      socket.write([
        `GET ${path} HTTP/1.1`,
        `Host: ${target.host}`,
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
    });
  });
}

/** 按版本 2 帧协议连上的设备。 */
class LinkDevice {
  constructor(token, url, deviceId) {
    this.frames = [];
    this.waiters = new Set();
    this.socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
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

  reply(open, body) {
    const bytes = Buffer.from(JSON.stringify(body), 'utf8');
    this.send({ type: 'accepted', channelId: open.channelId, generation: open.generation, status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
    this.send({ type: 'data', channelId: open.channelId, generation: open.generation, seq: 0, payloadLength: bytes.length, payload: bytes.toString('base64') });
    this.send({ type: 'end', channelId: open.channelId, generation: open.generation, lastSeq: 0 });
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

test('validateDeviceTargetPath：只接受单个斜杠开始的相对路径', () => {
  const accepted = [
    '/',
    '/api/x',
    '/api/x?y=1',
    '/plugins/x.js?v=1',
    '/a/b/c/',
    '/%E4%B8%AD%E6%96%87',
    '/a%41b',
  ];
  for (const path of accepted) {
    assert.equal(validateDeviceTargetPath(path), undefined, `应当接受 ${path}`);
  }

  const rejected = [
    ['http://evil.example/x', 'device-path-not-relative'],
    ['https://evil.example/api/x', 'device-path-not-relative'],
    ['api/x', 'device-path-not-relative'],
    ['', 'device-path-not-relative'],
    ['//evil.example/x', 'device-path-malformed'],
    ['/api//v1', 'device-path-malformed'],
    ['/api/../admin', 'device-path-traversal'],
    ['/..', 'device-path-traversal'],
    ['/.', 'device-path-traversal'],
    ['/api/%2e%2e/admin', 'device-path-traversal'],
    ['/api/%2E%2E/admin', 'device-path-traversal'],
    ['/api/%2e%2e%2fadmin', 'device-path-traversal'],
    ['/api/%2fadmin', 'device-path-traversal'],
    ['/api/%5c..%5cadmin', 'device-path-traversal'],
    ['/api%00/x', 'device-path-malformed'],
    ['/api/%00', 'device-path-malformed'],
    ['/api/%zz', 'device-path-malformed'],
    [`/${'a'.repeat(3000)}`, 'device-path-too-long'],
    [`/%41`.repeat(900), 'device-path-too-long'],
  ];
  for (const [path, code] of rejected) {
    assert.equal(validateDeviceTargetPath(path), code, `应当拒绝 ${path}`);
  }
});

test('resolveDeviceResourcePath：切出设备前缀与资源路径，查询串保留', () => {
  assert.deepEqual(resolveDeviceResourcePath('/d/dev-a/api/remote.mux'), {
    ok: true,
    deviceId: 'dev-a',
    path: '/api/remote.mux',
  });
  assert.deepEqual(resolveDeviceResourcePath('/d/dev-a'), { ok: true, deviceId: 'dev-a', path: '/' });
  assert.deepEqual(resolveDeviceResourcePath('/d/dev-a/'), { ok: true, deviceId: 'dev-a', path: '/' });
  assert.deepEqual(resolveDeviceResourcePath('/d/dev-a/deep/path/'), {
    ok: true,
    deviceId: 'dev-a',
    path: '/deep/path/',
  });
  assert.deepEqual(resolveDeviceResourcePath('/d/dev-a/api/x?y=1&z=2'), {
    ok: true,
    deviceId: 'dev-a',
    path: '/api/x?y=1&z=2',
  });
  assert.deepEqual(resolveDeviceResourcePath('/d/%64%65%76/api'), { ok: true, deviceId: 'dev', path: '/api' });

  assert.deepEqual(resolveDeviceResourcePath('http://host/d/dev-a/api'), { ok: false, code: 'device-url-absolute' });
  assert.deepEqual(resolveDeviceResourcePath('/other/dev-a'), { ok: false, code: 'device-path-not-relative' });
  assert.deepEqual(resolveDeviceResourcePath('/d/'), { ok: false, code: 'device-path-not-relative' });
  assert.deepEqual(resolveDeviceResourcePath('/d/../x'), { ok: false, code: 'device-path-malformed' });
  assert.deepEqual(resolveDeviceResourcePath('/d/%2e%2e/x'), { ok: false, code: 'device-path-malformed' });
  assert.deepEqual(resolveDeviceResourcePath('/d/a%2fb/x'), { ok: false, code: 'device-path-malformed' });
  assert.deepEqual(resolveDeviceResourcePath('/d/dev-a//x'), { ok: false, code: 'device-path-malformed' });
  assert.deepEqual(resolveDeviceResourcePath('/d/dev-a/../x'), { ok: false, code: 'device-path-traversal' });
  assert.deepEqual(resolveDeviceResourcePath('/d/dev-a/%2e%2e/x'), { ok: false, code: 'device-path-traversal' });
  assert.deepEqual(resolveDeviceResourcePath('/d/dev-a/./x'), { ok: false, code: 'device-path-traversal' });
  assert.deepEqual(resolveDeviceResourcePath('/d/dev-a/%00'), { ok: false, code: 'device-path-malformed' });
  assert.deepEqual(resolveDeviceResourcePath(`/d/dev-a/${'a'.repeat(2500)}`), {
    ok: false,
    code: 'device-path-too-long',
  });
});

test('前缀转发：资源路径与查询串原样交给设备，响应照原样回填', async () => {
  const gateway = await startGateway();
  let device;
  try {
    const node = await pairNode(gateway, 'device-prefix');
    device = new LinkDevice(node.token, linkUrl(gateway), node.deviceId);
    await device.opened;
    await device.waitFrame((frame) => frame.type === 'welcome');

    const pending = fetch(`${gateway.url}/d/${node.deviceId}/api/v1/items?limit=5&after=abc`);
    const open = await device.waitFrame((frame) => frame.type === 'open');
    assert.equal(open.path, '/api/v1/items?limit=5&after=abc', '设备前缀之后的资源路径与查询串原样转发');
    device.reply(open, { echoed: open.path });

    const response = await pending;
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { echoed: '/api/v1/items?limit=5&after=abc' });

    const nested = fetch(`${gateway.url}/d/${node.deviceId}/plugins/a/b/`);
    const nestedOpen = await device.waitFrame((frame) => frame.type === 'open' && frame.path === '/plugins/a/b/');
    device.reply(nestedOpen, { echoed: nestedOpen.path });
    assert.deepEqual(await (await nested).json(), { echoed: '/plugins/a/b/' });
  } finally {
    device?.close();
    await gateway.close();
  }
});

test('路径穿越在写开通道帧之前就被拒绝', async () => {
  const gateway = await startGateway();
  let device;
  try {
    const node = await pairNode(gateway, 'device-traversal');
    device = new LinkDevice(node.token, linkUrl(gateway), node.deviceId);
    await device.opened;
    await device.waitFrame((frame) => frame.type === 'welcome');

    const probe = fetch(`${gateway.url}/d/${node.deviceId}/probe`);
    const probeOpen = await device.waitFrame((frame) => frame.type === 'open');
    device.reply(probeOpen, { ok: true });
    assert.equal((await probe).status, 200);

    for (const path of [
      `/d/${node.deviceId}/../secret`,
      `/d/${node.deviceId}/api/%2e%2e/secret`,
      `/d/${node.deviceId}//api/x`,
    ]) {
      const response = await rawRequest(gateway.url, path);
      assert.equal(response.status, 502, `${path} 应当在转发之前被拒绝`);
      assert.deepEqual(JSON.parse(response.text), { error: 'device-path-invalid' });
    }
    assert.equal(device.framesOf('open').length, 1, '被拒绝的路径不产生开通道帧');
    assert.ok(gateway.deviceLink.online(node.deviceId), '拒绝不关闭设备连接');
  } finally {
    device?.close();
    await gateway.close();
  }
});

test('未知设备与离线设备按设备前缀明确失败，不回退默认运行时', async () => {
  const gateway = await startGateway();
  try {
    const offline = await pairNode(gateway, 'device-offline');

    const unknown = await fetch(`${gateway.url}/d/no-such-device/api/x`);
    assert.equal(unknown.status, 404);
    assert.equal(unknown.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.deepEqual(await unknown.json(), { error: 'device-not-found' });

    const offlineResponse = await fetch(`${gateway.url}/d/${offline.deviceId}/api/x`);
    assert.equal(offlineResponse.status, 409);
    assert.equal(offlineResponse.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.deepEqual(await offlineResponse.json(), { error: 'device-offline' });

    const offlineRoot = await fetch(`${gateway.url}/d/${offline.deviceId}/`);
    assert.equal(offlineRoot.status, 409);
    assert.deepEqual(await offlineRoot.json(), { error: 'device-offline' });
    assert.equal(gateway.deviceLink.online(offline.deviceId), false);
  } finally {
    await gateway.close();
  }
});

test('设备前缀下的 WebSocket 升级回明确设备错误，不落到默认运行时', async () => {
  const gateway = await startGateway();
  try {
    const offline = await pairNode(gateway, 'device-upgrade');
    for (const path of [
      `/d/no-such-device/api/remote.mux`,
      `/d/${offline.deviceId}/api/remote.mux`,
      `/d/${offline.deviceId}/other/path`,
    ]) {
      const text = await upgradeAttempt(gateway.url, path);
      const headerEnd = text.indexOf('\r\n\r\n');
      assert.notEqual(headerEnd, -1, `${path} 应当回一个完整的 HTTP 响应`);
      const statusLine = text.slice(0, text.indexOf('\r\n'));
      assert.doesNotMatch(text, /101 Switching Protocols/, `${path} 不得升级成功`);
      assert.match(statusLine, /^HTTP\/1\.1 [45]\d\d /, `${path} 应当以明确状态码拒绝`);
      const payload = JSON.parse(text.slice(headerEnd + 4));
      assert.match(payload.error, /^device-[a-z-]+$/, `${path} 应当给出设备侧错误码`);
    }
  } finally {
    await gateway.close();
  }
});
