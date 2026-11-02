// 主题切换遥测的浏览器测试。
//
// 页面由测试自己的 HTTP 服务提供，里面加载的是主题插件源码打包出来的产物；插件按同源相对
// 路径向 `/chatdsh/telemetry/browser` 发 OTLP 载荷，因此请求真实走网络落到本测试的接收端，
// 接收端按请求头 `x-chatdsh-signal` 记录日志、span 与计数器。页面由真实 Chrome 通过
// agent-browser CLI 驱动，浏览器使用独立的 session、HOME、TMPDIR 与 profile 目录。
//
// 断言四件事：没有切换时不发切换记录；切换后收到 action="theme-switch" 的日志与配套 span、
// 计数器，属性键全部落在 `docs/telemetry.md` 第六节的登记里；只改字号不算切换；中继拒绝时
// 切换依然生效且页面没有未捕获错误。
//
// 运行：node --test e2e/unit/client-complete-wp02-theme-telemetry.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';

const execute = promisify(execFile);

const ROOT = resolve(import.meta.dirname, '..', '..');
const RELAY_PATH = '/chatdsh/telemetry/browser';
const SESSION = `tt-${process.pid}`;
const CHROME = '/usr/bin/google-chrome';
const UPSTREAM_DECLARATION = join(
  ROOT,
  '.dsh-deps',
  '@deepseek-ai',
  'dsh-client-ui-theme',
  'lib',
  'types',
  'client',
  'index.d.ts',
);

/** 从 PATH 里找 agent-browser 可执行文件。 */
function resolveCli() {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir === '') continue;
    const candidate = join(dir, 'agent-browser');
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** 把一条 OTLP 属性列表摊平成对象。 */
function attributesOf(item) {
  return Object.fromEntries((item.attributes ?? []).map((entry) => [entry.key, entry.value.stringValue]));
}

/** 读出 `docs/telemetry.md` 第六节登记的信号名与属性键。 */
function readRegisteredSignals() {
  const text = readFileSync(join(ROOT, 'docs', 'telemetry.md'), 'utf8');
  const signals = new Map();
  for (const line of text.split('\n')) {
    const match = line.match(/^\| (span|event|metric) \| `([a-z0-9_.]+)` \|.*\| (.+) \|\s*$/);
    if (match === null) continue;
    signals.set(match[2], {
      kind: match[1],
      attributes: [...match[3].matchAll(/`([\w.]+)`/g)].map((item) => item[1]),
    });
  }
  return signals;
}

test('真实 Chrome 里切换主题产生登记的遥测信号', { timeout: 240_000 }, async (ctx) => {
  const cli = resolveCli();
  const missing = [
    ...(cli === undefined ? ['agent-browser 可执行文件'] : []),
    ...(existsSync(CHROME) ? [] : [CHROME]),
  ];
  if (missing.length > 0) {
    ctx.skip(`本机缺少 ${missing.join(' 与 ')}，主题切换遥测测试未执行`);
    return;
  }

  const home = allocateIndependentHome('wp02-theme-telemetry');
  const tmp = join(home, 'tmp');
  const profile = join(home, 'profile');
  const socket = join(home, 's');
  for (const dir of [tmp, profile, socket]) mkdirSync(dir, { recursive: true });

  /** 固定环境：浏览器与全部 CLI 调用共用同一份 HOME、TMPDIR 与 session。 */
  const env = {
    ...process.env,
    HOME: home,
    TMPDIR: tmp,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    AGENT_BROWSER_SESSION: SESSION,
    AGENT_BROWSER_SOCKET_DIR: socket,
  };

  /** 按固定环境执行一条 CLI；用异步执行，测试自己的 HTTP 服务才能在浏览器导航期间应答。 */
  async function runCli(args) {
    const result = await execute(cli, ['--profile', profile, '--executable-path', CHROME, ...args], {
      env,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    return result.stdout;
  }

  /** 页面里求值一个表达式，返回反序列化后的取值。 */
  async function evaluate(expression) {
    return JSON.parse(JSON.parse((await runCli(['eval', `JSON.stringify(${expression})`])).trim()));
  }

  // 插件订阅的事件名与切换入口必须与上游声明一致，否则页面上装配的一层就与真实上游脱节。
  const declaration = readFileSync(UPSTREAM_DECLARATION, 'utf8');
  assert.match(
    declaration,
    /'theme\/change'\(snapshot: ThemeSnapshot\): void;/,
    '上游主题服务没有声明 theme/change 事件',
  );
  assert.match(declaration, /setTheme\(id: string\): void;/, '上游主题服务没有声明 setTheme');

  const registered = readRegisteredSignals();
  const actionRow = registered.get('chatdsh.client.ui.action');
  assert.ok(actionRow !== undefined, 'docs/telemetry.md 没有登记 chatdsh.client.ui.action');
  assert.equal(actionRow.kind, 'event');
  const switchSpanRow = registered.get('chatdsh.theme.switch');
  assert.ok(switchSpanRow !== undefined, 'docs/telemetry.md 没有登记 chatdsh.theme.switch');
  assert.equal(switchSpanRow.kind, 'span');
  const switchMetricRow = registered.get('chatdsh_theme_switch_total');
  assert.ok(switchMetricRow !== undefined, 'docs/telemetry.md 没有登记 chatdsh_theme_switch_total');
  assert.equal(switchMetricRow.kind, 'metric');

  const manifest = JSON.parse(readFileSync(join(ROOT, 'packages/client/theme/package.json'), 'utf8'));
  assert.deepEqual(
    manifest.chatdsh.telemetry,
    {
      events: ['chatdsh.client.ui.action'],
      spans: ['chatdsh.theme.switch'],
      metrics: ['chatdsh_theme_switch_total'],
    },
    '主题插件的遥测声明与登记不一致',
  );

  const bundle = await build({
    entryPoints: [join(ROOT, 'e2e/unit/client-complete-wp02-theme-telemetry-harness.ts')],
    write: false,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    jsx: 'automatic',
    loader: { '.css': 'text' },
    alias: { '@chatdsh/core-ui-kit': join(ROOT, 'packages/core/ui-kit/src/index.ts') },
    logLevel: 'silent',
  });

  const page = [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head><meta charset="utf-8"><title>主题切换遥测测试</title></head>',
    '<body><main id="main">主题切换遥测测试</main>',
    '<script>',
    'window.__errors = [];',
    'addEventListener("error", (event) => window.__errors.push(String(event.message)));',
    'addEventListener("unhandledrejection", (event) => window.__errors.push(String(event.reason)));',
    '</script>',
    '<script src="/harness.js"></script>',
    '</body>',
    '</html>',
    '',
  ].join('\n');

  const received = [];
  let rejectRelay = false;
  const server = createServer((request, response) => {
    if (request.method === 'POST' && request.url === RELAY_PATH) {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        received.push({
          signal: request.headers['x-chatdsh-signal'],
          csrf: request.headers['x-chatdsh-csrf'],
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        });
        response.writeHead(rejectRelay ? 503 : 200, { 'Content-Type': 'application/json' });
        response.end(rejectRelay ? '{"accepted":false}' : '{"accepted":true}');
      });
      return;
    }
    if (request.url === '/harness.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      response.end(bundle.outputFiles[0].text);
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(page);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;

  /** 等接收端满足条件。 */
  async function waitFor(predicate, timeoutMs = 8_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await delay(100);
    }
    return predicate();
  }

  /** 全部日志记录。 */
  function logRecords() {
    const records = [];
    for (const entry of received) {
      if (entry.signal !== 'logs') continue;
      for (const resourceLog of entry.body.resourceLogs ?? []) {
        for (const scopeLog of resourceLog.scopeLogs ?? []) {
          for (const record of scopeLog.logRecords ?? []) {
            records.push({ resource: resourceLog.resource, scope: scopeLog.scope, record });
          }
        }
      }
    }
    return records;
  }

  /** 界面动作记录里 action 取给定值的那几条。 */
  function actionsOf(action) {
    return logRecords()
      .filter((item) => item.record.body?.stringValue === 'chatdsh.client.ui.action')
      .filter((item) => attributesOf(item.record).action === action)
      .map((item) => ({ ...item, attributes: attributesOf(item.record) }));
  }

  /** 全部 span。 */
  function spans() {
    const list = [];
    for (const entry of received) {
      if (entry.signal !== 'traces') continue;
      for (const resourceSpan of entry.body.resourceSpans ?? []) {
        for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
          for (const span of scopeSpan.spans ?? []) {
            list.push({ resource: resourceSpan.resource, scope: scopeSpan.scope, span });
          }
        }
      }
    }
    return list;
  }

  /** 全部指标。 */
  function metrics() {
    const list = [];
    for (const entry of received) {
      if (entry.signal !== 'metrics') continue;
      for (const resourceMetric of entry.body.resourceMetrics ?? []) {
        for (const scopeMetric of resourceMetric.scopeMetrics ?? []) {
          for (const metric of scopeMetric.metrics ?? []) {
            list.push({ resource: resourceMetric.resource, scope: scopeMetric.scope, metric });
          }
        }
      }
    }
    return list;
  }

  let opened = false;
  try {
    await ctx.test('页面加载插件并上报安装动作，此时没有切换记录', async () => {
      const output = await runCli(['open', `${origin}/`]);
      opened = true;
      assert.match(output, /主题切换遥测测试/, '页面没有按标题打开');
      const installed = await evaluate('({ install: typeof window.__chatdshTheme.switchTo, current: window.__chatdshTheme.current() })');
      assert.equal(installed.install, 'function');
      assert.equal(installed.current.id, 'light', '安装不应改动用户当前配色偏好');

      const arrived = await waitFor(() => actionsOf('theme-install').length > 0);
      assert.equal(arrived, true, '安装动作没有到达中继');
      const install = actionsOf('theme-install')[0];
      assert.deepEqual(install.attributes, { action: 'theme-install', outcome: 'ok' });
      assert.equal(install.scope.name, '@chatdsh/client-theme');
      const resourceAttributes = attributesOf(install.resource);
      assert.equal(resourceAttributes['service.name'], 'chatdsh-browser');
      assert.equal(resourceAttributes['chatdsh.surface'], 'browser');
      assert.equal(resourceAttributes['chatdsh.component'], '@chatdsh/client-theme');
      assert.equal(received[0].csrf, '1', '中继请求缺少来源校验头');

      assert.deepEqual(actionsOf('theme-switch'), [], '没有切换时不应上报切换记录');
      assert.deepEqual(spans(), [], '没有切换时不应上报 span');
      assert.deepEqual(metrics(), [], '没有切换时不应上报计数器');
    });

    await ctx.test('切换配色后收到切换日志、span 与计数器', async () => {
      const before = await evaluate('window.__chatdshTheme.current()');
      const switched = await evaluate('window.__chatdshTheme.switchTo("chatdsh")');
      assert.equal(switched.id, 'chatdsh');
      assert.equal(switched.colorScheme, 'dark');
      assert.equal(switched.revision, before.revision + 1, '切换应发布一次新快照');

      const arrived = await waitFor(() => actionsOf('theme-switch').length > 0 && spans().length > 0 && metrics().length > 0);
      assert.equal(arrived, true, '切换后没有收到完整的三类信号');

      const switches = actionsOf('theme-switch');
      assert.equal(switches.length, 1, '一次切换只应上报一条日志');
      assert.deepEqual(switches[0].attributes, {
        action: 'theme-switch',
        outcome: 'ok',
        'theme.id': 'chatdsh',
        'previous.id': 'light',
        color_scheme: 'dark',
      });
      for (const key of Object.keys(switches[0].attributes)) {
        assert.ok(actionRow.attributes.includes(key), `属性键 ${key} 没有登记在 chatdsh.client.ui.action 一行`);
      }
      assert.equal(switches[0].record.severityText, 'INFO');

      const switchSpans = spans().filter((item) => item.span.name === 'chatdsh.theme.switch');
      assert.equal(switchSpans.length, 1);
      const spanAttributes = attributesOf(switchSpans[0].span);
      assert.equal(spanAttributes['theme.id'], 'chatdsh');
      assert.equal(spanAttributes['previous.id'], 'light');
      assert.equal(spanAttributes['color_scheme'], 'dark');
      assert.equal(spanAttributes.outcome, 'ok');
      assert.equal(Number.isFinite(Number(spanAttributes.duration)), true, 'span 应记录耗时');
      assert.equal(switchSpans[0].span.status.code, 1);
      assert.match(switchSpans[0].span.traceId, /^[0-9a-f]{32}$/);
      assert.match(switchSpans[0].span.spanId, /^[0-9a-f]{16}$/);
      assert.equal(switchSpans[0].scope.name, '@chatdsh/client-theme');
      for (const key of Object.keys(spanAttributes)) {
        assert.ok(switchSpanRow.attributes.includes(key), `span 属性 ${key} 没有登记在 chatdsh.theme.switch 一行`);
      }

      const switchMetrics = metrics().filter((item) => item.metric.name === 'chatdsh_theme_switch_total');
      assert.equal(switchMetrics.length, 1);
      const sum = switchMetrics[0].metric.sum;
      assert.equal(sum.isMonotonic, true);
      assert.equal(sum.aggregationTemporality, 1);
      assert.equal(sum.dataPoints.length, 1);
      assert.equal(sum.dataPoints[0].asDouble, 1);
      const pointAttributes = attributesOf(sum.dataPoints[0]);
      assert.equal(pointAttributes.theme_id, 'chatdsh');
      assert.equal(pointAttributes.previous_id, 'light');
      assert.equal(pointAttributes.color_scheme, 'dark');
      for (const key of Object.keys(pointAttributes)) {
        assert.ok(switchMetricRow.attributes.includes(key), `指标属性 ${key} 没有登记在 chatdsh_theme_switch_total 一行`);
      }
    });

    await ctx.test('只改字号时快照变更但不算切换', async () => {
      const before = actionsOf('theme-switch').length;
      const revision = (await evaluate('window.__chatdshTheme.current()')).revision;
      const tapped = await evaluate('window.__chatdshTheme.tapFontSize(16)');
      assert.equal(tapped.revision, revision + 1, '字号变化应发布新快照');
      assert.equal(tapped.id, 'chatdsh', '生效主题不随字号变化');

      await delay(1_000);
      assert.equal(actionsOf('theme-switch').length, before, '字号变化不应上报切换记录');
      assert.equal(spans().filter((item) => item.span.name === 'chatdsh.theme.switch').length, 1);
    });

    await ctx.test('中继拒绝时切换仍然生效且页面没有未捕获错误', async () => {
      rejectRelay = true;
      const before = received.length;
      const revision = (await evaluate('window.__chatdshTheme.current()')).revision;
      const switched = await evaluate('window.__chatdshTheme.switchTo("light")');
      assert.equal(switched.id, 'light');
      assert.equal(switched.colorScheme, 'light');
      assert.equal(switched.revision, revision + 1);

      const delivered = await waitFor(() => received.length >= before + 1);
      assert.equal(delivered, true, '中继拒绝时请求仍应发出');
      await delay(500);
      const after = await evaluate('({ id: window.__chatdshTheme.current().id, errors: window.__errors })');
      assert.equal(after.id, 'light', '切换应已生效');
      assert.deepEqual(after.errors, [], '中继拒绝不应在页面留下未捕获错误');
      rejectRelay = false;
    });
  } finally {
    if (opened) await runCli(['close']);
    await new Promise((settle) => server.close(settle));
    releaseIndependentHome(home);
  }
});
