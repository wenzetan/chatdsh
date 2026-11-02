// WP24 设备界面的真实浏览器验收：分组列表、详情、链路检查、配对、撤销与键盘焦点。
//
// 页面用 esbuild 打包真实界面源码（`packages/client/account/src/client/index.tsx`），数据由
// 真实装配的控制平面提供：真实 `GatewayStore`（SQLite）、真实设备生命周期模块与真实 HTTP。
// 浏览器是 agent-browser 独立会话里的真实 Chrome，使用独立 HOME、TMPDIR 与 profile，不截图；
// 断言全部来自 DOM、可访问属性、真实接口响应与磁盘数据库记录。
//
// 运行：node --test e2e/unit/client-complete-wp24-browser.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { UI_KIT_CSS } from '../../packages/core/ui-kit/lib/index.js';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { createTelemetryClient } from '../../packages/core/diagnostics/lib/client.js';
import { defaultTelemetryConfig } from '../../packages/core/diagnostics/lib/config.js';
import { GatewayStore, ReplicaStore } from '../../gateway/lib/store.js';
import { DeviceLinkHub } from '../../gateway/lib/device-link.js';
import {
  DeviceLifecycle,
  DeviceTransportRegistry,
  PairingService,
  createDeviceHost,
} from '../../gateway/lib/devices/index.js';
import { DEVICE_LIST_PATH, DEVICE_PAIR_PATH } from '../../gateway/lib/devices/index.js';

const execute = promisify(execFile);
const NODE_BIN = '/usr/local/nvm/versions/node/v24.19.0/bin';
const AGENT_BROWSER = `${NODE_BIN}/agent-browser`;
const ROOT = new URL('../../', import.meta.url);

const hash = (value) => createHash('sha256').update(value).digest('hex');

/** 页面入口：挂载真实的设备区段，设备凭据由宿主页面提供。 */
const EXERCISE = `
import { createRoot } from 'react-dom/client';
import { DeviceSection } from '../../packages/client/account/src/client/index.tsx';
window.__wp24Errors = [];
window.addEventListener('error', (event) => window.__wp24Errors.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) => window.__wp24Errors.push('rejection:' + String(event.reason)));
createRoot(document.getElementById('root')).render(
  <DeviceSection credential={() => window.__chatdshDeviceCredential} />,
);
`;

/** 关闭遥测的网关客户端。 */
function silentTelemetry() {
  return createTelemetryClient({
    config: defaultTelemetryConfig({ surface: 'gateway' }),
    component: '@chatdsh/gateway',
    env: { CHATDSH_TELEMETRY: 'off' },
  });
}

/** 直接登记一台访问客户端，返回它的令牌。 */
function seedAccess(store, id, name = id) {
  const token = randomBytes(32).toString('base64url');
  store.registerMobileDevice({ id, name, platform: 'linux', tokenHash: hash(token) });
  return token;
}

/** 等一个页面条件成立。 */
async function waitFor(cli, expression, message) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const { data } = await cli('eval', `Boolean(${expression})`);
    if (data.result === true) return;
    await new Promise((done) => setTimeout(done, 250));
  }
  const state = (await cli('eval', 'JSON.stringify({ text: document.getElementById("root").textContent, errors: window.__wp24Errors })')).data.result;
  assert.fail(`等待超时：${message}\n页面状态：${state}`);
}

/** 收集页面遥测里的界面动作。 */
function actionsOf(telemetryBatches) {
  const actions = [];
  for (const batch of telemetryBatches) {
    for (const resource of batch.body.resourceLogs ?? []) {
      for (const scope of resource.scopeLogs ?? []) {
        for (const record of scope.logRecords ?? []) {
          if (record.body?.stringValue !== 'chatdsh.client.ui.action') continue;
          const attributes = Object.fromEntries((record.attributes ?? []).map((entry) => [entry.key, entry.value?.stringValue]));
          actions.push({ action: attributes.action, outcome: attributes.outcome });
        }
      }
    }
  }
  return actions;
}

/** 按版本 2 帧协议接入的执行节点。 */
class TestDevice {
  constructor(origin, token, deviceId, platform = 'linux') {
    this.frames = [];
    this.waiters = new Set();
    this.socket = new WebSocket(`${origin.replace(/^http/, 'ws')}/chatdsh/gateway/device-link`, {
      headers: { authorization: `Bearer ${token}` },
    });
    this.closed = new Promise((resolve) => this.socket.addEventListener('close', resolve));
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => {
        this.send({ type: 'hello', version: 2, deviceId, platform, role: 'both', capabilities: ['shell'] });
        resolve();
      });
      this.socket.addEventListener('error', () => reject(new Error('设备长连接失败')));
      this.socket.addEventListener('message', (event) => {
        const frame = JSON.parse(event.data);
        this.frames.push(frame);
        if (frame.type === 'ping') this.send({ type: 'pong', generation: frame.generation, nonce: frame.nonce });
        if (frame.type === 'open') {
          this.send({ type: 'accepted', channelId: frame.channelId, generation: frame.generation, status: 200, headers: {} });
          this.send({ type: 'end', channelId: frame.channelId, generation: frame.generation, lastSeq: 0 });
        }
        for (const waiter of [...this.waiters]) waiter(frame);
      });
    });
    void this.opened.catch(() => undefined);
  }

  send(frame) {
    this.socket.send(JSON.stringify(frame));
  }

  waitFrame(predicate, timeoutMs = 3000) {
    const seen = this.frames.find((frame) => predicate(frame));
    if (seen !== undefined) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`等待帧超时，已收到：${this.frames.map((frame) => frame.type).join('、')}`));
      }, timeoutMs);
      const waiter = (frame) => {
        if (!predicate(frame)) return;
        clearTimeout(timer);
        this.waiters.delete(waiter);
        resolve(frame);
      };
      this.waiters.add(waiter);
    });
  }

  close() {
    this.socket.close();
  }
}

/** 起一个真实装配的控制平面。 */
async function startApp() {
  const home = allocateIndependentHome('wp24-browser');
  const store = new GatewayStore(join(home, 'gateway.sqlite'));
  const replica = new ReplicaStore(store.handle());
  const telemetry = silentTelemetry();
  const transports = new DeviceTransportRegistry();
  const deviceLink = new DeviceLinkHub({ store, telemetry, heartbeatMs: 1000, deadAfterMs: 5000, requestTimeoutMs: 3000 });
  const pairing = new PairingService({ ttlMs: 5000 });
  const upgraded = new Set();
  let host;

  const server = createServer(async (request, response) => {
    if (host !== undefined && await host.handle(request, response)) return;
    response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ error: 'object-not-found' }));
  });
  server.on('upgrade', (request, socket) => {
    upgraded.add(socket);
    socket.once('close', () => upgraded.delete(socket));
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    if (path === '/chatdsh/gateway/device-link') {
      deviceLink.handleUpgrade(request, socket);
      return;
    }
    socket.destroy();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const lifecycle = new DeviceLifecycle({
    store,
    telemetry,
    deviceLink,
    transports,
    pairing,
    controlUrl: origin,
    linkCheckTimeoutMs: 2000,
  });
  host = createDeviceHost({ lifecycle, telemetry, transports, controlUrl: origin });
  const controlToken = seedAccess(store, 'control', '验收访问客户端');
  seedAccess(store, 'reader', '第二访问客户端');
  return {
    home,
    origin,
    store,
    replica,
    deviceLink,
    controlToken,
    async close() {
      host.stop();
      deviceLink.stop();
      for (const socket of [...upgraded]) socket.destroy();
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await telemetry.shutdown();
      store.close();
      releaseIndependentHome(home);
    },
  };
}

/** 发一次真实配对请求。 */
async function pair(app, code, name) {
  const response = await fetch(`${app.origin}${DEVICE_PAIR_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ controlUrl: app.origin, code, name, platform: 'linux', role: 'both' }),
  });
  assert.equal(response.status, 200, `配对失败：${await response.clone().text()}`);
  return response.json();
}

test('设备界面：分组、详情、链路检查、配对、撤销、过期与键盘焦点', async () => {
  const app = await startApp();
  const session = `wp24-${randomUUID().slice(0, 8)}`;
  const env = {
    ...process.env,
    PATH: `${NODE_BIN}:${process.env.PATH}`,
    HOME: app.home,
    TMPDIR: app.home,
    DSH_HOME: app.home,
    AGENT_BROWSER_SESSION: session,
    AGENT_BROWSER_EXECUTABLE_PATH: '/usr/bin/google-chrome',
    AGENT_BROWSER_PROFILE: join(app.home, 'chrome'),
    AGENT_BROWSER_ARGS: '--no-sandbox',
  };
  const cli = async (...args) => {
    const result = await execute(AGENT_BROWSER, ['--session', session, '--json', ...args], {
      env,
      timeout: 90_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const response = JSON.parse(result.stdout);
    assert.equal(response.success, true, `agent-browser ${args[0]}：${result.stdout}`);
    return response;
  };
  const evaluate = async (expression) => (await cli('eval', expression)).data.result;
  /** 用键盘激活一个控件：先聚焦再按 Enter，这条路与真实键盘用户一致。 */
  const activate = async (selector) => {
    const found = await evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (node === null) return false; node.focus(); return document.activeElement === node; })()`);
    assert.equal(found, true, `找不到可以聚焦的控件：${selector}`);
    await cli('press', 'Enter');
  };

  const telemetryBatches = [];
  let front;
  let opened = false;
  let upstream = app.origin;
  let linked;
  try {
    const bundle = await build({
      stdin: { contents: EXERCISE, resolveDir: fileURLToPath(new URL('.', import.meta.url)), sourcefile: 'wp24-exercise.tsx', loader: 'tsx' },
      bundle: true,
      write: false,
      format: 'iife',
      jsx: 'automatic',
      target: 'es2022',
      logLevel: 'warning',
    });
    const tokens = readFileSync(new URL('packages/client/theme/src/client/styles/tokens.css', ROOT), 'utf8');
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>设备验收</title><style>${tokens}\n${UI_KIT_CSS}\nmain { padding:16px; max-width:100%; }</style></head><body><main id="root"></main><script>window.__chatdshDeviceCredential = ${JSON.stringify(app.controlToken)};</script><script>${bundle.outputFiles[0].text}</script></body></html>`;

    /** 把非页面路径转发给真实控制平面。 */
    const proxy = (request, response) => {
      const target = new URL(upstream);
      const sent = httpRequest(
        { host: target.hostname, port: target.port, method: request.method, path: request.url, headers: { ...request.headers, host: target.host } },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(response);
        },
      );
      sent.on('error', () => {
        if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'upstream-unavailable' }));
      });
      request.pipe(sent);
    };

    front = createServer(async (request, response) => {
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (url.pathname === '/chatdsh/telemetry/browser') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        telemetryBatches.push({ body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        response.writeHead(204).end();
        return;
      }
      if (url.pathname.startsWith('/chatdsh/')) {
        proxy(request, response);
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(html);
    });
    front.listen(0, '127.0.0.1');
    await once(front, 'listening');
    const origin = `http://127.0.0.1:${front.address().port}`;

    await cli('open', `${origin}/`);
    opened = true;
    await waitFor(cli, 'document.querySelector("[data-device-group=\\"nodes\\"]") !== null', '设备区段载入');

    // 1. 分组列表：执行节点为空，访问客户端两台并标出当前客户端。
    assert.match(await evaluate('document.querySelector("[data-device-group=\\"nodes\\"]").textContent'), /执行节点（0）/);
    assert.match(await evaluate('document.querySelector("[data-device-group=\\"nodes\\"]").textContent'), /还没有登记的执行节点。/);
    const clientsText = await evaluate('document.querySelector("[data-device-group=\\"access-clients\\"]").textContent');
    assert.match(clientsText, /访问客户端（2）/);
    assert.match(clientsText, /验收访问客户端/);
    assert.match(clientsText, /第二访问客户端/);
    assert.match(clientsText, /当前客户端/);
    assert.match(clientsText, /Linux/);
    assert.match(clientsText, /最近活动/);
    assert.equal(await evaluate('document.querySelector("[aria-label=\\"查看客户端详情：第二访问客户端\\"]") !== null'), true);
    assert.equal(await evaluate('document.querySelector("[aria-label=\\"查看客户端详情：验收访问客户端\\"]") !== null'), true);

    // 2. 配对：签发真实配对码，显示目标地址、有效期、配对码与手填载荷。
    await activate('#chdsh-device-pairing-issue');
    await waitFor(cli, 'document.querySelector("[data-pairing-facts]") !== null', '配对码显示出来');
    const facts = await evaluate('document.querySelector("[data-pairing-facts]").textContent');
    assert.match(facts, /目标地址/);
    assert.match(facts, /有效期/);
    assert.match(facts, /配对码/);
    assert.equal(await evaluate('document.querySelector("[data-pairing-target]").textContent'), app.origin);
    assert.match(await evaluate('document.querySelector("[data-pairing-remaining]").textContent'), /^\d{2}:\d{2}$/);
    const shownCode = await evaluate('document.querySelector("[data-pairing-code]").textContent');
    assert.match(shownCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.match(await evaluate('document.querySelector("[data-pairing-qr-unavailable]").textContent'), /没有安装二维码生成库/);
    const payloadText = await evaluate('document.getElementById("chdsh-device-pairing-payload").value');
    assert.ok(payloadText.length > 20, '手填载荷不能为空');
    const decoded = JSON.parse(Buffer.from(payloadText, 'base64url').toString('utf8'));
    assert.equal(decoded.controlUrl, app.origin);
    assert.equal(decoded.pairingCode, shownCode);
    assert.equal(await evaluate('document.getElementById("chdsh-device-pairing-payload").readOnly'), true);
    await activate('#chdsh-device-pairing-copy');
    await waitFor(cli, '/已复制到剪贴板|手动复制|剪贴板/.test(document.getElementById("root").textContent)', '复制状态出现');

    // 真实配对：用页面显示的配对码登记一台离线节点，列表刷新后出现在执行节点分组。
    const offline = await pair(app, shownCode, '离线节点');
    await activate('#chdsh-device-refresh');
    await waitFor(cli, `document.querySelector('[data-device-name="离线节点"]') !== null`, '离线节点出现在列表');
    const offlineRow = await evaluate('document.querySelector("[data-device-name=\\"离线节点\\"]").closest("li").textContent');
    assert.match(offlineRow, /离线/);
    assert.match(offlineRow, /宿主与执行节点/);
    assert.match(await evaluate('document.querySelector("[data-device-group=\\"nodes\\"]").textContent'), /执行节点（1）/);

    // 3. 详情与链路检查：不可达时给出原因；对话框约束焦点，Escape 关闭并恢复焦点。
    await activate(`#chdsh-device-open-${offline.deviceId}`);
    await waitFor(cli, 'document.querySelector("dialog[open]") !== null', '详情对话框出现');
    const detailText = await evaluate('document.querySelector("dialog[open]").textContent');
    assert.match(detailText, /配对时间/);
    assert.match(detailText, /角色/);
    assert.match(detailText, /宿主与执行节点/);
    assert.equal(await evaluate('document.querySelector("[data-device-detail-capabilities]").textContent'), '设备没有上报能力');
    assert.match(await evaluate('document.querySelector("[data-device-detail-online]").textContent'), /离线/);
    await activate('#chdsh-device-link-check');
    await waitFor(cli, 'document.querySelector("[data-link-result]") !== null', '链路检查结果出现');
    assert.equal(await evaluate('document.querySelector("[data-link-result]").textContent'), '不可达：执行节点离线（device-offline）');
    assert.equal(await evaluate('document.querySelector("dialog[open]").contains(document.activeElement)'), true);
    for (let index = 0; index < 6; index += 1) {
      await cli('press', 'Tab');
      assert.equal(await evaluate('document.querySelector("dialog[open]").contains(document.activeElement)'), true, 'Tab 不能离开对话框');
    }
    await cli('press', 'Escape');
    await waitFor(cli, 'document.querySelector("dialog[open]") === null', 'Escape 关闭详情对话框');
    assert.equal(await evaluate('document.activeElement.id'), `chdsh-device-open-${offline.deviceId}`, '关闭后焦点回到详情按钮');

    // 4. 访问客户端详情：链路检查只对执行节点提供。
    await activate('[aria-label="查看客户端详情：第二访问客户端"]');
    await waitFor(cli, 'document.querySelector("dialog[open]") !== null', '客户端详情对话框出现');
    const clientDetail = await evaluate('document.querySelector("dialog[open]").textContent');
    assert.match(clientDetail, /访问客户端/);
    assert.match(clientDetail, /链路检查只针对执行节点/);
    assert.equal(await evaluate('document.querySelector("[data-link-check] #chdsh-device-link-check")'), null);
    await cli('press', 'Escape');
    await waitFor(cli, 'document.querySelector("dialog[open]") === null', '客户端详情关闭');
    assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), '查看客户端详情：第二访问客户端');

    // 5. 在线节点：真实设备长连接建立后链路检查给出延迟。
    await activate('#chdsh-device-pairing-reissue');
    await waitFor(cli, `document.querySelector("[data-pairing-code]") !== null && document.querySelector("[data-pairing-code]").textContent !== ${JSON.stringify(shownCode)}`, '重签的配对码出现');
    const secondCode = await evaluate('document.querySelector("[data-pairing-code]").textContent');
    assert.notEqual(secondCode, shownCode, '重签要换一枚配对码');
    const online = await pair(app, secondCode, '在线节点');
    linked = new TestDevice(app.origin, online.nodeToken, online.deviceId);
    await linked.opened;
    await linked.waitFrame((frame) => frame.type === 'welcome');
    await activate('#chdsh-device-refresh');
    await waitFor(cli, `document.querySelector('[data-device-name="在线节点"]') !== null && document.querySelector('[data-device-name="在线节点"]').closest("li").textContent.includes("在线")`, '在线节点显示为在线');
    await activate(`#chdsh-device-open-${online.deviceId}`);
    await waitFor(cli, 'document.querySelector("dialog[open]") !== null', '在线节点详情出现');
    await activate('#chdsh-device-link-check');
    await waitFor(cli, 'document.querySelector("[data-link-result]") !== null', '在线链路检查结果出现');
    assert.match(await evaluate('document.querySelector("[data-link-result]").textContent'), /^可达，往返延迟 \d+ 毫秒$/);
    await cli('press', 'Escape');
    await waitFor(cli, 'document.querySelector("dialog[open]") === null', '在线节点详情关闭');

    // 6. 撤销：二次确认说明关闭的通道与保留的内容，撤销后状态与入口立即变化。
    app.store.upsertSession({ sessionId: 'session-wp24', deviceId: online.deviceId, cwd: '/workspace/wp24', kind: 'work', createdAt: 1 });
    app.replica.append('session-wp24', [{ seq: 0, kind: 'user/message', time: 1, bytes: 4, payload: { data: { text: '保留' } } }]);

    await activate(`#chdsh-device-revoke-${online.deviceId}`);
    await waitFor(cli, 'document.querySelector("dialog[open]") !== null', '撤销确认出现');
    const revokeText = await evaluate('document.querySelector("dialog[open]").textContent');
    assert.match(revokeText, /设备长连接/);
    assert.match(revokeText, /WebSocket/);
    assert.match(revokeText, /SSE/);
    assert.match(revokeText, /在途 HTTP 请求/);
    assert.match(revokeText, /会话副本保留/);
    assert.match(revokeText, /重新加入需要新的配对码/);
    await cli('press', 'Escape');
    await waitFor(cli, 'document.querySelector("dialog[open]") === null', 'Escape 关闭撤销确认');
    assert.equal(await evaluate('document.activeElement.id'), `chdsh-device-revoke-${online.deviceId}`, '关闭后焦点回到撤销按钮');

    await activate(`#chdsh-device-revoke-${online.deviceId}`);
    await waitFor(cli, 'document.getElementById("chdsh-device-revoke-confirm") !== null', '确认按钮出现');
    await activate('#chdsh-device-revoke-confirm');
    await waitFor(cli, '/已撤销 在线节点：关闭了 \\d+ 条通道/.test(document.getElementById("root").textContent)', '撤销结果出现');
    await waitFor(cli, `document.querySelector('[data-device-name="在线节点"]').closest("li").textContent.includes("已撤销")`, '列表状态更新为已撤销');
    assert.equal(await evaluate(`document.getElementById("chdsh-device-revoke-${online.deviceId}")`), null, '撤销入口消失');
    assert.equal(await evaluate(`document.getElementById("chdsh-device-open-${online.deviceId}") !== null`), true, '详情入口仍在');
    await linked.closed;
    assert.equal(app.deviceLink.online(online.deviceId), false);
    const afterRevoke = await fetch(`${app.origin}${DEVICE_LIST_PATH}`, { headers: { authorization: `Bearer ${online.nodeToken}` } });
    assert.equal(afterRevoke.status, 401);
    assert.equal((await afterRevoke.json()).error, 'device-token-revoked');
    assert.equal(app.store.listSessions().some((record) => record.sessionId === 'session-wp24'), true);
    assert.equal(app.replica.read('session-wp24').length, 1);

    await activate(`#chdsh-device-open-${online.deviceId}`);
    await waitFor(cli, 'document.querySelector("dialog[open]") !== null', '已撤销设备的详情出现');
    assert.match(await evaluate('document.querySelector("[data-device-detail-revoked]").textContent'), /\d{4}年\d{2}月\d{2}日/);
    assert.equal(await evaluate('document.querySelector("[data-link-check] #chdsh-device-link-check")'), null);
    assert.equal(await evaluate('document.getElementById("chdsh-device-detail-revoke")'), null);
    await cli('press', 'Escape');
    await waitFor(cli, 'document.querySelector("dialog[open]") === null', '已撤销设备详情关闭');

    // 7. 过期提示与重新签发。
    await activate('#chdsh-device-pairing-reissue');
    await waitFor(cli, `document.querySelector("[data-pairing-code]").textContent !== ${JSON.stringify(secondCode)}`, '新配对码出现');
    const beforeExpiry = await evaluate('document.querySelector("[data-pairing-code]").textContent');
    await waitFor(cli, '/配对码已过期/.test(document.getElementById("root").textContent)', '配对码过期提示出现');
    assert.match(await evaluate('document.querySelector("[data-pairing-remaining]").textContent'), /已过期/);
    assert.equal(await evaluate('document.getElementById("chdsh-device-pairing-reissue").textContent'), '重新签发');
    await activate('#chdsh-device-pairing-reissue');
    await waitFor(cli, `document.querySelector("[data-pairing-code]").textContent !== ${JSON.stringify(beforeExpiry)}`, '重新签发换了一枚配对码');
    assert.match(await evaluate('document.querySelector("[data-pairing-remaining]").textContent'), /^\d{2}:\d{2}$/);

    // 8. 令牌与摘要不进入页面文本与遥测。
    const pageHtml = await evaluate('document.getElementById("root").innerHTML');
    const pageText = await evaluate('document.getElementById("root").textContent');
    for (const secret of [online.nodeToken, app.controlToken, hash(online.nodeToken), hash(app.controlToken)]) {
      assert.equal(pageHtml.includes(secret), false, '页面结构里不出现令牌与摘要');
      assert.equal(pageText.includes(secret), false, '页面文本里不出现令牌与摘要');
    }
    const serializedTelemetry = JSON.stringify(telemetryBatches);
    for (const secret of [online.nodeToken, app.controlToken, hash(online.nodeToken)]) {
      assert.equal(serializedTelemetry.includes(secret), false, '遥测里不出现令牌与摘要');
    }
    assert.equal(serializedTelemetry.includes('在线节点'), false, '遥测里不出现设备名称');
    assert.equal(serializedTelemetry.includes(app.origin), false, '遥测里不出现控制平面地址');

    // 9. 界面动作遥测：四个动作各有一条真实结论。
    const actions = actionsOf(telemetryBatches);
    for (const action of ['device-list', 'device-pairing-issue', 'device-link-check', 'device-revoke']) {
      assert.ok(actions.some((entry) => entry.action === action && entry.outcome === 'ok'), `缺少成功动作 ${action}：${JSON.stringify(actions)}`);
    }
    assert.ok(actions.some((entry) => entry.action === 'device-link-check' && entry.outcome === 'failed'), '不可达的链路检查要记一次失败');
    assert.ok(actions.filter((entry) => entry.action === 'device-list').length >= 3, '每次刷新都要记一条列表读取');

    // 10. 读取失败：控制平面不可达时给出原因与重新读取入口。
    const dead = createServer(() => undefined);
    dead.listen(0, '127.0.0.1');
    await once(dead, 'listening');
    const deadPort = dead.address().port;
    await new Promise((resolve) => dead.close(resolve));
    upstream = `http://127.0.0.1:${deadPort}`;
    await activate('#chdsh-device-refresh');
    await waitFor(cli, 'document.getElementById("chdsh-device-reload") !== null', '读取失败状态出现');
    const failureText = await evaluate('document.getElementById("root").textContent');
    assert.match(failureText, /设备列表读取失败/);
    upstream = app.origin;
    await activate('#chdsh-device-reload');
    await waitFor(cli, 'document.querySelector("[data-device-group=\\"nodes\\"]") !== null', '重新读取后恢复列表');
    assert.match(await evaluate('document.querySelector("[data-device-group=\\"nodes\\"]").textContent'), /已撤销/);

    assert.deepEqual(await evaluate('window.__wp24Errors'), []);
  } finally {
    if (opened) await cli('close').catch(() => undefined);
    linked?.close();
    front?.closeAllConnections();
    if (front !== undefined) await new Promise((done) => front.close(done));
    await app.close();
  }
});
