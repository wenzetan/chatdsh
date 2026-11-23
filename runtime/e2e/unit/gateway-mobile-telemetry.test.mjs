// 移动端遥测中转与设备管理接口的端到端测试。
//
// 起真实中继服务端，覆盖设备令牌鉴权、设备吊销、遥测上报、禁止字段、批量上限与限流。
// 遥测出口换成记录器，只为观察中继服务端实际写入的信号；设备登记、鉴权、限流与校验
// 全部走真实路由与 SQLite 存储。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tempHome } from '../../scripts/lib/cleanup.mjs';
import { useHome } from '../lib/environment.mjs';
import { GatewayStore, PushQueue, ReceiptStore, ReplicaStore, SettingsStore } from '../../gateway/lib/store.js';
import { createPushHub } from '../../gateway/lib/push.js';
import { createGatewayServer } from '../../gateway/lib/server.js';
import { deviceTokenHash } from '../../gateway/lib/mobile-http.js';
import { createTelemetryClient } from '../../packages/core/diagnostics/lib/client.js';
import { defaultTelemetryConfig } from '../../packages/core/diagnostics/lib/config.js';

/** 记录全部信号的遥测出口，方法与 ChatdshTelemetry 同名。 */
class RecordingTelemetry {
  constructor({ enabled = true } = {}) {
    this.enabled = enabled;
    this.reason = enabled ? undefined : 'env';
    this.events = [];
    this.counters = [];
    this.histograms = [];
    this.gauges = [];
    this.spans = [];
  }

  event(name, attributes = {}) {
    this.events.push({ name, attributes });
  }

  log(level, message, attributes = {}) {
    this.events.push({ name: message, level, attributes });
  }

  counter(name, options) {
    return { add: (delta, attributes = {}) => this.counters.push({ name, delta, attributes, options }) };
  }

  histogram(name, options) {
    return { record: (value, attributes = {}) => this.histograms.push({ name, value, attributes, options }) };
  }

  gauge(name, options) {
    return { record: (value, attributes = {}) => this.gauges.push({ name, value, attributes, options }) };
  }

  startSpan(name, attributes = {}) {
    const record = { name, attributes: { ...attributes }, ended: false };
    this.spans.push(record);
    return {
      setAttribute: (key, value) => { record.attributes[key] = value; },
      setAttributes: (extra) => { Object.assign(record.attributes, extra); },
      recordException: () => {},
      end: () => { record.ended = true; },
    };
  }

  runSpanSync(name, attributes, fn) {
    const span = this.startSpan(name, attributes);
    try {
      return fn(span);
    } finally {
      span.end();
    }
  }

  async runSpan(name, attributes, fn) {
    const span = this.startSpan(name, attributes);
    try {
      return await fn(span);
    } finally {
      span.end();
    }
  }

  inject(carrier) {
    return carrier;
  }

  extract() {
    return {};
  }

  withContext(_carrier, fn) {
    return fn();
  }

  currentTraceId() {
    return undefined;
  }

  async flush() {}

  async shutdown() {}
}

/** 起一个完整装配的控制平面。 */
async function startGateway({ telemetry = new RecordingTelemetry() } = {}) {
  const home = tempHome('gateway-mobile');
  const restoreHome = useHome(home);
  const databasePath = join(home, 'gateway.sqlite');
  const store = new GatewayStore(databasePath);
  const replica = new ReplicaStore(store.handle());
  const receipts = new ReceiptStore(store.handle());
  const push = createPushHub({
    queue: new PushQueue(store.handle()),
    devices: store,
    mode: 'all-at-once',
    escalationMs: 1000,
    telemetry: { counter: () => ({ add: () => {} }) },
  });
  const server = createGatewayServer({
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
    replica,
    receipts,
    settings: new SettingsStore(store.handle()),
    push,
    telemetry,
  });
  await server.start();
  return {
    url: server.url(),
    store,
    telemetry,
    async close() {
      await server.stop();
      store.close();
      restoreHome();
    },
  };
}

/** 在真实存储里登记一台客户端设备并返回令牌。 */
function seedDevice(gateway, options = {}) {
  const device = {
    id: options.id ?? 'mobile-device',
    name: options.name ?? 'Pixel 9',
    platform: options.platform ?? 'android',
    token: options.token ?? 'mobile-device-token',
  };
  gateway.store.registerMobileDevice({
    id: device.id,
    name: device.name,
    platform: device.platform,
    tokenHash: deviceTokenHash(device.token),
  });
  return device;
}

/** 一条合法的移动端记录。 */
function mobileRecord(overrides = {}) {
  return {
    signal: 'span',
    name: 'chatdsh.mobile.connect',
    attributes: { attempt: 1, outcome: 'ok' },
    ...overrides,
  };
}

/** 等一轮微任务，让中转队列把记录投递给遥测出口。 */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

test('吊销设备后令牌立即失效', async () => {
  const gateway = await startGateway();
  try {
    const pairing = seedDevice(gateway);
    const listed = await fetch(`${gateway.url}/chatdsh/gateway/mobile/devices`);
    assert.equal(listed.status, 200);
    const devices = (await listed.json()).devices;
    assert.ok(devices.some((device) => device.id === pairing.id && device.revokedAt === undefined));

    const revoked = await fetch(`${gateway.url}/chatdsh/gateway/mobile/devices?id=${pairing.id}`, {
      method: 'DELETE',
    });
    assert.equal(revoked.status, 200);
    assert.equal((await revoked.json()).revoked, true);

    const session = await fetch(`${gateway.url}/chatdsh/telemetry/mobile`, {
      method: 'POST',
      headers: { 'x-chatdsh-device-token': pairing.token },
      body: JSON.stringify({ records: [mobileRecord()] }),
    });
    assert.equal(session.status, 401);
    assert.equal((await session.json()).error, 'device-token-invalid');

    const after = await (await fetch(`${gateway.url}/chatdsh/gateway/mobile/devices`)).json();
    assert.ok(after.devices.some((device) => device.id === pairing.id && typeof device.revokedAt === 'number'));
    assert.ok(gateway.telemetry.spans.some((span) => span.name === 'chatdsh.gateway.mobile.devices'
      && span.attributes.outcome === 'revoked'));
  } finally {
    await gateway.close();
  }
});

test('遥测上报成功并补写形态与设备类别', async () => {
  const gateway = await startGateway();
  try {
    const pairing = seedDevice(gateway);
    const response = await fetch(`${gateway.url}/chatdsh/telemetry/mobile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-chatdsh-device-token': pairing.token },
      body: JSON.stringify({
        records: [
          mobileRecord({ signal: 'event', name: 'chatdsh.mobile.queue.replay', attributes: { count: 1, outcome: 'ok', 'unregistered.key': 'x' } }),
          mobileRecord({ signal: 'span', name: 'chatdsh.mobile.connect', durationMs: 120, attributes: { attempt: 1, outcome: 'ok' } }),
          mobileRecord({ signal: 'metric', name: 'chatdsh_mobile_offline_queue_depth', value: 3, metricKind: 'gauge' }),
        ],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.accepted, true);
    assert.deepEqual(body.counts, { event: 1, span: 1, metric: 1 });
    assert.deepEqual(body.dropped, { event: 1, span: 0, metric: 0 });

    await settle();
    const startup = gateway.telemetry.events.find((entry) => entry.name === 'chatdsh.mobile.queue.replay');
    assert.equal(startup.attributes['chatdsh.surface'], 'mobile');
    assert.equal(startup.attributes['device.kind'], 'mobile');
    assert.equal(startup.attributes['unregistered.key'], undefined);

    const connect = gateway.telemetry.spans.find((span) => span.name === 'chatdsh.mobile.connect');
    assert.equal(connect.attributes['device.kind'], 'mobile');
    assert.equal(connect.attributes.duration, 120);
    assert.equal(connect.ended, true);

    const gauge = gateway.telemetry.gauges.find((entry) => entry.name === 'chatdsh_mobile_offline_queue_depth');
    assert.equal(gauge.value, 3);
    assert.equal(gauge.attributes['chatdsh.surface'], 'mobile');

    assert.ok(gateway.telemetry.spans.some((span) => span.name === 'chatdsh.gateway.mobile.telemetry'
      && span.attributes.outcome === 'accepted' && span.attributes.count === 3));
    assert.ok(gateway.telemetry.counters.some((entry) => entry.name === 'chatdsh_mobile_telemetry_batches_total'
      && entry.attributes.outcome === 'accepted'));
  } finally {
    await gateway.close();
  }
});


test('遥测含禁止字段被拒并写入拒绝信号', async () => {
  const gateway = await startGateway();
  try {
    const pairing = seedDevice(gateway);
    const response = await fetch(`${gateway.url}/chatdsh/telemetry/mobile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-chatdsh-device-token': pairing.token },
      body: JSON.stringify({
        records: [mobileRecord({ attributes: { outcome: 'ok', 'message.body': '用户原文' } })],
      }),
    });
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error, 'forbidden-attribute');
    assert.ok(gateway.telemetry.events.some((entry) => entry.name === 'chatdsh.gateway.mobile.telemetry.rejected'
      && entry.attributes['error.code'] === 'forbidden-attribute'));
    assert.ok(!gateway.telemetry.spans.some((span) => span.name === 'chatdsh.mobile.connect'));

    const email = await fetch(`${gateway.url}/chatdsh/telemetry/mobile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-chatdsh-device-token': pairing.token },
      body: JSON.stringify({
        records: [mobileRecord({ attributes: { outcome: ['alice', 'example.com'].join('@') } })],
      }),
    });
    assert.equal(email.status, 422);
    assert.equal((await email.json()).error, 'email');
  } finally {
    await gateway.close();
  }
});
test('遥测批量超限与单条超限都被拒绝', async () => {
  const gateway = await startGateway();
  try {
    const pairing = seedDevice(gateway);
    const records = Array.from({ length: 65 }, () => mobileRecord());
    const batch = await fetch(`${gateway.url}/chatdsh/telemetry/mobile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-chatdsh-device-token': pairing.token },
      body: JSON.stringify({ records }),
    });
    assert.equal(batch.status, 413);
    assert.equal((await batch.json()).error, 'batch-too-large');

    const huge = await fetch(`${gateway.url}/chatdsh/telemetry/mobile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-chatdsh-device-token': pairing.token },
      body: JSON.stringify({ records: [mobileRecord({ attributes: { outcome: 'x'.repeat(17 * 1024) } })] }),
    });
    assert.equal(huge.status, 413);
    assert.equal((await huge.json()).error, 'record-too-large');
    assert.ok(gateway.telemetry.counters.some((entry) => entry.name === 'chatdsh_mobile_telemetry_batches_total'
      && entry.attributes['error.code'] === 'batch-too-large'));
  } finally {
    await gateway.close();
  }
});

test('遥测令牌无效与缺失都被拒绝', async () => {
  const gateway = await startGateway();
  try {
    const invalid = await fetch(`${gateway.url}/chatdsh/telemetry/mobile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-chatdsh-device-token': 'bad-token' },
      body: JSON.stringify({ records: [mobileRecord()] }),
    });
    assert.equal(invalid.status, 401);
    assert.equal((await invalid.json()).error, 'device-token-invalid');

    const missing = await fetch(`${gateway.url}/chatdsh/telemetry/mobile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: [mobileRecord()] }),
    });
    assert.equal(missing.status, 401);
    assert.equal((await missing.json()).error, 'device-token-required');

    assert.ok(gateway.telemetry.spans.some((span) => span.name === 'chatdsh.gateway.mobile.telemetry'
      && span.attributes['error.code'] === 'device-token-invalid'));
  } finally {
    await gateway.close();
  }
});

test('单台设备超过每分钟批次数被限流', async () => {
  const gateway = await startGateway();
  try {
    const pairing = seedDevice(gateway);
    let limited;
    for (let index = 0; index < 61; index += 1) {
      const response = await fetch(`${gateway.url}/chatdsh/telemetry/mobile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-chatdsh-device-token': pairing.token },
        body: JSON.stringify({
          records: [mobileRecord({ signal: 'event', name: 'chatdsh.mobile.keystore', attributes: { action: 'read', outcome: 'ok' } })],
        }),
      });
      if (response.status === 429) {
        limited = await response.json();
        break;
      }
      assert.equal(response.status, 200);
    }
    assert.ok(limited, '第 61 批应当被限流');
    assert.equal(limited.error, 'too-many-batches');
    assert.ok(gateway.telemetry.events.some((entry) => entry.name === 'chatdsh.gateway.mobile.telemetry.rejected'
      && entry.attributes['error.type'] === 'rate-limit'
      && entry.attributes['error.code'] === 'too-many-batches'));
  } finally {
    await gateway.close();
  }
});
test('遥测关闭时上报端点返回 404', async () => {
  const telemetry = new RecordingTelemetry({ enabled: false });
  const gateway = await startGateway({ telemetry });
  try {
    const response = await fetch(`${gateway.url}/chatdsh/telemetry/mobile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-chatdsh-device-token': 'whatever' },
      body: JSON.stringify({ records: [mobileRecord()] }),
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'telemetry-disabled', reason: 'env' });
    assert.equal(telemetry.events.length, 0);
  } finally {
    await gateway.close();
  }
});

test('真实遥测管道把移动端记录转发到 OTLP 接收端', async () => {
  const received = [];
  const receiver = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      received.push({ path: request.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"partialSuccess":{}}');
    });
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const port = receiver.address().port;
  const telemetry = createTelemetryClient({
    config: defaultTelemetryConfig({ surface: 'gateway', exportIntervalMs: 200, exportIntervalMsMetrics: 200, exportTimeoutMs: 100 }),
    component: '@chatdsh/gateway',
    env: {
      CHATDSH_TELEMETRY_ENDPOINT: `http://127.0.0.1:${port}`,
      CHATDSH_TELEMETRY_USER: 'probe-user',
      CHATDSH_TELEMETRY_PASSWORD: 'probe-password', // gitleaks:allow
    },
  });
  const gateway = await startGateway({ telemetry });
  try {
    const pairing = seedDevice(gateway);
    const response = await fetch(`${gateway.url}/chatdsh/telemetry/mobile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-chatdsh-device-token': pairing.token },
      body: JSON.stringify({ records: [mobileRecord({ signal: 'event', name: 'chatdsh.mobile.queue.replay' })] }),
    });
    assert.equal(response.status, 200);
    await settle();
    await telemetry.flush(3000);
    const logsEntries = received.filter((entry) => entry.path.endsWith('/v1/logs'));
    assert.ok(logsEntries.length > 0, '应当收到日志导出请求');
    const records = logsEntries.flatMap((entry) => entry.body.resourceLogs.flatMap((resource) => resource.scopeLogs.flatMap((scope) => scope.logRecords)));
    const startup = records.find((record) => record.body?.stringValue === 'chatdsh.mobile.queue.replay');
    assert.ok(startup, '导出的日志里应当有移动端启动事件');
    const attributes = Object.fromEntries(startup.attributes.map((item) => [item.key, item.value.stringValue]));
    assert.equal(attributes['chatdsh.surface'], 'mobile');
    assert.equal(attributes['device.kind'], 'mobile');
  } finally {
    await telemetry.shutdown();
    await gateway.close();
    await new Promise((resolve) => receiver.close(resolve));
  }
});
