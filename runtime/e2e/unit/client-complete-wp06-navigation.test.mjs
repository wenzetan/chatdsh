// WP06 设备内导航桥的验收测试：契约校验、宿主与内容端的真实往返、超时重试与丢弃记录。
//
// 宿主与内容端都用包里的真实实现，相互投递真实的 `Event` 子类实例，计时用真实计时器，
// 遥测发到本机真实 HTTP 中继并逐条核对载荷。窗口替身只提供浏览器已经在实现的消息成员：
// `postMessage(message, targetOrigin)`、`addEventListener('message')` 与 `location.origin`，
// `targetOrigin` 与真实浏览器一样做来源匹配，投递像真实浏览器一样在下一个任务异步到达。
// 浏览器里的真实跨源行为由同编号的 Chrome 用例覆盖。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  BRIDGE_CAPABILITIES,
  CONTENT_STATES,
  DEFAULT_NAVIGATION_ATTEMPTS,
  DEFAULT_NAVIGATION_TIMEOUT_MS,
  MAX_NAVIGATION_ATTEMPTS,
  NAVIGATION_VERSION,
  NavigationContent,
  NavigationHost,
  NavigationOpenError,
  createNavigationTelemetry,
  navigateMessage,
  parseBridgeMessage,
  randomHex,
  readyMessage,
  rejectedMessage,
  selectedMessage,
  sourceMessage,
  stricterState,
} from '../../packages/client/session-bridge/lib/index.js';

const HOST_ORIGIN = 'https://host.example';
const CONTENT_ORIGIN = 'https://content.example';
const DEVICE_ID = 'device-alpha';

/** 带 `data`、`origin`、`source` 的 message 事件：真实 Event，成员与浏览器的 MessageEvent 相同。 */
class WindowMessageEvent extends Event {
  constructor({ data, origin, source }) {
    super('message');
    this.data = data;
    this.origin = origin;
    this.source = source;
  }
}

/** 窗口替身：真实的 EventTarget 加消息与计时成员。 */
class BridgeWindow extends EventTarget {
  constructor(origin) {
    super();
    this.location = { origin };
    /** 向本窗口投递消息的窗口；真实浏览器由调用方决定。 */
    this.sender = undefined;
    this.delivered = [];
    this.refused = [];
  }

  postMessage(message, targetOrigin) {
    const sender = this.sender;
    if (sender === undefined) {
      this.refused.push({ message, targetOrigin, reason: 'no-sender' });
      return;
    }
    if (targetOrigin !== '*' && targetOrigin !== this.location.origin) {
      this.refused.push({ message, targetOrigin, reason: 'origin-mismatch' });
      return;
    }
    this.delivered.push({ message, targetOrigin, from: sender });
    setTimeout(() => {
      this.dispatchEvent(new WindowMessageEvent({ data: message, origin: sender.location.origin, source: sender }));
    }, 0);
  }

  /** 构造一条指定来源与来源窗口的消息，用于跨源与来源不符的用例。 */
  inject({ data, origin, source }) {
    this.dispatchEvent(new WindowMessageEvent({ data, origin, source }));
  }

  setTimeout(handler, timeout) {
    return globalThis.setTimeout(handler, timeout);
  }

  clearTimeout(handle) {
    globalThis.clearTimeout(handle);
  }
}

/** iframe 替身：真实的 EventTarget 加 `contentWindow` 与 `dataset`。 */
class BridgeFrame extends EventTarget {
  constructor(contentWindow) {
    super();
    this.contentWindow = contentWindow;
    this.dataset = {};
  }
}

/**
 * 起一个真实的中继端点，记录每次上报。
 * @returns 中继句柄。
 */
async function startRelay() {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      signal: request.headers['x-chatdsh-signal'],
      csrf: request.headers['x-chatdsh-csrf'],
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"accepted":true}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}/chatdsh/telemetry/browser`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * 等一个条件成立。
 * @param predicate - 判据。
 * @param label - 超时提示。
 */
async function waitFor(predicate, label) {
  const deadline = Date.now() + 4000;
  while (predicate() !== true) {
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * 建一套宿主与内容端环境。
 * @param input - 时限、状态与打开实现。
 * @returns 环境句柄。
 */
async function createEnvironment(input = {}) {
  const relay = await startRelay();
  const telemetry = createNavigationTelemetry({
    fetchImpl: fetch,
    randomHex,
    now: () => Date.now(),
    relayPath: relay.url,
  });
  const hostWindow = new BridgeWindow(HOST_ORIGIN);
  const contentWindow = new BridgeWindow(CONTENT_ORIGIN);
  hostWindow.sender = contentWindow;
  contentWindow.sender = hostWindow;
  const frame = new BridgeFrame(contentWindow);
  const opened = [];
  const content = new NavigationContent({
    window: contentWindow,
    parent: hostWindow,
    deviceId: input.deviceId ?? DEVICE_ID,
    telemetry,
    hostOrigin: HOST_ORIGIN,
    ...(input.contentState === undefined ? {} : { state: input.contentState }),
    openSession: input.openSession ?? (async (sessionId) => {
      opened.push(sessionId);
      return { sessionId, title: `会话 ${sessionId}` };
    }),
    ...(input.currentSession === undefined ? {} : { currentSession: input.currentSession }),
    ...(input.contentTimeoutMs === undefined ? {} : { timeoutMs: input.contentTimeoutMs }),
  });
  const host = new NavigationHost({
    window: hostWindow,
    frame,
    deviceId: input.deviceId ?? DEVICE_ID,
    telemetry,
    contentOrigin: CONTENT_ORIGIN,
    ...(input.hostState === undefined ? {} : { state: input.hostState }),
    ...(input.hostTimeoutMs === undefined ? {} : { timeoutMs: input.hostTimeoutMs }),
    ...(input.attempts === undefined ? {} : { attempts: input.attempts }),
    ...(input.createRequestId === undefined ? {} : { createRequestId: input.createRequestId }),
  });
  if (input.loaded !== false) frame.dispatchEvent(new Event('load'));
  return {
    relay,
    host,
    content,
    hostWindow,
    contentWindow,
    frame,
    opened,
    async close() {
      host.dispose();
      content.dispose();
      await relay.close();
    },
  };
}

/** 取一次上报里的 span 记录。 */
function spansOf(requests) {
  const out = [];
  for (const request of requests) {
    if (request.signal !== 'traces') continue;
    for (const resource of request.body.resourceSpans ?? []) {
      for (const scope of resource.scopeSpans ?? []) {
        for (const span of scope.spans ?? []) {
          out.push({ name: span.name, status: span.status, attributes: attributesOf(span.attributes) });
        }
      }
    }
  }
  return out;
}

/** 取一次上报里的日志记录。 */
function eventsOf(requests) {
  const out = [];
  for (const request of requests) {
    if (request.signal !== 'logs') continue;
    for (const resource of request.body.resourceLogs ?? []) {
      for (const scope of resource.scopeLogs ?? []) {
        for (const record of scope.logRecords ?? []) {
          out.push({ body: record.body?.stringValue, attributes: attributesOf(record.attributes) });
        }
      }
    }
  }
  return out;
}

/** 取一次上报里的指标数据点。 */
function metricPointsOf(requests) {
  const out = [];
  for (const request of requests) {
    if (request.signal !== 'metrics') continue;
    for (const resource of request.body.resourceMetrics ?? []) {
      for (const scope of resource.scopeMetrics ?? []) {
        for (const metric of scope.metrics ?? []) {
          for (const point of metric.sum?.dataPoints ?? []) {
            out.push({ name: metric.name, attributes: attributesOf(point.attributes), value: point.asDouble });
          }
        }
      }
    }
  }
  return out;
}

/** 把 OTLP 属性数组摊平成对象。 */
function attributesOf(attributes) {
  const out = {};
  for (const attribute of attributes ?? []) {
    out[attribute.key] = attribute.value.stringValue ?? attribute.value.intValue;
  }
  return out;
}

test('契约：五类消息逐字段校验，未知版本与缺字段被明确拒绝', () => {
  const source = sourceMessage({
    deviceId: DEVICE_ID,
    state: 'writable',
    capabilities: ['open-session', 'report-selection'],
    sessionId: 'session-one',
  });
  const ready = readyMessage({ deviceId: DEVICE_ID, state: 'readonly', capabilities: ['open-session'] });
  const navigate = navigateMessage({ requestId: 'request-one', deviceId: DEVICE_ID, sessionId: 'session-one' });
  const selected = selectedMessage({
    requestId: 'request-one',
    deviceId: DEVICE_ID,
    sessionId: 'session-one',
    title: '会话一',
  });
  const rejected = rejectedMessage({ requestId: 'request-one', code: 'device-offline' });

  for (const message of [source, ready, navigate, selected, rejected]) {
    const parsed = parseBridgeMessage(message);
    assert.equal(parsed.ok, true, `合法消息被拒绝：${JSON.stringify(message)}`);
    assert.deepEqual(parsed.message, message);
  }

  // 未知版本。
  const futureVersion = parseBridgeMessage({ ...navigate, version: NAVIGATION_VERSION + 1 });
  assert.equal(futureVersion.ok, false);
  assert.equal(futureVersion.rejection.code, 'message-schema-invalid');
  assert.equal(futureVersion.rejection.type, 'unsupported-version');

  // 缺少 version。
  const { version: _dropped, ...withoutVersion } = navigate;
  const missingVersion = parseBridgeMessage(withoutVersion);
  assert.equal(missingVersion.ok, false);
  assert.equal(missingVersion.rejection.code, 'message-schema-invalid');

  // 每个必需字段逐个缺失。
  const required = [
    [source, 'deviceId'],
    [source, 'state'],
    [source, 'capabilities'],
    [navigate, 'requestId'],
    [navigate, 'deviceId'],
    [navigate, 'sessionId'],
    [ready, 'deviceId'],
    [ready, 'capabilities'],
    [selected, 'requestId'],
    [selected, 'sessionId'],
    [rejected, 'requestId'],
    [rejected, 'code'],
  ];
  for (const [message, field] of required) {
    const broken = { ...message };
    delete broken[field];
    const parsed = parseBridgeMessage(broken);
    assert.equal(parsed.ok, false, `缺少 ${field} 的消息被接受`);
    assert.equal(parsed.rejection.code, 'message-schema-invalid');
    assert.equal(parsed.rejection.type, 'schema-invalid');
    assert.match(parsed.rejection.detail, new RegExp(field));
  }

  // 字段类型与取值不符。
  const wrongTypes = [
    { ...navigate, requestId: 7 },
    { ...navigate, deviceId: '' },
    { ...navigate, sessionId: 'x'.repeat(201) },
    { ...source, state: 'closed' },
    { ...source, capabilities: 'open-session' },
    { ...source, capabilities: ['open-session', 'unknown-capability'] },
    { ...rejected, code: 'not-a-registered-code' },
    { ...selected, title: '' },
  ];
  for (const message of wrongTypes) {
    const parsed = parseBridgeMessage(message);
    assert.equal(parsed.ok, false, `非法字段被接受：${JSON.stringify(message)}`);
    assert.equal(parsed.rejection.type, 'schema-invalid');
  }

  // 未登记的判别值。
  for (const message of [{ action: 'open', version: 1 }, { outcome: 'pending', version: 1, requestId: 'r' }]) {
    const parsed = parseBridgeMessage(message);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.rejection.type, 'schema-invalid');
  }

  // 不是对象与缺少判别字段。
  for (const raw of [null, undefined, 'navigate', 42, [], { version: 1 }]) {
    const parsed = parseBridgeMessage(raw);
    assert.equal(parsed.ok, false, `非对象载荷被接受：${String(raw)}`);
    assert.equal(parsed.rejection.code, 'message-schema-invalid');
  }

  // 未登记的附加字段被忽略，与契约 schema 的语义一致。
  const withExtra = parseBridgeMessage({ ...navigate, extra: 'ignored' });
  assert.equal(withExtra.ok, true);
  assert.deepEqual(withExtra.message, navigate);
});

test('契约：消息形状与外壳现有导航通道一致', () => {
  // 外壳 packages/client/shell/src/client/main-view.ts 发出的载荷就是这个形状。
  const shellMessage = { action: 'navigate', version: 1, requestId: 'request-one', deviceId: DEVICE_ID, sessionId: 'session-one' };
  assert.deepEqual(
    navigateMessage({ requestId: 'request-one', deviceId: DEVICE_ID, sessionId: 'session-one' }),
    shellMessage,
  );
  // 外壳只读取 outcome、requestId 与 code；内容端的回执必须带这三项。
  const selected = selectedMessage({ requestId: 'request-one', deviceId: DEVICE_ID, sessionId: 'session-one', title: '会话一' });
  assert.equal(selected.outcome, 'selected');
  assert.equal(selected.requestId, 'request-one');
  const rejected = rejectedMessage({ requestId: 'request-one', code: 'navigation-rejected' });
  assert.equal(rejected.outcome, 'rejected');
  assert.equal(rejected.code, 'navigation-rejected');
  // 版本与时限与导航契约登记的取值一致。
  assert.equal(NAVIGATION_VERSION, 1);
  assert.equal(DEFAULT_NAVIGATION_TIMEOUT_MS, 5000);
  assert.equal(DEFAULT_NAVIGATION_ATTEMPTS, 2);
  assert.equal(MAX_NAVIGATION_ATTEMPTS, 4);
  assert.deepEqual([...CONTENT_STATES], ['writable', 'readonly', 'offline']);
  assert.deepEqual([...BRIDGE_CAPABILITIES], ['open-session', 'report-selection', 'readonly-mode', 'offline-mode']);
  assert.equal(stricterState('writable', 'offline'), 'offline');
  assert.equal(stricterState('readonly', 'writable'), 'readonly');
});

test('往返：握手后导航成功，宿主与内容端只确认真实选中的会话', async () => {
  const environment = await createEnvironment();
  try {
    const handshake = await environment.host.handshake();
    assert.equal(handshake.ok, true);
    assert.equal(handshake.ready.deviceId, DEVICE_ID);
    assert.equal(handshake.ready.state, 'writable');
    assert.deepEqual([...handshake.ready.capabilities], [...BRIDGE_CAPABILITIES]);
    assert.equal(environment.host.ready, true);
    assert.equal(environment.host.contentState, 'writable');

    const outcome = await environment.host.select('session-one');
    assert.equal(outcome.outcome, 'selected');
    assert.equal(outcome.attempts, 1);
    assert.equal(outcome.sessionId, 'session-one');
    assert.equal(outcome.title, '会话 session-one');
    assert.equal(environment.host.selectedSessionId, 'session-one');
    assert.equal(environment.content.selectedSessionId, 'session-one');
    assert.deepEqual(environment.opened, ['session-one']);

    // 宿主发出的是契约里的 navigate，内容端回的是 selected。
    const navigate = environment.contentWindow.delivered
      .map((item) => item.message)
      .filter((message) => message.action === 'navigate');
    assert.equal(navigate.length, 1);
    assert.equal(navigate[0].version, NAVIGATION_VERSION);
    assert.equal(navigate[0].deviceId, DEVICE_ID);
    const replies = environment.hostWindow.delivered
      .map((item) => item.message)
      .filter((message) => message.outcome === 'selected');
    assert.equal(replies.length, 1);
    assert.equal(replies[0].requestId, navigate[0].requestId);
  } finally {
    await environment.close();
  }
});

test('往返：打开失败回 rejected 并带原因码，宿主按拒绝结束', async () => {
  const environment = await createEnvironment({
    openSession: async () => {
      throw new NavigationOpenError('device-offline', '目标设备当前离线');
    },
  });
  try {
    const outcome = await environment.host.select('session-one');
    assert.equal(outcome.outcome, 'rejected');
    assert.equal(outcome.code, 'device-offline');
    assert.deepEqual(environment.opened, []);
    const replies = environment.hostWindow.delivered
      .map((item) => item.message)
      .filter((message) => message.outcome === 'rejected');
    assert.equal(replies.length, 1);
    assert.equal(replies[0].code, 'device-offline');
  } finally {
    await environment.close();
  }
});

test('往返：打开实现返回别的会话时不确认成功', async () => {
  const environment = await createEnvironment({
    openSession: async () => ({ sessionId: 'session-other', title: '别的会话' }),
  });
  try {
    const outcome = await environment.host.select('session-one');
    assert.equal(outcome.outcome, 'rejected');
    assert.equal(outcome.code, 'navigation-rejected');
    assert.equal(environment.host.selectedSessionId, undefined);
    assert.equal(environment.content.selectedSessionId, undefined);
  } finally {
    await environment.close();
  }
});

test('往返：当前选中与会话打开结果不一致时不确认成功', async () => {
  const environment = await createEnvironment({
    openSession: async (sessionId) => ({ sessionId, title: '会话' }),
    currentSession: () => 'session-other',
  });
  try {
    const outcome = await environment.host.select('session-one');
    assert.equal(outcome.outcome, 'rejected');
    assert.equal(outcome.code, 'navigation-rejected');
  } finally {
    await environment.close();
  }
});

test('往返：未声明席位的导航请求被拒绝为未就绪', async () => {
  const environment = await createEnvironment();
  try {
    // 直接从宿主窗口投递一条 navigate，内容端尚未收到 source 声明。
    environment.contentWindow.inject({
      data: navigateMessage({ requestId: 'request-early', deviceId: DEVICE_ID, sessionId: 'session-one' }),
      origin: HOST_ORIGIN,
      source: environment.hostWindow,
    });
    await waitFor(
      () => environment.hostWindow.delivered.some((item) => item.message.outcome === 'rejected'),
      '内容端回拒绝',
    );
    const reply = environment.hostWindow.delivered
      .map((item) => item.message)
      .find((message) => message.outcome === 'rejected');
    assert.equal(reply.code, 'navigation-not-ready');
    assert.equal(reply.requestId, 'request-early');
    assert.deepEqual(environment.opened, []);
    // 宿主把这条没有对应请求的拒绝记为丢弃记录并写失败事件。
    await waitFor(() => environment.host.rejections().length >= 1, '宿主记录丢弃的拒绝回执');
    assert.equal(environment.host.rejections()[0].code, 'navigation-not-ready');
  } finally {
    await environment.close();
  }
});

test('超时与重试：内容端不回应时按有限次数重试后明确失败', async () => {
  const environment = await createEnvironment({ hostTimeoutMs: 40, attempts: 3 });
  try {
    // 让内容端收到导航却不回应：摘掉内容端的监听器，只记录收到的消息。
    environment.content.dispose();
    const received = [];
    environment.contentWindow.addEventListener('message', (event) => {
      if (event.data?.action === 'navigate') received.push(event.data);
    });
    const startedAt = Date.now();
    const outcome = await environment.host.select('session-one');
    const elapsed = Date.now() - startedAt;
    assert.equal(outcome.outcome, 'timeout');
    assert.equal(outcome.code, 'navigation-timeout');
    assert.equal(outcome.attempts, 3);
    assert.equal(received.length, 3);
    assert.equal(new Set(received.map((message) => message.requestId)).size, 3);
    // 三次尝试各等 40 毫秒，总计不超过有限上限。
    assert.ok(elapsed >= 100 && elapsed < 3000, `等待时长 ${elapsed} 毫秒`);

    await waitFor(() => spansOf(environment.relay.requests).length >= 1, '超时 span 上报');
    const span = spansOf(environment.relay.requests).find((item) => item.name === 'chatdsh.client.navigate');
    assert.equal(span.attributes['outcome'], 'timeout');
    assert.equal(span.attributes['attempt'], '3');
    assert.equal(span.attributes['deviceId'], DEVICE_ID);
    assert.equal(span.attributes['error.code'], 'navigation-timeout');
    assert.equal(span.status.code, 2);
    await waitFor(() => metricPointsOf(environment.relay.requests).length >= 1, '超时计数上报');
    const points = metricPointsOf(environment.relay.requests);
    assert.equal(points[0].attributes['outcome'], 'timeout');
    await waitFor(() => eventsOf(environment.relay.requests).length >= 1, '超时失败事件上报');
    const failures = eventsOf(environment.relay.requests);
    assert.equal(failures[0].attributes['outcome'], 'timeout');
    assert.equal(failures[0].attributes['error.type'], 'timeout');
    assert.equal(failures[0].attributes['error.code'], 'navigation-timeout');
  } finally {
    await environment.close();
  }
});

test('超时与重试：迟到的回执不改变已判定的超时结果', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const environment = await createEnvironment({
    hostTimeoutMs: 40,
    attempts: 1,
    openSession: async (sessionId) => {
      await gate;
      return { sessionId, title: '迟到的会话' };
    },
  });
  try {
    const outcome = await environment.host.select('session-one');
    assert.equal(outcome.outcome, 'timeout');
    assert.equal(outcome.attempts, 1);
    // 放下闸门，内容端此时才回执；宿主已经结束这次导航，不会被改写。
    release();
    await waitFor(
      () => environment.hostWindow.delivered.some((item) => item.message.outcome === 'selected'),
      '迟到的回执到达宿主',
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(environment.host.selectedSessionId, undefined);
    // 下一次导航仍然可用，没有被旧回执污染。
    const next = await environment.host.select('session-one');
    assert.equal(next.outcome, 'selected');
    assert.equal(next.sessionId, 'session-one');
  } finally {
    await environment.close();
  }
});

test('来源校验：其他窗口伪造的回执被丢弃，导航按超时结束', async () => {
  const environment = await createEnvironment({ hostTimeoutMs: 40, attempts: 1, createRequestId: () => 'fixed-request' });
  try {
    // 内容端不回应，只让同源的另一个窗口拿到同一个请求标识投递伪造回执。
    environment.content.dispose();
    const rogue = new BridgeWindow(CONTENT_ORIGIN);
    const navigation = environment.host.select('session-one');
    environment.hostWindow.inject({
      data: selectedMessage({ requestId: 'fixed-request', deviceId: DEVICE_ID, sessionId: 'session-one', title: '伪造会话' }),
      origin: CONTENT_ORIGIN,
      source: rogue,
    });
    const outcome = await navigation;
    assert.equal(outcome.outcome, 'timeout');
    const rejected = environment.host.rejections();
    assert.ok(rejected.some((item) => item.code === 'message-source-mismatch'), JSON.stringify(rejected));
  } finally {
    await environment.close();
  }
});

test('来源校验：跨源回执被丢弃并记录', async () => {
  const environment = await createEnvironment({ hostTimeoutMs: 40, attempts: 1, createRequestId: () => 'fixed-request' });
  try {
    environment.content.dispose();
    const navigation = environment.host.select('session-one');
    environment.hostWindow.inject({
      data: selectedMessage({ requestId: 'fixed-request', deviceId: DEVICE_ID, sessionId: 'session-one', title: '跨源伪造' }),
      origin: 'https://attacker.example',
      source: environment.contentWindow,
    });
    const outcome = await navigation;
    assert.equal(outcome.outcome, 'timeout');
    const rejected = environment.host.rejections();
    assert.ok(rejected.some((item) => item.code === 'origin-rejected'), JSON.stringify(rejected));
  } finally {
    await environment.close();
  }
});

test('来源校验：内容端丢弃其他窗口与跨源的导航消息，不打开任何会话', async () => {
  const environment = await createEnvironment();
  try {
    const handshake = await environment.host.handshake();
    assert.equal(handshake.ok, true);
    const rogueSibling = new BridgeWindow(HOST_ORIGIN);
    environment.contentWindow.inject({
      data: navigateMessage({ requestId: 'rogue-request', deviceId: DEVICE_ID, sessionId: 'session-rogue' }),
      origin: HOST_ORIGIN,
      source: rogueSibling,
    });
    environment.contentWindow.inject({
      data: navigateMessage({ requestId: 'cross-request', deviceId: DEVICE_ID, sessionId: 'session-cross' }),
      origin: 'https://attacker.example',
      source: environment.hostWindow,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const rejected = environment.content.rejections();
    assert.ok(rejected.some((item) => item.code === 'message-source-mismatch'), JSON.stringify(rejected));
    assert.ok(rejected.some((item) => item.code === 'origin-rejected'), JSON.stringify(rejected));
    assert.deepEqual(environment.opened, []);
    // 内容端没有向伪造来源回复任何消息。
    assert.deepEqual(environment.hostWindow.delivered.filter((item) => item.from === rogueSibling), []);
    // 正常的导航不受影响。
    const outcome = await environment.host.select('session-one');
    assert.equal(outcome.outcome, 'selected');
    assert.deepEqual(environment.opened, ['session-one']);
  } finally {
    await environment.close();
  }
});

test('席位声明：设备不符时不确认握手', async () => {
  const relay = await startRelay();
  try {
    const telemetry = createNavigationTelemetry({
      fetchImpl: fetch,
      randomHex,
      now: () => Date.now(),
      relayPath: relay.url,
    });
    const hostWindow = new BridgeWindow(HOST_ORIGIN);
    const contentWindow = new BridgeWindow(CONTENT_ORIGIN);
    hostWindow.sender = contentWindow;
    contentWindow.sender = hostWindow;
    const content = new NavigationContent({
      window: contentWindow,
      parent: hostWindow,
      deviceId: 'device-beta',
      telemetry,
      hostOrigin: HOST_ORIGIN,
      openSession: async (sessionId) => ({ sessionId, title: '会话' }),
    });
    const frame = new BridgeFrame(contentWindow);
    const host = new NavigationHost({
      window: hostWindow,
      frame,
      deviceId: DEVICE_ID,
      telemetry,
      contentOrigin: CONTENT_ORIGIN,
      timeoutMs: 40,
      attempts: 1,
    });
    frame.dispatchEvent(new Event('load'));
    try {
      const handshake = await host.handshake();
      assert.equal(handshake.ok, false);
      assert.equal(handshake.rejection.code, 'device-mismatch');
      assert.equal(host.ready, false);
    } finally {
      host.dispose();
      content.dispose();
    }
  } finally {
    await relay.close();
  }
});

test('状态传递：宿主声明只读与离线，内容端取较严格的状态并回报', async () => {
  const environment = await createEnvironment({ hostState: 'offline', contentState: 'writable' });
  try {
    const handshake = await environment.host.handshake();
    assert.equal(handshake.ok, true);
    assert.equal(handshake.ready.state, 'offline');
    // 握手只认带回本次声明标识的就绪上报，内容端启动时的自主上报不会被当成应答。
    assert.equal(handshake.ready.requestId !== undefined, true);
    assert.equal(environment.content.state, 'offline');
    assert.equal(environment.host.contentState, 'offline');
    // 只读与离线状态下仍然可以打开会话查看内容。
    const outcome = await environment.host.select('session-one');
    assert.equal(outcome.outcome, 'selected');

    const ready = environment.content.setState('readonly');
    assert.equal(ready.state, 'offline');
    const writable = await createEnvironment({ contentState: 'readonly' });
    try {
      const second = await writable.host.handshake();
      assert.equal(second.ok, true);
      assert.equal(second.ready.state, 'readonly');
    } finally {
      await writable.close();
    }
  } finally {
    await environment.close();
  }
});

test('销毁：宿主与内容端停止监听，导航按超时结束', async () => {
  const environment = await createEnvironment({ hostTimeoutMs: 40, attempts: 1 });
  try {
    const handshake = await environment.host.handshake();
    assert.equal(handshake.ok, true);
    environment.content.dispose();
    const timedOut = await environment.host.select('session-one');
    assert.equal(timedOut.outcome, 'timeout');
    environment.host.dispose();
    const afterDispose = await environment.host.select('session-one');
    assert.equal(afterDispose.outcome, 'timeout');
  } finally {
    await environment.close();
  }
});

test('并发：后一次导航取代前一次的等待，前一次按超时结束且不污染结果', async () => {
  const environment = await createEnvironment({
    hostTimeoutMs: 300,
    attempts: 1,
    contentTimeoutMs: 400,
    openSession: async (sessionId) => {
      if (sessionId === 'session-slow') await new Promise((resolve) => setTimeout(resolve, 120));
      return { sessionId, title: `会话 ${sessionId}` };
    },
  });
  try {
    const handshake = await environment.host.handshake();
    assert.equal(handshake.ok, true);
    const first = environment.host.select('session-slow');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await environment.host.select('session-fast');
    assert.equal(second.outcome, 'selected');
    assert.equal(second.sessionId, 'session-fast');
    const firstOutcome = await first;
    assert.equal(firstOutcome.outcome, 'timeout');
    // 慢的那次打开完成后回执已经对不上，宿主不把它当成选中。
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(environment.host.selectedSessionId, 'session-fast');
    assert.ok(
      environment.host.rejections().some((item) => item.type === 'superseded'),
      JSON.stringify(environment.host.rejections()),
    );
  } finally {
    await environment.close();
  }
});

test('遥测：导航 span、失败事件与计数指标都带登记过的属性', async () => {
  const environment = await createEnvironment({
    openSession: async (sessionId) => {
      if (sessionId !== 'session-one') throw new NavigationOpenError('session-not-found', '会话不存在');
      return { sessionId, title: '会话一' };
    },
  });
  try {
    const selected = await environment.host.select('session-one');
    assert.equal(selected.outcome, 'selected');
    const failed = await environment.host.select('session-missing');
    assert.equal(failed.outcome, 'rejected');
    assert.equal(failed.code, 'session-not-found');
    await waitFor(
      () => metricPointsOf(environment.relay.requests).length >= 2,
      '两条计数指标上报',
    );

    const spans = spansOf(environment.relay.requests).filter((item) => item.name === 'chatdsh.client.navigate');
    assert.equal(spans.length, 2);
    assert.equal(spans[0].attributes['outcome'], 'selected');
    assert.equal(spans[0].attributes['deviceId'], DEVICE_ID);
    assert.equal(spans[0].attributes['session.id'], 'session-one');
    assert.equal(spans[0].attributes['attempt'], '1');
    assert.equal(spans[0].status.code, 1);
    assert.equal(spans[1].attributes['outcome'], 'rejected');
    assert.equal(spans[1].attributes['error.type'], 'open-failed');
    assert.equal(spans[1].attributes['error.code'], 'session-not-found');
    assert.equal(spans[1].status.code, 2);

    const failures = eventsOf(environment.relay.requests).filter((item) => item.body === 'chatdsh.client.navigate.rejected');
    assert.equal(failures.length, 1, JSON.stringify(eventsOf(environment.relay.requests)));
    assert.equal(failures[0].attributes['deviceId'], DEVICE_ID);
    assert.equal(failures[0].attributes['outcome'], 'rejected');
    assert.equal(failures[0].attributes['error.type'], 'open-failed');
    assert.equal(failures[0].attributes['error.code'], 'session-not-found');

    const points = metricPointsOf(environment.relay.requests).filter((item) => item.name === 'chatdsh_client_navigations_total');
    assert.equal(points.length, 2);
    assert.deepEqual(points.map((item) => item.attributes['outcome']).sort(), ['rejected', 'selected']);
    assert.equal(points[0].value, 1);

    const signals = new Set(environment.relay.requests.map((item) => item.signal));
    assert.deepEqual([...signals].sort(), ['logs', 'metrics', 'traces']);
    for (const request of environment.relay.requests) assert.equal(request.csrf, '1');
  } finally {
    await environment.close();
  }
});
