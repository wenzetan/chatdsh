// WP20 分享区段的导入页签验收：真实控制平面、真实 SQLite 与真实浏览器。
//
// 分享区段的第三个页签把另一台设备的会话副本还原成本机的一条新会话。页面用 esbuild 打包
// 真实界面源码，控制平面是真实的 `createGatewayServer`：副本读取、形状校验、导入与跳转
// 全部经真实 HTTP 与真实 SQLite。浏览器是 agent-browser 独立会话里的真实 Chrome，使用独立
// HOME、TMPDIR 与 profile，不截图；断言来自 DOM、地址与磁盘数据库记录。
//
// 运行：node --test e2e/unit/client-complete-wp20-browser.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { UI_KIT_CSS } from '../../packages/core/ui-kit/lib/index.js';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { createTelemetryClient } from '../../packages/core/diagnostics/lib/client.js';
import { defaultTelemetryConfig } from '../../packages/core/diagnostics/lib/config.js';
import { GatewayStore, PushQueue, ReceiptStore, ReplicaStore, ShareStore } from '../../gateway/lib/store.js';
import { createPushHub } from '../../gateway/lib/push.js';
import { DeviceLinkHub } from '../../gateway/lib/device-link.js';
import { createGatewayServer } from '../../gateway/lib/server.js';
import { buildEvents } from './client-complete-wp20-support.mjs';

const execute = promisify(execFile);
const NODE_BIN = '/usr/local/nvm/versions/node/v24.19.0/bin';
const AGENT_BROWSER = `${NODE_BIN}/agent-browser`;
const ROOT = new URL('../../', import.meta.url);
const BASE = Date.UTC(2026, 10, 1, 12, 0, 0);

/** 页面入口：挂载真实的分享区段。 */
const EXERCISE = `
import { createRoot } from 'react-dom/client';
import { ShareSection } from '../../packages/client/share/src/client/index.tsx';
window.__wp20Errors = [];
window.addEventListener('error', (event) => window.__wp20Errors.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) => window.__wp20Errors.push('rejection:' + String(event.reason)));
createRoot(document.getElementById('root')).render(<ShareSection />);
`;

/**
 * 等一个页面条件成立。
 * @param {object} cli - 浏览器命令。
 * @param {string} expression - 页面表达式。
 * @param {string} message - 超时说明。
 */
async function waitFor(cli, expression, message) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const { data } = await cli('eval', `Boolean(${expression})`);
    if (data.result === true) return;
    await new Promise((done) => setTimeout(done, 250));
  }
  const state = (await cli('eval', 'JSON.stringify({ url: location.href, text: document.getElementById("root").textContent, errors: window.__wp20Errors })')).data.result;
  assert.fail(`等待超时：${message}\n页面状态：${state}`);
}

test('导入页签：没有副本的会话明确失败，有副本的会话导入并跳转', async () => {
  const home = allocateIndependentHome('wp20-import');
  const session = `wp20-import-${randomUUID().slice(0, 8)}`;
  const env = {
    ...process.env,
    PATH: `${NODE_BIN}:${process.env.PATH}`,
    HOME: home,
    TMPDIR: home,
    DSH_HOME: home,
    AGENT_BROWSER_SESSION: session,
    AGENT_BROWSER_EXECUTABLE_PATH: '/usr/bin/google-chrome',
    AGENT_BROWSER_PROFILE: join(home, 'chrome'),
    AGENT_BROWSER_ARGS: '--no-sandbox',
  };
  const cli = async (...args) => {
    const result = await execute(AGENT_BROWSER, ['--session', session, '--json', ...args], { env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
    const response = JSON.parse(result.stdout);
    assert.equal(response.success, true, `agent-browser ${args[0]}：${result.stdout}`);
    return response;
  };
  const evaluate = async (expression) => (await cli('eval', expression)).data.result;
  const activate = async (selector) => {
    const found = await evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (node === null) return false; node.focus(); return document.activeElement === node; })()`);
    assert.equal(found, true, `找不到可以聚焦的控件：${selector}`);
    await cli('press', 'Enter');
  };

  const telemetry = createTelemetryClient({
    config: defaultTelemetryConfig({ surface: 'gateway' }),
    component: '@chatdsh/gateway',
    env: { CHATDSH_TELEMETRY: 'off' },
  });
  const store = new GatewayStore(join(home, 'gateway.sqlite'));
  const replica = new ReplicaStore(store.handle());
  const gatewayServer = createGatewayServer({
    config: {
      host: '127.0.0.1',
      port: 0,
      runtimeUrl: 'http://127.0.0.1:1',
      databasePath: join(home, 'gateway.sqlite'),
      environment: 'test',
      version: '0.0.0',
      pushMode: 'all-at-once',
      pushEscalationMs: 1000,
      llmGateway: { quota: {} },
      pairingCode: 'pair-wp20-import',
    },
    store,
    replica,
    share: new ShareStore(store.handle()),
    receipts: new ReceiptStore(store.handle()),
    push: createPushHub({
      queue: new PushQueue(store.handle()),
      devices: store,
      mode: 'all-at-once',
      escalationMs: 1000,
      telemetry: { counter: (name, config) => telemetry.counter(name, config) },
    }),
    telemetry,
    deviceLink: new DeviceLinkHub({ store, telemetry }),
  });

  let front;
  let opened = false;
  try {
    await gatewayServer.start();
    const gatewayUrl = gatewayServer.url();

    store.upsertSession({ sessionId: 'session-import', deviceId: 'device-beta', cwd: '/workspace/import', kind: 'work', createdAt: BASE });
    // 只有归属、没有副本的会话：导入必须以明确失败结束。
    store.upsertSession({ sessionId: 'session-empty', deviceId: 'device-gamma', cwd: '/workspace/empty', kind: 'work', createdAt: BASE + 1 });
    const events = buildEvents(BASE);
    const published = await fetch(`${gatewayUrl}/chatdsh/gateway/replica`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-import', events }),
    });
    assert.equal(published.status, 200);

    const bundle = await build({
      stdin: { contents: EXERCISE, resolveDir: fileURLToPath(new URL('.', import.meta.url)), sourcefile: 'wp20-import.tsx', loader: 'tsx' },
      bundle: true,
      write: false,
      format: 'iife',
      jsx: 'automatic',
      target: 'es2022',
      loader: { '.css': 'text' },
      logLevel: 'warning',
    });
    const tokens = readFileSync(new URL('packages/client/theme/src/client/styles/tokens.css', ROOT), 'utf8');
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>导入验收</title><style>${tokens}\n${UI_KIT_CSS}\nmain { padding:16px; max-width:100%; }</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`;

    const proxy = (request, response) => {
      const upstream = new URL(gatewayUrl);
      const sent = httpRequest(
        { host: upstream.hostname, port: upstream.port, method: request.method, path: request.url, headers: { ...request.headers, host: upstream.host } },
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

    front = createServer((request, response) => {
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (url.pathname.startsWith('/chatdsh/')) {
        proxy(request, response);
        return;
      }
      // 逻辑路由与根路径都交给分享页面：导入成功后的跳转需要真实可打开的地址。
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(html);
    });
    front.listen(0, '127.0.0.1');
    await once(front, 'listening');
    const origin = `http://127.0.0.1:${front.address().port}`;

    await cli('open', `${origin}/`);
    opened = true;
    await cli('wait', '[role="tablist"]');
    await activate('[role="tablist"] button:nth-child(3)');
    await waitFor(cli, 'document.getElementById("chdsh-share-import-source") !== null', '导入面板出现');
    await waitFor(cli, 'document.getElementById("chdsh-share-import-source").options.length >= 3', '会话选项载入');

    // 没有副本的会话：明确失败，不出现确认按钮。
    await cli('select', '#chdsh-share-import-source', 'session-empty');
    await activate('#chdsh-share-import-check');
    await waitFor(cli, 'document.querySelector("[data-import-invalid]") !== null', '导入失败提示出现');
    assert.match(await evaluate('document.querySelector("[data-import-invalid]").textContent'), /源会话没有可读副本/);
    assert.equal(await evaluate('document.getElementById("chdsh-share-import-confirm")'), null, '失败时不出现确认步骤');
    assert.equal(await evaluate('document.querySelector("[data-import-ready]")'), null);

    // 有副本的会话：校验通过之后创建新会话，并跳转到新会话的逻辑路由。
    await cli('select', '#chdsh-share-import-source', 'session-import');
    await waitFor(cli, 'document.getElementById("chdsh-share-import-cwd").value === "/workspace/import"', '目标目录取自源会话');
    await cli('select', '#chdsh-share-import-device', 'device-gamma');
    await activate('#chdsh-share-import-check');
    await waitFor(cli, 'document.querySelector("[data-import-ready]") !== null', '副本校验通过');
    assert.match(await evaluate('document.querySelector("[data-import-ready]").textContent'), new RegExp(`校验通过：${String(events.length)} 条事件、3 个完整回合`));
    await activate('#chdsh-share-import-confirm');
    await waitFor(cli, 'location.pathname.startsWith("/sessions/")', '导入后跳转到新会话');
    const pathname = await evaluate('location.pathname');
    assert.match(pathname, /^\/sessions\/[0-9a-f-]{36}$/);
    assert.equal(await evaluate('location.search'), '?device=device-gamma');

    const newSessionId = pathname.slice('/sessions/'.length);
    const owned = store.listSessions().find((record) => record.sessionId === newSessionId);
    assert.equal(owned?.parentSession, 'session-import');
    assert.equal(owned?.deviceId, 'device-gamma');
    assert.equal(replica.read(newSessionId).length, events.length);
    assert.equal(replica.read(newSessionId)[0]?.kind, 'session/title');
  } finally {
    if (opened) await cli('close').catch(() => undefined);
    front?.closeAllConnections();
    if (front !== undefined) await new Promise((done) => front.close(done));
    await gatewayServer.stop();
    store.close();
    releaseIndependentHome(home);
  }
});
