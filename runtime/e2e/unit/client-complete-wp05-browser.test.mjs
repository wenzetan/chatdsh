// WP05 的真实浏览器验收：逻辑路由、历史导航、离线只读副本、草稿与键盘焦点。
//
// 页面用 esbuild 打包真实外壳源码（`packages/client/shell/src/client/index.ts`），由真实的
// 控制平面 `createGatewayServer` 与真实的私有读取入口 `createClientHttpHandler` 提供数据。
// 浏览器是 agent-browser 独立会话里的真实 Chrome，使用独立 HOME、TMPDIR 与 profile，不截图，
// 断言全部来自 DOM、可访问属性、地址与请求记录。
//
// 两个测试宿主的说明：
//   1. 前置服务把根路径、`/sessions/*`、`/settings/*`、`/diagnostics` 都交给同一个外壳页面。
//      生产里这些逻辑路径由 WP39 在公共路由上挂载；外壳的逻辑路由与深链接恢复不依赖它。
//   2. `/d/<deviceId>/` 的内容页由真实设备长连接上的测试设备进程提供，它按设备协议回真实帧，
//      并在页面脚本里按导航契约（版本 1、请求标识、目标设备与会话）确认选中。设备内容端的
//      导航桥由 WP06 交付，这里用最小真实页面代为确认。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
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

/** 设备长连接上的测试设备：按设备协议回答内容页、目录列举与创建会话。 */
class ShellDevicePeer {
  constructor(deviceId, token, url) {
    this.deviceId = deviceId;
    this.paths = [];
    this.createdSessions = 0;
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
        this.paths.push(frame.path);
        const answer = this.answer(frame);
        this.reply(frame.requestId, answer.status, answer.body, answer.type);
      });
    });
  }

  /** 按路径回答一次请求。 */
  answer(frame) {
    const raw = frame.body === undefined ? '' : Buffer.from(frame.body, 'base64').toString('utf8');
    const url = new URL(frame.path, 'http://device.invalid');
    if (url.pathname === '/') return { status: 200, body: DEVICE_PAGE, type: 'text/html; charset=utf-8' };
    if (url.pathname === '/api/directoryPicker/list') {
      const envelope = JSON.parse(raw);
      const listing = {
        path: '/work/alpha',
        home: '/home/acceptance',
        crumbs: [
          { name: '/', path: '/', hidden: false },
          { name: 'work', path: '/work', hidden: false },
          { name: 'alpha', path: '/work/alpha', hidden: false },
        ],
        entries: [{ name: 'src', path: '/work/alpha/src', hidden: false }],
        truncated: false,
      };
      return {
        status: 200,
        type: 'application/json; charset=utf-8',
        body: JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: listing } }),
      };
    }
    if (url.pathname === '/api/session/create') {
      const envelope = JSON.parse(raw);
      this.createdSessions += 1;
      const sessionId = `created-peer-${String(this.createdSessions)}`;
      return {
        status: 200,
        type: 'application/json; charset=utf-8',
        body: JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: { sessionId } } }),
      };
    }
    return { status: 404, type: 'application/json; charset=utf-8', body: JSON.stringify({ error: 'not-found' }) };
  }

  /** 回一帧响应。 */
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

/** 本机运行时的测试宿主：按设备协议回答目录列举，供「在本机继续」选择目录。 */
async function startLocalRuntime() {
  const calls = [];
  const listingPath = '/workspace/chatdsh';
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

test('真实 Chrome：逻辑路由、历史导航、离线只读副本、草稿与键盘焦点', { timeout: 300000 }, async (t) => {
  const home = allocateIndependentHome('wp05-browser');
  const session = `wp05-${randomUUID().slice(0, 8)}`;
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
  const localRuntime = await startLocalRuntime();
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
      pairingCode: 'pair-wp05',
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
  let clientHandler;
  let gatewayStarted = false;
  let opened = false;
  const postCount = { value: 0 };
  const telemetryBatches = [];

  try {
    await gatewayServer.start();
    gatewayStarted = true;
    const gatewayUrl = gatewayServer.url();
    const pair = async (name, role = 'executor') => {
      const response = await fetch(`${gatewayUrl}/chatdsh/gateway/devices/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: 'pair-wp05', name, platform: 'linux', role, capabilities: [] }),
      });
      assert.equal(response.status, 200);
      const payload = await response.json();
      return { deviceId: payload.deviceId, token: payload.token };
    };
    const nodeA = await pair('甲方设备');
    const nodeB = await pair('乙方设备');
    const nodeLocal = await pair('本机运行时', 'both');
    device = new ShellDevicePeer(nodeA.deviceId, nodeA.token, `${gatewayUrl.replace('http', 'ws')}/chatdsh/gateway/device-link`);
    await device.opened;

    /**
     * 登记一条归属并写入真实副本事件。
     *
     * 归属直接写真实存储：控制平面的归属端点只在目标设备在线时接受新建（离线设备会被 409 拒绝），
     * 而这里需要构造一台离线设备已经拥有的会话。副本仍经真实 HTTP 端点追加。
     */
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
        events.push({
          seq,
          kind: 'assistant/message',
          time: input.time + 2 + index,
          bytes: 32,
          payload: { seq, type: 'assistant/message', time: input.time + 2 + index, data: { text: `回答${String(index)}` } },
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
    await seed({ sessionId: 'session-online', deviceId: nodeA.deviceId, cwd: '/work/alpha', title: '甲设备上的 alpha', time: now - 3000, user: '在线时的问题', assistants: 3 });
    await seed({ sessionId: 'session-offline', deviceId: nodeB.deviceId, cwd: '/home/other/alpha', title: '乙设备上的 alpha', time: now - 2000, user: '离线时要读的内容', assistants: 1 });
    await seed({ sessionId: 'session-beta', deviceId: nodeB.deviceId, cwd: '/work/beta', title: '乙设备上的 beta', time: now - 1000, assistants: 0 });

    const bundle = await build({
      entryPoints: [new URL('packages/client/shell/src/client/index.ts', ROOT).pathname],
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      target: 'es2022',
      loader: { '.css': 'text' },
      logLevel: 'warning',
    });
    const shellScript = bundle.outputFiles[0].text;
    assert.ok(shellScript.length > 20_000, `外壳脚本大小异常：${String(shellScript.length)}`);
    const shellHtml = renderShellPage();
    const accessCookie = serializeAccessCookie(accessToken, 3600);

    /** 把非外壳路径转发给真实控制平面。 */
    const proxy = (request, response) => {
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

    const frontServer = createServer(async (request, response) => {
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (request.method !== 'GET' && url.pathname !== '/chatdsh/telemetry/browser') postCount.value += 1;
      if (url.pathname === '/shell/shell.js') {
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
        response.end(shellScript);
        return;
      }
      if (url.pathname === '/chatdsh/client/sessions') {
        const handled = await clientHandler(request, response);
        assert.equal(handled, true);
        return;
      }
      if (url.pathname === '/chatdsh/telemetry/browser') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        telemetryBatches.push({
          signal: request.headers['x-chatdsh-signal'],
          body: chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8')),
        });
        response.writeHead(204).end();
        return;
      }
      const proxied =
        url.pathname.startsWith('/chatdsh/') ||
        url.pathname.startsWith('/d/') ||
        url.pathname.startsWith('/api/') ||
        url.pathname.startsWith('/s/') ||
        url.pathname === '/healthz';
      if (proxied) {
        proxy(request, response);
        return;
      }
      // 逻辑路径与未知路径都交给外壳页面：未知路径由外壳显示错误并可返回列表。
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'set-cookie': accessCookie,
      });
      response.end(shellHtml);
    });
    frontServer.listen(0, '127.0.0.1');
    await once(frontServer, 'listening');
    const origin = `http://127.0.0.1:${frontServer.address().port}`;
    front = frontServer;
    clientHandler = createClientHttpHandler({
      origin,
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

    const evaluate = async (expression) => (await cli('eval', expression)).data.result;
    const waitFor = async (expression) => {
      try {
        await cli('wait', '--fn', expression);
      } catch (error) {
        const state = await evaluate(
          'JSON.stringify({ url: location.href, active: document.activeElement && (document.activeElement.id || document.activeElement.className), palette: document.querySelectorAll(".shell-palette").length, backdrops: [...document.querySelectorAll(".shell-dialog-backdrop")].map((node) => node.hidden), errors: window.__wp05Errors || null })'
        );
        throw new Error(`等待失败：${expression}\n页面状态：${state}\n${String(error)}`);
      }
    };
    await evaluate('window.__wp05Errors = []; window.addEventListener("error", (event) => window.__wp05Errors.push(String(event.message))); window.addEventListener("unhandledrejection", (event) => window.__wp05Errors.push("rejection:" + String(event.reason))); true');

    // 1. 深链接：地址里的会话与设备直接还原成同一个对象。
    await cli('open', `${origin}/sessions/session-online?device=${nodeA.deviceId}`);
    opened = true;
    await cli('wait', 'button.session[aria-current="true"]');
    assert.equal(await evaluate('location.pathname'), '/sessions/session-online');
    assert.equal(await evaluate('location.search'), `?device=${nodeA.deviceId}`);
    assert.equal(
      await evaluate('document.querySelector("button.session[aria-current=true]").dataset.sessionId'),
      'session-online'
    );
    assert.equal(await evaluate('document.querySelector(".shell-iframe").hidden'), false);

    // 2. 同名工作区区分：两台设备的 alpha 目录在同一工作区节点下，条目显示设备与完整路径。
    const workspaceNote = await evaluate('[...document.querySelectorAll(".workspace-note")].map((node) => node.textContent)');
    assert.equal(workspaceNote.some((text) => text.includes('同名工作区')), true, JSON.stringify(workspaceNote));
    const entryPaths = await evaluate('[...document.querySelectorAll(".entry-path")].map((node) => node.textContent)');
    assert.deepEqual(entryPaths.sort(), ['/home/other/alpha', '/work/alpha', '/work/beta']);
    const deviceLabels = await evaluate('[...document.querySelectorAll(".entry-device")].map((node) => node.textContent)');
    assert.deepEqual([...new Set(deviceLabels)].sort(), ['乙方设备', '甲方设备']);

    // 3. 导航消息：版本、请求标识、目标设备与会话都正确，内容端确认后不再显示等待提示。
    await waitFor('document.querySelector("iframe").contentWindow.__navMessages.length > 0');
    const nav = await evaluate('document.querySelector("iframe").contentWindow.__navMessages[0]');
    assert.equal(nav.action, 'navigate');
    assert.equal(nav.version, 1);
    assert.equal(nav.deviceId, nodeA.deviceId);
    assert.equal(nav.sessionId, 'session-online');
    await waitFor('document.querySelector(".shell-frame-note").hidden === true');
    await waitFor('document.querySelector("iframe").contentWindow.__navMessages.length === 1');

    // 4. 离线会话：只读副本入口可见并带读取时间与内容片段，输入区保留草稿。
    await cli('click', 'button[data-session-id="session-offline"]');
    await cli('wait', '.shell-readonly:not([hidden])');
    assert.equal(await evaluate('location.pathname'), '/sessions/session-offline');
    assert.equal(await evaluate('location.search'), `?device=${nodeB.deviceId}`);
    const readonlyText = await evaluate('document.querySelector(".shell-readonly-body").textContent');
    assert.equal(readonlyText.includes('只读'), true, readonlyText);
    assert.equal(readonlyText.includes('内容读取于'), true, readonlyText);
    assert.equal(readonlyText.includes('离线时要读的内容'), true, readonlyText);
    assert.equal(await evaluate('document.querySelector(".shell-iframe").hidden'), true);
    assert.equal(await evaluate('document.querySelector(".shell-draft").hidden'), false);
    assert.equal(await evaluate('document.querySelector(".shell-draft").getAttribute("aria-label")'), '草稿');

    // 5. 草稿：输入即保存到本机；发送立即失败、保留输入、不发出任何写请求。
    await cli('fill', '#shell-draft-input', '离线草稿内容');
    await waitFor('document.querySelector(".shell-draft-status").textContent.includes("草稿已保存在本机")');
    const beforeSend = postCount.value;
    await cli('click', '.shell-draft-send');
    await waitFor('document.querySelector(".shell-draft-status").textContent.includes("发送失败")');
    assert.equal(await evaluate('document.querySelector(".shell-draft-status").textContent'), '目标设备离线，发送失败，草稿已保留');
    assert.equal(await evaluate('document.querySelector("#shell-draft-input").value'), '离线草稿内容');
    assert.equal(postCount.value, beforeSend, '离线发送没有发出任何写入请求');
    const draftKeys = await evaluate('Object.keys(localStorage).filter((key) => key.startsWith("chatdsh-shell.draft.v1:"))');
    assert.equal(draftKeys.length, 1, JSON.stringify(draftKeys));
    assert.equal(
      draftKeys[0],
      `chatdsh-shell.draft.v1:${await evaluate('localStorage.getItem("chatdsh-shell.client.v1")')}:${await evaluate('sessionStorage.getItem("chatdsh-shell.window.v1")')}:${nodeB.deviceId}:session-offline`,
      '草稿按客户端、窗口、设备与会话保存'
    );

    // 6. 换设备再换回：各自的草稿分别恢复。
    await cli('click', 'button[data-session-id="session-online"]');
    await waitFor('document.querySelector(".shell-draft").hidden === true');
    assert.equal(await evaluate('document.querySelector("#shell-draft-input").value'), '');
    await cli('click', 'button[data-session-id="session-offline"]');
    await waitFor('document.querySelector("#shell-draft-input").value === "离线草稿内容"');

    // 7. 刷新：同一窗口的标识保持稳定，草稿恢复。
    await cli('reload');
    await waitFor('document.querySelector("#shell-draft-input") !== null && document.querySelector("#shell-draft-input").value === "离线草稿内容"');

    // 8. 前进后退：同一个对象随浏览器历史恢复。
    await cli('click', 'button[data-session-id="session-beta"]');
    await waitFor('location.pathname === "/sessions/session-beta"');
    await cli('back');
    await waitFor('location.pathname === "/sessions/session-offline"');
    assert.equal(await evaluate('document.querySelector("button.session[aria-current=true]").dataset.sessionId'), 'session-offline');
    await cli('forward');
    await waitFor('location.pathname === "/sessions/session-beta"');
    assert.equal(await evaluate('document.querySelector("button.session[aria-current=true]").dataset.sessionId'), 'session-beta');

    // 9. 非法路径：显示错误并可返回列表。
    await cli('open', `${origin}/no-such-page`);
    await waitFor('document.querySelector(".shell-route-error") !== null && !document.querySelector(".shell-route-error").hidden');
    const errorText = await evaluate('document.querySelector(".shell-route-error").textContent');
    assert.equal(errorText.includes('无法识别的地址'), true, errorText);
    await cli('click', '.shell-route-error .shell-return-list');
    await waitFor('location.pathname === "/"');
    await cli('wait', 'button.session');

    // 9b. 筛选持久化：检索词与分组方式写进本机，刷新后仍然生效。
    await cli('fill', '#shell-search-input', 'alpha');
    await waitFor('document.querySelectorAll("button.session").length === 2');
    await cli('select', '.shell-grouping', 'device');
    await waitFor('document.querySelectorAll(".workspace-header .device-state").length >= 1');
    await cli('reload');
    await waitFor('document.querySelector("#shell-search-input") !== null');
    assert.equal(await evaluate('document.querySelector("#shell-search-input").value'), 'alpha');
    assert.equal(await evaluate('document.querySelector(".shell-grouping").value'), 'device');
    assert.equal(await evaluate('document.querySelectorAll("button.session").length'), 2);
    const deviceGroupNames = await evaluate('[...document.querySelectorAll(".workspace-header .workspace-name")].map((node) => node.textContent)');
    assert.equal(deviceGroupNames.includes('甲方设备'), true, JSON.stringify(deviceGroupNames));
    await cli('select', '.shell-grouping', 'workspace');
    await cli('fill', '#shell-search-input', '');
    await waitFor('document.querySelectorAll("button.session").length === 3');

    // 10. 键盘：跳转链接、命令面板快捷键、方向键选择、Enter 执行、Escape 关闭并恢复焦点。
    await evaluate('window.__wp05Errors = []; window.addEventListener("error", (event) => window.__wp05Errors.push(String(event.message))); window.addEventListener("unhandledrejection", (event) => window.__wp05Errors.push("rejection:" + String(event.reason))); true');
    await cli('reload');
    await cli('wait', 'button.session');
    await cli('focus', 'body');
    await cli('press', 'Tab');
    assert.equal(await evaluate('document.activeElement.className'), 'shell-skip');
    assert.equal(await evaluate('document.activeElement.textContent'), '跳到主内容');
    await cli('press', 'Tab');
    assert.equal(await evaluate('document.activeElement.className'), 'shell-action shell-palette-trigger');
    await cli('press', 'Tab');
    assert.equal(await evaluate('document.activeElement.className'), 'shell-action shell-new');
    await cli('press', 'Shift+Tab');
    await cli('press', 'Shift+Tab');
    assert.equal(await evaluate('document.activeElement.textContent'), '跳到主内容');
    await cli('press', 'Enter');
    assert.equal(await evaluate('document.activeElement.id'), 'shell-main');
    // 用可见按钮打开面板：关闭后焦点回到该按钮。
    await cli('focus', '.shell-palette-trigger');
    await cli('press', 'Enter');
    await waitFor('document.querySelector(".shell-palette").closest(".shell-dialog-backdrop").hidden === false');
    await cli('press', 'Escape');
    await waitFor('document.querySelector(".shell-palette").closest(".shell-dialog-backdrop").hidden === true');
    assert.equal(await evaluate('document.activeElement.className'), 'shell-action shell-palette-trigger');
    // 快捷键打开：关闭后焦点回到打开它时的控件。
    const focusDescriptor = 'document.activeElement === document.body ? "body" : (document.activeElement.id || document.activeElement.className)';
    const focusBefore = await evaluate(focusDescriptor);
    await cli('press', 'Control+k');
    await waitFor('document.querySelector(".shell-palette") !== null');
    await waitFor('document.querySelector(".shell-palette").closest(".shell-dialog-backdrop").hidden === false');
    assert.equal(await evaluate('document.activeElement.id'), 'shell-palette-input');
    assert.equal(await evaluate('document.querySelectorAll(".shell-palette-item").length >= 20'), true);
    await cli('press', 'ArrowDown');
    assert.equal(await evaluate('document.querySelector(".shell-palette-item[aria-selected=true] .shell-palette-name").textContent'), '新建会话');
    await cli('press', 'End');
    assert.equal(await evaluate('document.querySelector(".shell-palette-item[aria-selected=true] .shell-palette-name").textContent'), '设置：诊断');
    await cli('press', 'Home');
    assert.equal(await evaluate('document.querySelector(".shell-palette-item[aria-selected=true] .shell-palette-name").textContent'), '会话列表');
    await cli('fill', '#shell-palette-input', '设备');
    await waitFor('document.querySelectorAll(".shell-palette-item").length > 0');
    const matches = await evaluate('[...document.querySelectorAll(".shell-palette-name")].map((node) => node.textContent)');
    assert.equal(matches.includes('设置：设备'), true, JSON.stringify(matches));
    await cli('press', 'Escape');
    await waitFor('document.querySelector(".shell-palette").closest(".shell-dialog-backdrop").hidden === true');
    assert.equal(await evaluate(focusDescriptor), focusBefore, '关闭面板后焦点回到打开它时的控件');

    await cli('press', 'Control+k');
    await waitFor('document.querySelector(".shell-palette").closest(".shell-dialog-backdrop").hidden === false');
    await cli('fill', '#shell-palette-input', '设置：通用');
    await waitFor('document.querySelectorAll(".shell-palette-item").length === 1');
    await cli('press', 'Enter');
    await waitFor('location.pathname === "/settings/general"');
    assert.equal(await evaluate('document.querySelector(".shell-page-title").textContent'), '设置：通用');
    assert.equal(await evaluate('document.querySelector(".shell-palette").closest(".shell-dialog-backdrop").hidden'), true);

    // 11. 继续确认：远程继续与 fork 预估来自真实副本；在本机继续真的建出带血缘的新会话。
    await cli('open', `${origin}/sessions/session-offline/continue?device=${nodeB.deviceId}`);
    await waitFor('document.querySelector(".shell-estimate-list") !== null');
    const estimateText = await evaluate('document.querySelector(".shell-estimate-list").textContent');
    assert.equal(estimateText.includes('复制事件'), true, estimateText);
    assert.equal(estimateText.includes('3 条'), true, estimateText, '标题、用户消息、助手消息三条事件');
    assert.equal(estimateText.includes('部分（源设备离线）'), true, estimateText);
    assert.equal(await evaluate('document.querySelector(".shell-continue-remote-confirm").disabled'), true, '源设备离线时远程继续禁用');
    await waitFor(`document.querySelector(".shell-continue-cwd").value === ${JSON.stringify(localRuntime.listingPath)}`);
    assert.equal(await evaluate('document.querySelector(".shell-continue-submit").disabled'), false);
    assert.equal(localRuntime.calls.length > 0, true, '本机目录经真实本机运行时列举');
    await cli('click', '.shell-continue-submit');
    await waitFor('location.pathname.startsWith("/sessions/") && !location.pathname.endsWith("/continue")');
    assert.equal(await evaluate('location.search'), `?device=${nodeLocal.deviceId}`);
    await waitFor('document.querySelector(".shell-status").textContent.includes("已在本机新开会话")');
    const forkSessionId = await evaluate('location.pathname.split("/").pop()');
    const fork = store.listSessions().find((entry) => entry.sessionId === forkSessionId);
    assert.equal(fork.parentSession, 'session-offline', '新会话保存源会话作为血缘');
    assert.equal(fork.deviceId, nodeLocal.deviceId, '新会话归属本机运行时');
    assert.equal(fork.cwd, localRuntime.listingPath, '新会话使用选择的本机目录');

    // 12. 创建向导：先选设备再浏览该设备目录，离线设备不可选，创建后跳到新会话。
    await cli('open', `${origin}/sessions/new`);
    await cli('wait', '.shell-create-device');
    const options = await evaluate('[...document.querySelectorAll(".shell-create-device option")].map((option) => ({ text: option.textContent, disabled: option.disabled }))');
    const optionsByText = new Map(options.map((option) => [option.text, option.disabled]));
    assert.deepEqual([...optionsByText.keys()].sort(), ['甲方设备', '乙方设备（离线）', '本机运行时（离线）'].sort());
    assert.equal(optionsByText.get('甲方设备'), false);
    assert.equal(optionsByText.get('乙方设备（离线）'), true);
    assert.equal(optionsByText.get('本机运行时（离线）'), true);
    await waitFor('document.querySelectorAll(".shell-listing-entry").length === 1');
    assert.equal(await evaluate('document.querySelector(".shell-create-cwd").value'), '/work/alpha');
    assert.equal(await evaluate('document.querySelector(".shell-listing-entry").textContent'), 'src');
    const beforeCreate = device.createdSessions;
    await cli('click', '.shell-create-submit');
    await waitFor('location.pathname.startsWith("/sessions/created-peer-")');
    assert.equal(await evaluate('location.search'), `?device=${nodeA.deviceId}`);
    assert.equal(device.createdSessions - beforeCreate, 1, '一次点击只创建一条会话');
    await waitFor('document.querySelector("button.session[aria-current=true]") !== null');

    // 13. 遥测：界面动作与调用 span 都经同源中继上报，名称取自登记的浏览器客户端信号。
    const attributeOf = (record, key) => record.attributes.find((attribute) => attribute.key === key)?.value.stringValue;
    const logActions = telemetryBatches
      .filter((batch) => batch.signal === 'logs')
      .flatMap((batch) => batch.body.resourceLogs.flatMap((entry) => entry.scopeLogs.flatMap((scope) => scope.logRecords)))
      .filter((record) => record.body.stringValue === 'chatdsh.client.ui.action')
      .map((record) => ({ action: attributeOf(record, 'action'), outcome: attributeOf(record, 'outcome') }));
    assert.equal(logActions.some((entry) => entry.action === 'route'), true, JSON.stringify(logActions.slice(0, 10)));
    assert.equal(logActions.some((entry) => entry.action === 'offline-send' && entry.outcome === 'rejected'), true);
    assert.equal(logActions.some((entry) => entry.action === 'session-create' && entry.outcome === 'ok'), true);
    const spans = telemetryBatches
      .filter((batch) => batch.signal === 'traces')
      .flatMap((batch) => batch.body.resourceSpans.flatMap((entry) => entry.scopeSpans.flatMap((scope) => scope.spans)));
    assert.equal(spans.every((span) => span.name === 'chatdsh.client.remote.call'), true);
    const methods = spans.map((span) => attributeOf(span, 'rpc.method'));
    assert.equal(methods.includes('client/sessions.list'), true, JSON.stringify([...new Set(methods)]));
    assert.equal(spans.some((span) => attributeOf(span, 'outcome') === 'ok'), true);

    const errors = await cli('errors');
    assert.deepEqual(errors.data.errors, []);
  } finally {
    if (opened) await cli('close').catch(() => undefined);
    device?.close();
    if (clientHandler !== undefined) {
      // 客户端读取入口只读存储，没有需要释放的资源。
    }
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
