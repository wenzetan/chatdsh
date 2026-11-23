// WP22 验收：通知中心、已读与业务已处理、投递设置、权限订阅与实时更新。
//
// 宿主侧是完整装配的 `createGatewayServer`（真实 HTTP 与真实 SSE）、真实 `GatewayStore`
// （SQLite）与真实通知宿主 `createNotificationHost`；推送目标是本机真实推送服务，它按
// RFC 8292 验证 VAPID 签名并按 RFC 8291 解密 `aes128gcm` 载荷。通知接口按真实 HTTP 路由
// 读写，事件流按真实 SSE 接收。
//
// 运行：node --test e2e/unit/client-complete-wp22-notifications.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, randomUUID, verify } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, get } from 'node:http';
import { join } from 'node:path';
import { allocateIndependentHome, releaseIndependentHome, useHome } from '../lib/environment.mjs';
import { createTelemetryClient } from '../../packages/core/diagnostics/lib/client.js';
import { defaultTelemetryConfig } from '../../packages/core/diagnostics/lib/config.js';
import { GatewayStore, PushQueue, ReceiptStore, ReplicaStore, SettingsStore } from '../../gateway/lib/store.js';
import { createPushHub } from '../../gateway/lib/push.js';
import { DeviceLinkHub } from '../../gateway/lib/device-link.js';
import { createGatewayServer } from '../../gateway/lib/server.js';
import { createNotificationHost } from '../../gateway/lib/notifications/index.js';

/** 通知中心在宿主上的挂载前缀。 */
const PREFIX = '/chatdsh/gateway/notifications';

/** 中继的推送通道。 */
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

/** 起一整套真实服务：中继、通知宿主、推送服务与遥测接收端。 */
async function startEnvironment(prefix) {
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
    gatewayPort,
    notificationOrigin: `http://127.0.0.1:${notificationPort}`,
    notificationUrl: `http://127.0.0.1:${notificationPort}${PREFIX}`,
    async close() {
      await host.close();
      await gateway.stop();
      await new Promise((done) => notificationServer.close(done));
      await new Promise((done) => pushService.server.close(done));
      await new Promise((done) => otlp.server.close(done));
      await telemetry.shutdown();
      store.close();
      releaseIndependentHome(home);
      restoreHome();
    },
  };
}

/** 建立通知接口的 HTTP 客户端。 */
function notificationClient(environment, clientId, deviceId) {
  const headers = { 'x-chatdsh-node-id': deviceId, 'x-chatdsh-client': clientId };
  const request = async (path, options = {}) => {
    const response = await call(`${environment.notificationUrl}${path}`, { ...options, headers: { ...headers, ...(options.headers ?? {}) } });
    if (response.status !== 200) {
      const error = new Error(response.body?.error ?? `HTTP ${response.status}`);
      error.code = response.body?.error;
      error.status = response.status;
      error.current = response.body?.settings;
      throw error;
    }
    return response.body;
  };
  return {
    list: (query = {}) => {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) search.set(key, String(value));
      }
      return request(search.size === 0 ? '/' : `/?${search.toString()}`);
    },
    markRead: (ids) => request('/read', { method: 'POST', body: { ids } }),
    markHandled: (ids) => request('/handled', { method: 'POST', body: { ids } }),
    readSettings: () => request('/settings'),
    saveSettings: async (settings, revision) => {
      const response = await call(`${environment.notificationUrl}/settings`, {
        method: 'PUT',
        headers,
        body: { ...settings, revision },
      });
      if (response.status === 200) return { ok: true, settings: response.body };
      if (response.status === 409) return { ok: false, code: response.body.error, current: response.body.settings };
      const error = new Error(response.body?.error ?? `HTTP ${response.status}`);
      error.code = response.body?.error;
      error.status = response.status;
      throw error;
    },
    readSubscription: () => request('/subscription'),
    saveSubscription: (subscription) => request('/subscription', {
      method: 'POST',
      body: {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        permission: subscription.permission,
      },
    }),
    removeSubscription: () => request('/subscription', { method: 'DELETE' }),
    sendProbe: async () => {
      const response = await call(`${environment.notificationUrl}/probe`, { method: 'POST', headers, body: {} });
      if (response.status !== 200 && response.status !== 502) {
        const error = new Error(response.body?.error ?? `HTTP ${response.status}`);
        error.code = response.body?.error;
        error.status = response.status;
        throw error;
      }
      return response.body;
    },
    reportProbeReceipt: (probeId, receivedAt) => request('/probe/receipt', { method: 'POST', body: { probeId, receivedAt } }),
  };
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
    const gatewayA = notificationClient(environment, 'client-a', 'device-a');
    const gatewayB = notificationClient(environment, 'client-b', 'device-b');

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
    const otherDevice = await gatewayB.list({ filter: 'all', limit: 20 });
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
    const gateway = notificationClient(environment, 'client-settings', 'device-settings');
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
    const gateway = notificationClient(environment, 'client-probe', deviceId);
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
    const gateway = notificationClient(environment, 'client-events', deviceId);
    const withdrawn = [];
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
      const listed = await gateway.list({ filter: 'all', limit: 20 });
      assert.equal(listed.items.length, 1, '通知记录进入列表');
      assert.equal(listed.unread, 1, '未读计数加一');

      const readResult = await gateway.markRead([notified.id]);
      assert.equal(readResult.marked, 1, '已读写入一条');
      await waitFor(() => stream.events.some((event) => event.kind === 'notification-read'), 5000, '收到已读事件');
      const readEvent = stream.events.find((event) => event.kind === 'notification-read');
      assert.deepEqual(readEvent.ids, [notified.id], '已读事件带通知标识');
      assert.equal(readEvent.clientId, 'client-events', '已读事件带访问客户端标识');
      const afterRead = await gateway.list({ filter: 'all', limit: 20 });
      assert.equal(afterRead.items[0].readAt, readEvent.readAt, '列表写入已读时刻');
      assert.equal(afterRead.unread, 0, '已读之后未读计数归零');

      const handledResult = await gateway.markHandled([notified.id]);
      assert.equal(handledResult.marked, 1, '已处理写入一条');
      await waitFor(() => stream.events.some((event) => event.kind === 'notification-handled'), 5000, '收到已处理事件');
      const handledEvent = stream.events.find((event) => event.kind === 'notification-handled');
      const afterHandled = await gateway.list({ filter: 'all', limit: 20 });
      assert.equal(afterHandled.items[0].handledAt, handledEvent.handledAt, '列表写入已处理时刻');
      assert.equal(afterHandled.handled, 1, '已处理计数加一');

      const count = environment.host.delivery.withdrawApproval('session-events', 'call-events');
      assert.equal(count, 1, '审批终结撤回一条通知');
      await waitFor(() => stream.events.some((event) => event.kind === 'notification-withdraw'), 5000, '收到撤回事件');
      const withdrawEvent = stream.events.find((event) => event.kind === 'notification-withdraw');
      assert.deepEqual(withdrawEvent.tags, ['approval-call-events'], '撤回事件带稳定 tag');
      assert.equal(withdrawEvent.objectId, 'call-events', '撤回事件带工具调用标识');
      withdrawn.push(...withdrawEvent.tags);
      assert.deepEqual(withdrawn, ['approval-call-events'], '客户端拿到要关闭的 tag');

      const page = await gateway.list({ filter: 'all', limit: 20 });
      assert.equal(page.items.length, 0, '撤回的记录不再出现在列表里');
    } finally {
      stream.close();
    }
  } finally {
    await environment.close();
  }
});
