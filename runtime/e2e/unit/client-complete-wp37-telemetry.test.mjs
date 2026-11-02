// WP37 验收：诊断、遥测管道与登记集成。
//
// 全部装配都是真实件：真实 Cordis 上下文、真实本机 HTTP 服务、真实 OTLP/HTTP 接收端，
// 浏览器侧使用 `packages/client/telemetry/src` 的真实源码与真实 HTTP 中继接收端。
// 接收端记录每一条上报的完整载荷，断言按载荷内容判定，不使用替身。
// 本机 OpenObserve 的凭据只从环境变量读取，缺失时中继以 503 `credential-missing` 明确记录。
//
// 运行：node --test e2e/unit/client-complete-wp37-telemetry.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { ensureDeps } from '../lib/ensure-deps.mjs';

const REPO = resolve(import.meta.dirname, '../../..');
const RUNTIME = resolve(import.meta.dirname, '../..');
ensureDeps(RUNTIME);
ensureDeps(resolve(REPO, 'dsh-adapter'));

const { Context } = await import('@deepseek-ai/cordis');
const { default: WebServer } = await import('@deepseek-ai/dsh-host-webserver');
const { ChatdshTelemetryService } = await import('../../packages/host/telemetry/lib/index.js');
const { defaultTelemetryConfig } = await import('../../packages/core/diagnostics/lib/config.js');
const { DECLARED_ATTRIBUTE_KEYS } = await import('../../packages/core/diagnostics/lib/redact.js');
const { BrowserTelemetry } = await import('../../packages/client/telemetry/src/client/index.ts');

/** 关闭来源在进程环境里的键。 */
const ENV_KEYS = ['CHATDSH_TELEMETRY', 'DSH_TELEMETRY_DISABLED'];

/** 等到条件成立，超时即失败。 */
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error(`等待超时：${label}（${timeoutMs}ms）`);
}

/**
 * 设置关闭来源相关的环境变量，并返回恢复函数。
 * @param {{ enabled?: string, disabled?: string }} source - 环境变量取值。
 * @returns {() => void} 恢复函数。
 */
function setEnv(source) {
  const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  if (source.enabled !== undefined) process.env.CHATDSH_TELEMETRY = source.enabled;
  if (source.disabled !== undefined) process.env.DSH_TELEMETRY_DISABLED = source.disabled;
  return () => {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/** 起一个真实的 OTLP/HTTP 接收端。 */
async function startReceiver(status = 200) {
  const records = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      records.push({ path: request.url ?? '', headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
      response.writeHead(status, { 'Content-Type': 'application/json' });
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
    payloads: (fragment) => records.filter((item) => item.path.includes(fragment)).map((item) => item.body),
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}

/**
 * 装配一套真实的宿主平面：本机 HTTP 服务与遥测出口插件。
 * @param {{ root: string, config: object }} options 数据根与遥测配置。
 * @returns {Promise<{ ctx: any, origin: string }>} 上下文与同源地址。
 */
async function openStack({ root, config }) {
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  const ctx = new Context();
  ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  await waitFor(() => ctx.webServer !== undefined, 10_000, '本机 HTTP 服务');
  // 遥测出口声明依赖 `otel` 与 `settings`；本测试不触碰这两个服务的能力。
  ctx.provide('otel');
  ctx.set('otel', {});
  ctx.provide('settings');
  ctx.set('settings', {});
  ctx.plugin(ChatdshTelemetryService, config);
  await waitFor(() => ctx.chatdshTelemetry !== undefined, 10_000, '遥测出口');
  return {
    ctx,
    origin: ctx.webServer.getOrigin(),
    async close() {
      await ctx.fiber.dispose();
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
    },
  };
}

/** 发一次真实的 HTTP 请求。 */
async function call(origin, path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.method !== undefined && options.method !== 'GET') headers['x-chatdsh-csrf'] = '1';
  const response = await fetch(`${origin}${path}`, { method: options.method ?? 'GET', headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) };
}

/** 解析接收端收到的全部 JSON 载荷。 */
function parsedPayloads(receiver, fragment) {
  return receiver.payloads(fragment).map((body) => JSON.parse(body));
}

/** 在追踪载荷里找出全部 span。 */
function spansOf(receiver) {
  const spans = [];
  for (const payload of parsedPayloads(receiver, '/v1/traces')) {
    for (const resourceSpans of payload.resourceSpans ?? []) {
      for (const scopeSpans of resourceSpans.scopeSpans ?? []) spans.push(...(scopeSpans.spans ?? []));
    }
  }
  return spans;
}

/** 在日志载荷里找出全部记录。 */
function logsOf(receiver) {
  const records = [];
  for (const payload of parsedPayloads(receiver, '/v1/logs')) {
    for (const resourceLogs of payload.resourceLogs ?? []) {
      for (const scopeLogs of resourceLogs.scopeLogs ?? []) records.push(...(scopeLogs.logRecords ?? []));
    }
  }
  return records;
}

/** 在指标载荷里找出全部指标名与属性。 */
function metricsOf(receiver) {
  const entries = [];
  for (const payload of parsedPayloads(receiver, '/v1/metrics')) {
    for (const resourceMetrics of payload.resourceMetrics ?? []) {
      for (const scopeMetrics of resourceMetrics.scopeMetrics ?? []) {
        for (const metric of scopeMetrics.metrics ?? []) entries.push(metric);
      }
    }
  }
  return entries;
}

test('动作 span、失败事件、计数与丢弃计数经真实 OTLP 接收端可查询', { timeout: 120_000 }, async () => {
  const home = allocateIndependentHome('wp37-signals');
  const root = join(home, 'runtime');
  mkdirSync(root, { recursive: true });
  const restoreEnv = setEnv({ enabled: 'on' });
  const receiver = await startReceiver();
  let stack;
  try {
    const config = defaultTelemetryConfig({
      endpoint: receiver.endpoint,
      surface: 'runtime',
      environment: 'test',
      version: '0.0.0',
      exportIntervalMs: 2000,
      exportIntervalMsMetrics: 2000,
      exportTimeoutMs: 500,
    });
    stack = await openStack({ root, config });
    const telemetry = stack.ctx.chatdshTelemetry;
    assert.equal(telemetry.enabled, true);
    assert.equal(telemetry.reason, undefined);

    const traceId = await telemetry.runSpan('chatdsh.tool.execute', { 'tool.name': 'shell' }, async (span) => {
      // 未登记键与原文都不能进入任何信号。
      span.setAttribute('tool.arguments', 'echo 机密参数');
      const childValue = await telemetry.runSpan('chatdsh.tool.sandbox', { 'policy.mode': 'workspace' }, async () => 7);
      assert.equal(childValue, 7);
      telemetry.event('chatdsh.tool.denied', { 'tool.name': 'shell', 'error.code': 'permission-denied', outcome: 'denied' });
      telemetry.counter('chatdsh_tool_calls_total', { description: '工具调用' }).add(1, { tool: 'shell', outcome: 'denied' });
      const current = telemetry.currentTraceId();
      assert.match(current, /^[0-9a-f]{32}$/);
      return current;
    });
    assert.equal(telemetry.currentTraceId(), undefined, 'span 结束后不再有活动 trace');

    await telemetry.flush(5000);

    const spans = spansOf(receiver);
    const parent = spans.find((span) => span.name === 'chatdsh.tool.execute');
    const child = spans.find((span) => span.name === 'chatdsh.tool.sandbox');
    assert.ok(parent !== undefined, `接收端收到执行 span：${receiver.records.map((item) => item.path).join(' ')}`);
    assert.ok(child !== undefined, '接收端收到子 span');
    assert.equal(parent.traceId, traceId);
    assert.equal(child.traceId, traceId, '子 span 与原 trace 相同');
    assert.equal(child.parentSpanId, parent.spanId, '子 span 以执行 span 为父');
    assert.equal(parent.status?.code, 1);
    const parentAttributeKeys = (parent.attributes ?? []).map((item) => item.key);
    assert.ok(parentAttributeKeys.includes('tool.name'), '登记过的属性保留');
    assert.equal(parentAttributeKeys.includes('tool.arguments'), false, '未登记属性被丢弃');

    const logs = logsOf(receiver);
    const denied = logs.find((record) => record.body?.stringValue === 'chatdsh.tool.denied');
    assert.ok(denied !== undefined, '失败事件以事件名作为正文');
    assert.equal(denied.traceId, traceId, '日志带同一条 trace');
    const deniedKeys = Object.fromEntries((denied.attributes ?? []).map((item) => [item.key, item.value]));
    assert.equal(deniedKeys['error.code']?.stringValue, 'permission-denied');

    const metrics = metricsOf(receiver);
    const names = metrics.map((metric) => metric.name);
    assert.ok(names.includes('chatdsh_tool_calls_total'), `计数已导出：${names.join(' ')}`);
    assert.ok(names.includes('chatdsh_telemetry_dropped_total'), '未登记属性计入丢弃计数');

    const payloads = receiver.records.map((item) => item.body).join('\n');
    assert.equal(payloads.includes('echo 机密参数'), false, '未登记属性的值没有进入接收端');
    assert.equal(payloads.includes('tool.arguments'), false, '未登记属性键没有进入接收端');
  } finally {
    if (stack !== undefined) await stack.close();
    await receiver.close();
    restoreEnv();
    releaseIndependentHome(home);
  }
});

test('状态端点、自检端点与诊断导出返回开关、队列、丢弃与脱敏事件', { timeout: 120_000 }, async () => {
  const home = allocateIndependentHome('wp37-status');
  const root = join(home, 'runtime');
  mkdirSync(root, { recursive: true });
  const restoreEnv = setEnv({ enabled: 'on' });
  const receiver = await startReceiver();
  let stack;
  try {
    const config = defaultTelemetryConfig({
      endpoint: receiver.endpoint,
      surface: 'runtime',
      environment: 'test',
      version: '0.0.0',
      exportIntervalMs: 2000,
      exportIntervalMsMetrics: 2000,
      exportTimeoutMs: 500,
    });
    stack = await openStack({ root, config });
    const telemetry = stack.ctx.chatdshTelemetry;
    telemetry.event('chatdsh.tool.completed', { 'tool.name': 'read', outcome: 'ok', 'not.registered': 'x' });
    telemetry.log('error', '文件读取失败 /home/user/secret.txt?token=abc', { outcome: 'failure' });

    const status = await call(stack.origin, '/chatdsh/telemetry/status');
    assert.equal(status.status, 200);
    assert.equal(status.body.enabled, true);
    assert.equal(status.body.reason, undefined);
    assert.equal(typeof status.body.sources, 'object');
    for (const key of ['env', 'upstream', 'settings', 'flag', 'platform']) {
      assert.equal(status.body.sources[key], false, `${key} 来源未触发关闭`);
    }
    assert.equal(typeof status.body.queueDepth, 'object');
    assert.equal(typeof status.body.dropped.total, 'number');
    assert.ok(status.body.dropped.total >= 1, '未登记属性计入丢弃总数');
    assert.equal(status.body.dropped.byReason['unregistered-attribute'] >= 1, true);

    const selfTest = await call(stack.origin, '/chatdsh/telemetry/self-test', { method: 'POST' });
    assert.equal(selfTest.status, 200);
    assert.match(selfTest.body.probeId, /^[0-9a-f-]{36}$/);

    const exported = await call(stack.origin, '/chatdsh/telemetry/diagnostics?limit=3');
    assert.equal(exported.status, 200);
    assert.ok(exported.body.events.length >= 1);
    assert.ok(exported.body.events.length <= 3, '导出条数受 limit 约束');
    for (const event of exported.body.events) {
      assert.equal(typeof event.at, 'number');
      assert.ok(['event', 'log', 'span'].includes(event.kind));
      assert.equal(typeof event.name, 'string');
    }
    const logEvent = exported.body.events.find((event) => event.kind === 'log');
    assert.ok(logEvent !== undefined, '日志事件出现在诊断导出里');
    assert.equal(logEvent.message.includes('/home/user/secret.txt'), false, '绝对路径已脱敏');
    assert.equal(logEvent.message.includes('token=abc'), false, '查询串已脱敏');
    const payloads = JSON.stringify(exported.body);
    assert.equal(payloads.includes('not.registered'), false, '未登记属性不在导出里');

    const invalidLimit = await call(stack.origin, '/chatdsh/telemetry/diagnostics?limit=9999');
    assert.equal(invalidLimit.status, 200);
    assert.ok(invalidLimit.body.events.length <= 256, '条数上限受到约束');
  } finally {
    if (stack !== undefined) await stack.close();
    await receiver.close();
    restoreEnv();
    releaseIndependentHome(home);
  }
});

test('四类关闭来源都零构造、零出网、零 trace，端点上报告原因', { timeout: 180_000 }, async () => {
  const home = allocateIndependentHome('wp37-off');
  const root = join(home, 'runtime');
  mkdirSync(root, { recursive: true });
  const receiver = await startReceiver();
  const cases = [
    { label: '环境变量', env: { enabled: 'off' }, overrides: {}, reason: 'env', source: 'env' },
    { label: '上游开关', env: { enabled: 'on', disabled: '1' }, overrides: {}, reason: 'env', source: 'upstream' },
    { label: '设置文件', env: { enabled: 'on' }, overrides: { enabled: false }, reason: 'settings', source: 'settings' },
    { label: '启动参数', env: { enabled: 'on' }, overrides: { noTelemetry: true }, reason: 'flag', source: 'flag' },
  ];
  try {
    for (const item of cases) {
      const restoreEnv = setEnv(item.env);
      let stack;
      try {
        const config = defaultTelemetryConfig({
          endpoint: receiver.endpoint,
          surface: 'runtime',
          environment: 'test',
          version: '0.0.0',
          exportIntervalMs: 500,
          exportIntervalMsMetrics: 500,
          exportTimeoutMs: 200,
          ...item.overrides,
        });
        const before = receiver.records.length;
        stack = await openStack({ root, config });
        const telemetry = stack.ctx.chatdshTelemetry;
        assert.equal(telemetry.enabled, false, `${item.label}关闭`);
        assert.equal(telemetry.reason, item.reason, `${item.label}的关闭原因`);

        const status = await call(stack.origin, '/chatdsh/telemetry/status');
        assert.equal(status.status, 200);
        assert.equal(status.body.enabled, false);
        assert.equal(status.body.reason, item.reason);
        assert.equal(status.body.sources[item.source], true, `${item.label}的来源被标记`);
        assert.equal(status.body.queueDepth.logs, 0);
        assert.equal(status.body.queueDepth.traces, 0);
        assert.equal(status.body.lastExportAt, undefined, '关闭时不创建管道');

        assert.deepEqual(telemetry.inject({ kept: 'yes' }), { kept: 'yes' }, '关闭时不注入 traceparent');
        assert.equal(telemetry.extract({ traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' }).traceparent, undefined);
        assert.equal(telemetry.runSpanSync('chatdsh.tool.execute', {}, () => telemetry.currentTraceId()), undefined, '关闭时不生成 trace');
        telemetry.event('chatdsh.tool.completed', { 'tool.name': 'read', outcome: 'ok' });
        telemetry.counter('chatdsh_tool_calls_total').add(1, { tool: 'read', outcome: 'ok' });

        const selfTest = await call(stack.origin, '/chatdsh/telemetry/self-test', { method: 'POST' });
        assert.equal(selfTest.status, 409);
        assert.equal(selfTest.body.error, 'telemetry-disabled');
        const relay = await call(stack.origin, '/chatdsh/telemetry/browser', { method: 'POST', body: { resourceLogs: [] } });
        assert.equal(relay.status, 404, `${item.label}时上报端点返回 404`);
        const diagnostics = await call(stack.origin, '/chatdsh/telemetry/diagnostics');
        assert.equal(diagnostics.status, 409);

        await new Promise((done) => setTimeout(done, 1200));
        assert.equal(receiver.records.length, before, `${item.label}关闭时没有任何出网请求`);
        await stack.close();
        stack = undefined;
      } finally {
        if (stack !== undefined) await stack.close();
        restoreEnv();
      }
    }
  } finally {
    await receiver.close();
    releaseIndependentHome(home);
  }
});

test('设置页开关与命令都不重启进程，热切换不影响当前回合', { timeout: 180_000 }, async () => {
  const home = allocateIndependentHome('wp37-hot');
  const root = join(home, 'runtime');
  mkdirSync(root, { recursive: true });
  const restoreEnv = setEnv({ enabled: 'on' });
  const receiver = await startReceiver();
  let stack;
  try {
    const config = defaultTelemetryConfig({
      endpoint: receiver.endpoint,
      surface: 'runtime',
      environment: 'test',
      version: '0.0.0',
      exportIntervalMs: 500,
      exportIntervalMsMetrics: 500,
      exportTimeoutMs: 300,
    });
    stack = await openStack({ root, config });
    const telemetry = stack.ctx.chatdshTelemetry;
    assert.equal(telemetry.enabled, true);

    // 进行中的回合：关闭发生在它结束之前。
    let releaseTurn;
    const gate = new Promise((done) => {
      releaseTurn = done;
    });
    const pendingTurn = telemetry.runSpan('chatdsh.runtime.chat.dispatch', { 'chat.backend': 'dsh' }, async () => {
      await gate;
      return 'turn-result';
    });
    await new Promise((done) => setTimeout(done, 50));

    const off = await call(stack.origin, '/chatdsh/telemetry/state', { method: 'POST', body: { enabled: false } });
    assert.equal(off.status, 200);
    assert.equal(off.body.enabled, false);
    assert.equal(off.body.reason, 'settings');
    assert.equal(off.body.sources.settings, true);
    assert.equal(telemetry.enabled, false);
    releaseTurn();
    assert.equal(await pendingTurn, 'turn-result', '关闭不影响进行中的回合结果');

    const frozen = receiver.records.length;
    telemetry.event('chatdsh.tool.completed', { 'tool.name': 'read', outcome: 'ok' });
    telemetry.counter('chatdsh_tool_calls_total').add(1, { tool: 'read', outcome: 'ok' });
    await new Promise((done) => setTimeout(done, 1200));
    assert.equal(receiver.records.length, frozen, '关闭后不再出网');

    const on = await call(stack.origin, '/chatdsh/telemetry/state', { method: 'POST', body: { enabled: true } });
    assert.equal(on.status, 200);
    assert.equal(on.body.enabled, true);
    assert.equal(on.body.reason, undefined);
    assert.equal(on.body.sources.settings, false);
    assert.equal(telemetry.enabled, true, '再次开启不重启进程');
    await telemetry.runSpan('chatdsh.tool.execute', { 'tool.name': 'read' }, async () => 'ok');
    await telemetry.flush(5000);
    const logs = logsOf(receiver);
    assert.ok(logs.some((record) => record.body?.stringValue === 'chatdsh.telemetry.enabled'), '再次开启写出开启事件');
    assert.ok(logs.some((record) => record.body?.stringValue === 'chatdsh.telemetry.disabled'), '关闭写出关闭事件');

    // 命令路径：写入设置文件后由宿主重载配置。
    const applied = telemetry.applyConfig({ ...config, enabled: false });
    await applied;
    assert.equal(telemetry.enabled, false);
    assert.equal(telemetry.reason, 'settings');
    await telemetry.applyConfig({ ...config, enabled: true });
    assert.equal(telemetry.enabled, true, '命令写回的开启同样立即生效');
  } finally {
    if (stack !== undefined) await stack.close();
    await receiver.close();
    restoreEnv();
    releaseIndependentHome(home);
  }
});

test('故意停止遥测出口时业务结果不变，失败只在遥测模块内计数', { timeout: 120_000 }, async () => {
  const home = allocateIndependentHome('wp37-outage');
  const root = join(home, 'runtime');
  mkdirSync(root, { recursive: true });
  const restoreEnv = setEnv({ enabled: 'on' });
  const receiver = await startReceiver(503);
  let stack;
  try {
    const config = defaultTelemetryConfig({
      endpoint: receiver.endpoint,
      surface: 'runtime',
      environment: 'test',
      version: '0.0.0',
      exportIntervalMs: 300,
      exportIntervalMsMetrics: 300,
      exportTimeoutMs: 300,
    });
    stack = await openStack({ root, config });
    const telemetry = stack.ctx.chatdshTelemetry;
    const result = await telemetry.runSpan('chatdsh.tool.execute', { 'tool.name': 'shell' }, async () => {
      telemetry.event('chatdsh.tool.completed', { 'tool.name': 'shell', outcome: 'ok' });
      telemetry.counter('chatdsh_tool_calls_total').add(1, { tool: 'shell', outcome: 'ok' });
      return { exitCode: 0 };
    });
    assert.deepEqual(result, { exitCode: 0 }, '出口故障时业务返回值不变');
    await telemetry.flush(2000);
    await new Promise((done) => setTimeout(done, 600));
    const status = await call(stack.origin, '/chatdsh/telemetry/status');
    assert.equal(status.status, 200);
    assert.equal(status.body.enabled, true, '出口故障不关闭遥测，只在模块内计数');
    assert.ok(status.body.recentDiagnostics.length >= 1, `导出失败记入最近诊断：${JSON.stringify(status.body.recentDiagnostics)}`);
    const failure = status.body.recentDiagnostics.at(-1);
    assert.equal(typeof failure.signal, 'string');
    assert.equal(typeof failure.at, 'number');
  } finally {
    if (stack !== undefined) await stack.close();
    await receiver.close();
    restoreEnv();
    releaseIndependentHome(home);
  }
});

test('浏览器统一客户端：同源中继、白名单、trace 注入与关闭零出网', { timeout: 120_000 }, async () => {
  const receiver = await startReceiver();
  const client = new BrowserTelemetry({
    enabled: true,
    version: '0.0.0',
    environment: 'test',
    fetchImpl: (url, init) => fetch(`${receiver.endpoint}${url}`, init),
  });
  try {
    const traceId = client.runSpanSync(
      'chatdsh.client.command.run',
      { 'command.id': 'settings.save', 'prompt.text': '机密提示词' },
      (span) => {
        span.setAttribute('file.content', '机密文件内容');
        const carrier = client.inject({ kept: 'yes' });
        assert.equal(carrier.kept, 'yes');
        assert.match(carrier.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
        client.event('chatdsh.client.ui.action', { action: 'settings-save', outcome: 'ok' });
        client.counter('chatdsh_client_command_runs_total', { description: '命令执行' }).add(1, { outcome: 'ok' });
        return carrier.traceparent.split('-')[1];
      },
    );
    await client.flush(5000);

    const signals = receiver.records.map((item) => item.headers['x-chatdsh-signal']);
    for (const signal of ['logs', 'traces', 'metrics']) assert.ok(signals.includes(signal), `中继收到 ${signal}`);
    for (const record of receiver.records) assert.equal(record.headers['x-chatdsh-csrf'], '1');

    const traceBodies = receiver.records
      .filter((item) => item.headers['x-chatdsh-signal'] === 'traces')
      .map((item) => JSON.parse(item.body));
    const spans = traceBodies.flatMap((payload) => payload.resourceSpans ?? []).flatMap((resourceSpans) => resourceSpans.scopeSpans ?? []).flatMap((scopeSpans) => scopeSpans.spans ?? []);
    const span = spans.find((item) => item.name === 'chatdsh.client.command.run');
    assert.ok(span !== undefined, '浏览器侧 span 进入中继载荷');
    assert.equal(span.traceId, traceId);

    const payloads = receiver.records.map((item) => item.body).join('\n');
    assert.equal(payloads.includes('机密提示词'), false, '未登记属性的值没有进入载荷');
    assert.equal(payloads.includes('prompt.text'), false, '未登记属性键没有进入载荷');
    assert.equal(payloads.includes('机密文件内容'), false, 'setAttribute 追加的未登记键没有进入载荷');
    assert.equal(payloads.includes('chatdsh-browser'), true, '载荷自带服务名');

    client.setEnabled(false, 'settings');
    assert.equal(client.enabled, false);
    assert.equal(client.reason, 'settings');
    const frozen = receiver.records.length;
    assert.deepEqual(client.inject({ kept: 'yes' }), { kept: 'yes' }, '关闭时不注入 traceparent');
    assert.equal(client.currentTraceId(), undefined);
    client.event('chatdsh.client.ui.action', { action: 'settings-save', outcome: 'ok' });
    client.counter('chatdsh_client_command_runs_total', { description: '命令执行' }).add(1, { outcome: 'ok' });
    await client.flush(1000);
    assert.equal(receiver.records.length, frozen, '关闭后浏览器侧零出网');
  } finally {
    await client.shutdown();
    await receiver.close();
  }
});

/** 递归收集源文件，跳过构建产物与依赖目录。 */
async function collectSources(dir, out = []) {
  const { readdirSync } = await import('node:fs');
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'lib', 'dist', 'build', 'android', '.dsh-deps', '.run', '.verify'].includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await collectSources(full, out);
    else if (/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|kt|java)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('遥测名称三处一致：清单覆盖源码，声明落在清单，属性键落在白名单', { timeout: 120_000 }, async () => {
  const { readdirSync } = await import('node:fs');
  const doc = readFileSync(join(RUNTIME, 'docs', 'telemetry.md'), 'utf8');
  const roots = ['packages', 'gateway', 'desktop', 'mobile/overlay'].map((item) => join(RUNTIME, item));
  const files = [];
  for (const root of roots) await collectSources(root, files);

  const events = new Set();
  const metrics = new Set();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\bchatdsh\.[a-z0-9]+(?:\.[a-z0-9]+)+\b/g)) events.add(match[0]);
    for (const match of text.matchAll(/\bchatdsh_[a-z0-9_]+\b/g)) metrics.add(match[0]);
  }

  // 资源属性键不是信号名；这三段是控制平面 SQL 里的自定义函数名。
  const ignored = new Set([
    'chatdsh.surface',
    'chatdsh.component',
    'chatdsh.instance.id',
    'chatdsh.version',
    'chatdsh_cwd_tail',
    'chatdsh_casefold',
    'chatdsh_identifier_digest',
  ]);
  const missing = [];
  // 清单里的模板行（例如 `chatdsh.desktop.startup.<stage>`）覆盖同前缀的全部实例。
  const templates = [...doc.matchAll(/`(chatdsh\.[a-z0-9.]+\.)<[a-z]+>`/g)].map((match) => match[1]);
  for (const name of [...events].sort()) {
    if (ignored.has(name)) continue;
    if (doc.includes(`\`${name}\``)) continue;
    if (doc.includes(`\`${name}.`)) continue;
    if (templates.some((prefix) => name.startsWith(prefix))) continue;
    missing.push(name);
  }
  for (const name of [...metrics].sort()) {
    if (ignored.has(name)) continue;
    if (doc.includes(`\`${name}\``)) continue;
    missing.push(name);
  }
  assert.deepEqual(missing, [], `源码里的信号没有登记：${missing.join(' ')}`);

  // 文档第六节的属性列必须全部落在脱敏白名单里。
  const attributeKeys = new Set();
  for (const line of doc.split('\n')) {
    const match = line.match(/^\| (span|event|metric) \| `[a-z0-9_.]+` \|.*\| (.+) \|\s*$/);
    if (match === null) continue;
    for (const item of match[2].matchAll(/`([\w.]+)`/g)) attributeKeys.add(item[1]);
  }
  const undeclared = [...attributeKeys].filter((key) => !DECLARED_ATTRIBUTE_KEYS.has(key));
  assert.deepEqual(undeclared, [], `文档登记的属性键不在白名单：${undeclared.join(' ')}`);

  // 每个声明了遥测面的包：声明必须同时落在源码与文档里，控制平面与桌面也不例外。
  const manifests = [];
  for (const root of roots) {
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', 'lib', 'dist', 'build', 'android', '.dsh-deps', '.run'].includes(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name === 'package.json') manifests.push(full);
      }
    };
    walk(root);
  }
  const problems = [];
  for (const manifestPath of manifests) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const declared = manifest.chatdsh?.telemetry;
    if (declared === undefined) continue;
    const dir = resolve(manifestPath, '..');
    const sources = [];
    await collectSources(dir, sources);
    const text = sources.map((file) => readFileSync(file, 'utf8')).join('\n');
    for (const group of ['events', 'spans', 'metrics']) {
      for (const name of declared[group] ?? []) {
        const template = templates.find((prefix) => name.startsWith(prefix));
        if (!doc.includes(`\`${name}\``) && template === undefined) {
          problems.push(`${manifest.name} 声明了 ${name}，清单里没有`);
        }
        if (!text.includes(name) && (template === undefined || !text.includes(template))) {
          problems.push(`${manifest.name} 声明了 ${name}，源码里没有`);
        }
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});
