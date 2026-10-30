// 客户端外壳的单元级验证：聚合会话列表、外壳页面与脚本、按设备取插件清单。
//
// 控制平面是完整装配的真实 HTTP 服务；设备侧按帧协议实现最小客户端，覆盖插件清单两个
// Remote 端点的请求与响应回填。整机链路（真实 dsh 运行时与真实 Chrome 的四条断言）由
// scripts/verify-shell.mjs 覆盖。
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
async function startGateway() {
  const home = tempHome('gateway-shell');
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
  const deviceLink = new DeviceLinkHub({ store, telemetry });
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
      pairingCode: 'pair-shell',
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
    replica,
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
    body: JSON.stringify({ code: 'pair-shell', name, platform: 'linux', role: 'both', capabilities: [] }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  return { deviceId: payload.deviceId, token: payload.token };
}

/** 答插件清单请求的测试设备：按端点名回两份真实的信封形状。 */
class InventoryDevice {
  constructor(deviceId, token, url) {
    this.deviceId = deviceId;
    this.paths = [];
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
        this.paths.push(frame.path);
        const envelope = JSON.parse(Buffer.from(frame.body, 'base64').toString('utf8'));
        const value = frame.path.endsWith('/pluginManager/listBundles')
          ? [{ name: '@chatdsh/bundle-hosted', enabled: true, rows: [{ entryId: 'shell', moduleName: '@chatdsh/client-shell' }] }]
          : [{ entryId: 'shell', moduleName: '@chatdsh/client-shell', enabled: true, fiberPhase: 'active' }];
        const reply = {
          type: 'server-response',
          rpcId: envelope.rpcId,
          result: { ok: true, value },
        };
        const body = Buffer.from(JSON.stringify(reply), 'utf8');
        this.socket.send(JSON.stringify({
          type: 'response',
          requestId: frame.requestId,
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: body.toString('base64'),
        }));
      });
    });
  }

  close() {
    this.socket.close();
  }
}

/** 记一条会话归属。 */
function own(store, sessionId, deviceId, cwd, createdAt) {
  store.upsertSession({ sessionId, deviceId, cwd, kind: 'work', createdAt });
}

/** 往副本里追加一条标题事件，形状与运行时上报的一致。 */
function appendTitle(replica, sessionId, seq, title, time) {
  replica.append(sessionId, [{
    seq,
    kind: 'session/title',
    time,
    bytes: 32,
    payload: { seq, type: 'session/title', time, data: { title, messageSeqs: [1], source: { kind: 'user' } } },
  }]);
}

test('聚合会话列表按设备分组，标题取副本里的标题事件，缺失时用 cwd 末段', async () => {
  const gateway = await startGateway();
  try {
    const nodeA = await pairNode(gateway, 'device-a');
    const nodeB = await pairNode(gateway, 'device-b');
    const now = Date.now();
    own(gateway.store, 'session-a1', nodeA.deviceId, '/home/me/repo-alpha', now - 3000);
    own(gateway.store, 'session-a2', nodeA.deviceId, '/home/me/repo-beta', now - 2000);
    own(gateway.store, 'session-b1', nodeB.deviceId, '/home/me/gamma', now - 1000);
    own(gateway.store, 'session-c1', 'device-unknown', '/home/me/delta', now - 500);

    appendTitle(gateway.replica, 'session-a1', 3, '修复登录超时', now - 1500);
    gateway.replica.append('session-a2', [{ seq: 1, kind: 'user/message', time: now - 400, bytes: 8, payload: { text: '你好' } }]);

    const response = await fetch(`${gateway.url}/chatdsh/gateway/sessions`);
    assert.equal(response.status, 200);
    const snapshot = await response.json();

    const byId = new Map(snapshot.devices.map((device) => [device.deviceId, device]));
    assert.equal(byId.size, 3, '两台已配对设备加一台只在归属里出现的设备');
    const a1 = byId.get(nodeA.deviceId).sessions.find((session) => session.sessionId === 'session-a1');
    assert.equal(a1.title, '修复登录超时', '副本里有标题事件时用标题');
    assert.equal(a1.updatedAt, now - 1500, '更新时间取副本里最新事件的时间');
    assert.equal(a1.cwd, '/home/me/repo-alpha');
    const a2 = byId.get(nodeA.deviceId).sessions.find((session) => session.sessionId === 'session-a2');
    assert.equal(a2.title, 'repo-beta', '副本里没有标题事件时用 cwd 末段');
    assert.equal(byId.get(nodeA.deviceId).sessions.length, 2);
    assert.equal(byId.get(nodeA.deviceId).online, false, '没有长连接时设备是离线');
    assert.equal(byId.get('device-unknown').name, 'device-unknown', '归属里的未知设备照样列出');
    assert.equal(byId.get('device-unknown').sessions[0].title, 'delta');
    assert.equal(byId.get(nodeB.deviceId).sessions[0].sessionId, 'session-b1');
  } finally {
    await gateway.close();
  }
});

test('设备在线时聚合列表标成在线，会话按最近活动倒序', async () => {
  const gateway = await startGateway();
  let device;
  try {
    const node = await pairNode(gateway, 'device-a');
    own(gateway.store, 'session-old', node.deviceId, '/home/me/old', Date.now() - 10_000);
    own(gateway.store, 'session-new', node.deviceId, '/home/me/fresh', Date.now() - 5_000);
    gateway.replica.append('session-old', [{ seq: 1, kind: 'user/message', time: Date.now() - 4000, bytes: 4, payload: {} }]);
    gateway.replica.append('session-new', [{ seq: 1, kind: 'user/message', time: Date.now() - 1000, bytes: 4, payload: {} }]);
    device = new InventoryDevice(node.deviceId, node.token, `${gateway.url.replace('http', 'ws')}/chatdsh/gateway/device-link`);
    await device.opened;

    const snapshot = await (await fetch(`${gateway.url}/chatdsh/gateway/sessions`)).json();
    const listed = snapshot.devices.find((entry) => entry.deviceId === node.deviceId);
    assert.equal(listed.online, true);
    assert.deepEqual(listed.sessions.map((session) => session.sessionId), ['session-new', 'session-old']);
  } finally {
    device?.close();
    await gateway.close();
  }
});

test('根路径返回外壳页面，外壳脚本由控制平面托管，带启动口令的根路径仍走反代', async () => {
  const gateway = await startGateway();
  try {
    const page = await fetch(`${gateway.url}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /\/shell\/shell\.js/);
    assert.match(html, /id="chatdsh-shell"/);

    const script = await fetch(`${gateway.url}/shell/shell.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);
    assert.ok((await script.text()).length > 0);

    const other = await fetch(`${gateway.url}/shell/other.js`);
    assert.equal(other.status, 404);

    // 带启动口令的根路径属于运行时的启动路径，照旧走默认反代（这里指向一个不监听的端口）。
    const boot = await fetch(`${gateway.url}/?token=abc`);
    assert.equal(boot.status, 502);
  } finally {
    await gateway.close();
  }
});

test('按设备取插件清单：在线时经长连接取回组合包与插件行，离线与未知设备明确失败', async () => {
  const gateway = await startGateway();
  let online;
  let offline;
  try {
    const nodeOnline = await pairNode(gateway, 'device-online');
    const nodeOffline = await pairNode(gateway, 'device-offline');
    online = new InventoryDevice(nodeOnline.deviceId, nodeOnline.token, `${gateway.url.replace('http', 'ws')}/chatdsh/gateway/device-link`);
    await online.opened;
    // 另一台连过又断开的设备，用来断言离线分支。
    offline = new InventoryDevice(nodeOffline.deviceId, nodeOffline.token, `${gateway.url.replace('http', 'ws')}/chatdsh/gateway/device-link`);
    await offline.opened;
    offline.close();
    offline = undefined;
    await new Promise((settle) => setTimeout(settle, 200));

    const response = await fetch(`${gateway.url}/chatdsh/gateway/devices/${nodeOnline.deviceId}/plugins`);
    assert.equal(response.status, 200);
    const snapshot = await response.json();
    assert.equal(snapshot.deviceId, nodeOnline.deviceId);
    assert.equal(snapshot.bundles.length, 1);
    assert.equal(snapshot.bundles[0].name, '@chatdsh/bundle-hosted');
    assert.equal(snapshot.plugins.length, 1);
    assert.equal(snapshot.plugins[0].moduleName, '@chatdsh/client-shell');
    assert.deepEqual(online.paths, ['/api/pluginManager/listBundles', '/api/pluginManager/listPlugins'], '两次都是真实存在的 Remote 端点');

    const missing = await fetch(`${gateway.url}/chatdsh/gateway/devices/no-such-device/plugins`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, 'device-not-found');

    const gone = await fetch(`${gateway.url}/chatdsh/gateway/devices/${nodeOffline.deviceId}/plugins`);
    assert.equal(gone.status, 409);
    assert.equal((await gone.json()).error, 'device-offline');

    const wrongMethod = await fetch(`${gateway.url}/chatdsh/gateway/sessions`, { method: 'POST' });
    assert.equal(wrongMethod.status, 405);
  } finally {
    online?.close();
    await gateway.close();
  }
});
