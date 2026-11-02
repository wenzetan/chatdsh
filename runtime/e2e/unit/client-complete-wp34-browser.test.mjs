// WP34 真实浏览器验收：两个真实窗口共享同一存储与广播通道，验证读取、发送、草稿隔离、
// 分屏键盘操作、新窗口深链接、并发冲突展示，以及窗口增加不新增运行时与订阅。
//
// 页面把仓库里的真实客户端入口（`packages/client/multi-window/src/index.ts`）打包后由真实
// HTTP 服务提供；会话读取与写入走真实控制平面进程（真实 SQLite 与真实 HTTP）；订阅走控制
// 平面的真实 SSE 端点 `GET /chatdsh/gateway/events`，页面服务只做透明转发与计数。同时启动
// 真实 `dsh` Web 运行时进程，用进程表核对窗口增加前后运行时数量不变。浏览器是
// agent-browser 独立会话里的真实 Chrome，使用独立 HOME、TMPDIR 与 profile，不截图。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';

const execute = promisify(execFile);
const RUNTIME = resolve(import.meta.dirname, '../..');
const NODE_BIN = '/usr/local/nvm/versions/node/v24.19.0/bin';
const AGENT_BROWSER = `${NODE_BIN}/agent-browser`;
const PROFILE = 'chatdsh-web';
const TOKENS = readFileSync(join(RUNTIME, 'packages/client/theme/src/client/styles/tokens.css'), 'utf8');
const PACKAGE_ENTRY = join(RUNTIME, 'packages/client/multi-window/src/index.ts');
const PAGE_TIMEOUT = 180_000;
const TEST_TIMEOUT = 900_000;

const { findFreePort } = await import('../../gateway/lib/runtime.js');

/** 等一段时间。 */
function settle(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * 反复执行检查直到成立。
 * @param {() => Promise<{ ok: boolean, value?: unknown, detail?: unknown }>} check - 检查函数。
 * @param {number} timeoutMs - 超时毫秒数。
 * @param {string} label - 失败说明。
 */
async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last.ok) return last.value;
    await settle(80);
  }
  throw new Error(`等待超时：${label}；最后状态 ${JSON.stringify(last?.detail ?? last)}`);
}

/**
 * 启动真实控制平面。
 * @param {string} home - 数据根。
 * @param {string} pairingCode - 配对码。
 */
async function startGateway(home, pairingCode) {
  const port = await findFreePort(20450);
  const child = spawn(process.execPath, [join(RUNTIME, 'gateway/lib/main.js')], {
    cwd: RUNTIME,
    env: {
      ...process.env,
      CHATDSH_TELEMETRY: 'off',
      CHATDSH_GATEWAY_HOST: '127.0.0.1',
      CHATDSH_GATEWAY_PORT: String(port),
      CHATDSH_GATEWAY_DB: join(home, 'gateway.sqlite'),
      CHATDSH_PAIRING_CODE: pairingCode,
      CHATDSH_RUNTIME_URL: 'http://127.0.0.1:1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { text: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output.text += chunk; });
  child.stderr.on('data', (chunk) => { output.text += chunk; });
  const base = `http://127.0.0.1:${String(port)}`;
  await waitFor(async () => {
    if (child.exitCode !== null) return { ok: false, detail: `控制平面退出：${output.text.slice(-800)}` };
    const response = await fetch(`${base}/healthz`).catch(() => undefined);
    return { ok: response?.ok === true, detail: response?.status ?? '不可达' };
  }, 30_000, '控制平面监听');
  return {
    base,
    port,
    output: () => output.text,
    async stop() {
      child.kill('SIGTERM');
      await waitFor(async () => ({ ok: child.exitCode !== null }), 15_000, '控制平面退出').catch(() => child.kill('SIGKILL'));
    },
  };
}

/**
 * 把仓库 profile 复制到独立数据根，依赖目录用符号链接投影。
 * @param {string} home - 数据根。
 */
function prepareProfile(home) {
  const source = join(RUNTIME, 'profiles', PROFILE);
  const target = join(home, 'profiles', PROFILE);
  mkdirSync(target, { recursive: true });
  for (const file of ['package.json', 'cordis.yml', 'cordis.patch.yml']) {
    copyFileSync(join(source, file), join(target, file));
  }
  const from = join(source, 'node_modules');
  const to = join(target, 'node_modules');
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (entry.name.startsWith('@')) {
      const scope = join(to, entry.name);
      mkdirSync(scope, { recursive: true });
      for (const scoped of readdirSync(join(from, entry.name))) {
        symlinkSync(join(from, entry.name, scoped), join(scope, scoped), 'dir');
      }
      continue;
    }
    symlinkSync(join(from, entry.name), join(to, entry.name), 'dir');
  }
}

/**
 * 启动真实 dsh Web 运行时。
 * @param {string} home - 数据根。
 * @param {{ base: string, port: number }} gateway - 控制平面。
 * @param {{ token: string, deviceId: string }} device - 配对设备。
 */
async function startRuntime(home, gateway, device) {
  prepareProfile(home);
  const port = await findFreePort(3750);
  const child = spawn(`${NODE_BIN}/dsh`, ['--profile', PROFILE, '--port', String(port), '--no-open'], {
    cwd: RUNTIME,
    env: {
      ...process.env,
      PATH: `${NODE_BIN}:${process.env.PATH ?? ''}`,
      DSH_HOME: home,
      CHATDSH_TELEMETRY: 'off',
      CHATDSH_CONTROL_URL: gateway.base,
      CHATDSH_NODE_TOKEN: device.token,
      CHATDSH_DEVICE_ID: device.deviceId,
      CHATDSH_GATEWAY_PORT: String(gateway.port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { text: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output.text += chunk; });
  child.stderr.on('data', (chunk) => { output.text += chunk; });
  const url = await waitFor(async () => {
    if (child.exitCode !== null) return { ok: false, detail: `运行时退出：${output.text.slice(-2000)}` };
    const match = /dsh web: (http:\S+)/u.exec(output.text);
    return match === null ? { ok: false, detail: output.text.slice(-400) } : { ok: true, value: match[1] };
  }, PAGE_TIMEOUT, '运行时监听');
  const login = await fetch(url, { redirect: 'manual' });
  return {
    child,
    port,
    url,
    status: login.status,
    output: () => output.text,
    async stop() {
      child.kill('SIGTERM');
      await waitFor(async () => ({ ok: child.exitCode !== null }), 30_000, '运行时退出').catch(() => child.kill('SIGKILL'));
    },
  };
}

/**
 * 统计指定端口上的 dsh Web 运行时进程数量。
 * @param {number} port - 运行时监听端口。
 * @returns {number} 进程数量。
 */
function runtimeProcessCount(port) {
  const table = execFileSync('ps', ['-eo', 'args='], { encoding: 'utf8' });
  return table
    .split('\n')
    .filter((line) => line.includes('--profile chatdsh-web') && line.includes(`--port ${String(port)}`))
    .length;
}

/** 页面里的挂载脚本：真实客户端入口、真实 SSE 订阅与真实副本读写。 */
const MOUNT_SCRIPT = [
  'window.__mwErrors = [];',
  'window.addEventListener("error", function (event) { window.__mwErrors.push(String(event.message)); });',
  'window.addEventListener("unhandledrejection", function (event) { window.__mwErrors.push("rejection:" + String(event.reason)); });',
  'try {',
  '  var parsed = window.__chatdshMultiWindow.parseDeepLink(location.pathname + location.search + location.hash);',
  '  if (!parsed.ok) { window.__mwErrors.push("route:" + parsed.reason); } else {',
  '    var handle = window.__chatdshMultiWindow.startMultiWindow(document.getElementById("app"), {',
  '      target: parsed.target,',
  '      transport: window.__chatdshMultiWindow.eventSourceTransport({ url: "/chatdsh/gateway/events" }),',
  '      readObject: async function (target) {',
  '        var response = await fetch("/chatdsh/gateway/replica?sessionId=" + encodeURIComponent(target.sessionId), { cache: "no-store" });',
  '        var body = await response.json();',
  '        return { revision: typeof body.watermark === "number" ? body.watermark : 0, text: (body.events || []).map(function (event) { return (event.payload && event.payload.text) ? event.payload.text : event.kind; }).join("\\n") };',
  '      },',
  '      send: async function (input) {',
  '        var response = await fetch("/chatdsh/gateway/replica", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: input.target.sessionId, events: [{ seq: input.baseRevision + 1, kind: "message/assistant", payload: { text: input.text, operationId: input.operationId } }] }) });',
  '        var body = await response.json();',
  '        return { revision: typeof body.watermark === "number" ? body.watermark : 0, outcome: "applied" };',
  '      },',
  '      draftDebounceMs: 60,',
  '    });',
  '    document.title = "MW " + handle.windowId;',
  '    window.__mw = handle;',
  '    window.__mwState = function () {',
  '      var objectKey = handle.target.deviceId + ":" + handle.target.sessionId;',
  '      var notice = handle.conflicts.noticeOf(objectKey);',
  '      return {',
  '        windowId: handle.windowId,',
  '        role: handle.runtime.role,',
  '        connections: handle.runtime.connectionCount,',
  '        tabs: handle.registry.tabs().map(function (tab) { return tab.windowId; }),',
  '        target: handle.target,',
  '        revision: handle.conflicts.revisionOf(objectKey) === undefined ? null : handle.conflicts.revisionOf(objectKey),',
  '        conflict: notice === undefined ? null : { kind: notice.kind, message: notice.message, serverRevision: notice.serverRevision, localRevision: notice.localRevision },',
  '        draftKeys: Object.keys(localStorage).filter(function (key) { return key.indexOf("chatdsh-multi-window.draft.v1:") === 0; }),',
  '        sessionWindow: sessionStorage.getItem("chatdsh-multi-window.window.v1"),',
  '        split: handle.layout(),',
  '        paneWidth: document.querySelector("[data-pane=\\"primary\\"]").getAttribute("data-pane-width"),',
  '        draftHint: document.querySelector("[data-chatdsh-draft-state]").textContent,',
  '        errors: window.__mwErrors,',
  '      };',
  '    };',
  '  }',
  '} catch (error) { window.__mwErrors.push("mount:" + String(error)); }',
].join('\n');

/** 页面正文。 */
function pageHtml() {
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="dark light">',
    '<title>ChatDSH 第二窗口验收</title>',
    `<style>${TOKENS}</style>`,
    '<style>html, body { height: 100%; margin: 0; } body { display: flex; flex-direction: column; } #app { display: flex; flex: 1; min-height: 0; }</style>',
    '</head>',
    '<body>',
    '<div id="app"></div>',
    '<script src="/assets/app.js"></script>',
    `<script>${MOUNT_SCRIPT}</script>`,
    '</body>',
    '</html>',
  ].join('\n');
}

/**
 * 建立页面服务：真实页面与打包产物，其余请求透明转发到真实控制平面。
 * @param {{ gatewayOrigin: string, clientScript: string }} options - 控制平面来源与打包产物。
 */
function createHarnessServer(options) {
  const state = {
    sseRequests: 0,
    sseOpen: 0,
    sseMaxOpen: 0,
    telemetry: [],
    replicaReads: 0,
    replicaWrites: 0,
    requests: [],
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    state.requests.push({ method: request.method, path: url.pathname });
    if (url.pathname === '/assets/app.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      response.end(options.clientScript);
      return;
    }
    if (url.pathname === '/' || url.pathname.startsWith('/sessions/')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(pageHtml());
      return;
    }
    if (url.pathname === '/chatdsh/telemetry/browser') {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        try {
          state.telemetry.push({ signal: request.headers['x-chatdsh-signal'], body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch {
          state.telemetry.push({ signal: request.headers['x-chatdsh-signal'], body: undefined });
        }
        response.writeHead(204).end();
      });
      return;
    }
    if (url.pathname === '/chatdsh/gateway/events') {
      state.sseRequests += 1;
      state.sseOpen += 1;
      state.sseMaxOpen = Math.max(state.sseMaxOpen, state.sseOpen);
      response.on('close', () => {
        state.sseOpen = Math.max(state.sseOpen - 1, 0);
      });
    }
    if (url.pathname === '/chatdsh/gateway/replica' && request.method === 'POST') state.replicaWrites += 1;
    if (url.pathname === '/chatdsh/gateway/replica' && request.method === 'GET') state.replicaReads += 1;

    const upstream = httpRequest(
      `${options.gatewayOrigin}${request.url ?? '/'}`,
      { method: request.method, headers: { ...request.headers, host: new URL(options.gatewayOrigin).host } },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      }
    );
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' });
      response.end('upstream-failed');
    });
    request.pipe(upstream);
  });
  return {
    state,
    async start() {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      return `http://127.0.0.1:${String(server.address().port)}`;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}

test('真实两个窗口：读取、发送、草稿隔离、分屏键盘、冲突与订阅不增加', { timeout: TEST_TIMEOUT }, async () => {
  const home = allocateIndependentHome('wp34-window');
  const browserHome = allocateIndependentHome('wp34-browser');
  let gateway;
  let runtime;
  let front;
  let cli;
  try {
  const pairingCode = `WP34-${randomUUID().slice(0, 8)}`;
  gateway = await startGateway(home, pairingCode);
  const paired = await fetch(`${gateway.base}/chatdsh/gateway/devices/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: pairingCode, name: 'wp34-runtime', platform: 'linux', role: 'both', capabilities: ['shell'] }),
  });
  assert.equal(paired.status, 200, `配对失败：${String(paired.status)}`);
  const device = await paired.json();
  runtime = await startRuntime(home, gateway, device);
  assert.equal(runtimeProcessCount(runtime.port), 1, '启动之后只有一台运行时');

  const bundle = await build({
    entryPoints: [PACKAGE_ENTRY],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: '__chatdshMultiWindow',
    platform: 'browser',
    target: 'es2022',
    logLevel: 'warning',
  });
  const clientScript = bundle.outputFiles[0].text;
  assert.ok(clientScript.length > 30_000, `客户端脚本大小异常：${String(clientScript.length)}`);

  front = createHarnessServer({ gatewayOrigin: gateway.base, clientScript });
  const origin = await front.start();
  const pageUrl = `${origin}/sessions/session-1?device=device-1#pane=document:doc-7`;

  mkdirSync(join(browserHome, '.agent-browser'), { recursive: true });
  mkdirSync(join(browserHome, 'chrome'), { recursive: true });
  const session = `wp34-${randomUUID().slice(0, 8)}`;
  const env = {
    ...process.env,
    TMPDIR: browserHome,
    HOME: browserHome,
    AGENT_BROWSER_SESSION: session,
    AGENT_BROWSER_EXECUTABLE_PATH: '/usr/bin/google-chrome',
    AGENT_BROWSER_PROFILE: join(browserHome, 'chrome'),
    AGENT_BROWSER_ARGS: '--no-sandbox',
  };
  cli = async (...args) => {
    const result = await execute(AGENT_BROWSER, ['--session', session, '--json', ...args], {
      env,
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const answer = JSON.parse(result.stdout);
    assert.equal(answer.success, true, `agent-browser ${args[0]}：${result.stdout}`);
    return answer;
  };
  const evaluate = async (expression) => (await cli('eval', expression)).data.result;
  const waitForPage = async (expression, note) => {
    try {
      await cli('wait', '--fn', expression);
    } catch (error) {
      const state = await evaluate('JSON.stringify({ url: location.href, errors: window.__mwErrors || null, state: window.__mwState ? window.__mwState() : null, body: document.body ? document.body.textContent.slice(0, 400) : null })');
      throw new Error(`等待失败：${note}\n页面状态：${state}\n${String(error)}`);
    }
  };
  const stateOf = async () => JSON.parse(await evaluate('JSON.stringify(window.__mwState())'));
  const textOf = async (selector) => String(await evaluate(`(document.querySelector(${JSON.stringify(selector)}) || {}).textContent || ""`));
  const tabsOf = async () => (await cli('tab', 'list')).data.tabs;
  const openPage = async (url) => {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await cli('open', url);
        return;
      } catch (error) {
        if (attempt === 2 || !String(error.message).includes('Failed to connect')) throw error;
      }
    }
  };
  const currentWindowId = async () => (await stateOf()).windowId;
  const activeTabId = async () => {
    const tabs = await tabsOf();
    const active = tabs.find((tab) => tab.active === true);
    if (active === undefined) throw new Error('没有活动标签');
    return String(active.tabId);
  };
  /** 窗口标识到标签标识的登记：Chrome 回收后台标签之后标签标识保持稳定。 */
  const windowTabs = new Map();
  const registerCurrentWindow = async () => {
    const windowId = await currentWindowId();
    windowTabs.set(windowId, await activeTabId());
    return windowId;
  };
  const switchToWindow = async (windowId) => {
    const tabId = windowTabs.get(windowId);
    if (tabId === undefined) throw new Error(`没有登记窗口 ${windowId} 的标签`);
    await cli('tab', tabId);
    await waitForPage(`window.__mwState !== undefined && window.__mwState().windowId === ${JSON.stringify(windowId)}`, `切到窗口 ${windowId}`);
  };
  const switchToNewWindow = async () => {
    const known = new Set(windowTabs.values());
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const tabs = await tabsOf();
      const created = tabs.find((tab) => !known.has(String(tab.tabId)) && tab.type === 'page');
      if (created !== undefined) {
        await cli('tab', String(created.tabId));
        await waitForPage('window.__mwState !== undefined', '新窗口挂载');
        return await registerCurrentWindow();
      }
      await settle(150);
    }
    throw new Error('没有发现新打开的标签');
  };

    // 先往真实控制平面写入两条事件，供两个窗口读取。
    const seed = await fetch(`${gateway.base}/chatdsh/gateway/replica`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'session-1',
        events: [
          { seq: 1, kind: 'message/user', payload: { text: '第一条读取内容' } },
          { seq: 2, kind: 'message/assistant', payload: { text: '第二条读取内容' } },
        ],
      }),
    });
    assert.equal(seed.status, 200);
    assert.equal(front.state.replicaWrites, 0, '读取用的写入来自测试进程本身');

    // 1. 第一个真实窗口：深链接带会话、设备与右栏对象，读取到真实副本内容。
    await openPage(pageUrl);
    await waitForPage('window.__mw !== undefined && window.__mwState !== undefined', '第一个窗口挂载');
    const first = await stateOf();
    assert.deepEqual(first.errors, []);
    assert.equal(first.target.sessionId, 'session-1');
    assert.equal(first.target.deviceId, 'device-1');
    assert.deepEqual(first.target.pane, { kind: 'document', id: 'doc-7' });
    await waitForPage('(document.querySelector("[data-chatdsh-pane]").textContent || "").includes("第一条读取内容")', '读取到副本内容');
    assert.equal(await textOf('[data-chatdsh-pane]'), '第一条读取内容\n第二条读取内容');
    assert.match(await textOf('[data-chatdsh-pane-head]'), /文档 · doc-7/u);
    assert.equal(first.revision, 2);
    // 订阅建立时会补发离线队列里的推送，这些行只做提示，不参与本窗口的读取断言。
    const initialLines = Number(await evaluate('document.querySelectorAll("[data-chatdsh-messages] li").length'));
    assert.ok(initialLines <= 1, `首个窗口的推送补发行数：${String(initialLines)}`);
    assert.equal(runtimeProcessCount(runtime.port), 1);
    const firstWindowId = await registerCurrentWindow();

    // 2. 第二个窗口：同一存储与同一广播通道，窗口标识不同，标签列表互相可见。
    await cli('tab', 'new', pageUrl);
    await waitForPage('window.__mw !== undefined && window.__mwState !== undefined', '第二个窗口挂载');
    const second = await stateOf();
    const secondWindowId = await registerCurrentWindow();
    assert.equal(secondWindowId, second.windowId);
    assert.notEqual(secondWindowId, firstWindowId, '两个窗口的窗口标识不同');
    assert.equal(second.sessionWindow, secondWindowId);
    await waitForPage('window.__mwState().tabs.length === 2', '两个窗口的标签列表');
    assert.deepEqual(second.tabs.sort(), [firstWindowId, secondWindowId].sort());
    await waitForPage('window.__mwState().role === "leader" || window.__mwState().role === "follower"', '选举完成');
    await settle(400);
    const stateSecond = await stateOf();
    await switchToWindow(firstWindowId);
    const stateFirst = await stateOf();
    assert.equal([stateFirst, stateSecond].filter((entry) => entry.role === 'leader').length, 1, '只有一个持连窗口');
    assert.equal(stateFirst.connections + stateSecond.connections, 1, '窗口数量增加没有新增订阅');
    assert.equal(front.state.sseRequests, 1, `两个窗口只有一条订阅：${JSON.stringify(front.state.requests.filter((entry) => entry.path === '/chatdsh/gateway/events'))}`);
    assert.equal(front.state.sseMaxOpen, 1);
    assert.equal(runtimeProcessCount(runtime.port), 1, '第二个窗口没有新增运行时');

    // 3. 分屏键盘操作：方向键、Home、End、回车与 Esc，比例按窗口保存。
    await cli('focus', '[data-chatdsh-separator]');
    const initialWidth = await evaluate('document.querySelector("[data-chatdsh-split]").getBoundingClientRect().width');
    assert.ok(initialWidth > 760, `窗口宽度足够分屏：${String(initialWidth)}`);
    const separatorMin = Number(await evaluate('document.querySelector("[data-chatdsh-separator]").getAttribute("aria-valuemin")'));
    const separatorMax = Number(await evaluate('document.querySelector("[data-chatdsh-separator]").getAttribute("aria-valuemax")'));
    await cli('press', 'ArrowRight');
    const afterRight = await stateOf();
    assert.equal(afterRight.split.ratio, 0.52);
    assert.equal(afterRight.split.mode, 'split');
    await cli('press', 'Home');
    const afterHome = await stateOf();
    assert.equal(Math.round(afterHome.split.ratio * 100), separatorMin, 'Home 收到最小宽度');
    assert.equal(Number(afterHome.paneWidth), 360, '主栏收到 360px 最小宽度');
    await cli('press', 'End');
    const afterEnd = await stateOf();
    assert.equal(Math.round(afterEnd.split.ratio * 100), separatorMax, 'End 放到最大宽度');
    assert.equal(await evaluate('document.querySelector("[data-pane=\\"secondary\\"]").getAttribute("data-pane-width")'), '360', '次栏保留 360px');

    // 鼠标拖动分隔条：真实指针事件，向左拖动之后主栏变窄且比例写入本窗口。
    const separatorBox = JSON.parse(await evaluate('JSON.stringify(document.querySelector("[data-chatdsh-separator]").getBoundingClientRect())'));
    const dragX = Math.round(separatorBox.x + separatorBox.width / 2);
    const dragY = Math.round(separatorBox.y + 60);
    await cli('mouse', 'move', String(dragX), String(dragY));
    await cli('mouse', 'down');
    await cli('mouse', 'move', String(dragX - 140), String(dragY));
    await cli('mouse', 'up');
    const afterDrag = await stateOf();
    assert.ok(afterDrag.split.ratio < separatorMax / 100, `拖动之后主栏变窄：${String(afterDrag.split.ratio)}`);
    assert.ok(afterDrag.split.ratio >= separatorMin / 100, '拖动之后仍不小于最小宽度');
    const ariaNow = Number(await evaluate('document.querySelector("[data-chatdsh-separator]").getAttribute("aria-valuenow")'));
    assert.equal(ariaNow, Math.round(afterDrag.split.ratio * 100), '读屏数值跟随拖动');
    const storedAfterDrag = await evaluate('Object.keys(localStorage).filter((key) => key.indexOf("chatdsh-multi-window.split.v1:") === 0).map((key) => localStorage.getItem(key))');
    assert.equal(storedAfterDrag.length, 1, '拖动之后比例已保存');
    assert.equal(Number.parseFloat(storedAfterDrag[0]) > 0, true);

    await cli('press', 'Enter');
    const afterReset = await stateOf();
    assert.equal(afterReset.split.ratio, 0.5, '回车恢复默认比例');
    await cli('press', 'Escape');
    const afterEscape = await stateOf();
    assert.equal(afterEscape.split.mode, 'single', 'Esc 收起次栏');
    assert.equal(await evaluate('document.querySelector("[data-pane=\\"secondary\\"]").getAttribute("data-hidden")'), 'true');
    const storedRatio = await evaluate('Object.keys(localStorage).filter((key) => key.indexOf("chatdsh-multi-window.split.v1:") === 0).map((key) => localStorage.getItem(key))');
    assert.deepEqual(storedRatio, ['0.5000'], '比例按窗口与设备保存');
    await cli('click', '[data-chatdsh-toggle-split]');
    await waitForPage('window.__mwState().split.mode === "split"', '重新展开分屏');

    // 4. 草稿隔离：两个窗口写同一个会话的草稿，键不同、内容互不覆盖。
    await cli('fill', '[data-chatdsh-composer]', '窗口一的草稿');
    await waitForPage('(document.querySelector("[data-chatdsh-draft-state]").textContent || "").includes("草稿已保存在本窗口")', '第一个窗口草稿保存');
    const firstDraftKeys = (await stateOf()).draftKeys;
    assert.equal(firstDraftKeys.length, 1);
    assert.match(firstDraftKeys[0], new RegExp(`:${firstWindowId}:device-1:session-1$`, 'u'));

    await switchToWindow(second.windowId);
    assert.equal(await evaluate('document.querySelector("[data-chatdsh-composer]").value'), '', '第二个窗口的输入区为空');
    await cli('fill', '[data-chatdsh-composer]', '窗口二的草稿');
    await waitForPage('(document.querySelector("[data-chatdsh-draft-state]").textContent || "").includes("草稿已保存在本窗口")', '第二个窗口草稿保存');
    const bothKeys = (await stateOf()).draftKeys;
    assert.equal(bothKeys.length, 2, '两个窗口各有一份草稿');
    assert.equal(new Set(bothKeys).size, 2);

    await switchToWindow(firstWindowId);
    assert.equal(await evaluate('document.querySelector("[data-chatdsh-composer]").value'), '窗口一的草稿', '第二个窗口的输入没有覆盖第一个窗口的草稿');

    // 5. 第一个窗口发送：真实写入控制平面，副本水位前进。
    await cli('click', '[data-chatdsh-send]');
    await waitForPage('(document.querySelector("[data-chatdsh-messages]").textContent || "").includes("我：窗口一的草稿")', '第一个窗口发送完成');
    assert.equal(front.state.replicaWrites, 1, '发送只写入一次');
    const afterSend = await stateOf();
    assert.equal(afterSend.revision, 3);
    assert.equal(await evaluate('document.querySelector("[data-chatdsh-composer]").value'), '');
    await settle(300);

    // 6. 第二个窗口基于过期版本提交：给出冲突提示，没有第二次写入。
    await switchToWindow(second.windowId);
    await waitForPage('window.__mwState().conflict === null', '第二个窗口还没有冲突');
    const stale = await stateOf();
    assert.equal(stale.revision, 3, '第二个窗口经跨窗口见证知道服务端版本');
    await cli('click', '[data-chatdsh-send]');
    await waitForPage('window.__mwState().conflict !== null', '冲突提示出现');
    const conflict = await stateOf();
    assert.equal(conflict.conflict.kind, 'revision');
    assert.equal(conflict.conflict.serverRevision, 3);
    assert.equal(conflict.conflict.localRevision, 2);
    assert.match(conflict.conflict.message, /服务端版本 3/u);
    assert.match(conflict.conflict.message, /本窗口基于版本 2/u);
    assert.equal(await evaluate('document.querySelector("[data-chatdsh-conflict]").hidden'), false);
    assert.match(await textOf('[data-chatdsh-conflict-refresh]'), /刷新读取最新内容/u);
    assert.equal(front.state.replicaWrites, 1, '冲突时没有发出第二次写入');

    // 7. 刷新入口：读到服务端最新内容，提示消失，重新提交成功。
    await cli('click', '[data-chatdsh-conflict-refresh]');
    await waitForPage('window.__mwState().conflict === null && window.__mwState().revision === 3', '刷新之后读到最新版本');
    await waitForPage('(document.querySelector("[data-chatdsh-pane]").textContent || "").includes("窗口一的草稿")', '刷新之后读到第一个窗口写入的内容');
    assert.equal(await evaluate('document.querySelector("[data-chatdsh-conflict]").hidden'), true);
    await cli('click', '[data-chatdsh-send]');
    await waitForPage('window.__mwState().revision === 4', '刷新之后重新提交成功');
    assert.equal(front.state.replicaWrites, 2);

    // 8. 新窗口深链接：从当前上下文打开新窗口，地址保持会话、设备与右栏对象。
    await cli('click', '[data-chatdsh-open-window]');
    await settle(600);
    const newWindowId = await switchToNewWindow();
    const newWindowState = await stateOf();
    assert.deepEqual(newWindowState.target, { sessionId: 'session-1', deviceId: 'device-1', pane: { kind: 'document', id: 'doc-7' } });
    const newTab = (await tabsOf()).find((tab) => String(tab.tabId) === windowTabs.get(newWindowId));
    assert.notEqual(newTab, undefined);
    assert.match(String(newTab.url ?? ''), /\/sessions\/session-1\?device=device-1#pane=document:doc-7/u);
    await waitForPage('window.__mwState().tabs.length === 3', '标签式呈现列出三个窗口');
    await settle(400);
    assert.equal(front.state.sseRequests, 1, '第三个窗口没有新增订阅');
    assert.equal(runtimeProcessCount(runtime.port), 1);

    // 9. 关闭新窗口：其余窗口继续接收真实推送，订阅数不变。
    await switchToWindow(firstWindowId);
    const beforePush = Number(await evaluate('document.querySelectorAll("[data-chatdsh-messages] li").length'));
    await switchToWindow(newWindowId);
    await cli('tab', 'close');
    await settle(600);
    const remaining = await tabsOf();
    assert.equal(remaining.length, 2);
    await switchToWindow(firstWindowId);
    const push = await fetch(`${gateway.base}/chatdsh/gateway/replica`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'session-1',
        events: [{ seq: 5, kind: 'message/assistant', payload: { text: '关闭窗口之后的新事件' } }],
      }),
    });
    assert.equal(push.status, 200);
    await waitForPage(
      `document.querySelectorAll("[data-chatdsh-messages] li").length > ${String(beforePush)}`,
      '关闭第二个窗口之后回合仍在接收事件'
    );
    assert.match(await textOf('[data-chatdsh-messages]'), /replica/u, '真实推送到达剩余窗口');
    assert.equal(front.state.sseRequests, 1, '关闭窗口没有产生新的订阅');

    // 10. 遥测：窗口与分屏动作的 span、事件与计数都到达真实中继路径。
    const telemetryText = JSON.stringify(front.state.telemetry.map((entry) => entry.body));
    assert.match(telemetryText, /chatdsh\.client\.navigate/u);
    assert.match(telemetryText, /chatdsh\.client\.command\.run/u);
    assert.match(telemetryText, /chatdsh\.client\.ui\.action/u);
    assert.match(telemetryText, /chatdsh_client_command_runs_total/u);
    assert.match(telemetryText, /chatdsh_client_navigations_total/u);
    assert.equal(telemetryText.includes('窗口一的草稿'), false, '遥测里不出现草稿正文');
    assert.equal(telemetryText.includes('?device='), false, '遥测里不出现会话地址');

    // 11. 浏览器日志里没有失败，运行时进程数量与开始时一致。
    const finalState = await stateOf();
    assert.deepEqual(finalState.errors, []);
    assert.equal(runtimeProcessCount(runtime.port), 1, '全程只有一台运行时');
    assert.equal(runtime.status === 303 || runtime.status === 200, true, `运行时页面可访问：${String(runtime.status)}`);
  } finally {
    if (cli !== undefined) await cli('close', '--all').catch(() => undefined);
    if (front !== undefined) await front.close();
    if (runtime !== undefined) await runtime.stop();
    if (gateway !== undefined) await gateway.stop();
    releaseIndependentHome(browserHome);
    releaseIndependentHome(home);
  }
});
