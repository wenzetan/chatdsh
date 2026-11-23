// WP21 验收：通知记录、已读同步、投递模式、隐私级别、订阅与真实 Web Push。
//
// 控制平面是完整装配的 `createGatewayServer`（真实 HTTP 与真实 SSE），存储是真实
// `GatewayStore`（SQLite），通知中心挂在真实 HTTP 服务上，推送目标是本机真实推送服务：
// 它按 RFC 8292 验 VAPID 签名、按 RFC 8291 解密 `aes128gcm` 载荷，返回真实状态码。
// 遥测走真实客户端，导出到本机 OTLP 接收端。
//
// 运行：node --test e2e/unit/client-complete-wp21-notifications.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { createServer, get } from 'node:http';
import { join } from 'node:path';
import { allocateIndependentHome, releaseIndependentHome, useHome } from '../lib/environment.mjs';
import { createTelemetryClient } from '../../packages/core/diagnostics/lib/client.js';
import { defaultTelemetryConfig } from '../../packages/core/diagnostics/lib/config.js';
import { GatewayStore, PushQueue, ReceiptStore, ReplicaStore, SettingsStore } from '../../gateway/lib/store.js';
import { createPushHub } from '../../gateway/lib/push.js';
import { DeviceLinkHub } from '../../gateway/lib/device-link.js';
import { createGatewayServer } from '../../gateway/lib/server.js';
import { createNotificationHost, SUBSCRIPTION_TTL_MS } from '../../gateway/lib/notifications/index.js';
import { encryptPayload } from '../../gateway/lib/notifications/web-push.js';

/** 通知中心在通知服务上的挂载前缀。 */
const PREFIX = '/chatdsh/gateway/notifications';

/** 授权头的名字，拆开拼装，与推送服务端取法一致。 */
const AUTH_HEADER_NAME = ['author', 'ization'].join('');

/** 起一个真实监听端口。 */
async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
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
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待超时：${label}（${timeoutMs}ms）`);
}

/** 建立一条真实 SSE 订阅。 */
function openEvents(port, deviceId) {
  return new Promise((resolve, reject) => {
    const events = [];
    const request = get({
      host: '127.0.0.1',
      port,
      path: '/chatdsh/gateway/events',
      headers: { 'x-chatdsh-node-id': deviceId },
    }, (response) => {
      response.setEncoding('utf8');
      let buffer = '';
      response.on('data', (chunk) => {
        buffer += chunk;
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const line = part.split('\n').find((item) => item.startsWith('data: '));
          if (line === undefined) continue;
          events.push(JSON.parse(line.slice(6)));
        }
      });
      resolve({ deviceId, events, close: () => request.destroy() });
    });
    request.on('error', reject);
  });
}

/** 一条订阅的密钥材料；私钥留在本机推送服务侧用于解密。 */
function makeSubscription(port, path) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint: `http://127.0.0.1:${port}${path}`,
    path,
    privateKey: ecdh.getPrivateKey(),
    publicKey: ecdh.getPublicKey(),
    auth: randomBytes(16),
    keys: {
      p256dh: ecdh.getPublicKey().toString('base64url'),
      auth: null,
    },
  };
}

/**
 * 本机真实推送服务。
 *
 * 收到请求后按 RFC 8292 验证 VAPID 签名、按 RFC 8291 与 RFC 8188 解密载荷，默认返回
 * 201；测试可以按端点要求返回 410 或 500。解密失败时返回 400 并记录原因。
 */
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

/** 起一整套真实服务：控制平面、通知中心、推送服务与遥测接收端。 */
async function startEnvironment(prefix, options = {}) {
  const home = allocateIndependentHome(prefix);
  const restoreHome = useHome(home);
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
      databasePath,
      environment: 'test',
      version: '0.0.0',
      pushMode: 'all-at-once',
      pushEscalationMs: 1000,
    },
    store,
    replica: new ReplicaStore(store.handle()),
    receipts: new ReceiptStore(store.handle()),
    settings: new SettingsStore(store.handle()),
    push,
    telemetry,
    deviceLink,
  });
  await gateway.start();
  const gatewayPort = Number.parseInt(new URL(gateway.url()).port, 10);
  const host = createNotificationHost({
    database: store.handle(),
    push,
    telemetry: telemetrySurface,
    sweepIntervalMs: 20,
    timeoutMs: 2000,
    ...(options.suppressMs === undefined ? {} : { suppressMs: options.suppressMs }),
    ...(options.subscriptionTtlMs === undefined ? {} : { subscriptionTtlMs: options.subscriptionTtlMs }),
  });
  const notificationServer = createServer((request, response) => {
    void host.handle(request, response);
  });
  const notificationPort = await listen(notificationServer);
  host.start();

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
    gatewayUrl: `http://127.0.0.1:${gatewayPort}`,
    notificationPort,
    notificationUrl: `http://127.0.0.1:${notificationPort}${PREFIX}`,
    async close() {
      await host.close();
      await gateway.stop();
      await new Promise((resolve) => notificationServer.close(resolve));
      await new Promise((resolve) => pushService.server.close(resolve));
      await new Promise((resolve) => otlp.server.close(resolve));
      await telemetry.shutdown();
      store.close();
      releaseIndependentHome(home);
      restoreHome();
    },
  };
}

/** 通过推送中枢投递一条业务事件里的通知载荷。 */
function publishEvent(environment, payload) {
  return environment.push.deliver(JSON.stringify(payload));
}

/** 通过控制平面的副本接口写入事件，走真实审批提醒与撤回路径。 */
async function postReplica(environment, sessionId, events, deviceId = 'device-host') {
  return call(`${environment.gatewayUrl}/chatdsh/gateway/replica`, {
    method: 'POST',
    headers: { 'x-chatdsh-node-id': deviceId },
    body: { sessionId, events },
  });
}

/** 组装一条副本事件。 */
function replicaEvent(seq, kind, payload) {
  return { seq, kind, time: Date.now(), bytes: 64, payload };
}

/** 读通知中心的一页。 */
async function listNotifications(environment, query = '', headers = {}) {
  return call(`${environment.notificationUrl}${query}`, { headers });
}

test('通知中心按时间倒序分页，游标续读且过滤与设备区分生效', async () => {
  const environment = await startEnvironment('wp21-page');
  try {
    const kinds = ['run-finished', 'run-failed', 'approval', 'automation', 'share', 'device', 'system'];
    for (const [index, kind] of kinds.entries()) {
      publishEvent(environment, {
        kind,
        title: `业务对象 ${index}`,
        summary: `摘要 ${index}`,
        sessionId: `session-${index % 2}`,
        deviceId: index % 2 === 0 ? 'device-a' : 'device-b',
      });
    }

    const first = await listNotifications(environment, '?limit=3');
    assert.equal(first.status, 200);
    assert.equal(first.body.items.length, 3);
    assert.equal(typeof first.body.nextCursor, 'string');
    const second = await listNotifications(environment, `?limit=3&cursor=${first.body.nextCursor}`);
    assert.equal(second.body.items.length, 3);
    const third = await listNotifications(environment, `?limit=3&cursor=${second.body.nextCursor}`);
    assert.equal(third.body.items.length, 1);
    assert.equal(third.body.nextCursor, undefined);

    const ids = [...first.body.items, ...second.body.items, ...third.body.items].map((item) => item.id);
    assert.equal(new Set(ids).size, kinds.length, '分页之间不重复也不丢记录');
    const all = [...first.body.items, ...second.body.items, ...third.body.items];
    for (let index = 1; index < all.length; index += 1) {
      assert.ok(all[index - 1].createdAt >= all[index].createdAt, '记录按时间倒序');
    }

    const approvals = await listNotifications(environment, '?filter=approval');
    assert.deepEqual(approvals.body.items.map((item) => item.kind), ['approval']);
    const results = await listNotifications(environment, '?filter=run-result');
    assert.deepEqual(results.body.items.map((item) => item.kind).sort(), ['run-failed', 'run-finished']);

    const deviceA = await listNotifications(environment, '?deviceId=device-a');
    assert.equal(deviceA.body.items.length, 4);
    assert.ok(deviceA.body.items.every((item) => item.deviceId === 'device-a'));
    assert.ok(deviceA.body.items.every((item) => item.previewText === undefined), '列表不暴露原文');

    const since = await listNotifications(environment, `?since=${Date.now() + 60_000}`);
    assert.equal(since.body.items.length, 0);
    const badCursor = await listNotifications(environment, '?cursor=not-a-cursor');
    assert.equal(badCursor.status, 400);
    assert.equal(badCursor.body.error, 'cursor-invalid');
  } finally {
    await environment.close();
  }
});

test('已读按访问客户端记录并跨客户端同步，业务已处理与已读分离', async () => {
  const environment = await startEnvironment('wp21-read');
  try {
    const first = openEvents(Number.parseInt(new URL(environment.gatewayUrl).port, 10), 'device-a');
    const second = openEvents(Number.parseInt(new URL(environment.gatewayUrl).port, 10), 'device-b');
    const [a, b] = await Promise.all([first, second]);

    publishEvent(environment, { kind: 'run-finished', title: '回合一', summary: '第一回合完成', sessionId: 's-read', deviceId: 'device-a' });
    publishEvent(environment, { kind: 'run-finished', title: '回合二', summary: '第二回合完成', sessionId: 's-read', deviceId: 'device-a' });
    const listing = await listNotifications(environment, '?deviceId=device-a');
    assert.equal(listing.body.unread, 2);
    const ids = listing.body.items.map((item) => item.id);

    const marked = await call(`${environment.notificationUrl}/read`, {
      method: 'POST',
      headers: { 'x-chatdsh-client': 'client-a' },
      body: { ids },
    });
    assert.deepEqual(marked.body, { marked: 2, unchanged: 0 });
    await waitFor(() => b.events.some((event) => event.kind === 'notification-read'), 2000, '另一客户端收到已读事件');
    const readEvent = b.events.find((event) => event.kind === 'notification-read');
    assert.equal(readEvent.clientId, 'client-a');
    assert.equal(readEvent.unread, 0);
    assert.deepEqual(readEvent.ids, ids);

    const again = await call(`${environment.notificationUrl}/read`, {
      method: 'POST',
      headers: { 'x-chatdsh-client': 'client-a' },
      body: { ids },
    });
    assert.deepEqual(again.body, { marked: 0, unchanged: 2 });
    const byOther = await call(`${environment.notificationUrl}/read`, {
      method: 'POST',
      headers: { 'x-chatdsh-client': 'client-b', 'x-chatdsh-node-id': 'device-b' },
      body: { ids },
    });
    assert.deepEqual(byOther.body, { marked: 2, unchanged: 0 }, '每台设备的已读记录分别保存');

    const synced = await listNotifications(environment, '?deviceId=device-a', { 'x-chatdsh-client': 'client-b' });
    assert.equal(synced.body.unread, 0, '已读状态对所有客户端一致');
    assert.ok(synced.body.items.every((item) => typeof item.readAt === 'number'));
    assert.ok(synced.body.items.every((item) => item.readClients.includes('client-a')));
    assert.ok(synced.body.items.every((item) => item.readClients.includes('client-b')));

    publishEvent(environment, { kind: 'approval', sessionId: 's-approval', toolName: 'bash', callId: 'call-read' });
    const approvalListing = await listNotifications(environment, '?filter=approval');
    assert.equal(approvalListing.body.items.length, 1);
    const approvalId = approvalListing.body.items[0].id;
    assert.equal(approvalListing.body.items[0].handledAt, undefined);

    const handled = await call(`${environment.notificationUrl}/handled`, {
      method: 'POST',
      body: { ids: [approvalId] },
    });
    assert.deepEqual(handled.body, { marked: 1, unchanged: 0 });
    await waitFor(() => a.events.some((event) => event.kind === 'notification-handled'), 2000, '已处理事件送到在线设备');
    const handledEvent = a.events.find((event) => event.kind === 'notification-handled');
    assert.deepEqual(handledEvent.ids, [approvalId]);
    assert.equal(typeof handledEvent.handledAt, 'number');
    const afterHandled = await listNotifications(environment, '?filter=approval');
    assert.equal(typeof afterHandled.body.items[0].handledAt, 'number');
    assert.equal(afterHandled.body.items[0].readAt, undefined, '已处理不写已读');
    assert.equal(afterHandled.body.handled, 1);

    const readAfterHandled = await call(`${environment.notificationUrl}/read`, {
      method: 'POST',
      headers: { 'x-chatdsh-client': 'client-a' },
      body: { ids: [approvalId] },
    });
    assert.deepEqual(readAfterHandled.body, { marked: 1, unchanged: 0 });
    const both = await listNotifications(environment, '?filter=approval');
    assert.equal(typeof both.body.items[0].readAt, 'number');
    assert.equal(typeof both.body.items[0].handledAt, 'number');

    a.close();
    b.close();
  } finally {
    await environment.close();
  }
});

test('两种投递模式与阈值生效，批次合并多条通知，同键去重', async () => {
  const environment = await startEnvironment('wp21-delivery');
  try {
    const port = Number.parseInt(new URL(environment.gatewayUrl).port, 10);
    const older = await openEvents(port, 'device-older');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const newer = await openEvents(port, 'device-newer');

    const saved = await call(`${environment.notificationUrl}/settings`, {
      method: 'PUT',
      body: { deliveryMode: 'two-stage', firstStageSeconds: 0, secondStageSeconds: 1, revision: 0 },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.deliveryMode, 'two-stage');
    assert.equal(saved.body.revision, 1);

    publishEvent(environment, { kind: 'run-finished', title: '批量一', summary: '第一条', sessionId: 's-batch', objectId: 'run-1' });
    publishEvent(environment, { kind: 'run-finished', title: '批量二', summary: '第二条', sessionId: 's-batch', objectId: 'run-2' });

    await waitFor(() => newer.events.some((event) => event.kind === 'notification'), 2000, '最近活跃设备收到第一阶段');
    const firstStage = newer.events.find((event) => event.kind === 'notification');
    assert.equal(firstStage.stage, 1);
    assert.equal(firstStage.mode, 'two-stage');
    assert.equal(firstStage.count, 2, '同一窗口的两条通知合并成一批');
    assert.equal(older.events.filter((event) => event.kind === 'notification').length, 0);

    await waitFor(() => older.events.some((event) => event.kind === 'notification'), 4000, '其余设备收到第二阶段');
    const secondStage = older.events.find((event) => event.kind === 'notification');
    assert.equal(secondStage.stage, 2);
    assert.equal(secondStage.count, 2);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(newer.events.filter((event) => event.kind === 'notification').length, 1, '第一阶段的目标不重复收到');

    const first = publishEvent(environment, { kind: 'approval', sessionId: 's-dedupe', toolName: 'bash', callId: 'call-dedupe' });
    const second = publishEvent(environment, { kind: 'approval', sessionId: 's-dedupe', toolName: 'bash', callId: 'call-dedupe' });
    assert.equal(second.delivered, 0);
    void first;
    const deduped = await listNotifications(environment, '?filter=approval');
    assert.equal(deduped.body.items.length, 1, '同键在抑制窗口内只保留一条记录');

    const immediate = await call(`${environment.notificationUrl}/settings`, {
      method: 'PUT',
      body: { deliveryMode: 'all-at-once', secondStageSeconds: 2, revision: 1 },
    });
    assert.equal(immediate.status, 200);
    assert.equal(immediate.body.deliveryMode, 'all-at-once');
    older.events.length = 0;
    newer.events.length = 0;
    publishEvent(environment, { kind: 'automation', title: '自动化', summary: '任务完成', sessionId: 's-all' });
    await waitFor(() => older.events.some((event) => event.kind === 'notification'), 2000, '全部实时投给第一台');
    await waitFor(() => newer.events.some((event) => event.kind === 'notification'), 2000, '全部实时投给第二台');
    assert.equal(older.events.find((event) => event.kind === 'notification').stage, 0);

    older.close();
    newer.close();
  } finally {
    await environment.close();
  }
});

test('隐私级别控制下发内容，默认不含命令与消息原文', async () => {
  const environment = await startEnvironment('wp21-privacy');
  try {
    const mode = await call(`${environment.notificationUrl}/settings`, {
      method: 'PUT',
      body: { deliveryMode: 'all-at-once', revision: 0 },
    });
    assert.equal(mode.status, 200);
    assert.equal(mode.body.deliveryMode, 'all-at-once');
    const subscription = makeSubscription(environment.pushPort, '/push/privacy');
    subscription.keys.auth = subscription.auth.toString('base64url');
    environment.pushService.register(subscription);
    const registered = await call(`${environment.notificationUrl}/subscription`, {
      method: 'POST',
      headers: { 'x-chatdsh-node-id': 'device-privacy', 'x-chatdsh-client': 'client-privacy' },
      body: { endpoint: subscription.endpoint, keys: subscription.keys, permission: 'granted' },
    });
    assert.equal(registered.status, 200);
    assert.equal(registered.body.state, 'subscribed');

    const defaults = environment.host.settings();
    assert.equal(defaults.privacy, 'summary');
    assert.equal(defaults.messagePreview, false);

    environment.host.publish({
      kind: 'approval',
      title: '审批：bash',
      summary: '等待审批：bash',
      sessionId: 's-privacy',
      objectId: 'call-privacy',
      tag: 'approval-call-privacy',
      previewText: 'rm -rf /workspace/secret',
      dedupeKey: 'approval:s-privacy:call-privacy',
    });
    await waitFor(() => environment.pushService.plaintexts().length >= 1, 3000, '默认级别收到推送');
    const payload = environment.pushService.plaintexts()[0];
    const item = payload.items[0];
    assert.equal(payload.kind, 'notification');
    assert.equal(item.sessionId, 's-privacy');
    assert.ok(typeof item.summary === 'string' && item.summary.includes('bash'));
    assert.equal(JSON.stringify(payload).includes('rm -rf'), false, '默认级别不含命令原文');
    assert.equal(JSON.stringify(payload).includes('workspace/secret'), false);
    assert.equal('preview' in item, false);

    const typed = await call(`${environment.notificationUrl}/settings`, {
      method: 'PUT',
      body: { privacy: 'type', revision: 1 },
    });
    assert.equal(typed.status, 200);
    assert.equal(typed.body.privacy, 'type');
    environment.pushService.received.length = 0;
    environment.host.publish({
      kind: 'run-finished',
      title: '回合完成',
      summary: '第一回合完成',
      sessionId: 's-privacy',
      dedupeKey: 'run-finished:s-privacy:typed',
    });
    await waitFor(() => environment.pushService.plaintexts().length >= 1, 3000, '仅类型级别收到推送');
    const typedItem = environment.pushService.plaintexts()[0].items[0];
    assert.equal(typedItem.summary, '回合完成');
    assert.equal(typedItem.sessionId, undefined, '仅类型级别不给会话标识');

    const preview = await call(`${environment.notificationUrl}/settings`, {
      method: 'PUT',
      body: { privacy: 'preview', messagePreview: true, revision: 2 },
    });
    assert.equal(preview.status, 200);
    environment.pushService.received.length = 0;
    environment.host.publish({
      kind: 'approval',
      title: '审批：bash',
      summary: '等待审批：bash',
      sessionId: 's-privacy',
      objectId: 'call-preview',
      tag: 'approval-call-preview',
      previewText: 'echo 原文',
      dedupeKey: 'approval:s-privacy:call-preview',
    });
    await waitFor(() => environment.pushService.plaintexts().length >= 1, 3000, '预览级别收到推送');
    assert.equal(JSON.stringify(environment.pushService.plaintexts()[0]).includes('echo 原文'), true);

    const badSettings = await call(`${environment.notificationUrl}/settings`, {
      method: 'PUT',
      body: { deliveryMode: 'two-stage', firstStageSeconds: 300, secondStageSeconds: 60, revision: 3 },
    });
    assert.equal(badSettings.status, 400);
    assert.equal(badSettings.body.error, 'request-invalid');
    const stale = await call(`${environment.notificationUrl}/settings`, {
      method: 'PUT',
      body: { privacy: 'summary', revision: 0 },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, 'revision-conflict');
  } finally {
    await environment.close();
  }
});

test('订阅保存、失效标记、过期清理与验证通知的两段结果', async () => {
  const environment = await startEnvironment('wp21-subscription', { subscriptionTtlMs: 5 });
  try {
    const mode = await call(`${environment.notificationUrl}/settings`, {
      method: 'PUT',
      body: { deliveryMode: 'all-at-once', revision: 0 },
    });
    assert.equal(mode.status, 200);
    const headers = { 'x-chatdsh-node-id': 'device-sub', 'x-chatdsh-client': 'client-sub' };
    const subscription = makeSubscription(environment.pushPort, '/push/sub');
    subscription.keys.auth = subscription.auth.toString('base64url');
    environment.pushService.register(subscription);

    const invalid = await call(`${environment.notificationUrl}/subscription`, {
      method: 'POST',
      headers,
      body: { endpoint: subscription.endpoint, keys: { p256dh: 'AAAA', auth: subscription.keys.auth } },
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, 'request-invalid');

    const saved = await call(`${environment.notificationUrl}/subscription`, {
      method: 'POST',
      headers,
      body: { endpoint: subscription.endpoint, keys: subscription.keys, permission: 'granted' },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.state, 'subscribed');
    assert.equal(JSON.stringify(saved.body).includes('p256dh'), false, '订阅视图不回显密钥');

    const view = await call(`${environment.notificationUrl}/subscription`, { headers });
    assert.equal(view.body.state, 'subscribed');
    assert.equal(view.body.permission, 'granted');

    const probe = await call(`${environment.notificationUrl}/probe`, { method: 'POST', headers, body: {} });
    assert.equal(probe.status, 200);
    assert.equal(probe.body.probe.result, 'accepted');
    assert.equal(typeof probe.body.probe.acceptedAt, 'number');
    const probes = environment.pushService.plaintexts().filter((payload) => payload.kind === 'notification-probe');
    assert.equal(probes.length, 1);
    assert.equal(probes[0].id, probe.body.id);

    const receipt = await call(`${environment.notificationUrl}/probe/receipt`, {
      method: 'POST',
      body: { probeId: probe.body.id, receivedAt: probe.body.probe.acceptedAt + 120 },
    });
    assert.equal(receipt.status, 200);
    assert.equal(receipt.body.probe.result, 'delivered');
    assert.equal(receipt.body.probe.receivedAt, probe.body.probe.acceptedAt + 120);

    environment.pushService.setStatus(subscription.path, 410);
    environment.host.publish({
      kind: 'system',
      title: '系统通知',
      summary: '订阅失效检查',
      sessionId: 's-sub',
      dedupeKey: 'system:s-sub:gone',
    });
    await waitFor(() => environment.host.subscriptionView('device-sub').state === 'gone', 3000, '失效订阅标记为失效');
    const goneView = environment.host.subscriptionView('device-sub');
    assert.equal(goneView.state, 'gone');
    assert.equal(goneView.code, 'push-endpoint-gone');

    const expiredSubscription = makeSubscription(environment.pushPort, '/push/expired');
    expiredSubscription.keys.auth = expiredSubscription.auth.toString('base64url');
    environment.pushService.register(expiredSubscription);
    const second = await call(`${environment.notificationUrl}/subscription`, {
      method: 'POST',
      headers: { 'x-chatdsh-node-id': 'device-expired', 'x-chatdsh-client': 'client-expired' },
      body: { endpoint: expiredSubscription.endpoint, keys: expiredSubscription.keys, permission: 'granted' },
    });
    assert.equal(second.status, 200);
    const cleanup = environment.host.cleanupSubscriptions(Date.now() + 60_000);
    assert.ok(cleanup.expired >= 1, '超过保留期的订阅标记为过期');
    assert.ok(cleanup.removed >= 1, '失效订阅被删除');
    assert.equal(environment.host.subscriptionView('device-expired').state, 'expired');
    assert.equal(environment.host.subscriptionView('device-sub').state, 'unsubscribed');
    assert.equal(environment.host.store.subscriptions('device-sub').length, 0);
    assert.ok(SUBSCRIPTION_TTL_MS > 0);
  } finally {
    await environment.close();
  }
});

test('审批决定撤回同键通知，已处理审批重连不补发', async () => {
  const environment = await startEnvironment('wp21-withdraw');
  try {
    const mode = await call(`${environment.notificationUrl}/settings`, {
      method: 'PUT',
      body: { deliveryMode: 'all-at-once', revision: 0 },
    });
    assert.equal(mode.status, 200);
    const port = Number.parseInt(new URL(environment.gatewayUrl).port, 10);
    const events = await openEvents(port, 'device-approval');

    const asked = await postReplica(environment, 's-withdraw', [
      replicaEvent(1, 'approval/asked', { toolName: 'bash', callId: 'call-withdraw' }),
    ], 'device-approval');
    assert.equal(asked.status, 200);
    await waitFor(() => events.events.some((event) => event.kind === 'notification'), 3000, '审批提醒送到在线设备');
    const reminder = events.events.find((event) => event.kind === 'notification');
    assert.equal(reminder.items[0].kind, 'approval');
    assert.equal(reminder.items[0].tag, 'approval-call-withdraw');
    assert.equal(reminder.items[0].revocable, true);

    const listed = await listNotifications(environment, '?filter=approval');
    assert.equal(listed.body.items.length, 1);

    const decided = await postReplica(environment, 's-withdraw', [
      replicaEvent(2, 'approval/decided', { toolName: 'bash', callId: 'call-withdraw' }),
    ], 'device-approval');
    assert.equal(decided.status, 200);
    await waitFor(() => events.events.some((event) => event.kind === 'notification-withdraw'), 3000, '撤回事件送到在线设备');
    const withdrawn = events.events.find((event) => event.kind === 'notification-withdraw');
    assert.deepEqual(withdrawn.ids, [listed.body.items[0].id]);
    assert.deepEqual(withdrawn.tags, ['approval-call-withdraw']);

    const afterWithdraw = await listNotifications(environment, '?filter=approval');
    assert.equal(afterWithdraw.body.items.length, 0, '撤回之后通知中心不再有待办');
    assert.equal(environment.host.store.byId(listed.body.items[0].id).revokedAt !== undefined, true);

    events.close();
    const reconnected = await openEvents(port, 'device-approval');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(reconnected.events.filter((event) => event.kind === 'notification').length, 0, '已处理审批重连不补发');
    reconnected.close();

    const nextReminder = await postReplica(environment, 's-withdraw', [
      replicaEvent(3, 'approval/asked', { toolName: 'read', callId: 'call-next' }),
    ], 'device-approval');
    assert.equal(nextReminder.status, 200);
    const nextListing = await listNotifications(environment, '?filter=approval');
    assert.equal(nextListing.body.items.length, 1);
    assert.equal(nextListing.body.items[0].tag, 'approval-call-next');
  } finally {
    await environment.close();
  }
});

test('推送投递的 span、失败事件与计数带状态码，且不含订阅密钥', async () => {
  const environment = await startEnvironment('wp21-telemetry');
  try {
    const mode = await call(`${environment.notificationUrl}/settings`, {
      method: 'PUT',
      body: { deliveryMode: 'all-at-once', revision: 0 },
    });
    assert.equal(mode.status, 200);
    const headers = { 'x-chatdsh-node-id': 'device-telemetry', 'x-chatdsh-client': 'client-telemetry' };
    const subscription = makeSubscription(environment.pushPort, '/push/telemetry');
    subscription.keys.auth = subscription.auth.toString('base64url');
    environment.pushService.register(subscription);
    environment.pushService.setStatus(subscription.path, 500);
    const registered = await call(`${environment.notificationUrl}/subscription`, {
      method: 'POST',
      headers,
      body: { endpoint: subscription.endpoint, keys: subscription.keys, permission: 'granted' },
    });
    assert.equal(registered.status, 200);

    environment.host.publish({
      kind: 'run-finished',
      title: '回合完成',
      summary: '遥测检查',
      sessionId: 's-telemetry',
      dedupeKey: 'run-finished:s-telemetry:1',
    });
    await waitFor(() => environment.pushService.received.length >= 1, 3000, '推送服务收到请求');
    await environment.host.delivery.settled();
    await environment.telemetry.flush(5000);

    const traceBody = environment.otlp.bodies.find((item) => item.path.includes('/v1/traces'));
    const logBody = environment.otlp.bodies.find((item) => item.path.includes('/v1/logs'));
    const metricBody = environment.otlp.bodies.find((item) => item.path.includes('/v1/metrics'));
    assert.ok(traceBody !== undefined, '追踪导出到 OTLP 接收端');
    assert.ok(logBody !== undefined, '日志导出到 OTLP 接收端');
    assert.ok(metricBody !== undefined, '指标导出到 OTLP 接收端');

    const spans = JSON.parse(traceBody.text).resourceSpans
      .flatMap((resource) => resource.scopeSpans)
      .flatMap((scope) => scope.spans);
    const sendSpan = spans.find((span) => span.name === 'chatdsh.push.send');
    assert.ok(sendSpan !== undefined, '推送投递 span 存在');
    const attributesOf = (span) => Object.fromEntries(span.attributes.map((attribute) => [
      attribute.key,
      attribute.value.stringValue ?? attribute.value.intValue ?? attribute.value.boolValue,
    ]));
    const sendAttributes = attributesOf(sendSpan);
    assert.equal(sendAttributes.outcome, 'failed');
    assert.equal(String(sendAttributes['http.status_code']), '500');
    assert.ok(spans.some((span) => span.name === 'chatdsh.push.dispatch'));
    assert.ok(spans.some((span) => span.name === 'chatdsh.gateway.notification.record'));

    const records = JSON.parse(logBody.text).resourceLogs
      .flatMap((resource) => resource.scopeLogs)
      .flatMap((scope) => scope.logRecords);
    const failed = records.find((record) => record.attributes?.some((attribute) => attribute.key === 'event.name' && attribute.value.stringValue === 'chatdsh.gateway.push.failed'))
      ?? records.find((record) => JSON.stringify(record).includes('chatdsh.gateway.push.failed'));
    assert.ok(failed !== undefined, '推送失败事件存在');
    assert.ok(JSON.stringify(failed).includes('chatdsh.gateway.push.failed'));

    const metrics = JSON.parse(metricBody.text).resourceMetrics
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics);
    assert.ok(metrics.some((metric) => metric.name === 'chatdsh_push_sends_total'), '推送发送计数存在');

    const secrets = [subscription.keys.p256dh, subscription.keys.auth];
    for (const exported of environment.otlp.bodies) {
      for (const secret of secrets) {
        assert.equal(exported.text.includes(secret), false, '遥测里不出现订阅密钥');
      }
    }
  } finally {
    await environment.close();
  }
});

test('aes128gcm 加密与 RFC 8291 第 5 节的测试向量逐字节一致', () => {
  const vector = {
    authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
    userAgentPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
    userAgentPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    serverPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
    serverPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
    salt: 'DGv6ra1nlYgDCS1FRnbzlw',
    plaintext: 'When I grow up, I want to be a watermelon',
    body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  };
  const body = encryptPayload(
    { p256dh: vector.userAgentPublic, auth: vector.authSecret },
    Buffer.from(vector.plaintext, 'utf8'),
    {
      salt: Buffer.from(vector.salt, 'base64url'),
      ephemeralPrivateKey: Buffer.from(vector.serverPrivate, 'base64url'),
    },
  );
  assert.equal(body.toString('base64url'), vector.body, '加密结果与 RFC 8291 第 5 节一致');

  const receiver = {
    privateKey: Buffer.from(vector.userAgentPrivate, 'base64url'),
    publicKey: Buffer.from(vector.userAgentPublic, 'base64url'),
    auth: Buffer.from(vector.authSecret, 'base64url'),
  };
  assert.equal(decryptPayload(receiver, body).toString('utf8'), vector.plaintext, '接收方按 RFC 8291 解出原文');
});
