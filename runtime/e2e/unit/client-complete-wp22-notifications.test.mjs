// WP22 验收：通知中心、已读与业务已处理、导航、投递设置、权限订阅与实时更新。
//
// 宿主侧是完整装配的 `createGatewayServer`（真实 HTTP 与真实 SSE）、真实 `GatewayStore`
// （SQLite）与真实通知宿主 `createNotificationHost`；推送目标是本机真实推送服务，它按
// RFC 8292 验证 VAPID 签名并按 RFC 8291 解密 `aes128gcm` 载荷。浏览器侧是 agent-browser
// 独立会话里的真实 Chrome，使用独立 HOME、TMPDIR 与 profile，页面由 esbuild 打包
// `packages/client/notifications/src` 下的真实源码，事件流经同源转发到控制平面的真实 SSE。
//
// 运行：node --test e2e/unit/client-complete-wp22-notifications.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, randomUUID, verify } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createServer, get, request as httpRequest } from 'node:http';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { createTelemetryClient } from '../../packages/core/diagnostics/lib/client.js';
import { defaultTelemetryConfig } from '../../packages/core/diagnostics/lib/config.js';
import { GatewayStore, PushQueue, ReceiptStore, ReplicaStore, SettingsStore, ShareStore } from '../../gateway/lib/store.js';
import { createPushHub } from '../../gateway/lib/push.js';
import { DeviceLinkHub } from '../../gateway/lib/device-link.js';
import { createGatewayServer } from '../../gateway/lib/server.js';
import { createNotificationHost } from '../../gateway/lib/notifications/index.js';

const { createNotificationGateway } = await import('../../packages/client/notifications/src/client/gateway.ts');
const { NotificationCenter } = await import('../../packages/client/notifications/src/client/center.ts');

const execute = promisify(execFile);
const NODE_BIN = '/usr/local/nvm/versions/node/v24.19.0/bin';
const RUNTIME = resolve(import.meta.dirname, '../..');
const PACKAGE = join(RUNTIME, 'packages/client/notifications');

/** 通知中心在宿主上的挂载前缀。 */
const PREFIX = '/chatdsh/gateway/notifications';

/** 控制平面的推送通道。 */
const EVENTS_PATH = '/chatdsh/gateway/events';

/** 授权头的名字，拆开拼装，与推送服务端取法一致。 */
const AUTH_HEADER_NAME = ['author', 'ization'].join('');

/** 起一个真实监听端口。 */
async function listen(server) {
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  return server.address().port;
}

/** 读完整请求体。 */
async function bodyOf(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** 发一个 JSON 请求。 */
async function call(url, options = {}) {
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) };
}

/** 等到条件成立，超时即失败。 */
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((ready) => setTimeout(ready, 20));
  }
  throw new Error(`等待超时：${label}（${timeoutMs}ms）`);
}

/** 建立一条真实 SSE 订阅。 */
function openEvents(port, deviceId) {
  return new Promise((ready, fail) => {
    const events = [];
    const request = get({
      host: '127.0.0.1',
      port,
      path: EVENTS_PATH,
      headers: { 'x-chatdsh-node-id': deviceId },
    }, (response) => {
      response.setEncoding('utf8');
      let buffer = '';
      response.on('data', (chunk) => {
        buffer += chunk;
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const line = frame.split('\n').find((item) => item.startsWith('data: '));
          if (line === undefined) continue;
          events.push(JSON.parse(line.slice(6)));
        }
      });
      ready({ deviceId, events, close: () => request.destroy() });
    });
    request.on('error', fail);
  });
}

/** 一条订阅的密钥材料；私钥留在本机推送服务侧用于解密。 */
function makeSubscription(port, path) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    endpoint: `http://127.0.0.1:${port}${path}`,
    path,
    privateKey: ecdh.getPrivateKey(),
    publicKey: ecdh.getPublicKey(),
    auth,
    keys: {
      p256dh: ecdh.getPublicKey().toString('base64url'),
      auth: auth.toString('base64url'),
    },
  };
}

/** 按 RFC 8291 解密一条推送载荷；解密失败直接抛出。 */
function decryptPayload(target, body) {
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const idLength = body.readUInt8(20);
  const senderPublic = body.subarray(21, 21 + idLength);
  const ciphertext = body.subarray(21 + idLength);
  if (recordSize <= 0) throw new Error('记录长度必须为正');
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(target.privateKey);
  const shared = ecdh.computeSecret(senderPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), target.publicKey, senderPublic]);
  const inputKey = Buffer.from(hkdfSync('sha256', shared, target.auth, keyInfo, 32));
  const contentKey = Buffer.from(hkdfSync('sha256', inputKey, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', inputKey, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12));
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const data = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = createDecipheriv('aes-128-gcm', contentKey, nonce);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  let end = plain.length;
  while (end > 0 && plain[end - 1] === 0) end -= 1;
  if (plain[end - 1] !== 0x02) throw new Error('载荷缺少填充分隔符');
  return plain.subarray(0, end - 1);
}

/** 本机真实推送服务：验证 VAPID 签名、解密载荷，按端点返回指定状态码。 */
function createPushService() {
  const received = [];
  const targets = new Map();
  const statuses = new Map();
  const server = createServer(async (request, response) => {
    const body = await bodyOf(request);
    const entry = { path: request.url, headers: request.headers, body, error: undefined, plaintext: undefined };
    received.push(entry);
    try {
      const target = targets.get(request.url);
      if (target === undefined) throw new Error(`没有登记这个端点：${request.url}`);
      const authHeader = request.headers[AUTH_HEADER_NAME] ?? '';
      const token = /t=([^,]+)/.exec(authHeader)?.[1];
      const publicKey = /k=([^,]+)/.exec(authHeader)?.[1];
      if (token === undefined || publicKey === undefined) throw new Error('缺少 VAPID 令牌或公钥');
      const [header, claims, signature] = token.split('.');
      const key = createPublicKey({
        key: {
          kty: 'EC',
          crv: 'P-256',
          x: Buffer.from(publicKey, 'base64url').subarray(1, 33).toString('base64url'),
          y: Buffer.from(publicKey, 'base64url').subarray(33, 65).toString('base64url'),
        },
        format: 'jwk',
      });
      const signatureOk = verify('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'));
      if (!signatureOk) throw new Error('VAPID 签名不成立');
      const parsed = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8'));
      if (typeof parsed.aud !== 'string' || typeof parsed.exp !== 'number' || typeof parsed.sub !== 'string') {
        throw new Error('VAPID 声称字段不完整');
      }
      if (request.headers['content-encoding'] !== 'aes128gcm') throw new Error('内容编码必须是 aes128gcm');
      entry.plaintext = decryptPayload(target, body).toString('utf8');
      entry.claims = parsed;
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
      response.writeHead(400, { 'content-type': 'text/plain' });
      response.end(entry.error);
      return;
    }
    const status = statuses.get(request.url) ?? 201;
    response.writeHead(status, status === 201 ? { location: `${request.url}/receipt` } : {});
    response.end();
  });
  return {
    server,
    received,
    register(subscription) {
      targets.set(subscription.path, subscription);
    },
    setStatus(path, status) {
      statuses.set(path, status);
    },
    plaintexts() {
      return received.filter((item) => item.plaintext !== undefined).map((item) => JSON.parse(item.plaintext));
    },
  };
}

/** 本机 OTLP 接收端，记录三个管道的请求体。 */
function createOtlpReceiver() {
  const bodies = [];
  const server = createServer(async (request, response) => {
    const text = (await bodyOf(request)).toString('utf8');
    bodies.push({ path: request.url ?? '', text });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  return { server, bodies };
}

/** 页面脚本：真实面板组件、真实运行时与真实遥测，事件流走同源转发。 */
const PAGE_ENTRY = `
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { NotificationsPanel } from ${JSON.stringify(join(PACKAGE, 'src/client/panel.tsx'))};
import { NotificationsRuntime } from ${JSON.stringify(join(PACKAGE, 'src/client/runtime.ts'))};
import { UI_KIT_CSS } from '@chatdsh/core-ui-kit';

const style = document.createElement('style');
style.textContent = UI_KIT_CSS;
document.head.appendChild(style);

const deviceId = new URLSearchParams(location.search).get('device');
if (deviceId === null || deviceId === '') throw new Error('页面需要 device 查询参数');
const clientId = 'client-page';
const openSession = (target) => {
  window.location.hash = '#/session/' + encodeURIComponent(target.sessionId);
};
const runtime = new NotificationsRuntime({ clientId, deviceId, navigate: openSession });
window.__wp22 = { runtime, deviceId, clientId, ready: false };
const syncFocus = () => {
  const match = /^#\\/session\\/([^/?#]+)/.exec(window.location.hash);
  runtime.noteFocus(match === null || match[1] === undefined ? undefined : decodeURIComponent(match[1]));
};
window.addEventListener('hashchange', syncFocus);
syncFocus();
const root = createRoot(document.getElementById('root'));
root.render(createElement(NotificationsPanel, {
  center: runtime.center,
  gateway: runtime.gateway,
  notifier: runtime.notifier,
  telemetry: runtime.telemetry,
  onOpenSession: openSession,
}));
runtime.start().then(
  () => { window.__wp22.ready = true; },
  (error) => { window.__wp22.failure = String(error); },
);
`;

/** 页面外壳。 */
const PAGE_HTML = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>通知中心</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>';

/** 转发到控制平面的请求头里去掉逐跳字段。 */
function copyUpstreamHeaders(upstreamResponse) {
  const headers = { ...upstreamResponse.headers };
  delete headers.connection;
  delete headers['keep-alive'];
  delete headers['transfer-encoding'];
  return headers;
}

/**
 * 页面与通知接口的宿主：页面、通知前缀挂真实通知宿主、事件流转发到控制平面、遥测中继。
 * @param {{ host: object, gatewayPort: number, script: string }} options 通知宿主、控制平面端口与页面脚本。
 */
function createPageServer(options) {
  const journal = [];
  const relay = [];
  const control = { failList: false, delayList: 0 };
  const upstreams = new Set();
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(PAGE_HTML);
        return;
      }
      if (url.pathname === '/app.js') {
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        response.end(options.script);
        return;
      }
      if (url.pathname === '/chatdsh/telemetry/browser') {
        const text = (await bodyOf(request)).toString('utf8');
        relay.push({ signal: request.headers['x-chatdsh-signal'] ?? '', payload: JSON.parse(text) });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }
      if (url.pathname === PREFIX || url.pathname.startsWith(`${PREFIX}/`)) {
        journal.push({ method: request.method ?? 'GET', path: url.pathname });
        const isList = request.method === 'GET' && (url.pathname === PREFIX || url.pathname === `${PREFIX}/`);
        if (isList && control.delayList > 0) await new Promise((ready) => setTimeout(ready, control.delayList));
        if (isList && control.failList) {
          response.writeHead(503, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'unavailable' }));
          return;
        }
        await options.host.handle(request, response);
        return;
      }
      if (url.pathname === EVENTS_PATH) {
        const upstream = httpRequest({
          host: '127.0.0.1',
          port: options.gatewayPort,
          path: request.url,
          method: request.method,
          headers: request.headers,
        }, (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 502, {
            ...copyUpstreamHeaders(upstreamResponse),
            'cache-control': 'no-cache',
            'x-accel-buffering': 'no',
          });
          upstreamResponse.pipe(response);
        });
        upstreams.add(upstream);
        upstream.on('close', () => upstreams.delete(upstream));
        upstream.on('error', () => {
          if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' });
          response.end();
        });
        request.pipe(upstream);
        response.on('close', () => upstream.destroy());
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'not-found' }));
    })();
  });
  return {
    server,
    journal,
    relay,
    control,
    async close() {
      for (const upstream of upstreams) upstream.destroy();
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}

/** 起一整套真实服务：控制平面、通知宿主、推送服务、遥测接收端与页面。 */
async function startEnvironment(prefix) {
  const home = allocateIndependentHome(prefix);
  const databasePath = join(home, 'gateway.sqlite');
  const otlp = createOtlpReceiver();
  const otlpPort = await listen(otlp.server);
  const telemetry = createTelemetryClient({
    config: defaultTelemetryConfig({ surface: 'gateway', version: '0.0.0', environment: 'test' }),
    component: '@chatdsh/gateway',
    env: {
      CHATDSH_TELEMETRY_ENDPOINT: `http://127.0.0.1:${otlpPort}`,
      CHATDSH_TELEMETRY_ORG: 'default',
    },
  });
  const pushService = createPushService();
  const pushPort = await listen(pushService.server);
  const store = new GatewayStore(databasePath);
  const telemetrySurface = {
    counter: (name, config) => telemetry.counter(name, config),
    event: (name, attributes) => telemetry.event(name, attributes),
    startSpan: (name, attributes) => telemetry.startSpan(name, attributes),
    runSpanSync: (name, attributes, fn) => telemetry.runSpanSync(name, attributes, fn),
  };
  const push = createPushHub({
    queue: new PushQueue(store.handle()),
    devices: store,
    mode: 'all-at-once',
    escalationMs: 1000,
    telemetry: telemetrySurface,
  });
  const deviceLink = new DeviceLinkHub({ store, telemetry });
  const gateway = createGatewayServer({
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
    },
    store,
    replica: new ReplicaStore(store.handle()),
    share: new ShareStore(store.handle()),
    receipts: new ReceiptStore(store.handle()),
    settings: new SettingsStore(store.handle()),
    push,
    telemetry,
    deviceLink,
    runtime: {
      url: () => 'http://127.0.0.1:9',
      bootPath: () => '/?token=test-token',
      ready: () => true,
    },
  });
  await gateway.start();
  const gatewayPort = Number.parseInt(new URL(gateway.url()).port, 10);
  const host = createNotificationHost({
    database: store.handle(),
    push,
    telemetry: telemetrySurface,
    sweepIntervalMs: 20,
    timeoutMs: 2000,
  });
  const notificationServer = createServer((request, response) => {
    void host.handle(request, response);
  });
  const notificationPort = await listen(notificationServer);
  host.start();

  const bundle = await build({
    stdin: { contents: PAGE_ENTRY, resolveDir: RUNTIME, loader: 'tsx', sourcefile: 'wp22-page.tsx' },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    loader: { '.css': 'text' },
    alias: { '@chatdsh/core-ui-kit': join(RUNTIME, 'packages/core/ui-kit/src/index.ts') },
    logLevel: 'warning',
  });
  const script = bundle.outputFiles[0].text;
  const pageServer = createPageServer({ host, gatewayPort, script });
  const pagePort = await listen(pageServer.server);

  return {
    home,
    databasePath,
    store,
    push,
    telemetry,
    telemetrySurface,
    pushService,
    pushPort,
    host,
    otlp,
    script,
    journal: pageServer.journal,
    relay: pageServer.relay,
    control: pageServer.control,
    gatewayUrl: `http://127.0.0.1:${gatewayPort}`,
    gatewayPort,
    notificationOrigin: `http://127.0.0.1:${notificationPort}`,
    notificationUrl: `http://127.0.0.1:${notificationPort}${PREFIX}`,
    pageOrigin: `http://127.0.0.1:${pagePort}`,
    async close() {
      await host.close();
      await gateway.stop();
      await pageServer.close();
      await new Promise((done) => notificationServer.close(done));
      await new Promise((done) => pushService.server.close(done));
      await new Promise((done) => otlp.server.close(done));
      await telemetry.shutdown();
      store.close();
      releaseIndependentHome(home);
    },
  };
}

/** 建立客户端数据入口。 */
function nodeGateway(environment, clientId, deviceId) {
  return createNotificationGateway({ clientId, deviceId, baseUrl: environment.notificationOrigin });
}

/** 把投递节奏改成一次性投递，便于事件流断言。 */
function useAllAtOnce(environment) {
  const current = environment.host.settings();
  return environment.host.store.saveSettings({
    deliveryMode: 'all-at-once',
    firstStageSeconds: current.firstStageSeconds,
    secondStageSeconds: current.secondStageSeconds,
    onTurnEnd: current.onTurnEnd,
    onApproval: current.onApproval,
    messagePreview: current.messagePreview,
    quietWhenFocused: false,
    privacy: current.privacy,
  }, current.revision, Date.now());
}

/** 通过推送中枢投递一条业务事件里的通知载荷。 */
function publish(environment, payload) {
  return environment.push.deliver(JSON.stringify(payload));
}

/** 记一条通知。 */
function record(environment, input) {
  return environment.host.record({ ...input, dedupeKey: input.dedupeKey ?? `dedupe-${randomUUID()}` });
}

/** 读一个 CSS 选择器里的文本。 */
async function textOf(evaluate, selector) {
  return evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`);
}

/** 设置输入框的值并触发界面事件。 */
async function setInput(evaluate, selector, value) {
  return evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value;
  })()`);
}

test('通知列表分页、过滤、已读幂等、业务已处理与跨客户端同步', async () => {
  const environment = await startEnvironment('wp22-center');
  try {
    const base = Date.now() - 60_000;
    const rows = [];
    for (let index = 0; index < 5; index += 1) {
      rows.push(record(environment, {
        kind: index === 0 ? 'approval' : 'run-finished',
        title: `构建 ${String(index)}`,
        summary: `摘要 ${String(index)}`,
        deviceId: 'device-a',
        sessionId: index < 3 ? 'session-1' : 'session-2',
        objectId: `obj-${String(index)}`,
        createdAt: base + index * 1000,
      }));
    }
    const gatewayA = nodeGateway(environment, 'client-a', 'device-a');
    const gatewayB = nodeGateway(environment, 'client-b', 'device-b');

    const first = await gatewayA.list({ filter: 'all', limit: 2 });
    assert.equal(first.items.length, 2, '第一页取两行');
    assert.ok(typeof first.nextCursor === 'string' && first.nextCursor !== '', '第一页给出游标');
    assert.equal(first.unread, 5, '未读计数按设备与会话范围统计');
    assert.equal(first.handled, 0, '初始没有已处理记录');

    const second = await gatewayA.list({ filter: 'all', limit: 2, cursor: first.nextCursor });
    const firstIds = new Set(first.items.map((item) => item.id));
    assert.equal(second.items.length, 2, '第二页取两行');
    assert.equal(second.items.some((item) => firstIds.has(item.id)), false, '两页不重复');
    assert.deepEqual(
      [...first.items, ...second.items].map((item) => item.createdAt),
      [base + 4000, base + 3000, base + 2000, base + 1000],
      '列表按时间倒序',
    );

    const approvalOnly = await gatewayA.list({ filter: 'approval', limit: 20 });
    assert.deepEqual(approvalOnly.items.map((item) => item.kind), ['approval'], '审批过滤只留审批通知');
    const unreadOnly = await gatewayA.list({ filter: 'unread', limit: 20 });
    assert.equal(unreadOnly.items.length, 5, '未读过滤在没有已读记录时给出全部');
    const sessionOnly = await gatewayA.list({ filter: 'all', limit: 20, sessionId: 'session-1' });
    assert.equal(sessionOnly.items.length, 3, '会话过滤按会话标识');
    const otherDevice = await gatewayA.list({ filter: 'all', limit: 20, deviceId: 'device-b' });
    assert.equal(otherDevice.items.length, 0, '另一台设备没有记录');
    assert.equal(otherDevice.unread, 0, '另一台设备的未读计数为零');
    const timed = await gatewayA.list({ filter: 'all', limit: 20, since: base + 2000, until: base + 4000 });
    assert.equal(timed.items.length, 3, '时间范围按闭区间过滤');

    const readOne = await gatewayA.markRead([rows[1].id, rows[2].id]);
    assert.deepEqual(readOne, { marked: 2, unchanged: 0 }, '首次标记已读写入两条');
    const readAgain = await gatewayA.markRead([rows[1].id, rows[2].id]);
    assert.deepEqual(readAgain, { marked: 0, unchanged: 2 }, '重复标记按幂等处理');
    const afterRead = await gatewayA.list({ filter: 'all', limit: 20 });
    assert.equal(afterRead.items.find((item) => item.id === rows[2].id).readAt !== undefined, true, '已读时刻写进记录');
    assert.equal(afterRead.items.find((item) => item.id === rows[2].id).readClients.includes('client-a'), true, '已读客户端被记录');
    assert.equal(afterRead.unread, 3, '已读之后未读计数下降');
    assert.equal(afterRead.items.find((item) => item.id === rows[0].id).handledAt, undefined, '标记已读不写已处理');

    const crossRead = await gatewayB.markRead([rows[0].id]);
    assert.deepEqual(crossRead, { marked: 1, unchanged: 0 }, '另一个访问客户端标记已读');
    const sharedRead = await gatewayA.list({ filter: 'all', limit: 20 });
    const approvalRow = sharedRead.items.find((item) => item.id === rows[0].id);
    assert.equal(approvalRow.readAt !== undefined, true, '另一个客户端的已读立即可见');
    assert.deepEqual([...approvalRow.readClients], ['client-b'], '已读客户端列表记录标记的一方');
    assert.deepEqual([...afterRead.items.find((item) => item.id === rows[2].id).readClients], ['client-a'], '本端的已读记录保留');
    assert.equal(approvalRow.handledAt, undefined, '跨客户端已读不改变审批状态');

    const handled = await gatewayA.markHandled([rows[0].id]);
    assert.deepEqual(handled, { marked: 1, unchanged: 0 }, '标记业务已处理写入一条');
    const handledAgain = await gatewayA.markHandled([rows[0].id]);
    assert.deepEqual(handledAgain, { marked: 0, unchanged: 1 }, '重复标记业务已处理按幂等处理');
    const afterHandled = await gatewayA.list({ filter: 'all', limit: 20 });
    const handledRow = afterHandled.items.find((item) => item.id === rows[0].id);
    assert.equal(handledRow.handledAt !== undefined, true, '已处理时刻写进记录');
    assert.equal(handledRow.readAt !== undefined, true, '已处理不影响已读状态');
    assert.equal(afterHandled.handled, 1, '已处理计数变化');

    const badCursor = await call(`${environment.notificationUrl}/?filter=all&limit=5&cursor=not-a-cursor`);
    assert.equal(badCursor.status, 400, '非法游标被拒绝');
    assert.equal(badCursor.body.error, 'cursor-invalid', '非法游标返回错误码');
    const missingDevice = await call(`${environment.notificationUrl}/read`, { method: 'POST', body: { ids: ['x'] } });
    assert.equal(missingDevice.status, 400, '缺少访问客户端标识时拒绝');
  } finally {
    await environment.close();
    assert.equal(existsSync(environment.home), false, '关闭之后数据根被清理');
  }
});

test('设置的三档隐私、两种投递模式、阈值校验与 revision 冲突', async () => {
  const environment = await startEnvironment('wp22-settings');
  try {
    const gateway = nodeGateway(environment, 'client-settings', 'device-settings');
    const initial = await gateway.readSettings();
    assert.equal(initial.privacy, 'summary', '默认隐私级别为摘要');
    assert.equal(initial.deliveryMode, 'two-stage', '默认投递模式为两阶段');
    assert.equal(initial.revision, 0, '初始版本为零');

    const draft = {
      deliveryMode: 'all-at-once',
      firstStageSeconds: 0,
      secondStageSeconds: initial.secondStageSeconds,
      onTurnEnd: true,
      onApproval: false,
      messagePreview: false,
      quietWhenFocused: true,
      privacy: 'type',
    };
    const saved = await gateway.saveSettings(draft, initial.revision);
    assert.equal(saved.ok, true, '第一次写入成功');
    assert.equal(saved.settings.privacy, 'type', '隐私级别写入为仅事件类型');
    assert.equal(saved.settings.deliveryMode, 'all-at-once', '投递模式写入为一次性');
    assert.equal(saved.settings.revision, 1, '版本递增');

    const stale = await gateway.saveSettings({ ...draft, privacy: 'preview' }, initial.revision);
    assert.equal(stale.ok, false, '过期版本写入被拒绝');
    assert.equal(stale.code, 'revision-conflict', '冲突返回版本错误码');
    assert.equal(stale.current.revision, 1, '冲突结果带回服务端当前设置');

    await assert.rejects(
      gateway.saveSettings({ ...draft, deliveryMode: 'two-stage', firstStageSeconds: 200, secondStageSeconds: 100 }, 1),
      (error) => error.code === 'request-invalid' && error.status === 400,
      '第二阶段等待小于第一阶段时服务端拒绝',
    );
    await assert.rejects(
      gateway.saveSettings({ ...draft, firstStageSeconds: 400 }, 1),
      (error) => error.code === 'request-invalid',
      '第一阶段等待超过 300 秒时服务端拒绝',
    );
    await assert.rejects(
      gateway.saveSettings({ ...draft, privacy: 'body' }, 1),
      (error) => error.code === 'request-invalid',
      '未登记的隐私级别被拒绝',
    );

    const preview = await gateway.saveSettings({
      ...draft,
      privacy: 'preview',
      messagePreview: true,
      deliveryMode: 'two-stage',
      firstStageSeconds: 30,
      secondStageSeconds: 90,
    }, 1);
    assert.equal(preview.ok, true, '合法设置再次写入成功');
    assert.equal(preview.settings.privacy, 'preview', '隐私级别写入为预览');
    assert.equal(preview.settings.secondStageSeconds, 90, '第二阶段等待写入成功');
    assert.equal(preview.settings.revision, 2, '版本继续递增');
    assert.equal((await gateway.readSettings()).revision, 2, '直接读取到最新版本');
  } finally {
    await environment.close();
  }
});

test('订阅保存与失效、验证通知的服务受理与客户端接收分开记录', async () => {
  const environment = await startEnvironment('wp22-probe');
  try {
    const deviceId = 'device-probe';
    const gateway = nodeGateway(environment, 'client-probe', deviceId);
    const subscription = makeSubscription(environment.pushPort, '/push/probe-one');
    environment.pushService.register(subscription);

    const saved = await gateway.saveSubscription({
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      permission: 'granted',
    });
    assert.equal(saved.state, 'subscribed', '订阅保存之后为已订阅');
    assert.equal(saved.permission, 'granted', '订阅记录系统通知权限');

    const accepted = await gateway.sendProbe();
    assert.equal(accepted.probe.result, 'accepted', '推送服务受理之后结果为已受理');
    assert.equal(typeof accepted.probe.acceptedAt, 'number', '受理时刻被记录');
    assert.equal(accepted.probe.receivedAt, undefined, '客户端还未回报接收');
    const delivered = environment.pushService.plaintexts();
    assert.equal(delivered.length, 1, '推送服务收到并解密一条载荷');
    assert.equal(delivered[0].kind, 'notification-probe', '载荷是验证通知');
    assert.equal(delivered[0].id, accepted.id, '载荷带着验证标识');

    const receipt = await gateway.reportProbeReceipt(accepted.id, Date.now());
    assert.equal(receipt.probe.result, 'delivered', '回报接收之后结果为已送达');
    assert.equal(typeof receipt.probe.receivedAt, 'number', '接收时刻被记录');
    assert.equal(receipt.probe.acceptedAt, accepted.probe.acceptedAt, '两段时刻分别保留');

    const removed = await gateway.removeSubscription();
    assert.equal(removed.removed, 1, '退订把已订阅记录改为未订阅');
    const revoked = await gateway.readSubscription();
    assert.equal(revoked.state, 'unsubscribed', '退订之后订阅状态为未订阅');
    const unsupported = await gateway.sendProbe();
    assert.equal(unsupported.probe.result, 'failed', '没有有效订阅时验证通知失败');
    assert.equal(unsupported.probe.code, 'push-unsupported', '失败码说明缺少推送支持');

    const second = makeSubscription(environment.pushPort, '/push/probe-two');
    environment.pushService.register(second);
    await gateway.saveSubscription({
      endpoint: second.endpoint,
      p256dh: second.keys.p256dh,
      auth: second.keys.auth,
      permission: 'granted',
    });
    environment.pushService.setStatus('/push/probe-two', 410);
    const gone = await gateway.sendProbe();
    assert.equal(gone.probe.result, 'failed', '推送服务回 410 之后验证通知失败');
    assert.equal(gone.probe.code, 'push-endpoint-gone', '失败码说明端点失效');
    const view = await gateway.readSubscription();
    assert.equal(view.state, 'gone', '订阅状态变为已失效');
    assert.equal(view.code, 'push-endpoint-gone', '订阅状态带回失效码');
  } finally {
    await environment.close();
  }
});

test('事件流下发通知、已读、已处理与撤回，并驱动列表状态', async () => {
  const environment = await startEnvironment('wp22-events');
  try {
    useAllAtOnce(environment);
    const deviceId = 'device-events';
    const gateway = nodeGateway(environment, 'client-events', deviceId);
    const withdrawn = [];
    const center = new NotificationCenter({
      gateway,
      onWithdraw: (event) => {
        withdrawn.push(...event.tags);
      },
    });
    const stream = await openEvents(environment.gatewayPort, deviceId);
    try {
      await waitFor(() => environment.push.onlineDevices() > 0, 3000, '事件流连接建立');
      publish(environment, { kind: 'approval', sessionId: 'session-events', callId: 'call-events', toolName: 'Bash', deviceId, title: '审批：Bash' });
      await waitFor(() => stream.events.some((event) => event.kind === 'notification'), 5000, '收到通知事件');
      const notificationEvent = stream.events.find((event) => event.kind === 'notification');
      assert.equal(notificationEvent.mode, 'all-at-once', '事件带着投递节奏');
      assert.equal(notificationEvent.stage, 0, '一次性投递的阶段为零');
      assert.equal(notificationEvent.count, 1, '事件条数与内容一致');
      const notified = notificationEvent.items[0];
      assert.equal(notified.tag, 'approval-call-events', '审批通知带稳定 tag');
      assert.equal(notified.sessionId, 'session-events', '通知带会话标识');
      center.applyEvent(notificationEvent);
      assert.equal(center.snapshot().items.length, 1, '通知事件进入列表');
      assert.equal(center.snapshot().unread, 1, '未读计数加一');

      const readResult = await gateway.markRead([notified.id]);
      assert.equal(readResult.marked, 1, '已读写入一条');
      await waitFor(() => stream.events.some((event) => event.kind === 'notification-read'), 5000, '收到已读事件');
      const readEvent = stream.events.find((event) => event.kind === 'notification-read');
      assert.deepEqual(readEvent.ids, [notified.id], '已读事件带通知标识');
      assert.equal(readEvent.clientId, 'client-events', '已读事件带访问客户端标识');
      center.applyEvent(readEvent);
      assert.equal(center.snapshot().items[0].readAt, readEvent.readAt, '列表按事件写入已读时刻');
      assert.equal(center.snapshot().unread, 0, '已读之后未读计数归零');

      const handledResult = await gateway.markHandled([notified.id]);
      assert.equal(handledResult.marked, 1, '已处理写入一条');
      await waitFor(() => stream.events.some((event) => event.kind === 'notification-handled'), 5000, '收到已处理事件');
      const handledEvent = stream.events.find((event) => event.kind === 'notification-handled');
      center.applyEvent(handledEvent);
      assert.equal(center.snapshot().items[0].handledAt, handledEvent.handledAt, '列表按事件写入已处理时刻');
      assert.equal(center.snapshot().handled, 1, '已处理计数加一');

      const count = environment.host.delivery.withdrawApproval('session-events', 'call-events');
      assert.equal(count, 1, '审批终结撤回一条通知');
      await waitFor(() => stream.events.some((event) => event.kind === 'notification-withdraw'), 5000, '收到撤回事件');
      const withdrawEvent = stream.events.find((event) => event.kind === 'notification-withdraw');
      assert.deepEqual(withdrawEvent.tags, ['approval-call-events'], '撤回事件带稳定 tag');
      assert.equal(withdrawEvent.objectId, 'call-events', '撤回事件带工具调用标识');
      center.applyEvent(withdrawEvent);
      assert.equal(center.snapshot().items.length, 0, '撤回之后列表移除该条');
      assert.deepEqual(withdrawn, ['approval-call-events'], '界面拿到要关闭的 tag');

      const page = await gateway.list({ filter: 'all', limit: 20 });
      assert.equal(page.items.length, 0, '撤回的记录不再出现在列表里');
    } finally {
      stream.close();
    }
  } finally {
    await environment.close();
  }
});

test('真实 Chrome 的通知中心：过滤、已读幂等、导航、设置冲突、权限拒绝与实时撤回', { timeout: 300000 }, async (t) => {
  const environment = await startEnvironment('wp22-browser');
  const deviceId = 'device-page';
  const otherDevice = 'device-other';
  const session = `wp22-${randomUUID().slice(0, 8)}`;
  const env = {
    ...process.env,
    TMPDIR: environment.home,
    HOME: environment.home,
    AGENT_BROWSER_SESSION: session,
    AGENT_BROWSER_EXECUTABLE_PATH: '/usr/bin/google-chrome',
    AGENT_BROWSER_PROFILE: join(environment.home, 'chrome'),
    AGENT_BROWSER_ARGS: '--no-sandbox',
  };
  mkdirSync(join(environment.home, 'chrome'), { recursive: true });
  const cli = async (...args) => {
    const result = await execute(`${NODE_BIN}/agent-browser`, ['--session', session, '--json', ...args], { env, timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    const response = JSON.parse(result.stdout);
    assert.equal(response.success, true, `agent-browser ${args[0]}：${result.stdout}`);
    return response;
  };
  const evaluate = async (expression) => {
    const response = await cli('eval', expression);
    return response.data.result;
  };
  const textHas = async (needle) => evaluate(`document.body.innerText.includes(${JSON.stringify(needle)})`);
  const waitText = async (needle) => {
    await waitFor(() => textHas(needle), 20000, `页面出现文本：${needle}`);
  };
  const typeInto = async (selector, value) => {
    await cli('click', selector);
    await cli('press', 'Control+a');
    await cli('type', selector, value);
  };
  const badgesOf = async (openSelector) => evaluate(
    `[...document.querySelector(${JSON.stringify(openSelector)}).closest('li').querySelectorAll('.chdsh-badge')].map((node) => node.textContent.trim())`,
  );

  try {
    const approval = record(environment, {
      kind: 'approval',
      title: '审批：Write',
      summary: '等待审批：Write',
      deviceId,
      sessionId: 'session-alpha',
      objectId: 'call-1',
      tag: 'approval-call-1',
    });
    const finished = record(environment, {
      kind: 'run-finished',
      title: '构建完成',
      summary: '检查通过',
      deviceId,
      sessionId: 'session-alpha',
      objectId: 'run-1',
    });
    const share = record(environment, {
      kind: 'share',
      title: '分享快照',
      summary: '公开链接已生成',
      deviceId,
      objectId: 'share-1',
    });
    const other = record(environment, {
      kind: 'run-failed',
      title: '执行失败',
      summary: '任务失败',
      deviceId: otherDevice,
      sessionId: 'session-beta',
      objectId: 'run-2',
    });

    await cli('open', `${environment.pageOrigin}/?device=${encodeURIComponent(deviceId)}`);
    await cli('wait', '#wp22-counts');
    await cli('wait', '--fn', 'window.__wp22 && window.__wp22.ready === true');
    await waitText('构建完成');
    await waitText('审批：Write');

    await t.test('列表分页、过滤、空状态与加载失败重试', async () => {
      const counts = await textOf(evaluate, '#wp22-counts');
      assert.equal(counts.includes('未读 4 条'), true, `计数显示四条未读：${counts}`);
      assert.equal(await evaluate('document.querySelectorAll("[data-notify-open]").length'), 4, '四行通知');

      await cli('click', '#wp22-filter-unread');
      await waitFor(async () => (await evaluate('document.querySelectorAll("[data-notify-open]").length')) === 4, 10000, '未读过滤显示四行');
      await cli('click', '#wp22-filter-approval');
      await waitFor(async () => (await evaluate('document.querySelectorAll("[data-notify-open]").length')) === 1, 10000, '审批过滤显示一行');
      assert.equal(await textHas('构建完成'), false, '审批过滤隐藏执行结果');

      await cli('click', '#wp22-filter-all');
      await waitFor(async () => (await evaluate('document.querySelectorAll("[data-notify-open]").length')) === 4, 10000, '全部过滤恢复四行');

      await setInput(evaluate, '#wp22-filter-device', otherDevice);
      await cli('click', '#wp22-filter-apply');
      await waitFor(async () => (await evaluate('document.querySelectorAll("[data-notify-open]").length')) === 1, 10000, '设备过滤只留另一台设备');
      assert.equal(await textHas('执行失败'), true, '设备过滤显示该设备的通知');

      await setInput(evaluate, '#wp22-filter-device', '');
      await setInput(evaluate, '#wp22-filter-session', 'session-beta');
      await cli('click', '#wp22-filter-apply');
      await waitFor(async () => (await evaluate('document.querySelectorAll("[data-notify-open]").length')) === 1, 10000, '会话过滤只留一条');
      assert.equal(await textHas('构建完成'), false, '会话过滤隐藏其他会话');

      await setInput(evaluate, '#wp22-filter-session', '');
      await setInput(evaluate, '#wp22-filter-since', '2031-01-01');
      await cli('click', '#wp22-filter-apply');
      await waitText('当前过滤条件下没有通知');
      assert.equal(await evaluate('document.querySelectorAll("[data-notify-open]").length'), 0, '空状态下没有行');
      await cli('click', '#wp22-empty-refresh');
      await waitFor(async () => (await evaluate('document.querySelectorAll("[data-notify-open]").length')) === 0, 5000, '刷新之后仍为空');

      await setInput(evaluate, '#wp22-filter-since', '');
      await cli('click', '#wp22-filter-apply');
      await waitFor(async () => (await evaluate('document.querySelectorAll("[data-notify-open]").length')) === 4, 10000, '清空时间范围恢复四行');
      environment.control.failList = true;
      await cli('click', '#wp22-refresh');
      await cli('wait', '#wp22-failure');
      const failure = await textOf(evaluate, '#wp22-failure');
      assert.equal(failure.includes('通知中心暂时无法读取'), true, `失败状态给出说明：${failure}`);
      environment.control.failList = false;
      await cli('click', '#wp22-reload');
      await waitFor(async () => (await evaluate('document.querySelectorAll("[data-notify-open]").length')) === 4, 10000, '重新加载恢复四行');

      environment.control.delayList = 200;
      await cli('click', '#wp22-refresh');
      await cli('wait', '.chdsh-skeleton');
      await waitFor(async () => (await evaluate('document.querySelectorAll("[data-notify-open]").length')) === 4, 10000, '读取完成之后恢复行');
      environment.control.delayList = 0;
    });

    await t.test('标记已读幂等、跨客户端同步与业务已处理独立', async () => {
      const approvalOpen = `#wp22-open-${approval.id}`;
      await cli('click', `#wp22-read-${approval.id}`);
      await waitText('已标记 1 条为已读');
      const rowText = await textOf(evaluate, approvalOpen);
      assert.equal(rowText.includes('审批：Write'), true, '行标题保留业务名称');
      const readBadges = await badgesOf(approvalOpen);
      assert.equal(readBadges.includes('已读'), true, '行显示已读徽标');
      assert.equal(readBadges.includes('未处理'), true, '标记已读不写已处理');

      await waitFor(async () => (await evaluate(`document.getElementById("wp22-read-${approval.id}").disabled`)) === false, 5000, '已读按钮恢复可用');
      await cli('click', `#wp22-read-${approval.id}`);
      await waitText('已经处于已读状态，本次没有新的写入');

      const crossClient = nodeGateway(environment, 'client-other', deviceId);
      const crossResult = await crossClient.markRead([finished.id]);
      assert.equal(crossResult.marked, 1, '另一个客户端写入已读');
      await waitFor(
        async () => (await badgesOf(`#wp22-open-${finished.id}`)).includes('已读'),
        10000,
        '另一个客户端的已读经事件流同步到页面',
      );
      const countsAfter = await textOf(evaluate, '#wp22-counts');
      assert.equal(countsAfter.includes('未读 2 条'), true, `两端读取之后未读计数下降：${countsAfter}`);

      await cli('click', `#wp22-handled-${approval.id}`);
      await waitText('审批决定需要在审批页面完成');
      const handledBadges = await badgesOf(approvalOpen);
      assert.equal(handledBadges.includes('已处理'), true, '行显示已处理徽标');
      assert.equal(handledBadges.includes('已读'), true, '已处理与已读同时保留');
      const writes = environment.journal.filter((entry) => entry.method !== 'GET');
      assert.equal(writes.some((entry) => entry.path.includes('approve')), false, '界面没有调用任何审批接口');
      await waitFor(
        () => environment.relay.some((entry) => entry.signal === 'logs' && JSON.stringify(entry.payload).includes('chatdsh.client.ui.action')),
        10000,
        '界面动作经同源中继上报',
      );
    });

    await t.test('打开通知只跳转业务页面，没有关联会话时给出说明', async () => {
      const before = environment.journal.length;
      await cli('click', `#wp22-open-${finished.id}`);
      await waitText('正在打开关联会话');
      const hash = await evaluate('window.location.hash');
      assert.equal(hash, '#/session/session-alpha', '打开通知跳转到关联会话');
      const writes = environment.journal.slice(before).filter((entry) => entry.method !== 'GET');
      assert.equal(writes.length, 0, '打开通知没有写请求');

      const hashBefore = await evaluate('window.location.hash');
      await cli('click', `#wp22-open-${share.id}`);
      await waitText('没有关联会话');
      const notice = await textOf(evaluate, '#wp22-local-notice');
      assert.equal(notice.includes('无法打开业务页面'), true, `没有会话时给出说明：${notice}`);
      assert.equal(await evaluate('window.location.hash'), hashBefore, '没有会话时不改变地址');
      await waitFor(async () => (await evaluate('window.__wp22.runtime.focusedSessionId()')) === 'session-alpha', 5000, '页面记录当前聚焦会话');
      await waitFor(
        () => environment.relay.some((entry) => entry.signal === 'traces' && JSON.stringify(entry.payload).includes('chatdsh.client.navigate')),
        10000,
        '导航 span 经同源中继上报',
      );
      await waitFor(
        () => environment.relay.some((entry) => entry.signal === 'logs' && JSON.stringify(entry.payload).includes('chatdsh.client.navigate.rejected')),
        10000,
        '被拒绝的导航写一条拒绝事件',
      );
    });

    await t.test('投递设置：三档隐私、两种模式、阈值校验与版本冲突', async () => {
      await cli('click', 'div[role="tablist"] button:nth-child(2)');
      await cli('wait', '#wp22-settings-privacy');
      const options = await evaluate('[...document.querySelectorAll("#wp22-settings-privacy option")].map((option) => option.value)');
      assert.deepEqual(options, ['type', 'summary', 'preview'], '隐私级别三档');
      assert.equal(await evaluate('document.querySelectorAll("input[name=\\"wp22-delivery-mode\\"]").length'), 2, '投递模式两种');
      const revision = await textOf(evaluate, '#wp22-settings-revision');
      assert.equal(revision.includes('当前版本 0'), true, `初始版本为零：${revision}`);

      await typeInto('#wp22-settings-first', '300');
      await typeInto('#wp22-settings-second', '100');
      const beforeInvalid = environment.journal.filter((entry) => entry.method === 'PUT').length;
      await cli('scrollintoview', '#wp22-settings-save');
      await cli('click', '#wp22-settings-save');
      await cli('wait', '#wp22-settings-errors');
      const errors = await textOf(evaluate, '#wp22-settings-errors');
      assert.equal(errors.includes('第二阶段等待必须大于第一阶段等待'), true, `字段错误给出阈值规则：${errors}`);
      assert.equal(await evaluate('document.activeElement.id'), 'wp22-settings-errors', '校验失败之后焦点落在错误摘要');
      assert.equal(environment.journal.filter((entry) => entry.method === 'PUT').length, beforeInvalid, '校验失败没有写服务端');

      await cli('select', '#wp22-settings-privacy', 'type');
      await typeInto('#wp22-settings-second', '900');
      await cli('scrollintoview', '#wp22-settings-save');
      await cli('click', '#wp22-settings-save');
      await waitText('设置已保存，版本 1');

      const current = environment.host.settings();
      environment.host.store.saveSettings({ ...current, privacy: 'summary' }, current.revision, Date.now());
      await cli('scrollintoview', '#wp22-settings-save');
      await cli('click', '#wp22-settings-save');
      await cli('wait', '#wp22-settings-conflict');
      const conflict = await textOf(evaluate, '#wp22-settings-conflict');
      assert.equal(conflict.includes('服务端版本为 2'), true, `冲突给出服务端版本：${conflict}`);
      await waitFor(async () => (await evaluate('document.activeElement.id')) === 'wp22-settings-reload', 5000, '冲突之后焦点落在重新读取入口');

      await cli('scrollintoview', '#wp22-settings-reload');
      await cli('click', '#wp22-settings-reload');
      await waitFor(async () => (await textOf(evaluate, '#wp22-settings-revision')).includes('当前版本 2'), 10000, '重新读取之后版本更新');
      assert.equal(await evaluate('document.getElementById("wp22-settings-privacy").value'), 'summary', '重新读取带回服务端的隐私级别');
      assert.equal(await evaluate('document.getElementById("wp22-settings-conflict")'), null, '重新读取之后冲突提示消失');
    });

    await t.test('权限拒绝、订阅失效与验证通知的两段结果', async () => {
      await cli('click', 'div[role="tablist"] button:nth-child(3)');
      await cli('wait', '#wp22-permission-state');
      const permission = await evaluate('Notification.permission');
      const displayed = await textOf(evaluate, '#wp22-permission-state');
      assert.equal(displayed.includes(permission === 'default' ? '尚未请求' : permission === 'denied' ? '已拒绝' : '已允许'), true, `页面权限与浏览器一致：${displayed}`);

      await cli('click', '#wp22-permission-request');
      await cli('wait', '#wp22-permission-denied');
      const denied = await textOf(evaluate, '#wp22-permission-denied');
      assert.equal(denied.includes('浏览器拒绝了系统通知权限'), true, `拒绝分支给出说明：${denied}`);
      assert.equal((await textOf(evaluate, '#wp22-permission-state')).includes('已拒绝'), true, '页面显示真实权限为已拒绝');
      assert.equal(await evaluate('window.__wp22.runtime.notifier.activeTags().length'), 0, '拒绝期间没有展示系统通知');

      const subscription = makeSubscription(environment.pushPort, '/push/page');
      environment.pushService.register(subscription);
      const gateway = nodeGateway(environment, 'client-page', deviceId);
      await gateway.saveSubscription({
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        permission: 'granted',
      });
      await cli('click', '#wp22-subscription-reload');
      await waitFor(async () => (await textOf(evaluate, '#wp22-subscription-state')).includes('已订阅'), 10000, '订阅状态显示已订阅');

      await cli('click', '#wp22-probe-send');
      await waitFor(async () => (await textOf(evaluate, '#wp22-probe-accepted')).includes('已受理'), 15000, '验证通知被服务受理');
      const accepted = await textOf(evaluate, '#wp22-probe-accepted');
      assert.equal(accepted.includes('受理时刻'), true, `受理段给出时刻：${accepted}`);
      const received = await textOf(evaluate, '#wp22-probe-received');
      assert.equal(received.includes('尚未收到'), true, `接收段单独呈现：${received}`);
      assert.equal((await textOf(evaluate, '#wp22-subscription-note')).includes('没有已注册的 Service Worker'), true, '订阅备注说明缺少 Service Worker');

      environment.pushService.setStatus('/push/page', 410);
      await gateway.sendProbe();
      await cli('click', '#wp22-subscription-reload');
      await waitFor(async () => (await textOf(evaluate, '#wp22-subscription-state')).includes('已失效'), 10000, '推送回执之后订阅失效');
      assert.equal((await textOf(evaluate, '#wp22-subscription-state')).includes('push-endpoint-gone'), true, '失效状态带回错误码');

      await cli('click', '#wp22-probe-send');
      await waitFor(async () => (await textOf(evaluate, '#wp22-probe-accepted')).includes('未受理'), 15000, '没有有效订阅时验证失败');
      assert.equal((await textOf(evaluate, '#wp22-probe-accepted')).includes('push-unsupported'), true, '失败码说明缺少推送支持');

      const relayPaths = environment.relay.filter((entry) => entry.signal === 'logs');
      assert.equal(relayPaths.length > 0, true, '界面动作通过同源中继上报');
    });

    await t.test('实时撤回移除列表条目并关闭系统通知', async () => {
      useAllAtOnce(environment);
      await cli('click', 'div[role="tablist"] button:nth-child(1)');
      await cli('wait', '#wp22-list');
      publish(environment, { kind: 'approval', sessionId: 'session-withdraw', callId: 'call-w', toolName: 'Bash', deviceId, title: '审批：Bash' });
      await waitText('审批：Bash');
      const before = environment.journal.length;
      const count = environment.host.delivery.withdrawApproval('session-withdraw', 'call-w');
      assert.equal(count, 1, '审批终结撤回一条通知');
      await waitText('审批已经处理，对应的提醒已撤回');
      await waitFor(async () => (await textHas('审批：Bash')) === false, 10000, '撤回之后行消失');
      assert.equal(environment.journal.slice(before).filter((entry) => entry.method !== 'GET').length, 0, '撤回不触发页面写请求');
      assert.equal(await evaluate('window.__wp22.runtime.notifier.activeTags().length'), 0, '系统通知登记表为空');
      const remaining = await evaluate('document.querySelectorAll("[data-notify-open]").length');
      assert.equal(remaining, 4, '其余通知仍然在列表里');
    });

    await t.test('列表键盘导航与可访问名称', async () => {
      await cli('click', 'div[role="tablist"] button:nth-child(1)');
      await setInput(evaluate, '#wp22-filter-device', '');
      await setInput(evaluate, '#wp22-filter-session', '');
      await setInput(evaluate, '#wp22-filter-since', '');
      await setInput(evaluate, '#wp22-filter-until', '');
      await cli('click', '#wp22-filter-apply');
      await waitFor(async () => (await evaluate('document.querySelectorAll("[data-notify-open]").length')) === 4, 10000, '键盘导航之前恢复四行');
      const ids = await evaluate('[...document.querySelectorAll("[data-notify-open]")].map((button) => button.id)');
      assert.equal(ids.length, 4, '四行通知可导航');
      await cli('focus', `#${ids[0]}`);
      await cli('press', 'ArrowDown');
      assert.equal(await evaluate('document.activeElement.id'), ids[1], '向下方向键移到下一行');
      await cli('press', 'ArrowDown');
      assert.equal(await evaluate('document.activeElement.id'), ids[2], '继续向下移动');
      await cli('press', 'ArrowUp');
      assert.equal(await evaluate('document.activeElement.id'), ids[1], '向上方向键回到上一行');
      await cli('press', 'End');
      assert.equal(await evaluate('document.activeElement.id'), ids[3], 'End 键移到末行');
      await cli('press', 'Home');
      assert.equal(await evaluate('document.activeElement.id'), ids[0], 'Home 键移到首行');

      const names = await evaluate('[...document.querySelectorAll("#root button")].map((button) => (button.getAttribute("aria-label") ?? button.textContent ?? "").trim())');
      assert.equal(names.length > 0, true, '面板里有可操作按钮');
      assert.deepEqual(names.filter((name) => name === ''), [], '每个按钮都有可访问名称');
      const audit = await cli('a11y', '--selector', '#root', '--json');
      const violations = audit.data.violations ?? [];
      const namingViolations = violations.filter((violation) => ['button-name', 'label', 'link-name'].includes(violation.id));
      assert.deepEqual(namingViolations.map((violation) => violation.id), [], '无障碍审计没有名称类问题');
    });
  } finally {
    await cli('close').catch(() => undefined);
    await environment.close();
  }
});
