// WP06 的真实浏览器验收：两个真实页面间的导航往返、超时重试与跨源拒绝。
//
// 页面把包里已编译的真实模块用 esbuild 打成一个浏览器可用的 ESM 文件，由本机真实 HTTP 服务
// 提供：宿主页与内容页各是一个真实文档，消息经真实 `postMessage` 跨窗口投递；恶意页面来自
// 另一个真实来源，用来验证 `origin` 与来源窗口的拒绝。浏览器是 agent-browser 独立会话里的
// 真实 Chrome，使用独立 HOME、TMPDIR 与 profile，不截图，断言全部来自页面里记录的结论、
// 同源 iframe 的真实 DOM 与本机收到的遥测请求。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { build } from 'esbuild';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';

const execute = promisify(execFile);
const NODE_BIN = '/usr/local/nvm/versions/node/v24.19.0/bin';
const AGENT_BROWSER = `${NODE_BIN}/agent-browser`;
const PACKAGE_ENTRY = new URL('../../packages/client/session-bridge/lib/index.js', import.meta.url);

/** 宿主页：按顺序跑完五组场景，把结论写进 `window.__report`。 */
const HOST_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>导航桥宿主页</title></head>
<body>
<main id="host"></main>
<script type="module">
import { NavigationHost, createNavigationTelemetry, randomHex } from '/session-bridge.js';

const REPORT = { done: false, steps: [], errors: [] };
window.__report = REPORT;
window.addEventListener('error', (event) => REPORT.errors.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) => REPORT.errors.push(String(event.reason)));

const telemetry = createNavigationTelemetry({ fetchImpl: fetch, randomHex, now: () => Date.now() });
const DEVICE = 'device-alpha';
const crossOrigin = new URLSearchParams(location.search).get('cross') ?? '';

function remember(name, value) {
  REPORT.steps.push({ name, value });
}

async function addFrame(src) {
  const frame = document.createElement('iframe');
  frame.title = src;
  frame.src = src;
  document.querySelector('#host').append(frame);
  await new Promise((resolve) => frame.addEventListener('load', () => resolve(), { once: true }));
  frame.dataset.loaded = 'true';
  return frame;
}

function readContent(frame) {
  const doc = frame.contentDocument;
  return {
    opened: doc.querySelector('#opened').textContent,
    selected: doc.querySelector('#selected').textContent,
    state: doc.querySelector('#state').textContent,
    rejections: doc.querySelector('#rejections').textContent,
    navigations: doc.querySelector('#navigations').textContent,
  };
}

function contentUrl(query) {
  return '/content.html?' + query;
}

try {
  // 一：真实往返。内容页与宿主同源，宿主直接读它的真实 DOM 核对；内容页另外嵌套两个恶意页，
  // 分别来自宿主来源与第三方来源，用来验证内容端对来源窗口与 origin 的拒绝。
  {
    const nested = JSON.stringify(['/rogue-nested.html', crossOrigin + '/rogue-nested.html']);
    const frame = await addFrame(contentUrl('mode=full&nested=' + encodeURIComponent(nested)));
    const host = new NavigationHost({ window, frame, deviceId: DEVICE, telemetry, timeoutMs: 2000, attempts: 2 });
    const handshake = await host.handshake();
    const outcome = await host.select('session-alpha');
    await new Promise((resolve) => setTimeout(resolve, 120));
    remember('roundtrip', {
      handshake,
      outcome,
      content: readContent(frame),
      hostState: host.contentState,
      hostSession: host.selectedSessionId,
      capabilities: host.capabilities,
      rejections: host.rejections(),
    });
    host.dispose();
  }

  // 二：内容端不回应，宿主按有限次数重试后明确失败。
  {
    const frame = await addFrame(contentUrl('mode=silent'));
    const host = new NavigationHost({ window, frame, deviceId: DEVICE, telemetry, timeoutMs: 180, attempts: 2 });
    const startedAt = Date.now();
    const outcome = await host.select('session-silent');
    remember('timeout', { outcome, elapsed: Date.now() - startedAt, content: readContent(frame) });
    host.dispose();
  }

  // 三：同源的另一个窗口伪造回执，来源窗口不符被丢弃。
  {
    const frame = await addFrame(contentUrl('mode=silent'));
    const host = new NavigationHost({
      window, frame, deviceId: DEVICE, telemetry, timeoutMs: 220, attempts: 1,
      createRequestId: () => 'fixed-request',
    });
    await addFrame('/rogue.html?requestId=fixed-request&sessionId=session-alpha');
    const outcome = await host.select('session-alpha');
    remember('sourceMismatch', { outcome, rejections: host.rejections() });
    host.dispose();
  }

  // 四：跨源窗口伪造回执，来源被拒绝。
  {
    const frame = await addFrame(contentUrl('mode=silent'));
    const host = new NavigationHost({
      window, frame, deviceId: DEVICE, telemetry, timeoutMs: 220, attempts: 1,
      createRequestId: () => 'fixed-request',
    });
    await addFrame(crossOrigin + '/rogue.html?requestId=fixed-request&sessionId=session-alpha');
    const outcome = await host.select('session-alpha');
    remember('crossOrigin', { outcome, rejections: host.rejections() });
    host.dispose();
  }

  // 五：只读与离线状态下发，导航仍可打开会话查看内容。
  {
    const frame = await addFrame(contentUrl('mode=full'));
    const host = new NavigationHost({
      window, frame, deviceId: DEVICE, telemetry, timeoutMs: 2000, attempts: 2, state: 'offline',
    });
    const handshake = await host.handshake();
    const outcome = await host.select('session-beta');
    await new Promise((resolve) => setTimeout(resolve, 60));
    remember('offline', { handshake, outcome, content: readContent(frame), hostState: host.contentState });
    host.dispose();
  }
} catch (error) {
  REPORT.errors.push(String(error && error.stack ? error.stack : error));
}
REPORT.done = true;
</script>
</body></html>
`;

/** 内容页：`mode=silent` 只统计导航消息不回应，其余模式创建真实内容端并嵌套恶意页。 */
const CONTENT_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>设备内容页</title></head>
<body>
<p id="opened"></p>
<p id="selected"></p>
<p id="state"></p>
<p id="rejections"></p>
<p id="navigations"></p>
<script type="module">
import { NavigationContent, createNavigationTelemetry, randomHex } from '/session-bridge.js';

const params = new URLSearchParams(location.search);
const mode = params.get('mode') ?? 'full';
const opened = document.querySelector('#opened');
const selected = document.querySelector('#selected');
const state = document.querySelector('#state');
const rejections = document.querySelector('#rejections');
const navigations = document.querySelector('#navigations');

if (mode === 'silent') {
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (data !== null && typeof data === 'object' && data.action === 'navigate') {
      navigations.textContent = String(Number(navigations.textContent || '0') + 1);
    }
  });
} else {
  const telemetry = createNavigationTelemetry({ fetchImpl: fetch, randomHex, now: () => Date.now() });
  let current;
  const content = new NavigationContent({
    window,
    parent: window.parent,
    deviceId: 'device-alpha',
    telemetry,
    hostOrigin: location.origin,
    openSession: async (sessionId) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      current = sessionId;
      opened.textContent = opened.textContent === '' ? sessionId : opened.textContent + ',' + sessionId;
      selected.textContent = sessionId;
      return { sessionId, title: '会话 ' + sessionId };
    },
    currentSession: () => current,
  });
  window.__content = content;
  setInterval(() => {
    state.textContent = content.state;
    rejections.textContent = content.rejections().map((item) => item.code).join(',');
  }, 20);
  for (const src of JSON.parse(params.get('nested') ?? '[]')) {
    const frame = document.createElement('iframe');
    frame.src = src;
    document.body.append(frame);
  }
}
</script>
</body></html>
`;

/** 恶意页：向父窗口投递一条伪造的选中回执。 */
const ROGUE_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>伪造回执</title></head>
<body>
<script>
const params = new URLSearchParams(location.search);
const forged = {
  outcome: 'selected',
  version: 1,
  requestId: params.get('requestId') ?? 'fixed-request',
  deviceId: params.get('deviceId') ?? 'device-alpha',
  sessionId: params.get('sessionId') ?? 'session-alpha',
  title: '伪造会话',
};
setTimeout(() => { window.parent.postMessage(forged, '*'); }, 0);
</script>
</body></html>
`;

/** 恶意页：向父窗口投递一条导航请求，用来验证内容端对来源的拒绝。 */
const ROGUE_NESTED_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>伪造导航</title></head>
<body>
<script>
setTimeout(() => {
  window.parent.postMessage({
    action: 'navigate',
    version: 1,
    requestId: 'rogue-request',
    deviceId: 'device-alpha',
    sessionId: 'session-rogue',
  }, '*');
}, 0);
</script>
</body></html>
`;

/**
 * 起一个真实 HTTP 服务，记录遥测上报。
 * @param bundle - 打包后的桥模块。
 * @returns 服务句柄。
 */
async function startServer(bundle) {
  const telemetry = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const url = new URL(request.url, 'http://local.invalid');
    if (url.pathname === '/chatdsh/telemetry/browser') {
      telemetry.push({
        signal: request.headers['x-chatdsh-signal'],
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"accepted":true}');
      return;
    }
    if (url.pathname === '/session-bridge.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      response.end(bundle);
      return;
    }
    const pages = {
      '/host.html': HOST_PAGE,
      '/content.html': CONTENT_PAGE,
      '/rogue.html': ROGUE_PAGE,
      '/rogue-nested.html': ROGUE_NESTED_PAGE,
    };
    const page = pages[url.pathname];
    if (page === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    telemetry,
    port: server.address().port,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** 把 OTLP 属性数组摊平成对象。 */
function attributesOf(attributes) {
  const out = {};
  for (const attribute of attributes ?? []) out[attribute.key] = attribute.value.stringValue ?? attribute.value.intValue;
  return out;
}

/** 取上报里的 span。 */
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

/** 取上报里的日志记录。 */
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

/** 取上报里的计数指标数据点。 */
function metricPointsOf(requests) {
  const out = [];
  for (const request of requests) {
    if (request.signal !== 'metrics') continue;
    for (const resource of request.body.resourceMetrics ?? []) {
      for (const scope of resource.scopeMetrics ?? []) {
        for (const metric of scope.metrics ?? []) {
          for (const point of metric.sum?.dataPoints ?? []) {
            out.push({ name: metric.name, attributes: attributesOf(point.attributes) });
          }
        }
      }
    }
  }
  return out;
}

test('真实 Chrome：两个真实页面的导航往返、超时重试与跨源拒绝', { timeout: 300000 }, async (t) => {
  const home = allocateIndependentHome('wp06-browser');
  const session = `wp06-${randomUUID().slice(0, 8)}`;
  const env = {
    ...process.env,
    TMPDIR: home,
    HOME: home,
    AGENT_BROWSER_SESSION: session,
    AGENT_BROWSER_EXECUTABLE_PATH: '/usr/bin/google-chrome',
    AGENT_BROWSER_PROFILE: join(home, 'chrome'),
    AGENT_BROWSER_ARGS: '--no-sandbox',
  };
  const cli = async (...args) => {
    const result = await execute(AGENT_BROWSER, ['--session', session, '--json', ...args], {
      env,
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const response = JSON.parse(result.stdout);
    assert.equal(response.success, true, `agent-browser ${args[0]}：${result.stdout}`);
    return response;
  };

  const bundle = await build({
    entryPoints: [PACKAGE_ENTRY.pathname],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2023',
    write: false,
    logLevel: 'silent',
  });
  const bundleText = bundle.outputFiles[0].text;
  const server = await startServer(bundleText);
  const crossServer = await startServer(bundleText);
  const origin = `http://127.0.0.1:${server.port}`;
  const crossOrigin = `http://127.0.0.1:${crossServer.port}`;
  let opened = false;
  try {
    await cli('open', `${origin}/host.html?cross=${encodeURIComponent(crossOrigin)}`);
    opened = true;
    await cli('wait', '--fn', 'window.__report && window.__report.done === true');
    const report = JSON.parse((await cli('eval', 'JSON.stringify(window.__report)')).data.result);
    assert.deepEqual(report.errors, []);

    const step = (name) => {
      const found = report.steps.find((item) => item.name === name);
      assert.ok(found !== undefined, `缺少场景 ${name}`);
      return found.value;
    };

    const roundtrip = step('roundtrip');
    assert.equal(roundtrip.handshake.ok, true);
    assert.equal(roundtrip.handshake.ready.deviceId, 'device-alpha');
    assert.equal(roundtrip.outcome.outcome, 'selected');
    assert.equal(roundtrip.outcome.sessionId, 'session-alpha');
    assert.equal(roundtrip.outcome.title, '会话 session-alpha');
    assert.equal(roundtrip.content.opened, 'session-alpha');
    assert.equal(roundtrip.content.selected, 'session-alpha');
    assert.equal(roundtrip.hostSession, 'session-alpha');
    assert.equal(roundtrip.hostState, 'writable');
    assert.deepEqual(roundtrip.capabilities, ['open-session', 'report-selection', 'readonly-mode', 'offline-mode']);
    // 内容端丢弃了同源其他窗口与第三方来源的导航消息，只打开被请求的那一条。
    assert.match(roundtrip.content.rejections, /message-source-mismatch/);
    assert.match(roundtrip.content.rejections, /origin-rejected/);

    const timeout = step('timeout');
    assert.equal(timeout.outcome.outcome, 'timeout');
    assert.equal(timeout.outcome.code, 'navigation-timeout');
    assert.equal(timeout.outcome.attempts, 2);
    assert.equal(timeout.content.navigations, '2');
    assert.ok(timeout.elapsed >= 180, `等待 ${timeout.elapsed} 毫秒`);

    const sourceMismatch = step('sourceMismatch');
    assert.equal(sourceMismatch.outcome.outcome, 'timeout');
    assert.ok(
      sourceMismatch.rejections.some((item) => item.code === 'message-source-mismatch'),
      JSON.stringify(sourceMismatch.rejections),
    );

    const crossOriginStep = step('crossOrigin');
    assert.equal(crossOriginStep.outcome.outcome, 'timeout');
    assert.ok(
      crossOriginStep.rejections.some((item) => item.code === 'origin-rejected'),
      JSON.stringify(crossOriginStep.rejections),
    );

    const offline = step('offline');
    assert.equal(offline.handshake.ok, true);
    assert.equal(offline.handshake.ready.state, 'offline');
    assert.equal(offline.hostState, 'offline');
    assert.equal(offline.content.state, 'offline');
    assert.equal(offline.outcome.outcome, 'selected');
    assert.equal(offline.content.opened, 'session-beta');

    const errors = await cli('errors');
    assert.deepEqual(errors.data.errors, []);

    // 一个页面里的全部遥测都走真实同源中继，这里核对载荷。
    const spans = spansOf(server.telemetry).filter((item) => item.name === 'chatdsh.client.navigate');
    assert.ok(spans.length >= 3, JSON.stringify(spans));
    const selectedSpan = spans.find((item) => item.attributes['outcome'] === 'selected');
    assert.equal(selectedSpan.attributes['deviceId'], 'device-alpha');
    assert.equal(selectedSpan.attributes['session.id'], 'session-alpha');
    assert.equal(selectedSpan.attributes['attempt'], '1');
    assert.equal(selectedSpan.status.code, 1);
    const timeoutSpan = spans.find((item) => item.attributes['outcome'] === 'timeout');
    assert.equal(timeoutSpan.attributes['attempt'], '2');
    assert.equal(timeoutSpan.attributes['error.code'], 'navigation-timeout');
    assert.equal(timeoutSpan.status.code, 2);

    const failures = eventsOf(server.telemetry).filter((item) => item.body === 'chatdsh.client.navigate.rejected');
    assert.ok(
      failures.some((item) => item.attributes['outcome'] === 'ignored' && item.attributes['error.code'] === 'origin-rejected'),
      JSON.stringify(failures),
    );
    assert.ok(failures.some((item) => item.attributes['outcome'] === 'timeout'), JSON.stringify(failures));

    const points = metricPointsOf(server.telemetry).filter((item) => item.name === 'chatdsh_client_navigations_total');
    assert.ok(points.some((item) => item.attributes['outcome'] === 'selected'));
    assert.ok(points.some((item) => item.attributes['outcome'] === 'timeout'));
  } finally {
    if (opened) await cli('close');
    await crossServer.close();
    await server.close();
    releaseIndependentHome(home);
  }
});
