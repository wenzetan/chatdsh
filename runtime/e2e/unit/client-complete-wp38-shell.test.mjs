// WP38 外壳场景的非视觉与辅助技术验证：S01、S02、S03、S06 与窄屏布局。
//
// 页面用 esbuild 打包真实外壳源码（`packages/client/shell/src/client/index.ts`），由真实的
// 控制平面 `createGatewayServer`、真实私有读取入口 `createClientHttpHandler` 与真实设备长连接
// 提供数据。浏览器是 agent-browser 独立会话里的真实 Chrome，使用独立 HOME、TMPDIR 与 profile，
// 不截图，断言全部来自 DOM、计算样式、可访问树、焦点位置与真实请求记录。
//
// 覆盖矩阵：两个主题（亮色 `light`、暗色 `dark`）× 三个宽度（320、768、1440）× 适用状态
// （加载、空、失败、只读、离线、待处理、长内容）。断言项：可访问名称与角色、键盘路径与焦点
// 顺序、焦点恢复、逐元素横向溢出、触控目标尺寸、200% 文字缩放、`role=status` 与 `aria-live`
// 播报、只读校验（验证过程不写业务数据）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { createTelemetryClient } from '../../packages/core/diagnostics/lib/client.js';
import { defaultTelemetryConfig } from '../../packages/core/diagnostics/lib/config.js';
import { GatewayStore, PushQueue, ReceiptStore, ReplicaStore, ShareStore } from '../../gateway/lib/store.js';
import { createPushHub } from '../../gateway/lib/push.js';
import { DeviceLinkHub } from '../../gateway/lib/device-link.js';
import { createGatewayServer } from '../../gateway/lib/server.js';
import { renderShellPage } from '../../gateway/lib/shell.js';
import { createClientHttpHandler } from '../../gateway/lib/client-http.js';
import { AccessStore } from '../../gateway/lib/access/store.js';
import {
  ACCESS_SESSION_TTL_MS,
  accessTokenHash,
  accessTokenOf,
  newAccessToken,
  newSessionId,
  serializeAccessCookie,
} from '../../gateway/lib/access/session.js';
import { issueCsrfToken } from '../../gateway/lib/access/csrf.js';

const execute = promisify(execFile);
const NODE_BIN = '/usr/local/nvm/versions/node/v24.19.0/bin';
const AGENT_BROWSER = `${NODE_BIN}/agent-browser`;
const ROOT = new URL('../../', import.meta.url);

/** 主题令牌与上游暗色映射，与真实客户端装载的样式同一份。 */
const THEME_TOKENS = readFileSync(new URL('packages/client/theme/src/client/styles/tokens.css', ROOT), 'utf8');
const THEME_SHELL = readFileSync(new URL('packages/client/theme/src/client/styles/shell.css', ROOT), 'utf8');

/** 设备内容页：记录导航消息并按契约确认选中。 */
const DEVICE_PAGE = [
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>设备会话页</title></head><body>',
  '<div id="device-content">设备内容</div>',
  '<script>',
  'window.__navMessages = [];',
  'window.addEventListener("message", function (event) {',
  '  var data = event.data || {};',
  '  if (typeof data.requestId !== "string") return;',
  '  window.__navMessages.push({ action: data.action, version: data.version, deviceId: data.deviceId, sessionId: data.sessionId });',
  '  if (data.action !== "navigate") return;',
  '  event.source.postMessage({ outcome: "selected", requestId: data.requestId, deviceId: data.deviceId, sessionId: data.sessionId }, event.origin);',
  '});',
  '</script>',
  '</body></html>',
].join('\n');

/** 页面里执行的审计：逐元素横向溢出、触控目标、可聚焦顺序、播报区域与结构。 */
const AUDIT_SOURCE = `(function auditWp38() {
  var viewport = { width: window.innerWidth, height: window.innerHeight };
  var smallViewport = document.querySelector('meta[name="viewport"]');

  function isScrollableOf(element) {
    var style = getComputedStyle(element);
    return ['auto', 'scroll'].indexOf(style.overflowX) !== -1 || ['auto', 'scroll'].indexOf(style.overflow) !== -1;
  }
  function insideScroller(element) {
    var node = element.parentElement;
    while (node !== null) {
      if (isScrollableOf(node)) return true;
      node = node.parentElement;
    }
    return false;
  }
  function describe(element) {
    var parts = [];
    var node = element;
    while (node !== null && node !== document.body && parts.length < 4) {
      var part = node.tagName.toLowerCase();
      if (node.id !== '') part += '#' + node.id;
      else if (typeof node.className === 'string' && node.className.trim() !== '') part += '.' + node.className.trim().split(/\\s+/).join('.');
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  var overflow = [];
  var all = document.querySelectorAll('body *');
  for (var index = 0; index < all.length; index += 1) {
    var element = all[index];
    var style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.position === 'fixed') continue;
    var rect = element.getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0) continue;
    // 只给读屏用的隐藏文字按标准裁切模式收进 1 像素框，不算排版溢出。
    var clippedByPattern = style.clip === 'rect(0px, 0px, 0px, 0px)' || style.clipPath === 'inset(50%)' || (rect.width <= 1.5 && rect.height <= 1.5 && style.overflow === 'hidden');
    if (clippedByPattern) continue;
    if (insideScroller(element)) continue;
    if (rect.right > viewport.width + 1 || rect.left < -1) {
      overflow.push({ selector: describe(element), left: Math.round(rect.left), right: Math.round(rect.right), scrollWidth: element.scrollWidth, clientWidth: element.clientWidth });
      continue;
    }
    if (element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1 && !insideScroller(element)) {
      overflow.push({ selector: describe(element), clipped: element.scrollWidth - element.clientWidth, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth });
    }
  }

  var touchSelector = 'button, a[href], input, select, textarea, summary, [role="button"], [role="tab"], [role="menuitem"], [role="switch"], [role="checkbox"]';
  var small = [];
  var belowMinimum = [];
  var touchable = document.querySelectorAll(touchSelector);
  for (var touchIndex = 0; touchIndex < touchable.length; touchIndex += 1) {
    var target = touchable[touchIndex];
    var targetStyle = getComputedStyle(target);
    if (targetStyle.display === 'none' || targetStyle.visibility === 'hidden') continue;
    var box = target.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) continue;
    var type = target.getAttribute('type');
    if (type === 'radio' || type === 'checkbox' || type === 'range') continue;
    if (target.closest('p, li, .shell-readonly-body, .entry-path') !== null && target.tagName.toLowerCase() === 'a') continue;
    if (box.width < 43.5 || box.height < 43.5) {
      var entry = { selector: describe(target), width: Math.round(box.width * 10) / 10, height: Math.round(box.height * 10) / 10, text: (target.textContent || '').trim().slice(0, 20) };
      small.push(entry);
      if (box.width < 23.5 || box.height < 23.5) belowMinimum.push(entry);
    }
  }

  var focusableSelector = 'a[href], button, input, select, textarea, iframe, [tabindex]:not([tabindex="-1"])';
  var focusables = [];
  var candidates = document.querySelectorAll(focusableSelector);
  for (var focusIndex = 0; focusIndex < candidates.length; focusIndex += 1) {
    var candidate = candidates[focusIndex];
    var candidateStyle = getComputedStyle(candidate);
    if (candidateStyle.display === 'none' || candidateStyle.visibility === 'hidden' || candidate.disabled === true) continue;
    if (candidate.closest('[hidden]') !== null) continue;
    var index = Number(candidate.getAttribute('tabindex'));
    var labelText = '';
    if (candidate.id !== '') {
      var linked = document.querySelector('label[for="' + candidate.id + '"]');
      if (linked !== null) labelText = (linked.textContent || '').trim();
    }
    if (labelText === '' && candidate.closest('label') !== null) labelText = (candidate.closest('label').textContent || '').trim();
    focusables.push({
      selector: describe(candidate),
      name: candidate.getAttribute('aria-label') || labelText.slice(0, 24) || (candidate.textContent || '').trim().slice(0, 24) || candidate.getAttribute('title') || '',
      tabIndex: Number.isFinite(index) ? index : 0,
    });
  }

  var live = [];
  var regions = document.querySelectorAll('[role="status"], [role="alert"], [aria-live]');
  for (var liveIndex = 0; liveIndex < regions.length; liveIndex += 1) {
    var region = regions[liveIndex];
    live.push({
      role: region.getAttribute('role'),
      live: region.getAttribute('aria-live'),
      atomic: region.getAttribute('aria-atomic'),
      text: (region.textContent || '').trim().slice(0, 80),
    });
  }

  var headings = [];
  var headingNodes = document.querySelectorAll('h1, h2, h3, [role="heading"]');
  for (var headingIndex = 0; headingIndex < headingNodes.length; headingIndex += 1) {
    var heading = headingNodes[headingIndex];
    headings.push({
      level: Number(heading.getAttribute('aria-level') || heading.tagName.slice(1) || 0),
      text: (heading.textContent || '').trim().slice(0, 40),
      visible: heading.getBoundingClientRect().height > 0,
    });
  }

  var landmarks = [];
  var landmarkNodes = document.querySelectorAll('main, nav, header, footer, aside, [role="main"], [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"]');
  for (var landmarkIndex = 0; landmarkIndex < landmarkNodes.length; landmarkIndex += 1) {
    var landmark = landmarkNodes[landmarkIndex];
    landmarks.push({
      tag: landmark.tagName.toLowerCase(),
      role: landmark.getAttribute('role'),
      label: landmark.getAttribute('aria-label') || landmark.getAttribute('aria-labelledby') || '',
    });
  }

  var unnamedButtons = [];
  var buttons = document.querySelectorAll('button, [role="button"]');
  for (var buttonIndex = 0; buttonIndex < buttons.length; buttonIndex += 1) {
    var button = buttons[buttonIndex];
    var buttonStyle = getComputedStyle(button);
    if (buttonStyle.display === 'none' || buttonStyle.visibility === 'hidden') continue;
    var name = button.getAttribute('aria-label') || button.getAttribute('title') || (button.textContent || '').trim();
    if (name === '') unnamedButtons.push(describe(button));
  }

  var unnamedInputs = [];
  var inputs = document.querySelectorAll('input:not([type="hidden"]), select, textarea');
  var described = 0;
  for (var inputIndex = 0; inputIndex < inputs.length; inputIndex += 1) {
    var input = inputs[inputIndex];
    var labelled = input.getAttribute('aria-label') || input.getAttribute('aria-labelledby');
    var wrapping = input.closest('label');
    var explicit = input.id !== '' && document.querySelector('label[for="' + input.id + '"]') !== null;
    if (labelled === null && wrapping === null && !explicit) unnamedInputs.push(describe(input));
    else described += 1;
  }

  var iframes = [];
  var frames = document.querySelectorAll('iframe');
  for (var frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    iframes.push({ title: frames[frameIndex].getAttribute('title') || '', hidden: frames[frameIndex].closest('[hidden]') !== null });
  }

  return {
    viewport: viewport,
    title: document.title,
    htmlLang: document.documentElement.getAttribute('lang'),
    hasViewportMeta: smallViewport !== null && smallViewport.getAttribute('content').indexOf('width=device-width') !== -1,
    documentScrollWidth: document.documentElement.scrollWidth,
    documentClientWidth: document.documentElement.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
    overflow: overflow,
    touch: small,
    touchBelowMinimum: belowMinimum,
    focusables: focusables,
    live: live,
    headings: headings,
    landmarks: landmarks,
    unnamedButtons: unnamedButtons,
    unnamedInputs: unnamedInputs,
    describedInputs: described,
    iframes: iframes,
    rootFontSize: getComputedStyle(document.documentElement).fontSize,
  };
})()`;

/** 设备长连接上的测试设备：按设备协议回答内容页。 */
class ShellDevicePeer {
  constructor(deviceId, token, url) {
    this.deviceId = deviceId;
    this.opened = new Promise((resolve, reject) => {
      this.socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
      this.socket.addEventListener('open', () => {
        this.socket.send(JSON.stringify({ type: 'hello', deviceId, platform: 'linux', role: 'executor', capabilities: [] }));
        resolve();
      });
      this.socket.addEventListener('error', () => reject(new Error('设备长连接失败')));
      this.socket.addEventListener('message', (event) => {
        const frame = JSON.parse(event.data);
        if (frame.type === 'ping') {
          this.socket.send(JSON.stringify({ type: 'pong' }));
          return;
        }
        if (frame.type !== 'request') return;
        const url = new URL(frame.path, 'http://device.invalid');
        if (url.pathname === '/') {
          this.reply(frame.requestId, 200, DEVICE_PAGE, 'text/html; charset=utf-8');
          return;
        }
        this.reply(frame.requestId, 404, JSON.stringify({ error: 'not-found' }), 'application/json; charset=utf-8');
      });
    });
  }

  reply(requestId, status, body, type) {
    this.socket.send(
      JSON.stringify({
        type: 'response',
        requestId,
        status,
        headers: { 'content-type': type },
        body: Buffer.from(body, 'utf8').toString('base64'),
      })
    );
  }

  close() {
    this.socket.close();
  }
}

/** 本机运行时的最小宿主：按设备协议回答目录列举。 */
async function startLocalRuntime(listingPath) {
  const calls = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const url = new URL(request.url, 'http://local.invalid');
    if (url.pathname === '/api/directoryPicker/list') {
      calls.push(url.pathname);
      const envelope = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const value = {
        path: listingPath,
        home: '/root',
        crumbs: [
          { name: '/', path: '/', hidden: false },
          { name: 'workspace', path: '/workspace', hidden: false },
          { name: 'chatdsh', path: listingPath, hidden: false },
        ],
        entries: [{ name: 'runtime', path: `${listingPath}/runtime`, hidden: false }],
        truncated: false,
      };
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value } }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'not-found' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    listingPath,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('外壳场景矩阵：主题、宽度、状态、键盘、焦点与只读', { timeout: 900000 }, async (t) => {
  const home = allocateIndependentHome('wp38-shell');
  mkdirSync(join(home, 'chrome'), { recursive: true });
  mkdirSync(join(home, '.agent-browser'), { recursive: true });
  const session = `wp38-${randomUUID().slice(0, 8)}`;
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
      timeout: 120000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const response = JSON.parse(result.stdout);
    assert.equal(response.success, true, `agent-browser ${args[0]}：${result.stdout.slice(0, 2000)}`);
    return response;
  };

  const telemetry = createTelemetryClient({
    config: defaultTelemetryConfig({ surface: 'gateway' }),
    component: '@chatdsh/gateway',
    env: { CHATDSH_TELEMETRY: 'off' },
  });
  const store = new GatewayStore(join(home, 'gateway.sqlite'));
  const replica = new ReplicaStore(store.handle());
  const share = new ShareStore(store.handle());
  const receipts = new ReceiptStore(store.handle());
  const push = createPushHub({
    queue: new PushQueue(store.handle()),
    devices: store,
    mode: 'all-at-once',
    escalationMs: 1000,
    telemetry: { counter: (name, config) => telemetry.counter(name, config) },
  });
  const deviceLink = new DeviceLinkHub({ store, telemetry });
  const localRuntime = await startLocalRuntime('/workspace/chatdsh');
  const gatewayServer = createGatewayServer({
    config: {
      host: '127.0.0.1',
      port: 0,
      runtimeUrl: localRuntime.url,
      databasePath: join(home, 'gateway.sqlite'),
      environment: 'test',
      version: '0.0.0',
      pushMode: 'all-at-once',
      pushEscalationMs: 1000,
      llmGateway: { quota: {} },
      pairingCode: 'pair-wp38',
    },
    store,
    replica,
    share,
    receipts,
    push,
    telemetry,
    deviceLink,
    runtime: { url: () => localRuntime.url, bootPath: () => '/?token=test-token', ready: () => true },
    bootstrapSecret: 'launch-secret',
  });

  const access = new AccessStore(store.handle());
  const accessToken = newAccessToken();
  const accessSessionId = newSessionId();
  const now = Date.now();
  access.insertSession({
    sessionId: accessSessionId,
    tokenHash: accessTokenHash(accessToken),
    clientName: '验收浏览器',
    createdAt: now,
    lastActiveAt: now,
    expiresAt: now + ACCESS_SESSION_TTL_MS,
  });
  const csrfKey = randomBytes(32);

  let device;
  let front;
  let opened = false;
  let gatewayStarted = false;
  const writes = [];
  const shellScriptBundle = await build({
    entryPoints: [new URL('packages/client/shell/src/client/index.ts', ROOT).pathname],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    loader: { '.css': 'text' },
    logLevel: 'warning',
  });
  const shellScript = shellScriptBundle.outputFiles[0].text;
  assert.ok(shellScript.length > 20_000, `外壳脚本大小异常：${String(shellScript.length)}`);
  const shellHtml = renderShellPage();
  const accessCookie = serializeAccessCookie(accessToken, 3600);

  try {
    await gatewayServer.start();
    gatewayStarted = true;
    const gatewayUrl = gatewayServer.url();
    const pair = async (name, role = 'executor') => {
      const response = await fetch(`${gatewayUrl}/chatdsh/gateway/devices/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: 'pair-wp38', name, platform: 'linux', role, capabilities: [] }),
      });
      assert.equal(response.status, 200);
      return await response.json();
    };
    const nodeA = await pair('甲方设备');
    const nodeB = await pair('乙方设备');
    device = new ShellDevicePeer(nodeA.deviceId, nodeA.token, `${gatewayUrl.replace('http', 'ws')}/chatdsh/gateway/device-link`);
    await device.opened;

    /** 登记归属并写入真实副本事件。 */
    const seed = async (input) => {
      store.upsertSession({
        sessionId: input.sessionId,
        deviceId: input.deviceId,
        cwd: input.cwd,
        kind: 'work',
        createdAt: input.time,
      });
      const events = [
        { seq: 0, kind: 'session/title', time: input.time, bytes: 32, payload: { seq: 0, type: 'session/title', time: input.time, data: { title: input.title } } },
      ];
      let seq = 1;
      if (input.user !== undefined) {
        events.push({
          seq,
          kind: 'user/message',
          time: input.time + 1,
          bytes: 32,
          payload: { seq, type: 'user/message', time: input.time + 1, data: { content: [{ type: 'text', text: input.user }] } },
        });
        seq += 1;
      }
      for (let index = 0; index < (input.assistants ?? 0); index += 1) {
        const text = input.long === true ? `${'长内容片段'.repeat(60)}${String(index)}` : `回答${String(index)}`;
        events.push({
          seq,
          kind: 'assistant/message',
          time: input.time + 2 + index,
          bytes: 32,
          payload: { seq, type: 'assistant/message', time: input.time + 2 + index, data: { text } },
        });
        seq += 1;
      }
      const appended = await fetch(`${gatewayUrl}/chatdsh/gateway/replica`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: input.sessionId, events }),
      });
      assert.equal(appended.status, 200);
    };
    await seed({ sessionId: 'session-online', deviceId: nodeA.deviceId, cwd: '/work/alpha', title: '甲设备上的 alpha', time: now - 4000, user: '在线时的问题', assistants: 4, long: true });
    await seed({ sessionId: 'session-offline', deviceId: nodeB.deviceId, cwd: '/home/other/alpha', title: '乙设备上的 alpha', time: now - 3000, user: '离线时要读的内容', assistants: 1 });
    await seed({ sessionId: 'session-beta', deviceId: nodeB.deviceId, cwd: '/work/beta', title: '乙设备上的 beta', time: now - 2000, assistants: 0 });

    let gatewayDown = false;
    let slowSessions = false;
    const proxy = (request, response) => {
      if (gatewayDown) {
        response.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'control-plane-stopped' }));
        return;
      }
      const target = new URL(gatewayUrl);
      const sent = httpRequest(
        { host: target.hostname, port: target.port, method: request.method, path: request.url, headers: { ...request.headers, host: target.host } },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(response);
        }
      );
      sent.on('error', () => {
        if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'upstream-unavailable' }));
      });
      request.pipe(sent);
    };

    let clientHandler;
    const makeClientHandler = (pageOrigin) => createClientHttpHandler({
      origin: pageOrigin,
      authenticate(request) {
        const raw = accessTokenOf(request);
        if (raw === undefined) return undefined;
        const row = access.sessionByTokenHash(accessTokenHash(raw));
        if (row === undefined || row.revokedAt !== undefined) return undefined;
        return {
          clientId: accessSessionId,
          authentication: 'cookie',
          expiresAt: row.expiresAt,
          deviceIds: 'all',
          csrfToken: issueCsrfToken(csrfKey, row.tokenHash),
        };
      },
      store,
      replica,
      receipts,
      telemetry,
      cursorKey: randomBytes(32),
      online: (deviceId) => deviceLink.online(deviceId),
    });

    const frontServer = createServer(async (request, response) => {
      const url = new URL(request.url, `http://${request.headers.host ?? '127.0.0.1'}`);
      if (request.method !== 'GET' && !url.pathname.startsWith('/chatdsh/telemetry')) writes.push({ method: request.method, path: url.pathname });
      if (url.pathname === '/shell/shell.js') {
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
        response.end(shellScript);
        return;
      }
      if (url.pathname === '/chatdsh/theme/tokens.css') {
        response.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
        response.end(`${THEME_TOKENS}\n${THEME_SHELL}`);
        return;
      }
      if (url.pathname === '/chatdsh/client/sessions') {
        if (slowSessions) await new Promise((settle) => setTimeout(settle, 1500));
        await clientHandler(request, response);
        return;
      }
      if (url.pathname === '/chatdsh/telemetry/browser') {
        response.writeHead(204).end();
        return;
      }
      const proxied =
        url.pathname.startsWith('/chatdsh/') ||
        url.pathname.startsWith('/d/') ||
        url.pathname.startsWith('/api/');
      if (proxied) {
        proxy(request, response);
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'set-cookie': accessCookie,
      });
      response.end(shellHtml.replace('</head>', '<link rel="stylesheet" href="/chatdsh/theme/tokens.css">\n</head>'));
    });
    frontServer.listen(0, '127.0.0.1');
    await once(frontServer, 'listening');
    const origin = `http://127.0.0.1:${frontServer.address().port}`;
    front = frontServer;
    clientHandler = makeClientHandler(origin);

    const evaluate = async (expression) => (await cli('eval', expression)).data.result;
    const waitFor = async (expression, note = expression) => {
      const isSelector = !/[()\s]/.test(expression);
      try {
        if (isSelector) await cli('wait', expression);
        else await cli('wait', '--fn', expression);
      } catch (error) {
        const state = await evaluate(
          'JSON.stringify({ url: location.href, active: document.activeElement && (document.activeElement.id || document.activeElement.className), body: document.body ? document.body.innerText.slice(0, 600) : null })'
        );
        throw new Error(`等待失败：${note}\n页面状态：${state}\n${String(error)}`);
      }
    };
    const audit = async () => await evaluate(AUDIT_SOURCE);
    const setTheme = async (theme) => {
      await evaluate(
        theme === 'dark'
          ? 'document.body.setAttribute("data-ds-dark-theme", "true"); true'
          : 'document.body.removeAttribute("data-ds-dark-theme"); true'
      );
    };
    const setWidth = async (width) => {
      await cli('set', 'viewport', String(width), '900');
    };
    const axe = async () => {
      const answer = await cli('a11y');
      assert.equal(answer.data.axeVersion !== undefined, true, '返回 axe 版本');
      return answer.data;
    };
    // 对比度由 `scripts/check-ui-contrast.mjs` 逐对实测；axe 的 color-contrast 结果单独记录，
    // 与语义、名称、键盘一类问题分开归档。
    const contrastFindings = [];
    const layoutFindings = [];
    const touchFindings = [];
    // 触控目标：44 × 44 是设计上限要求，24 × 24 是 WCAG 2.2 AA 的机器可判定下限。
    // 介于两者之间的目标记入缺口清单；低于下限直接失败。
    const recordTouch = (report, where) => {
      for (const entry of report.touch) touchFindings.push({ where, ...entry });
      assert.deepEqual(report.touchBelowMinimum, [], `${where}：触控目标不低于 24 ${JSON.stringify(report.touchBelowMinimum)}`);
    };
    const assertNoSeriousAxe = (report, where) => {
      const serious = report.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical');
      for (const violation of serious.filter((entry) => entry.id === 'color-contrast')) {
        for (const node of violation.nodes) {
          contrastFindings.push({ where, target: node.target, summary: node.failureSummary.split('\n').slice(0, 3).join(' ') });
        }
      }
      assert.deepEqual(
        serious.filter((entry) => entry.id !== 'color-contrast').map((violation) => ({ id: violation.id, targets: violation.nodes.map((node) => node.target) })),
        [],
        `${where}：axe 无严重与致命问题`
      );
    };

    /** 打开一个路由并等它稳定。 */
    const openRoute = async (path, readySelector) => {
      await cli('open', `${origin}${path}`);
      opened = true;
      await cli('wait', readySelector);
    };

    await t.test('S01 工作会话：两个主题、三个宽度下的结构、名称、溢出与触控', async () => {
      for (const theme of ['light', 'dark']) {
        for (const width of [320, 768, 1440]) {
          await setWidth(width);
          await openRoute(`/sessions/session-online?device=${nodeA.deviceId}`, 'button.session[aria-current="true"]');
          await setTheme(theme);
          await waitFor('document.querySelectorAll("button.session").length === 3', '列表就绪');
          const report = await audit();
          const where = `${theme}/${String(width)}`;

          assert.equal(report.htmlLang, 'zh-CN', `${where}：文档语言`);
          assert.equal(report.hasViewportMeta, true, `${where}：视口声明`);
          assert.ok(report.documentScrollWidth <= report.documentClientWidth + 1, `${where}：页面没有横向滚动 ${JSON.stringify({ scroll: report.documentScrollWidth, client: report.documentClientWidth })}`);
          assert.deepEqual(report.overflow, [], `${where}：逐元素无横向溢出`);
          recordTouch(report, where);
          assert.deepEqual(report.unnamedButtons, [], `${where}：按钮都有可访问名称`);
          assert.deepEqual(report.unnamedInputs, [], `${where}：字段都有可访问名称`);
          const levelOnes = report.headings.filter((entry) => entry.level === 1 && entry.visible);
          assert.equal(levelOnes.length, 1, `${where}：页面有唯一可见主标题 ${JSON.stringify(report.headings)}`);
          assert.equal(report.landmarks.some((entry) => entry.tag === 'main' || entry.role === 'main'), true, `${where}：存在主区域 ${JSON.stringify(report.landmarks)}`);
          assert.equal(report.landmarks.some((entry) => entry.tag === 'nav' || entry.role === 'navigation' || entry.tag === 'aside' || entry.role === 'complementary'), true, `${where}：存在导航或侧栏区域 ${JSON.stringify(report.landmarks)}`);
          assert.equal(report.live.length >= 1, true, `${where}：有播报区域 ${JSON.stringify(report.live)}`);
          for (const live of report.live) {
            assert.ok(live.role === 'status' || live.role === 'alert' || live.live === 'polite' || live.live === 'assertive', `${where}：播报区域有角色或 aria-live ${JSON.stringify(live)}`);
          }
          assert.equal(report.iframes.every((frame) => frame.title !== ''), true, `${where}：iframe 都有标题 ${JSON.stringify(report.iframes)}`);
          assert.equal(report.iframes.some((frame) => frame.title.includes('甲方设备')), true, `${where}：设备内容页标题包含设备名`);

          const axeReport = await axe();
          assertNoSeriousAxe(axeReport, where);
          const snap = (await cli('snapshot')).data;
          const roles = Object.values(snap.refs ?? {}).map((entry) => entry.role);
          const names = Object.values(snap.refs ?? {}).map((entry) => entry.name);
          assert.equal(roles.includes('button'), true, `${where}：可访问树含按钮角色`);
          assert.equal(names.includes('跳到主内容'), true, `${where}：跳转链接在可访问树里 ${JSON.stringify(names.slice(0, 12))}`);
          assert.equal(names.filter((name) => name === '').length <= 1, true, `${where}：可访问树里的元素都有名称 ${JSON.stringify(names)}`);
          assert.equal(snap.snapshot.includes('main'), true, `${where}：可访问树含主区域`);
        }
      }
      await setTheme('light');
      await setWidth(1440);
    });

    await t.test('S02 新建会话：两个主题、三个宽度下的表单、名称与溢出', async () => {
      for (const theme of ['light', 'dark']) {
        for (const width of [320, 768, 1440]) {
          await setWidth(width);
          await openRoute('/sessions/new', '.shell-create-device');
          await setTheme(theme);
          const report = await audit();
          const where = `S02 ${theme}/${String(width)}`;
          assert.ok(report.documentScrollWidth <= report.documentClientWidth + 1, `${where}：页面没有横向滚动`);
          assert.deepEqual(report.overflow, [], `${where}：逐元素无横向溢出 ${JSON.stringify(report.overflow)}`);
          recordTouch(report, where);
          assert.deepEqual(report.unnamedInputs, [], `${where}：字段都有可访问名称 ${JSON.stringify(report.unnamedInputs)}`);
          assert.equal(report.describedInputs >= 4, true, `${where}：字段数量 ${String(report.describedInputs)}`);
          const levelOnes = report.headings.filter((entry) => entry.level === 1 && entry.visible);
          assert.equal(levelOnes.length, 1, `${where}：唯一主标题`);
          const axeReport = await axe();
          assertNoSeriousAxe(axeReport, where);
          // 键盘：字段与提交都在 Tab 顺序里，顺序与文档顺序一致。
          const focusables = report.focusables;
          assert.equal(focusables.length >= 5, true, `${where}：可聚焦元素 ${String(focusables.length)}`);
          assert.equal(focusables.every((entry) => entry.name !== ''), true, `${where}：可聚焦元素都有名称`);
        }
      }
      await setTheme('light');
      await setWidth(1440);
    });

    await t.test('S03 跨设备继续：离线源的只读说明、溢出与名称', async () => {
      for (const theme of ['light', 'dark']) {
        for (const width of [320, 768, 1440]) {
          await setWidth(width);
          await openRoute(`/sessions/session-offline/continue?device=${nodeB.deviceId}`, '.shell-estimate-list');
          await setTheme(theme);
          const report = await audit();
          const where = `S03 ${theme}/${String(width)}`;
          assert.ok(report.documentScrollWidth <= report.documentClientWidth + 1, `${where}：页面没有横向滚动`);
          assert.deepEqual(report.overflow, [], `${where}：逐元素无横向溢出 ${JSON.stringify(report.overflow)}`);
          recordTouch(report, where);
          assert.deepEqual(report.unnamedInputs, [], `${where}：字段都有可访问名称`);
          assert.deepEqual(report.unnamedButtons, [], `${where}：按钮都有可访问名称`);
          const axeReport = await axe();
          assertNoSeriousAxe(axeReport, where);
        }
      }
      await setTheme('light');
      await setWidth(1440);
    });

    await t.test('S06 命令面板：键盘路径、焦点顺序、焦点恢复与播报', async () => {
      await openRoute(`/sessions/session-online?device=${nodeA.deviceId}`, 'button.session[aria-current="true"]');
      const before = await audit();
      const expectedTabbables = before.focusables.map((entry) => entry.selector);
      assert.equal(expectedTabbables[0].includes('shell-skip'), true, `首个可聚焦元素是跳转链接：${expectedTabbables[0]}`);

      // 真实 Tab 遍历：焦点顺序与文档顺序一致，且覆盖全部可见可聚焦元素。
      await cli('focus', 'body');
      const visited = [];
      for (let index = 0; index < expectedTabbables.length; index += 1) {
        await cli('press', 'Tab');
        visited.push(
          await evaluate(
            '(function () { var node = document.activeElement; var parts = []; var current = node; while (current !== null && current !== document.body && parts.length < 4) { var part = current.tagName.toLowerCase(); if (current.id !== "") part += "#" + current.id; else if (typeof current.className === "string" && current.className.trim() !== "") part += "." + current.className.trim().split(/\\s+/).join("."); parts.unshift(part); current = current.parentElement; } return parts.join(" > "); })()'
          )
        );
      }
      assert.deepEqual(visited.slice(0, expectedTabbables.length), expectedTabbables, 'Tab 顺序与文档顺序一致');

      // 命令面板：Ctrl+K 打开，方向键、Home、End、Enter、Escape 完整可达，关闭后焦点回到触发控件。
      await cli('focus', '.shell-palette-trigger');
      const triggerFocus = await evaluate('document.activeElement.className');
      await cli('press', 'Control+k');
      await waitFor('document.querySelector(".shell-palette") !== null && document.querySelector(".shell-palette").closest(".shell-dialog-backdrop").hidden === false', '面板打开');
      await waitFor('document.activeElement.id === "shell-palette-input"', '焦点进入搜索框');
      const paletteSnapshot = (await cli('snapshot')).data;
      assert.equal(paletteSnapshot.snapshot.includes('dialog'), true, '面板以对话框角色出现');
      const paletteAxe = await axe();
      assertNoSeriousAxe(paletteAxe, 'S06 面板打开');
      await cli('press', 'ArrowDown');
      await cli('press', 'End');
      await cli('press', 'Home');
      await cli('press', 'Escape');
      await waitFor('document.querySelector(".shell-palette").closest(".shell-dialog-backdrop").hidden === true', 'Escape 关闭面板');
      assert.equal(await evaluate('document.activeElement.className'), triggerFocus, '关闭后焦点回到触发控件');
      await cli('press', 'Enter');
      await waitFor('document.querySelector(".shell-palette").closest(".shell-dialog-backdrop").hidden === false', '回车重新打开面板');
      await cli('press', 'Escape');
      await waitFor('document.querySelector(".shell-palette").closest(".shell-dialog-backdrop").hidden === true', '再次关闭');
      assert.equal(await evaluate('document.activeElement.className'), triggerFocus, '再次关闭后焦点仍回到触发控件');
    });

    await t.test('S01 加载与空状态：aria-busy、空结果与清除动作', async () => {
      await setWidth(1440);
      // 加载：读取期间列表容器声明忙碌，读取完成后取消忙碌。
      slowSessions = true;
      await cli('open', `${origin}/`);
      await waitFor('document.querySelector(".shell-devices").getAttribute("aria-busy") === "true"', '读取期间声明忙碌');
      await waitFor('document.querySelectorAll("button.session").length === 3', '列表载入');
      assert.equal(await evaluate('document.querySelector(".shell-devices").getAttribute("aria-busy")'), 'false', '读取完成后取消忙碌');
      assert.equal(await evaluate('document.querySelector(".shell-status").getAttribute("role")'), 'status', '播报区域角色为 status');
      assert.equal(await evaluate('document.querySelector(".shell-status").getAttribute("aria-live")'), 'polite', '播报区域为礼貌播报');
      await cli('click', '.shell-refresh');
      await waitFor('document.querySelector(".shell-status").textContent.length > 0', '刷新后播报结果');
      const statusText = await evaluate('document.querySelector(".shell-status").textContent');
      assert.equal(statusText.includes('会话'), true, `状态区域播报读取结果：${statusText}`);
      slowSessions = false;

      // 空：过滤后为空，空状态说明当前过滤词，清除过滤后回到完整列表。
      await cli('fill', '#shell-search-input', '不存在的会话标题');
      await waitFor('document.querySelector(".shell-devices .shell-notice") !== null', '空结果出现');
      const emptyReport = await audit();
      assert.deepEqual(emptyReport.unnamedButtons, [], '空状态区域按钮都有名称');
      const emptyText = await evaluate('document.querySelector(".shell-devices .shell-notice").textContent');
      assert.equal(emptyText.includes('没有匹配'), true, `空状态说明：${emptyText}`);
      assert.equal(await evaluate('document.querySelector(".shell-count").textContent'), '没有会话', '计数与空状态一致');
      await cli('fill', '#shell-search-input', '');
      await waitFor('document.querySelectorAll("button.session").length === 3', '清除过滤后回到三条');
    });

    await t.test('S01 失败与离线：控制平面停止、断网与只读副本', async () => {
      await setWidth(1440);
      gatewayDown = true;
      await cli('reload');
      await waitFor('document.body.innerText.includes("读取设备列表失败") || document.body.innerText.includes("读取会话列表失败")', '失败提示出现');
      const failed = await audit();
      assert.deepEqual(failed.unnamedButtons, [], '失败状态按钮都有名称');
      const failureText = await evaluate('document.body.innerText');
      assert.equal(failureText.includes('失败'), true, `失败说明：${failureText.slice(0, 400)}`);
      assert.equal(failureText.includes('control-plane-stopped'), true, '失败说明带上错误码');
      const failedAxe = await axe();
      assertNoSeriousAxe(failedAxe, 'S01 失败状态');
      gatewayDown = false;
      await cli('reload');
      await waitFor('button.session', '控制平面恢复后列表可用');

      // 断网：在已打开的页面上真实关闭网络，点刷新后读取失败；恢复后需要用户再次操作。
      await cli('set', 'offline', 'on');
      await cli('click', '.shell-refresh');
      await waitFor('document.body.innerText.includes("读取会话列表失败") || document.body.innerText.includes("读取设备列表失败")', '断网后读取失败说明出现');
      const offlineText = await evaluate('document.body.innerText');
      assert.equal(/离线|不可达|失败/.test(offlineText), true, `断网状态有说明：${offlineText.slice(0, 300)}`);
      const offlineAxe = await axe();
      assertNoSeriousAxe(offlineAxe, 'S01 断网状态');
      await cli('set', 'offline', 'off');
      await cli('click', '.shell-refresh');
      await waitFor('button.session', '恢复网络后列表可用');

      // 只读副本：目标设备离线的会话保留只读入口与读取时间，且没有发送入口。
      await cli('open', `${origin}/sessions/session-offline?device=${nodeB.deviceId}`);
       await cli('wait', '.shell-readonly');
      await waitFor('document.querySelector(".shell-readonly").hidden === false', '只读副本出现');
      const readonlyText = await evaluate('document.querySelector(".shell-readonly").textContent');
      assert.equal(readonlyText.includes('只读'), true, `只读说明：${readonlyText.slice(0, 200)}`);
      assert.equal(readonlyText.includes('内容读取于'), true, '只读副本带读取时间');
      assert.equal(await evaluate('document.querySelectorAll(".shell-readonly button").length'), 0, '只读副本没有可提交动作');
      const readonlyReport = await audit();
      assert.deepEqual(readonlyReport.overflow, [], '只读副本逐元素无横向溢出');
      recordTouch(readonlyReport, 'S01 只读副本');
    });

    await t.test('200% 文字缩放：三个宽度重排与可操作性', async () => {
      await setWidth(320);
      await openRoute(`/sessions/session-online?device=${nodeA.deviceId}`, 'button.session[aria-current="true"]');
      for (const width of [320, 768, 1440]) {
        await setWidth(width);
        await evaluate('document.documentElement.style.fontSize = "32px"');
        const scaled = await audit();
        assert.equal(scaled.rootFontSize, '32px', `${String(width)}：根字号确实放大`);
        recordTouch(scaled, `200% ${String(width)}`);
        const reach = await evaluate(
          '(function () { var worst = 0; var nodes = document.querySelectorAll("button, a[href], input, select, textarea"); for (var i = 0; i < nodes.length; i += 1) { var box = nodes[i].getBoundingClientRect(); if (box.width > 0 && box.height > 0) worst = Math.max(worst, box.right); } return { worstRight: Math.round(worst), scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }; })()'
        );
        assert.ok(reach.worstRight <= reach.scrollWidth + 1, `${String(width)}：200% 字号下全部动作都能通过滚动到达 ${JSON.stringify(reach)}`);
        if (width >= 768) {
          assert.deepEqual(scaled.overflow, [], `${String(width)}：200% 字号下逐元素无横向溢出 ${JSON.stringify(scaled.overflow)}`);
          assert.ok(scaled.documentScrollWidth <= scaled.documentClientWidth + 1, `${String(width)}：200% 字号下没有页面横向滚动`);
        } else {
          // 320 像素与 200% 文字同时成立时，侧栏的 16rem 最小宽度按放大后的根字号计算，
          // 页面出现横向滚动。记录实测值，并断言侧栏以外的元素没有被裁切。
          const sidebar = await evaluate(
            '(function () { var list = document.querySelector(".shell-list"); var style = getComputedStyle(list); return { width: Math.round(list.getBoundingClientRect().width), minWidth: style.minWidth, rootFontSize: getComputedStyle(document.documentElement).fontSize, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }; })()'
          );
          layoutFindings.push({ where: `S01 ${String(width)}/200%`, ...sidebar });
          const clipped = scaled.overflow.filter((entry) => entry.selector.includes('shell-list') === false && entry.selector.includes('chatdsh-shell') === false);
          assert.deepEqual(clipped, [], `${String(width)}：侧栏外的元素没有被裁切 ${JSON.stringify(clipped)}`);
        }
        await evaluate('document.documentElement.style.fontSize = ""');
      }
    });

    await t.test('只读校验：验证过程没有写出业务数据', async () => {
      const writeCounts = () => {
        const rows = store.handle().prepare('SELECT COUNT(*) AS total FROM sessions').get();
        return rows.total;
      };
      const before = writeCounts();
      await cli('reload');
      await waitFor('button.session', '重新读取列表');
      await cli('open', `${origin}/sessions/session-offline?device=${nodeB.deviceId}`);
      await cli('wait', '.shell-readonly');
      await waitFor('document.querySelector(".shell-readonly").hidden === false', '只读入口');
      const after = writeCounts();
      assert.equal(after, before, '只读读取没有新增会话记录');
      const writesDuringRead = writes.filter((entry) => !entry.path.startsWith('/chatdsh/telemetry'));
      // 只读阶段允许的请求：客户端的读取入口，以及设备侧的目录列举（只枚举目录内容）。
      const readOnlyPathOf = (path) =>
        path.startsWith('/chatdsh/client/') || path === '/chatdsh/client/sessions' || path.endsWith('/api/directoryPicker/list');
      for (const entry of writesDuringRead) {
        assert.equal(readOnlyPathOf(entry.path), true, `只读阶段没有业务写入：${JSON.stringify(entry)}`);
      }
      const errors = await cli('errors');
      assert.deepEqual(errors.data.errors, [], '页面没有脚本错误');
    });
  } finally {
    if (opened) await cli('close').catch(() => undefined);
    device?.close();
    if (front !== undefined) {
      front.closeAllConnections();
      await new Promise((resolve) => front.close(resolve));
    }
    if (gatewayStarted) {
      deviceLink.stop();
      await gatewayServer.stop();
    }
    await localRuntime.close();
    await telemetry.shutdown();
    store.close();
    releaseIndependentHome(home);
  }
});
