// WP17 验收：自动化的记录、执行目标与投递结果。
//
// 控制平面是完整装配的真实 HTTP 服务与真实 WebSocket 设备长连接，存储是真实 SQLite，
// 自动化接口挂在独立的真实 HTTP 服务上。设备与工作区来自真实控制平面数据，在线状态来自
// 真实设备长连接；目标设备通过真实通道接收会话建立请求，投递记录写进同一个数据库。
//
// 运行：node --test e2e/unit/client-complete-wp17-automation.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { ensureDeps } from '../lib/ensure-deps.mjs';

const RUNTIME = resolve(import.meta.dirname, '../..');
const REPO = resolve(RUNTIME, '..');
ensureDeps(RUNTIME);
ensureDeps(resolve(REPO, 'dsh-adapter'));

const { GatewayStore, PushQueue, ReceiptStore, ReplicaStore, SettingsStore, ShareStore } = await import('../../gateway/lib/store.js');
const { createPushHub } = await import('../../gateway/lib/push.js');
const { DeviceLinkHub } = await import('../../gateway/lib/device-link.js');
const { createGatewayServer } = await import('../../gateway/lib/server.js');
const { AutomationStore, handleWebhook } = await import('../../gateway/lib/automation.js');
const { createAutomationRoutes, AUTOMATIONS_PATH, AUTOMATION_DELIVERIES_PATH } = await import('../../gateway/lib/automation-routes.js');
const { createAutomationGateway } = await import('../../packages/client/automation/lib/client/gateway.js');
const { createTelemetryClient } = await import('../../packages/core/diagnostics/lib/client.js');
const { defaultTelemetryConfig } = await import('../../packages/core/diagnostics/lib/config.js');
const { ChatdshError } = await import('../../packages/core/contracts/lib/index.js');

/** 令牌摘要。 */
const hash = (value) => createHash('sha256').update(value).digest('hex');

/** 等待条件成立。 */
async function waitFor(predicate, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`等待超时：${label}`);
}

/** 设备长连接的升级地址。 */
function linkUrl(gateway) {
  return `${gateway.url.replace(/^http/, 'ws')}/chatdsh/gateway/device-link`;
}

/** 按版本 2 帧协议连上的设备；收到通道请求时按注入的应答函数回填。 */
class LinkDevice {
  constructor(token, url, deviceId, respond) {
    this.opens = [];
    this.respond = respond;
    this.socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    this.opened = new Promise((done, fail) => {
      this.socket.addEventListener('open', () => {
        this.send({ type: 'hello', version: 2, deviceId, generation: 0, platform: 'linux', role: 'both', capabilities: ['shell'] });
        done();
      });
      this.socket.addEventListener('error', () => fail(new Error('设备连接失败')));
      this.socket.addEventListener('message', (event) => {
        const frame = JSON.parse(event.data);
        if (frame.type === 'ping') this.send({ type: 'pong', generation: frame.generation, nonce: frame.nonce });
        if (frame.type === 'open') {
          this.opens.push(frame);
          void this.respond(frame);
        }
      });
    });
  }

  send(frame) {
    this.socket.send(JSON.stringify(frame));
  }

  /** 回填一段应答文本。 */
  reply(open, { status = 200, body = {} } = {}) {
    const text = JSON.stringify(body);
    this.send({ type: 'accepted', channelId: open.channelId, generation: open.generation, status, headers: { 'content-type': 'application/json; charset=utf-8' } });
    this.send({ type: 'data', channelId: open.channelId, generation: open.generation, seq: 0, payloadLength: Buffer.byteLength(text), payload: Buffer.from(text, 'utf8').toString('base64') });
    this.send({ type: 'end', channelId: open.channelId, generation: open.generation, lastSeq: 0 });
  }

  close() {
    this.socket.close();
  }
}

/**
 * 起一套真实环境：控制平面、自动化接口、设备长连接与自动化存储。
 * @returns {Promise<object>} 环境句柄。
 */
async function start() {
  const home = allocateIndependentHome('wp17-automation');
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
  const settings = new SettingsStore(store.handle());
  const push = createPushHub({
    queue: new PushQueue(store.handle()),
    devices: store,
    mode: 'all-at-once',
    escalationMs: 1000,
    telemetry: { counter: (name, config) => telemetry.counter(name, config) },
  });
  const deviceLink = new DeviceLinkHub({ store, telemetry });
  const gateway = createGatewayServer({
    config: {
      host: '127.0.0.1',
      port: 0,
      runtimeUrl: 'http://127.0.0.1:1',
      databasePath,
      environment: 'test',
      version: '0.0.0',
      pushMode: 'all-at-once',
      pushEscalationMs: 1000,
      llmGateway: { quota: {} },
      pairingCode: 'pair-wp17',
    },
    store,
    replica,
    share,
    receipts,
    settings,
    push,
    telemetry,
    deviceLink,
  });
  await gateway.start();
  const automations = new AutomationStore(store.handle(), { online: (deviceId) => deviceLink.online(deviceId) });

  const token = randomUUID().replaceAll('-', '');
  store.registerMobileDevice({ id: 'automation-console', name: '自动化控制台', platform: 'linux', tokenHash: hash(token) });
  const limitedToken = randomUUID().replaceAll('-', '');
  store.registerMobileDevice({ id: 'limited-console', name: '受限控制台', platform: 'linux', tokenHash: hash(limitedToken) });

  const devices = [];
  const dispatched = [];
  automations.attachDispatcher({
    async start(request) {
      dispatched.push(request);
      const response = await deviceLink.sendRequest(request.target.deviceId, {
        method: 'POST',
        path: '/chatdsh/sessions',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({
          automationId: request.automationId,
          eventId: request.eventId,
          prompt: request.prompt,
          cwd: request.target.cwd,
          presetId: request.target.presetId,
          model: request.target.model,
        }), 'utf8'),
      }, 5000);
      const body = JSON.parse(response.body.toString('utf8'));
      if (response.status === 504) throw new ChatdshError('automation-delivery-unconfirmed', '投递结果尚未确认');
      if (response.status >= 500) throw new ChatdshError('chat-backend-unreachable', '目标设备拒绝了会话建立');
      return { sessionId: body.sessionId };
    },
  });

  const routesServer = createServer(async (request, response) => {
    if (await routes(request, response)) return;
    response.writeHead(404).end();
  });
  let routes;
  routesServer.listen(0, '127.0.0.1');
  await once(routesServer, 'listening');
  const origin = `http://127.0.0.1:${routesServer.address().port}`;
  routes = createAutomationRoutes({
    automations,
    telemetry,
    origin,
    authenticate(request) {
      const header = request.headers.authorization;
      if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined;
      const value = header.slice(7);
      if (value === token) {
        return { clientId: 'automation-console', authentication: 'bearer', expiresAt: Date.now() + 60_000, deviceIds: 'all' };
      }
      if (value === limitedToken) {
        return { clientId: 'limited-console', authentication: 'bearer', expiresAt: Date.now() + 60_000, deviceIds: [] };
      }
      return undefined;
    },
  });

  /** 发一次接口请求。 */
  const call = async (path, init = {}) => {
    const response = await fetch(`${origin}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.method === undefined || init.method === 'GET' ? {} : { 'x-chatdsh-csrf': '1', 'content-type': 'application/json' }),
        ...init.headers,
      },
    });
    const text = await response.text();
    return { status: response.status, body: text === '' ? undefined : JSON.parse(text) };
  };

  /** 连上一台设备并让它应答会话建立请求。 */
  const connect = async (deviceId, tokenValue, respond) => {
    let device;
    const answer = respond ?? ((open) => device.reply(open, { body: { sessionId: `session-from-${deviceId}` } }));
    device = new LinkDevice(tokenValue, linkUrl({ url: gateway.url() }), deviceId, answer);
    await device.opened;
    devices.push(device);
    await waitFor(() => deviceLink.online(deviceId), `设备 ${deviceId} 上线`);
    return device;
  };

  return {
    origin,
    store,
    automations,
    deviceLink,
    call,
    connect,
    dispatched,
    telemetry,
    tokens: { full: token, limited: limitedToken },
    async pair(name, role = 'executor') {
      const response = await fetch(`${gateway.url()}/chatdsh/gateway/devices/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: 'pair-wp17', name, platform: 'linux', role, capabilities: ['shell'] }),
      });
      assert.equal(response.status, 200);
      return response.json();
    },
    async close() {
      for (const device of devices) device.close();
      deviceLink.stop();
      routesServer.closeAllConnections();
      await new Promise((done) => routesServer.close(done));
      await gateway.stop();
      await telemetry.shutdown();
      store.close();
      releaseIndependentHome(home);
    },
  };
}

/** 一份合法的建立取值。 */
function draftOf(app, deviceId, patch = {}) {
  return {
    name: '每日设计检查',
    trigger: { kind: 'webhook', secretEnv: 'CHATDSH_WP17_HOOK' },
    prompt: '核对客户端设计规范与当前实现，报告验收条件。',
    enabled: true,
    target: { deviceId, cwd: '/work/alpha', presetId: 'chatdsh-work', model: 'xhs/dots3-note-prev' },
    ...patch,
  };
}

test('真实 HTTP 与 SQLite：自动化 CRUD、修订号比较交换与执行目标校验', { timeout: 120_000 }, async () => {
  const app = await start();
  try {
    const online = await app.pair('工作站 alpha');
    const host = await app.pair('宿主节点', 'host');
    const offline = await app.pair('构建设备');
    const device = await app.connect(online.deviceId, online.token);
    app.store.upsertSession({ sessionId: 'session-alpha', deviceId: online.deviceId, workspaceId: 'ws-alpha', cwd: '/work/alpha', kind: 'work', createdAt: Date.now() });

    // 建立：返回真实记录的完整形状，目标设备名取自控制平面的节点记录。
    const created = await app.call(AUTOMATIONS_PATH, { method: 'POST', body: JSON.stringify(draftOf(app, online.deviceId)) });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const record = created.body;
    assert.match(record.id, /^automation-[0-9a-f]{16}$/);
    assert.equal(record.name, '每日设计检查');
    assert.deepEqual(record.trigger, { kind: 'webhook', secretEnv: 'CHATDSH_WP17_HOOK' });
    assert.deepEqual(record.action, { kind: 'start-session', prompt: '核对客户端设计规范与当前实现，报告验收条件。' });
    assert.equal(record.enabled, true);
    assert.equal(record.revision, 0);
    typeof record.createdAt === 'number' ? assert.ok(record.createdAt > 0) : assert.fail('缺少创建时刻');
    assert.deepEqual(record.target, {
      deviceId: online.deviceId,
      deviceName: '工作站 alpha',
      workspaceName: 'alpha',
      cwd: '/work/alpha',
      presetId: 'chatdsh-work',
      presetName: 'chatdsh-work',
      model: 'xhs/dots3-note-prev',
    });
    assert.equal(record.lastDelivery, undefined, '还没有投递记录');

    // 列表与读取。
    const listed = await app.call(AUTOMATIONS_PATH);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.automations.length, 1);
    assert.equal(listed.body.automations[0].id, record.id);
    const readByQuery = await app.call(`${AUTOMATIONS_PATH}?id=${record.id}`);
    assert.equal(readByQuery.status, 200);
    assert.equal(readByQuery.body.id, record.id);
    const readByPath = await app.call(`${AUTOMATIONS_PATH}/${record.id}`);
    assert.equal(readByPath.status, 200);
    assert.equal(readByPath.body.revision, 0);

    // 编辑：过期修订号被拒绝，当前修订号写入后加一。
    const edited = { ...draftOf(app, online.deviceId), name: '每日设计复核', revision: 0 };
    const updated = await app.call(AUTOMATIONS_PATH, { method: 'PUT', body: JSON.stringify({ id: record.id, ...edited }) });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.name, '每日设计复核');
    assert.equal(updated.body.revision, 1);
    const stale = await app.call(AUTOMATIONS_PATH, { method: 'PUT', body: JSON.stringify({ id: record.id, ...edited }) });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, 'revision-conflict');
    assert.equal(app.automations.get(record.id).name, '每日设计复核', '过期写入不改动记录');

    // 启停：带修订号时同样比较交换。
    const staleToggle = await app.call(AUTOMATIONS_PATH, { method: 'PATCH', body: JSON.stringify({ id: record.id, enabled: false, revision: 0 }) });
    assert.equal(staleToggle.status, 409);
    const toggled = await app.call(AUTOMATIONS_PATH, { method: 'PATCH', body: JSON.stringify({ id: record.id, enabled: false, revision: 1 }) });
    assert.equal(toggled.status, 200);
    assert.equal(toggled.body.enabled, false);
    assert.equal(toggled.body.revision, 2);
    assert.equal(app.automations.get(record.id).enabled, false, '启停写进真实数据库');

    // 编辑时改到离线设备同样被拒绝。
    const editOffline = await app.call(AUTOMATIONS_PATH, { method: 'PUT', body: JSON.stringify({ id: record.id, ...draftOf(app, offline.deviceId), revision: 2 }) });
    assert.equal(editOffline.status, 409);
    assert.equal(editOffline.body.error, 'device-offline');
    assert.equal(app.automations.get(record.id).target.deviceId, online.deviceId, '被拒绝的编辑不改动执行目标');

    // 字段校验：名称、触发方式、提示词、启用状态。
    const rejections = [
      [{ name: '   ' }, 400, 'request-invalid'],
      [{ trigger: { kind: 'webhook', secretEnv: 'lower-case' } }, 400, 'request-invalid'],
      [{ trigger: { kind: 'nope' } }, 400, 'request-invalid'],
      [{ prompt: '' }, 400, 'request-invalid'],
      [{ enabled: 'yes' }, 400, 'request-invalid'],
      [{ target: undefined }, 400, 'request-invalid'],
      [{ target: { deviceId: online.deviceId, cwd: 'relative/dir' } }, 400, 'request-invalid'],
      [{ spec: { kind: 'interval', everySeconds: 30, timeZone: 'Asia/Shanghai' } }, 400, 'request-invalid'],
      [{ spec: { kind: 'cron', expression: '0 9 * *', timeZone: 'Asia/Shanghai' } }, 400, 'request-invalid'],
      [{ spec: { kind: 'weekly', weekdays: [1, 1], time: '09:00', timeZone: 'Asia/Shanghai' } }, 400, 'request-invalid'],
      [{ spec: { kind: 'daily', time: '09:00', timeZone: 'Mars/Olympus' } }, 400, 'request-invalid'],
      [{ spec: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } }, 400, 'request-invalid'],
    ];
    for (const [patch, status, code] of rejections) {
      const attempt = await app.call(AUTOMATIONS_PATH, { method: 'POST', body: JSON.stringify(draftOf(app, online.deviceId, patch)) });
      assert.equal(attempt.status, status, `${JSON.stringify(patch)} 的应答状态：${JSON.stringify(attempt.body)}`);
      assert.equal(attempt.body.error, code);
    }

    // 执行目标校验：设备必须登记、承担执行、在线，工作区必须属于该设备。
    const unknownDevice = await app.call(AUTOMATIONS_PATH, { method: 'POST', body: JSON.stringify(draftOf(app, 'device-missing')) });
    assert.equal(unknownDevice.status, 404);
    assert.equal(unknownDevice.body.error, 'device-unknown');
    const hostRole = await app.call(AUTOMATIONS_PATH, { method: 'POST', body: JSON.stringify(draftOf(app, host.deviceId)) });
    assert.equal(hostRole.status, 409);
    assert.equal(hostRole.body.error, 'device-role-mismatch');
    const offlineDevice = await app.call(AUTOMATIONS_PATH, { method: 'POST', body: JSON.stringify(draftOf(app, offline.deviceId)) });
    assert.equal(offlineDevice.status, 409);
    assert.equal(offlineDevice.body.error, 'device-offline');
    const unknownWorkspace = await app.call(AUTOMATIONS_PATH, { method: 'POST', body: JSON.stringify(draftOf(app, online.deviceId, { target: { deviceId: online.deviceId, workspaceId: 'ws-missing', cwd: '/work/alpha' } })) });
    assert.equal(unknownWorkspace.status, 403);
    assert.equal(unknownWorkspace.body.error, 'workspace-forbidden');
    const knownWorkspace = await app.call(AUTOMATIONS_PATH, { method: 'POST', body: JSON.stringify(draftOf(app, online.deviceId, { target: { deviceId: online.deviceId, workspaceId: 'ws-alpha', cwd: '/work/alpha' } })) });
    assert.equal(knownWorkspace.status, 201, JSON.stringify(knownWorkspace.body));
    assert.equal(knownWorkspace.body.target.workspaceId, 'ws-alpha');
    assert.equal(knownWorkspace.body.action.workspaceId, 'ws-alpha');

    // 标识重复。
    const duplicateId = await app.call(AUTOMATIONS_PATH, { method: 'POST', body: JSON.stringify({ ...draftOf(app, online.deviceId), id: record.id }) });
    assert.equal(duplicateId.status, 409);
    assert.equal(duplicateId.body.error, 'object-in-use');

    // 权限、来源与写入令牌。
    const anonymous = await fetch(`${app.origin}${AUTOMATIONS_PATH}`);
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).error, 'auth-required');
    const crossOrigin = await app.call(AUTOMATIONS_PATH, { headers: { origin: 'https://attacker.invalid' } });
    assert.equal(crossOrigin.status, 403);
    assert.equal(crossOrigin.body.error, 'origin-rejected');
    const noCsrf = await fetch(`${app.origin}${AUTOMATIONS_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${app.tokens.full}`, 'content-type': 'application/json' },
      body: JSON.stringify(draftOf(app, online.deviceId)),
    });
    assert.equal(noCsrf.status, 403, '认证通过但缺少写入令牌时拒绝');
    assert.equal((await noCsrf.json()).error, 'csrf-required');
    const limited = await fetch(`${app.origin}${AUTOMATIONS_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${app.tokens.limited}`, 'x-chatdsh-csrf': '1', 'content-type': 'application/json' },
      body: JSON.stringify(draftOf(app, online.deviceId)),
    });
    assert.equal(limited.status, 403);
    assert.equal((await limited.json()).error, 'permission-denied');

    // 定时触发的记录只保存条件与时间方式，控制平面不建立定时调度器。
    const scheduleDraft = draftOf(app, online.deviceId, {
      trigger: { kind: 'schedule', cron: '0 9 * * *' },
      spec: { kind: 'cron', expression: '0 9 * * *', timeZone: 'Asia/Shanghai' },
    });
    const scheduled = await app.call(AUTOMATIONS_PATH, { method: 'POST', body: JSON.stringify(scheduleDraft) });
    assert.equal(scheduled.status, 201, JSON.stringify(scheduled.body));
    assert.deepEqual(scheduled.body.trigger, { kind: 'schedule', cron: '0 9 * * *' });
    assert.deepEqual(scheduled.body.spec, { kind: 'cron', expression: '0 9 * * *', timeZone: 'Asia/Shanghai' });
    await new Promise((done) => setTimeout(done, 400));
    assert.equal(app.automations.list().length, 3, '定时触发的记录没有引发执行');
    assert.equal(app.store.listSessions().length, 1, '控制平面没有自行建立会话');
    assert.equal(app.dispatched.length, 0, '控制平面没有向设备派发任何会话');

    // WP18 客户端的数据入口按同一批路径与响应形状读写，形状不符会直接抛出。
    const client = createAutomationGateway({
      origin: app.origin,
      telemetry: { action() {} },
      fetch: (input, init) => fetch(input, {
        ...init,
        headers: { ...(init?.headers ?? {}), authorization: `Bearer ${app.tokens.full}` },
      }),
    });
    const clientList = await client.automations();
    assert.equal(clientList.length, 3);
    const clientCreated = await client.create({
      name: '客户端建立的记录',
      trigger: { kind: 'webhook', secretEnv: 'CHATDSH_WP17_HOOK' },
      prompt: '从客户端建立',
      enabled: true,
      target: { deviceId: online.deviceId, cwd: '/work/alpha', presetId: 'chatdsh-work' },
    });
    assert.equal(clientCreated.name, '客户端建立的记录');
    assert.equal(clientCreated.target.deviceName, '工作站 alpha');
    assert.equal(clientCreated.target.cwd, '/work/alpha');
    const clientToggled = await client.setEnabled(clientCreated.id, false);
    assert.equal(clientToggled.enabled, false);
    const clientUpdated = await client.update(clientCreated.id, {
      name: '客户端编辑的记录',
      trigger: { kind: 'webhook', secretEnv: 'CHATDSH_WP17_HOOK' },
      prompt: '编辑之后的提示词',
      enabled: true,
      target: { deviceId: online.deviceId, cwd: '/work/alpha' },
      revision: clientToggled.revision,
    });
    assert.equal(clientUpdated.name, '客户端编辑的记录');
    assert.equal(clientUpdated.enabled, true);
    const clientDeliveries = await client.deliveries({ limit: 10 });
    assert.equal(clientDeliveries.deliveries.length, 0);
    await client.remove(clientCreated.id);
    assert.equal(app.automations.get(clientCreated.id), undefined, '客户端删除之后记录离开控制平面');

    // 删除：记录与投递记录一起消失。
    const removed = await app.call(`${AUTOMATIONS_PATH}?id=${record.id}`, { method: 'DELETE' });
    assert.equal(removed.status, 204);
    assert.equal(app.automations.get(record.id), undefined);
    const missing = await app.call(`${AUTOMATIONS_PATH}?id=${record.id}`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'automation-not-found');
    const removeMissing = await app.call(`${AUTOMATIONS_PATH}?id=${record.id}`, { method: 'DELETE' });
    assert.equal(removeMissing.status, 404);
    device.close();
  } finally {
    await app.close();
  }
});

test('真实 webhook 投递：在线派发、离线拒绝、重复去重与完整投递结果', { timeout: 120_000 }, async () => {
  const app = await start();
  const secretEnv = 'CHATDSH_WP17_WEBHOOK_SECRET';
  const secret = `wp17-${randomUUID().slice(0, 8)}`;
  try {
    const online = await app.pair('工作站 alpha');
    let dispatchStatus = 200;
    let device;
    const respond = (open) => {
      if (dispatchStatus === 200) device.reply(open, { body: { sessionId: `session-from-${online.deviceId}` } });
      else device.reply(open, { status: dispatchStatus, body: { error: 'session-start-refused' } });
    };
    device = await app.connect(online.deviceId, online.token, respond);
    app.store.upsertSession({ sessionId: 'session-alpha', deviceId: online.deviceId, workspaceId: 'ws-alpha', cwd: '/work/alpha', kind: 'work', createdAt: Date.now() });

    const created = await app.call(AUTOMATIONS_PATH, { method: 'POST', body: JSON.stringify(draftOf(app, online.deviceId, { trigger: { kind: 'webhook', secretEnv } })) });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const automationId = created.body.id;

    const post = (headers, body) => handleWebhook(app.automations, automationId, headers, body);

    // 密钥缺失、签名不符、载荷不合法：三种失败都写进投递记录。
    delete process.env[secretEnv];
    assert.equal(post({ 'x-github-delivery': 'event-secret', 'x-github-event': 'push' }, '{"action":"opened"}').status, 503);
    process.env[secretEnv] = secret;
    const unauthorized = post({ 'x-github-delivery': 'event-signature', 'x-github-event': 'push', 'x-chatdsh-webhook-secret': 'wrong' }, '{"action":"opened"}');
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.body.error, 'webhook-unauthorized');
    const invalid = post({ 'x-github-delivery': 'event-payload', 'x-chatdsh-webhook-secret': secret }, 'not-json');
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, 'automation/webhook-invalid');

    // 目标离线：明确失败，投递记录留下原因，不建立重发任务。
    device.close();
    await waitFor(() => !app.deviceLink.online(online.deviceId), '设备离线');
    const offline = post({ 'x-github-delivery': 'event-offline', 'x-chatdsh-webhook-secret': secret }, '{"action":"opened","issue":17}');
    assert.equal(offline.status, 409);
    assert.equal(offline.body.error, 'device-offline');
    const offlineRecord = app.automations.delivery(automationId, 'event-offline');
    assert.equal(offlineRecord.state, 'failed');
    assert.equal(offlineRecord.code, 'device-offline');
    assert.equal(offlineRecord.reason, 'target-offline');
    assert.equal(offlineRecord.httpStatus, 409);
    assert.equal(offlineRecord.attempts, 1);
    assert.equal(offlineRecord.sessionId, undefined);

    // 设备恢复后重试同一事件：建立会话，投递记录推进到完成。
    device = await app.connect(online.deviceId, online.token, respond);
    const accepted = post({ 'x-github-delivery': 'event-offline', 'x-chatdsh-webhook-secret': secret }, '{"action":"opened","issue":17}');
    assert.equal(accepted.status, 202);
    assert.deepEqual(accepted.body, { accepted: true });
    await app.automations.settle();
    const completed = app.automations.delivery(automationId, 'event-offline');
    assert.equal(completed.state, 'completed');
    assert.equal(completed.sessionId, 'session-from-' + online.deviceId);
    assert.equal(completed.attempts, 2);
    assert.equal(completed.code, undefined);
    assert.equal(completed.reason, undefined);
    assert.equal(typeof completed.completedAt, 'number');
    assert.equal(app.dispatched.length, 1, '一次事件只派发一次');
    assert.deepEqual(app.dispatched[0], {
      automationId,
      eventId: 'event-offline',
      target: { deviceId: online.deviceId, cwd: '/work/alpha', presetId: 'chatdsh-work', model: 'xhs/dots3-note-prev' },
      prompt: '核对客户端设计规范与当前实现，报告验收条件。',
    });
    assert.equal(device.opens.length, 1);
    const opening = device.opens[0];
    assert.equal(opening.method, 'POST');
    assert.equal(opening.path, '/chatdsh/sessions', '会话建立请求送到目标设备的真实通道');

    // 重复投递：返回幂等结论，记录只保留一行。
    const duplicate = post({ 'x-github-delivery': 'event-offline', 'x-chatdsh-webhook-secret': secret }, '{"action":"opened","issue":17}');
    assert.equal(duplicate.status, 202);
    assert.deepEqual(duplicate.body, { duplicate: true });
    await app.automations.settle();
    const deduped = app.automations.delivery(automationId, 'event-offline');
    assert.equal(deduped.attempts, 3);
    assert.equal(deduped.dedupe, 'duplicate');
    assert.equal(deduped.state, 'completed');
    assert.equal(app.dispatched.length, 1, '重复事件不再建立会话');
    assert.equal(app.automations.eventsOf(automationId).length, 1, '同一事件只保留一行收下的记录');

    // 派发失败与结果未确认：设备拒绝时记录失败原因，应答超时按未确认记录。
    dispatchStatus = 503;
    const refused = post({ 'x-github-delivery': 'event-refused', 'x-chatdsh-webhook-secret': secret }, '{"action":"closed"}');
    assert.equal(refused.status, 202);
    await app.automations.settle();
    const failedDispatch = app.automations.delivery(automationId, 'event-refused');
    assert.equal(failedDispatch.state, 'failed');
    assert.equal(failedDispatch.code, 'chat-backend-unreachable');
    assert.equal(failedDispatch.reason, 'dispatch');
    assert.equal(failedDispatch.httpStatus, 202, '应答按收下投递的状态记录');
    dispatchStatus = 504;
    const unconfirmed = post({ 'x-github-delivery': 'event-unconfirmed', 'x-chatdsh-webhook-secret': secret }, '{"action":"closed"}');
    assert.equal(unconfirmed.status, 202);
    await app.automations.settle();
    const unconfirmedRecord = app.automations.delivery(automationId, 'event-unconfirmed');
    assert.equal(unconfirmedRecord.state, 'unconfirmed');
    assert.equal(unconfirmedRecord.code, 'automation-delivery-unconfirmed');
    assert.equal(unconfirmedRecord.reason, 'unconfirmed');
    dispatchStatus = 200;

    // 记录不存在、记录停用：明确失败，不写投递记录。
    assert.equal(handleWebhook(app.automations, 'automation-missing', { 'x-chatdsh-webhook-secret': secret }, '{"a":1}').status, 404);
    const disabled = await app.call(AUTOMATIONS_PATH, { method: 'PATCH', body: JSON.stringify({ id: automationId, enabled: false }) });
    assert.equal(disabled.status, 200);
    const disabledPost = post({ 'x-github-delivery': 'event-disabled', 'x-chatdsh-webhook-secret': secret }, '{"a":1}');
    assert.equal(disabledPost.status, 404);
    assert.equal(disabledPost.body.error, 'automation-disabled');
    assert.equal(app.automations.delivery(automationId, 'event-disabled'), undefined);

    // 投递记录分页：完整字段、状态过滤、游标翻页与非法游标。
    const pageOne = await app.call(`${AUTOMATION_DELIVERIES_PATH}?automationId=${automationId}&limit=1`);
    assert.equal(pageOne.status, 200, JSON.stringify(pageOne.body));
    assert.equal(pageOne.body.deliveries.length, 1);
    assert.ok(typeof pageOne.body.nextCursor === 'string');
    const firstDelivery = pageOne.body.deliveries[0];
    for (const field of ['deliveryId', 'automationId', 'eventId', 'source', 'receivedAt', 'dedupe', 'state', 'attempts', 'httpStatus', 'lastAttemptAt']) {
      assert.ok(firstDelivery[field] !== undefined, `投递记录缺少字段 ${field}`);
    }
    const pageTwo = await app.call(`${AUTOMATION_DELIVERIES_PATH}?automationId=${automationId}&limit=1&cursor=${pageOne.body.nextCursor}`);
    assert.equal(pageTwo.status, 200);
    assert.equal(pageTwo.body.deliveries.length, 1);
    assert.notEqual(pageTwo.body.deliveries[0].deliveryId, firstDelivery.deliveryId);
    const failedOnly = await app.call(`${AUTOMATION_DELIVERIES_PATH}?automationId=${automationId}&state=failed`);
    assert.equal(failedOnly.status, 200);
    assert.ok(failedOnly.body.deliveries.length >= 3, '失败原因可以按状态查询出来');
    for (const delivery of failedOnly.body.deliveries) {
      assert.equal(delivery.state, 'failed');
      assert.ok(typeof delivery.code === 'string' && delivery.code !== '', '失败记录带错误码');
      assert.ok(typeof delivery.reason === 'string' && delivery.reason !== '', '失败记录带原因取值');
    }
    const githubOnly = await app.call(`${AUTOMATION_DELIVERIES_PATH}?source=github`);
    assert.equal(githubOnly.status, 200);
    assert.ok(githubOnly.body.deliveries.every((delivery) => delivery.source === 'github'));
    const badCursor = await app.call(`${AUTOMATION_DELIVERIES_PATH}?cursor=not-a-cursor`);
    assert.equal(badCursor.status, 400);
    assert.equal(badCursor.body.error, 'cursor-invalid');
    const badLimit = await app.call(`${AUTOMATION_DELIVERIES_PATH}?limit=0`);
    assert.equal(badLimit.status, 400);
    const badState = await app.call(`${AUTOMATION_DELIVERIES_PATH}?state=unknown`);
    assert.equal(badState.status, 400);
    const unknownQuery = await app.call(`${AUTOMATION_DELIVERIES_PATH}?payload=x`);
    assert.equal(unknownQuery.status, 400);
    const notJson = await fetch(`${app.origin}${AUTOMATIONS_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${app.tokens.full}`, 'x-chatdsh-csrf': '1', 'content-type': 'application/json' },
      body: '{',
    });
    assert.equal(notJson.status, 400, '非法 JSON 按请求内容不合法拒绝');
    assert.equal((await notJson.json()).error, 'request-invalid');
    const oversized = await fetch(`${app.origin}${AUTOMATIONS_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${app.tokens.full}`, 'x-chatdsh-csrf': '1', 'content-type': 'application/json' },
      body: JSON.stringify(draftOf(app, online.deviceId, { prompt: 'x'.repeat(80 * 1024) })),
    });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).error, 'payload-too-large');

    // 最近投递摘要出现在记录里，取最近一次投递的结论。
    const listed = await app.call(AUTOMATIONS_PATH);
    const summary = listed.body.automations.find((item) => item.id === automationId);
     assert.ok(summary.lastDelivery !== undefined, '记录带最近一次投递摘要');
    assert.equal(summary.lastDelivery.state, 'unconfirmed');
    assert.equal(summary.lastDelivery.code, 'automation-delivery-unconfirmed');

    device.close();
  } finally {
    delete process.env[secretEnv];
    await app.close();
  }
});

/** 起一个真实接收 OTLP/HTTP 请求的收集器。 */
async function startOtlpReceiver() {
  const records = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      records.push({ path: request.url ?? '', body: Buffer.concat(chunks).toString('utf8') });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{}');
    });
  });
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    records,
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}

test('遥测：自动化读写与投递分页写出 span、失败事件与计数指标', { timeout: 120_000 }, async () => {
  const home = allocateIndependentHome('wp17-automation-telemetry');
  const receiver = await startOtlpReceiver();
  let telemetry;
  let store;
  let routesServer;
  try {
    telemetry = createTelemetryClient({
      config: defaultTelemetryConfig({
        endpoint: receiver.endpoint,
        surface: 'gateway',
        exportIntervalMs: 2000,
        exportIntervalMsMetrics: 3000,
        exportTimeoutMs: 500,
      }),
      component: '@chatdsh/gateway',
      env: { CHATDSH_TELEMETRY: 'on' },
    });
    store = new GatewayStore(join(home, 'gateway.sqlite'));
    const automations = new AutomationStore(store.handle());
    automations.create({
      id: 'auto-telemetry',
      name: '遥测用例',
      trigger: { kind: 'webhook', secretEnv: 'CHATDSH_WP17_TELEMETRY_HOOK' },
      action: { kind: 'start-session', prompt: '核对遥测信号' },
      enabled: true,
      createdAt: Date.now(),
    });
    let routes;
    routesServer = createServer(async (request, response) => {
      if (await routes(request, response)) return;
      response.writeHead(404).end();
    });
    routesServer.listen(0, '127.0.0.1');
    await once(routesServer, 'listening');
    const origin = `http://127.0.0.1:${routesServer.address().port}`;
    routes = createAutomationRoutes({
      automations,
      telemetry,
      origin,
      authenticate: () => ({ clientId: 'telemetry-console', authentication: 'bearer', expiresAt: Date.now() + 60_000, deviceIds: 'all' }),
    });
    const headers = { authorization: 'Bearer [REDACTED:auth_header]', 'x-chatdsh-csrf': '1', 'content-type': 'application/json' };

    const listed = await fetch(`${origin}${AUTOMATIONS_PATH}`, { headers });
    assert.equal(listed.status, 200);
    const read = await fetch(`${origin}${AUTOMATIONS_PATH}?id=auto-telemetry`, { headers });
    assert.equal(read.status, 200);
    const invalid = await fetch(`${origin}${AUTOMATIONS_PATH}`, { method: 'POST', headers, body: JSON.stringify({ name: '', prompt: 'x', enabled: true, trigger: { kind: 'webhook', secretEnv: 'CHATDSH_WP17_TELEMETRY_HOOK' }, target: { deviceId: 'device-alpha' } }) });
    assert.equal(invalid.status, 400);
    const toggled = await fetch(`${origin}${AUTOMATIONS_PATH}`, { method: 'PATCH', headers, body: JSON.stringify({ id: 'auto-telemetry', enabled: false }) });
    assert.equal(toggled.status, 200);
    const deliveries = await fetch(`${origin}${AUTOMATION_DELIVERIES_PATH}?limit=5`, { headers });
    assert.equal(deliveries.status, 200);

    await telemetry.flush(5000);
    const traces = receiver.records.filter((item) => item.path.includes('/v1/traces')).map((item) => item.body);
    for (const expected of ['chatdsh.gateway.automation.list', 'chatdsh.gateway.automation.read', 'chatdsh.gateway.automation.create', 'chatdsh.gateway.automation.toggle', 'chatdsh.gateway.automation.deliveries']) {
      assert.ok(traces.some((body) => body.includes(expected)), `缺少 span ${expected}`);
    }
    assert.ok(traces.some((body) => body.includes('chatdsh.gateway.automation.create') && body.includes('"failed"')), '拒绝的建立写出失败 span');
    const logs = receiver.records.filter((item) => item.path.includes('/v1/logs')).map((item) => item.body);
    assert.ok(logs.some((body) => body.includes('chatdsh.gateway.automation.rejected') && body.includes('request-invalid')), '拒绝分支写出带错误码的事件');
    const metrics = receiver.records.filter((item) => item.path.includes('/v1/metrics')).map((item) => item.body);
    for (const expected of ['chatdsh_gateway_automation_requests_total', 'chatdsh_gateway_automation_writes_total', 'chatdsh_gateway_automation_deliveries_total']) {
      assert.ok(metrics.some((body) => body.includes(expected)), `缺少指标 ${expected}`);
    }
    const payloads = receiver.records.map((item) => item.body).join('\n');
    assert.equal(payloads.includes('核对遥测信号'), false, '遥测里没有提示词原文');
    assert.equal(payloads.includes('CHATDSH_WP17_TELEMETRY_HOOK'), false, '遥测里没有密钥环境变量名');
  } finally {
    if (routesServer !== undefined) {
      routesServer.closeAllConnections();
      await new Promise((done) => routesServer.close(done));
    }
    if (telemetry !== undefined) await telemetry.shutdown();
    await receiver.close();
    if (store !== undefined) store.close();
    releaseIndependentHome(home);
  }
});
