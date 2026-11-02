// WP31 的真实浏览器验收：PWA 安装入口、Service Worker 缓存、离线、受控更新、权限、安全凭据、
// 配对手填、窄屏导航、安全区、输入法避让、触控目标与文字缩放。
//
// 页面由 esbuild 打包真实客户端入口（`packages/client/pwa/src/client/index.ts`），静态资源来自
// 真实 HTTP 服务：清单、Service Worker 脚本、离线页与图标都由包内生成函数产出，页面自己注册
// Service Worker。浏览器是 agent-browser 独立会话里的真实 Chrome，使用独立 HOME、TMPDIR 与
// profile，不截图，断言全部来自 DOM、可访问属性、地址、缓存内容与真实请求记录。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { pwaStaticContent } from '../../packages/client/pwa/lib/index.js';

const execute = promisify(execFile);
const NODE_BIN = '/usr/local/nvm/versions/node/v24.19.0/bin';
const AGENT_BROWSER = `${NODE_BIN}/agent-browser`;
const ROOT = new URL('../../', import.meta.url);

/** 主题令牌，与真实客户端一样由主题插件先注入。 */
const TOKENS = readFileSync(new URL('packages/client/theme/src/client/styles/tokens.css', ROOT), 'utf8');

/** 图标资源。 */
const ICONS = {
  '/assets/icons/icon-192.png': readFileSync(new URL('packages/client/pwa/assets/icons/icon-192.png', ROOT)),
  '/assets/icons/icon-512.png': readFileSync(new URL('packages/client/pwa/assets/icons/icon-512.png', ROOT)),
  '/assets/icons/icon-maskable-512.png': readFileSync(new URL('packages/client/pwa/assets/icons/icon-maskable-512.png', ROOT)),
};

/** 页面里的挂载代码。 */
const MOUNT_SCRIPT = [
  'window.__pwaErrors = [];',
  'window.addEventListener("error", function (event) { window.__pwaErrors.push(String(event.message)); });',
  'window.addEventListener("unhandledrejection", function (event) { window.__pwaErrors.push("rejection:" + String(event.reason)); });',
  'window.__pwaReady = window.__chatdshPwa.startPwa(document.getElementById("chatdsh-pwa"), {',
  '  version: "1",',
  '  navigation: { workspace: "/work/alpha", deviceId: "device-pwa", unread: 2, updatedAt: Date.now() },',
  '  draft: { deviceId: "device-pwa", sessionId: "session-1" },',
  '  pairingEndpoint: "/chatdsh/gateway/devices/pair",',
  '  canReload: function () { return window.__pwaBusy !== true; }',
  '}).then(function (ui) { window.__pwa = ui; window.__pwaRuntime = ui.runtime; return true; })',
  '.catch(function (error) { window.__pwaErrors.push("mount:" + String(error)); });',
].join('\n');

/** 应用页。 */
function appHtml() {
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<meta name="color-scheme" content="dark light">',
    '<title>ChatDSH PWA 验收</title>',
    '<link rel="manifest" href="/manifest.webmanifest">',
    `<style>${TOKENS}</style>`,
    '</head>',
    '<body>',
    '<div id="chatdsh-pwa"></div>',
    '<script src="/assets/app.js"></script>',
    `<script>${MOUNT_SCRIPT}</script>`,
    '</body>',
    '</html>',
  ].join('\n');
}

/** 创建一个提供 PWA 静态资源与私有接口的真实服务。 */
function createPwaServer(clientScript) {
  const state = {
    version: 'v1',
    sends: [],
    pairingRequests: [],
    telemetry: [],
    requests: [],
    offlineNavigation: false,
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host ?? '127.0.0.1'}`);
    state.requests.push({ method: request.method, path: url.pathname, search: url.search });
    if (request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = chunks.length === 0 ? '' : Buffer.concat(chunks).toString('utf8');
      if (url.pathname === '/chatdsh/telemetry/browser') {
        state.telemetry.push({ signal: request.headers['x-chatdsh-signal'], payload: JSON.parse(body) });
        response.writeHead(204).end();
        return;
      }
      if (url.pathname === '/chatdsh/gateway/devices/pair') {
        const payload = JSON.parse(body);
        state.pairingRequests.push(payload);
        if (payload.code === 'ABCDEFGHJKLMNPQR') {
          response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          response.end(JSON.stringify({ deviceId: 'device-paired', token: `paired-token-${String(randomUUID())}` }));
          return;
        }
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'pairing-code-invalid' }));
        return;
      }
      if (url.pathname === '/chatdsh/client/messages') {
        state.sends.push(JSON.parse(body));
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      response.writeHead(404).end();
      return;
    }

    const json = (body) => {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(appHtml());
      return;
    }
    if (url.pathname === '/assets/app.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      response.end(clientScript);
      return;
    }
    if (url.pathname === '/assets/theme.css') {
      response.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=600' });
      response.end(`${TOKENS}\n.pwa-test { color: var(--chatdsh-ink); }`);
      return;
    }
    if (url.pathname === '/assets/auth-probe.css') {
      response.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=600' });
      response.end('.auth-probe { color: var(--chatdsh-ink); }');
      return;
    }
    if (ICONS[url.pathname] !== undefined) {
      response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=600' });
      response.end(ICONS[url.pathname]);
      return;
    }
    if (url.pathname === '/manifest.webmanifest') {
      const content = pwaStaticContent({ version: '5' });
      response.writeHead(200, { 'content-type': content.manifestContentType, 'cache-control': 'no-store' });
      response.end(content.manifestJson);
      return;
    }
    if (url.pathname === '/sw.js') {
      const content = pwaStaticContent({ version: '5', serviceWorkerVersion: state.version });
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      response.end(content.serviceWorkerSource);
      return;
    }
    if (url.pathname === '/offline.html') {
      const content = pwaStaticContent({
        version: '5',
        navigation: { workspace: '/work/alpha', deviceId: 'device-pwa', unread: 2, updatedAt: Date.now() },
      });
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(content.offlineHtml);
      return;
    }
    if (url.pathname === '/chatdsh/client/private') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'set-cookie': 'chatdsh_private=1; Path=/' });
      response.end(JSON.stringify({ secret: '私有接口响应体' }));
      return;
    }
    if (url.pathname === '/api/memory/search') {
      json({ results: ['记忆查询内容'] });
      return;
    }
    if (url.pathname === '/s/token-abc') {
      json({ snapshot: '快照正文' });
      return;
    }
    if (url.pathname.startsWith('/d/device-1/')) {
      json({ session: '设备转发正文' });
      return;
    }
    if (url.pathname === '/healthz') {
      response.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      response.end('ok');
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not-found');
  });
  return {
    state,
    async start() {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('真实 Chrome：安装入口、Service Worker 缓存、离线、更新、权限、凭据与移动布局', { timeout: 600000 }, async (t) => {
  const home = allocateIndependentHome('wp31-pwa');
  const session = `wp31-${randomUUID().slice(0, 8)}`;
  // 独立 HOME 下的状态目录与 profile 目录先建好，避免第一次启动时目录创建与连接竞争。
  mkdirSync(join(home, '.agent-browser'), { recursive: true });
  mkdirSync(join(home, 'chrome'), { recursive: true });
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
      maxBuffer: 8 * 1024 * 1024,
    });
    const answer = JSON.parse(result.stdout);
    assert.equal(answer.success, true, `agent-browser ${args[0]}：${result.stdout}`);
    return answer;
  };

  const bundle = await build({
    entryPoints: [new URL('packages/client/pwa/src/client/index.ts', ROOT).pathname],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: '__chatdshPwa',
    platform: 'browser',
    target: 'es2022',
    loader: { '.css': 'text' },
    logLevel: 'warning',
  });
  const clientScript = bundle.outputFiles[0].text;
  assert.ok(clientScript.length > 20_000, `客户端脚本大小异常：${String(clientScript.length)}`);

  const front = createPwaServer(clientScript);
  const origin = await front.start();
  const server = front.state;
  let opened = false;

  const evaluate = async (expression) => (await cli('eval', expression)).data.result;
  const waitFor = async (expression, note = expression) => {
    try {
      await cli('wait', '--fn', expression);
    } catch (error) {
      const state = await evaluate(
        'JSON.stringify({ url: location.href, online: navigator.onLine, ready: typeof window.__pwa, reachable: window.__pwaRuntime ? window.__pwaRuntime.reachable() : null, errors: window.__pwaErrors || null, storage: Object.keys(localStorage), draft: document.querySelector("#pwa-draft") ? document.querySelector("#pwa-draft").value : null, draftState: document.querySelector("[data-pwa-draft-state]") ? document.querySelector("[data-pwa-draft-state]").textContent : null, controlled: navigator.serviceWorker ? navigator.serviceWorker.controller !== null : null, body: document.body ? document.body.textContent.slice(0, 300) : null })'
      );
      throw new Error(`等待失败：${note}\n页面状态：${state}\n最近的请求：${JSON.stringify(server.requests.slice(-12))}\n${String(error)}`);
    }
  };
  const evaluateAsync = async (expression) => {
    await evaluate(`window.__asyncResult = null; window.__asyncError = null; void (async function () { try { window.__asyncResult = JSON.stringify(await (${expression})); } catch (error) { window.__asyncError = String(error); } })(); true`);
    await waitFor('window.__asyncResult !== null || window.__asyncError !== null', '异步结果');
    const failure = await evaluate('window.__asyncError');
    if (failure !== null && failure !== undefined) throw new Error(failure);
    return JSON.parse(await evaluate('window.__asyncResult'));
  };
  const activate = async (selector) => {
    await cli('scrollintoview', selector);
    await cli('click', selector);
  };
  const textOf = async (selector) => String(await evaluate(`(document.querySelector(${JSON.stringify(selector)}) || {}).textContent || ""`));
  /**
   * 打开页面。
   *
   * 浏览器进程启动偶发连接失败时再启动一次：每次尝试都是真实导航，断言与页面状态不变，
   * 只在启动握手失败时重来。
   * @param url - 目标地址。
   */
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

  try {
    // 1. 首屏：清单可读、Service Worker 注册、缓存建好。
    await openPage(`${origin}/`);
    opened = true;
    await waitFor('window.__pwa !== undefined', '界面挂载完成');
    await waitFor('document.querySelector("[data-pwa-install-state]") !== null', '安装区出现');
    const firstRegistration = await evaluateAsync('navigator.serviceWorker.getRegistration().then((registration) => registration === undefined ? null : { scope: registration.scope, active: registration.active !== null })');
    assert.deepEqual(firstRegistration, { scope: `${origin}/`, active: true });
    const firstState = await evaluateAsync('window.__pwaRuntime.serviceWorker.state()');
    assert.equal(firstState.registered, true);
    assert.equal(firstState.version, 'v1');
    assert.equal(server.requests.some((entry) => entry.path === '/manifest.webmanifest'), true, '清单被真实读取');

    await cli('reload');
    await waitFor('window.__pwa !== undefined && navigator.serviceWorker.controller !== null', '刷新后由 Service Worker 接管');
    const installState = await textOf('[data-pwa-install-state]');
    const installIssues = await evaluate('[...document.querySelectorAll("[data-pwa-install-issues] li")].map((node) => node.textContent)');
    assert.equal(installState, '可安装：满足安装条件', `${installState}：${JSON.stringify(installIssues)}`);
    assert.deepEqual(installIssues, [], JSON.stringify(installIssues));
    assert.match(await textOf('[data-pwa-install-detail]'), /Service Worker 版本 v1/);
    assert.equal(await evaluate('document.querySelector("[data-pwa-install]").disabled'), false);
    const cacheNames = await evaluateAsync('caches.keys()');
    assert.deepEqual(cacheNames, ['chatdsh-pwa-static-v1']);
    const precached = await evaluateAsync('caches.open("chatdsh-pwa-static-v1").then((cache) => cache.keys()).then((keys) => keys.map((request) => new URL(request.url).pathname).sort())');
    for (const asset of ['/', '/offline.html', '/manifest.webmanifest', '/assets/icons/icon-192.png', '/assets/icons/icon-512.png']) {
      assert.ok(precached.includes(asset), `预缓存包含 ${asset}：${JSON.stringify(precached)}`);
    }

    // 2. 私有响应与敏感地址不进入缓存，静态资源进入缓存。
    const fetched = await evaluateAsync(`(async () => {
      const urls = ['/chatdsh/client/private', '/chatdsh/client/private?token=secret', '/api/memory/search', '/s/token-abc', '/d/device-1/sessions/s-1', '/healthz', '/assets/theme.css', '/assets/theme.css'];
      const results = [];
      for (const url of urls) {
        const response = await fetch(url, { cache: 'no-store' });
        results.push({ url, status: response.status, body: await response.text() });
      }
      const cache = await caches.open('chatdsh-pwa-static-v1');
      const keys = (await cache.keys()).map((request) => new URL(request.url).pathname);
      const privateHit = await cache.match('/chatdsh/client/private');
      await fetch('/assets/auth-probe.css', { headers: { authorization: 'Bearer probe' } });
      await fetch('/assets/auth-probe.css?token=secret');
      const authorizedHit = await cache.match('/assets/auth-probe.css');
      const sensitiveHit = await cache.match('/assets/auth-probe.css?token=secret');
      return { results, keys, privateHit: privateHit === undefined, authProbe: authorizedHit === undefined && sensitiveHit === undefined };
    })()`);
    assert.equal(fetched.results[0].status, 200);
    assert.equal(fetched.results[0].body.includes('私有接口响应体'), true);
    assert.equal(fetched.privateHit, true, '私有接口响应没有进入缓存');
    for (const path of ['/chatdsh/client/private', '/api/memory/search', '/s/token-abc', '/d/device-1/sessions/s-1', '/healthz']) {
      assert.equal(fetched.keys.includes(path), false, `${path} 没有进入缓存：${JSON.stringify(fetched.keys)}`);
    }
    assert.equal(fetched.keys.includes('/assets/theme.css'), true, '静态样式进入缓存');
    assert.equal(fetched.authProbe, true, '带 Authorization 头与带敏感查询参数的静态请求都不进入缓存');
    const cachedCss = await evaluateAsync('caches.open("chatdsh-pwa-static-v1").then((cache) => cache.match("/assets/theme.css")).then((response) => response === undefined ? "" : response.text()).then((text) => text.includes("--chatdsh-bg"))');
    assert.equal(cachedCss, true);
    const entries = await evaluateAsync('caches.open("chatdsh-pwa-static-v1").then((cache) => cache.keys()).then((keys) => keys.map((request) => request.url))');
    assert.equal(entries.some((url) => url.includes('/chatdsh/')), false, '缓存里没有控制平面接口地址');

    // 3. 离线：导航由缓存提供，私有请求不可达，正文读取失败提示可见，发送被阻止。
    await cli('set', 'offline', 'on');
    await cli('reload');
    await waitFor('window.__pwa !== undefined', '离线时界面挂载');
    assert.equal(await evaluate('navigator.serviceWorker.controller !== null'), true, '离线时页面仍由 Service Worker 接管');
    assert.equal(await evaluate('document.querySelector(".chatdsh-pwa") !== null'), true);
    await waitFor('document.querySelector("[data-pwa-section=\\"offline\\"]").hidden === false', '离线提示出现');
    assert.match(await textOf('[data-pwa-offline]'), /正文读取失败/);
    assert.match(await textOf('.pwa-conn'), /网络不可达/);
    const offlineFetch = await evaluateAsync('fetch("/chatdsh/client/private").then(() => "reachable", () => "unreachable")');
    assert.equal(offlineFetch, 'unreachable', '离线时私有接口不可达');
    const offlineShell = await evaluateAsync('fetch("/offline.html").then((response) => response.status)');
    assert.equal(offlineShell, 200, '离线回退页由缓存提供');
    await cli('fill', '#pwa-draft', '离线时写的草稿');
    await waitFor('document.querySelector("[data-pwa-draft-state]").textContent === "草稿已保存在本机"', '离线草稿保存');
    await activate('[data-pwa-send]');
    await waitFor('document.querySelector("[data-pwa-draft-state]").textContent.includes("发送失败")', '离线发送被阻止');
    assert.match(await textOf('[data-pwa-draft-state]'), /草稿保存在本机/);
    assert.equal(server.sends.length, 0, '离线时没有发出任何发送请求');
    assert.equal(await evaluate('document.querySelector("#pwa-draft").value'), '离线时写的草稿');
    const draftKeys = await evaluate('Object.keys(localStorage).filter((key) => key.startsWith("chatdsh-pwa.draft.v1:"))');
    assert.equal(draftKeys.length, 1, JSON.stringify(draftKeys));
    assert.match(draftKeys[0], /^chatdsh-pwa\.draft\.v1:[^:]+:[^:]+:device-pwa:session-1$/);

    // 4. 恢复网络：没有自动发送，草稿仍在，离线提示消失。
    await cli('set', 'offline', 'off');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(server.sends.length, 0, '网络恢复后没有自动发送');
    await cli('reload');
    await waitFor('window.__pwa !== undefined && document.querySelector("#pwa-draft").value === "离线时写的草稿"', '刷新后草稿恢复');
    await waitFor('document.querySelector("[data-pwa-section=\\"offline\\"]").hidden === true', '恢复网络后离线提示消失');
    assert.match(await textOf('.pwa-conn'), /在线/);

    // 5. 关闭浏览器再打开：草稿跨会话恢复。
    await cli('close');
    opened = false;
    await openPage(`${origin}/`);
    opened = true;
    await waitFor('window.__pwa !== undefined && document.querySelector("#pwa-draft").value === "离线时写的草稿"', '重新打开浏览器后草稿恢复');
    assert.match(await textOf('[data-pwa-draft-state]'), /已恢复本机草稿/);

    // 5b. 第二个窗口：窗口标识独立，草稿互不覆盖。
    const firstWindow = await evaluate('sessionStorage.getItem("chatdsh-pwa.window.v1")');
    assert.equal(typeof firstWindow, 'string');
    await cli('tab', 'new');
    await openPage(`${origin}/`);
    await waitFor('window.__pwa !== undefined && document.querySelector("#pwa-draft") !== null', '第二个窗口挂载');
    const secondWindow = await evaluate('sessionStorage.getItem("chatdsh-pwa.window.v1")');
    assert.notEqual(secondWindow, firstWindow, '第二个窗口使用独立标识');
    assert.equal(await evaluate('document.querySelector("#pwa-draft").value'), '');
    await cli('fill', '#pwa-draft', '第二个窗口的草稿');
    await waitFor('document.querySelector("[data-pwa-draft-state]").textContent === "草稿已保存在本机"', '第二个窗口草稿保存');
    const draftKeysAfterSecond = await evaluate('Object.keys(localStorage).filter((key) => key.startsWith("chatdsh-pwa.draft.v1:"))');
    assert.equal(draftKeysAfterSecond.length, 2, JSON.stringify(draftKeysAfterSecond));
    await cli('tab', 'close');
    await waitFor('sessionStorage.getItem("chatdsh-pwa.window.v1") === ' + JSON.stringify(firstWindow), '回到第一个窗口');
    assert.equal(await evaluate('document.querySelector("#pwa-draft").value'), '离线时写的草稿');

    // 6. 受控更新：新版本先等待，选择“下次启动”不刷新；浏览器重启后新版本接管。
    server.version = 'v2';
    const pending = await evaluateAsync('window.__pwaRuntime.serviceWorker.checkForUpdate()');
    assert.equal(pending.waiting, true, JSON.stringify(pending));
    assert.equal(pending.waitingVersion, 'v2');
    await waitFor('document.querySelector("[data-pwa-section=\\"update\\"]").hidden === false', '更新提示出现');
    assert.match(await textOf('[data-pwa-update-state]'), /等待启用版本 v2/);
    await activate('[data-pwa-update-later]');
    await waitFor('document.querySelector("[data-pwa-section=\\"update\\"]").hidden === true', '选择下次启动后提示收起');
    const stillV1 = await evaluateAsync('window.__pwaRuntime.serviceWorker.state()');
    assert.equal(stillV1.version, 'v1', '未确认时不切换版本');

    await cli('close');
    opened = false;
    await openPage(`${origin}/`);
    opened = true;
    await waitFor('window.__pwa !== undefined && navigator.serviceWorker.controller !== null', '重启浏览器后新版本接管');
    await waitFor('document.querySelector("[data-pwa-section=\\"update\\"]").hidden === true', '接管后没有更新提示');
    const resumedVersion = await evaluateAsync('window.__pwaRuntime.serviceWorker.state()');
    assert.equal(resumedVersion.version, 'v2', JSON.stringify(resumedVersion));
    assert.deepEqual(await evaluateAsync('caches.keys()'), ['chatdsh-pwa-static-v2']);

    // 6b. 再次出现新版本：执行中的回合阻止刷新，确认后刷新并替换缓存。
    server.version = 'v3';
    const updated = await evaluateAsync('window.__pwaRuntime.serviceWorker.checkForUpdate()');
    assert.equal(updated.waiting, true, JSON.stringify(updated));
    assert.equal(updated.waitingVersion, 'v3');
    await waitFor('document.querySelector("[data-pwa-section=\\"update\\"]").hidden === false', '更新提示再次出现');
    assert.match(await textOf('[data-pwa-update-state]'), /等待启用版本 v3/);
    await evaluate('window.__pwaBusy = true');
    await activate('[data-pwa-update-apply]');
    await waitFor('document.querySelector("[data-pwa-update-state]").textContent.includes("正在执行回合")', '执行中的回合阻止刷新');
    const beforeApply = await evaluateAsync('window.__pwaRuntime.serviceWorker.state()');
    assert.equal(beforeApply.version, 'v2', '执行中不切换版本');
    await evaluate('window.__pwaBusy = false');
    await activate('[data-pwa-update-apply]');
    await waitFor('window.__pwa !== undefined && navigator.serviceWorker.controller !== null', '更新后页面重新挂载');
    await waitFor('document.querySelector("[data-pwa-section=\\"update\\"]").hidden === true', '更新提示消失');
    const afterUpdate = await evaluateAsync('window.__pwaRuntime.serviceWorker.state()');
    assert.equal(afterUpdate.version, 'v3');
    assert.deepEqual(await evaluateAsync('caches.keys()'), ['chatdsh-pwa-static-v3']);

    // 7. 权限：查询、请求、拒绝说明与不可用说明。
    const permissionStates = await evaluateAsync('window.__pwaRuntime.permissions.queryAll()');
    assert.deepEqual(permissionStates.map((entry) => entry.target), ['notifications', 'camera', 'microphone', 'clipboard']);
    for (const entry of permissionStates) {
      assert.ok(['granted', 'denied', 'prompt', 'unavailable'].includes(entry.state), `${entry.target} 状态 ${entry.state}`);
    }
    await activate('[data-pwa-permission-request="notifications"]');
    await waitFor('document.querySelector("[data-pwa-permission=\\"notifications\\"]").textContent !== "未请求"', '通知权限请求完成');
    const notificationState = await textOf('[data-pwa-permission="notifications"]');
    assert.ok(['已拒绝', '已允许'].includes(notificationState), notificationState);
    if (notificationState === '已拒绝') {
      assert.match(await textOf('[data-pwa-guidance="notifications"]'), /站点设置/);
    }
    await activate('[data-pwa-permission-request="camera"]');
    await waitFor('document.querySelector("[data-pwa-permission=\\"camera\\"]").textContent !== "未查询" && document.querySelector("[data-pwa-permission=\\"camera\\"]").textContent !== "未请求"', '相机权限请求完成');
    const cameraState = await textOf('[data-pwa-permission="camera"]');
    assert.ok(['已拒绝', '不可用', '已允许'].includes(cameraState), cameraState);
    assert.ok((await textOf('[data-pwa-guidance="camera"]')).length > 0, '相机权限有说明文字');
    const permissionRequested = server.telemetry
      .filter((entry) => entry.signal === 'logs')
      .flatMap((entry) => entry.payload.resourceLogs[0].scopeLogs[0].logRecords)
      .filter((record) => record.body.stringValue === 'chatdsh.client.ui.action')
      .filter((record) => record.attributes.some((attribute) => attribute.key === 'action' && attribute.value.stringValue === 'permission-request'));
    assert.ok(permissionRequested.length >= 2, `权限请求写入遥测：${String(permissionRequested.length)}`);

    // 8. 配对：扫码能力说明与手填配对码；令牌进入受保护存储。
    const scanCapability = await evaluateAsync('window.__pwaRuntime.scanCapability');
    assert.equal(scanCapability.fallback, 'manual-entry');
    const scanText = await textOf('[data-pwa-scan]');
    assert.match(scanText, /手动输入配对码/);
    await cli('fill', '#pwa-pairing-code', 'ABCD');
    await activate('.pwa-section[data-pwa-section="pairing"] .pwa-button--primary');
    const pairingError = await textOf('[data-pwa-pairing-state]');
    assert.match(pairingError, /当前输入 4 位/);
    await cli('fill', '#pwa-pairing-code', 'ABCD-EFGH-JKLM-NPQR');
    await activate('.pwa-section[data-pwa-section="pairing"] .pwa-button--primary');
    await waitFor('document.querySelector("[data-pwa-pairing-state]").textContent.includes("配对成功")', '配对成功');
    assert.deepEqual(server.pairingRequests.at(-1).code, 'ABCDEFGHJKLMNPQR');
    const credential = await evaluateAsync('window.__pwaRuntime.credentials.load("device-paired")');
    assert.equal(credential.deviceId, 'device-paired');
    assert.match(credential.token, /^paired-token-/);
    const storageLeak = await evaluate(`(function () { const dump = JSON.stringify(localStorage); return dump.includes("paired-token-"); })()`);
    assert.equal(storageLeak, false, '令牌没有写进本地存储');
    const idbPlaintext = await evaluateAsync(`(async () => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open('chatdsh-pwa-credentials', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const record = await new Promise((resolve, reject) => {
        const transaction = database.transaction('credentials', 'readonly');
        const request = transaction.objectStore('credentials').get('device-paired');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const text = new TextDecoder().decode(new Uint8Array(record.ciphertext));
      return { kind: window.__pwaRuntime.credentials.kind, plaintext: text.includes('paired-token-'), length: record.ciphertext.byteLength };
    })()`);
    assert.equal(idbPlaintext.kind, 'indexeddb');
    assert.equal(idbPlaintext.plaintext, false, 'IndexedDB 里只有密文');
    assert.ok(idbPlaintext.length > 16);
    assert.match(await textOf('[data-pwa-credential]'), /device-paired 的凭据已保存/);
    await activate('[data-pwa-credential-clear]');
    await waitFor('document.querySelector("[data-pwa-credential]").textContent.includes("没有保存的凭据")', '清除凭据');
    const cleared = await evaluateAsync('window.__pwaRuntime.credentials.load("device-paired").then((value) => value === undefined ? null : value)');
    assert.equal(cleared, null, '清除后读不到令牌');

    // 9. 窄屏导航：320 CSS 像素下抽屉、触控目标与逐层返回。
    await cli('set', 'viewport', '320', '800');
    await cli('reload');
    await waitFor('window.__pwa !== undefined && document.querySelector(".pwa-drawer") !== null', '窄屏重新挂载');
    assert.equal(await evaluate('document.querySelector(".pwa-drawer").hidden'), true);
    assert.equal(await evaluate('document.querySelector(".pwa-drawer-toggle").getBoundingClientRect().height >= 44'), true);
    const overflow = await evaluateAsync('(async () => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }))()');
    assert.ok(overflow.scrollWidth <= overflow.clientWidth + 1, JSON.stringify(overflow));
    const touchAudit = await evaluateAsync('window.__pwaRuntime.layout.auditTouchTargets()');
    assert.deepEqual(touchAudit.offenders, [], JSON.stringify(touchAudit));
    await activate('.pwa-drawer-toggle');
    await waitFor('document.querySelector(".pwa-drawer").hidden === false', '抽屉打开');
    assert.equal(await evaluate('document.querySelector(".pwa-drawer-toggle").getAttribute("aria-expanded")'), 'true');
    assert.equal(await evaluate('document.querySelector(".pwa-scrim").hidden'), false);
    const drawerText = await evaluate('document.querySelector(".pwa-drawer").textContent');
    for (const item of ['返回', '搜索', '工作区位置', '设备', '未读']) assert.ok(drawerText.includes(item), `抽屉包含 ${item}`);
    assert.equal(await evaluate('document.querySelector(".pwa-drawer").contains(document.activeElement)'), true, '焦点进入抽屉');
    const drawerEntries = await evaluate('[...document.querySelectorAll(".pwa-drawer [data-pwa-nav], .pwa-drawer .pwa-nav-item")].map((node) => node.getBoundingClientRect().height)');
    assert.equal(drawerEntries.every((height) => height >= 44), true, JSON.stringify(drawerEntries));
    await cli('back');
    await waitFor('document.querySelector(".pwa-drawer").hidden === true', '返回关闭抽屉');
    assert.equal(await evaluate('location.pathname'), '/');
    assert.equal(await evaluate('document.querySelector(".chatdsh-pwa") !== null'), true, '逐层返回没有退出页面');
    await activate('.pwa-drawer-toggle');
    await waitFor('document.querySelector(".pwa-drawer").hidden === false', '抽屉再次打开');
    await cli('press', 'Escape');
    await waitFor('document.querySelector(".pwa-drawer").hidden === true', 'Escape 关闭抽屉');
    assert.equal(await evaluate('document.querySelector(".pwa-drawer-toggle").getAttribute("aria-expanded")'), 'false');

    // 9b. 768 CSS 像素：布局仍然单列，导航仍是抽屉，触控目标与宽度都合格。
    await cli('set', 'viewport', '768', '900');
    const tablet = await evaluateAsync('(async () => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, drawerHidden: document.querySelector(".pwa-drawer").hidden, audit: window.__pwaRuntime.layout.auditTouchTargets() }))()');
    assert.ok(tablet.scrollWidth <= tablet.clientWidth + 1, JSON.stringify(tablet));
    assert.equal(tablet.drawerHidden, true);
    assert.deepEqual(tablet.audit.offenders, [], JSON.stringify(tablet.audit));

    // 10. 文字缩放 200%：不产生横向溢出，触控目标保持 44 像素。
    await evaluate('document.documentElement.style.fontSize = "32px"');
    const scaled = await evaluateAsync('(async () => ({ title: getComputedStyle(document.querySelector(".pwa-title")).fontSize, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, audit: window.__pwaRuntime.layout.auditTouchTargets() }))()');
    assert.equal(scaled.title, '32px');
    assert.ok(scaled.scrollWidth <= scaled.clientWidth + 1, JSON.stringify(scaled));
    assert.deepEqual(scaled.audit.offenders, [], JSON.stringify(scaled.audit));
    await evaluate('document.documentElement.style.fontSize = ""');

    // 11. 输入法避让：遮挡高度写进样式变量，输入区与焦点元素都留在可见区域。
    await cli('set', 'viewport', '390', '844');
    await cli('reload');
    await waitFor('window.__pwa !== undefined && document.querySelector("#pwa-draft") !== null', '输入法验收重新挂载');
    const inset = await evaluateAsync('window.__pwaRuntime.layout.syncViewport({ innerHeight: 844, height: 500, offsetTop: 0 })');
    assert.equal(inset, 344);
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".chatdsh-pwa")).getPropertyValue("--pwa-keyboard-inset").trim()'), '344px');
    await cli('focus', '#pwa-draft');
    const composerBox = await evaluateAsync('(async () => { const rect = document.querySelector(".pwa-composer").getBoundingClientRect(); const input = document.querySelector("#pwa-draft").getBoundingClientRect(); return { bottom: rect.bottom, inputTop: input.top, inputBottom: input.bottom }; })()');
    assert.ok(composerBox.bottom <= 501, JSON.stringify(composerBox));
    assert.ok(composerBox.inputTop >= 0 && composerBox.inputBottom <= 501, JSON.stringify(composerBox));
    const restoredInset = await evaluateAsync('window.__pwaRuntime.layout.syncViewport()');
    assert.equal(restoredInset, 0);

    // 12. 遥测：动作事件、失败事件与计数、启动与模块 span 的名称与属性都在登记范围内。
    const logs = server.telemetry
      .filter((entry) => entry.signal === 'logs')
      .flatMap((entry) => entry.payload.resourceLogs[0].scopeLogs[0].logRecords);
    const spans = server.telemetry
      .filter((entry) => entry.signal === 'traces')
      .flatMap((entry) => entry.payload.resourceSpans[0].scopeSpans[0].spans);
    const metrics = server.telemetry
      .filter((entry) => entry.signal === 'metrics')
      .flatMap((entry) => entry.payload.resourceMetrics[0].scopeMetrics[0].metrics);
    const actions = logs
      .filter((record) => record.body.stringValue === 'chatdsh.client.ui.action')
      .map((record) => record.attributes.find((attribute) => attribute.key === 'action').value.stringValue);
    for (const action of ['install-check', 'sw-register', 'permission-request', 'draft-save', 'sw-update-available', 'sw-update-apply', 'layout-layer', 'layout-ime']) {
      assert.ok(actions.includes(action), `遥测包含动作 ${action}：${JSON.stringify([...new Set(actions)])}`);
    }
    assert.ok(spans.some((span) => span.name === 'chatdsh.client.boot'), '启动 span 存在');
    assert.ok(spans.some((span) => span.name === 'chatdsh.client.module.load'), '模块装填 span 存在');
    for (const record of logs) {
      assert.equal(record.body.stringValue.startsWith('chatdsh.client.'), true, record.body.stringValue);
      const keys = record.attributes.map((attribute) => attribute.key);
      if (record.body.stringValue === 'chatdsh.client.ui.action') {
        assert.deepEqual(keys.sort(), ['action', 'outcome']);
      }
      if (record.body.stringValue === 'chatdsh.client.error') {
        assert.deepEqual(keys.sort(), ['error.code', 'error.type']);
      }
    }
    for (const span of spans) {
      assert.ok(['chatdsh.client.boot', 'chatdsh.client.module.load'].includes(span.name), span.name);
      assert.deepEqual(span.attributes.map((attribute) => attribute.key).sort(), span.name === 'chatdsh.client.boot' ? ['module.count', 'outcome'] : ['module.id', 'outcome']);
    }
    for (const metric of metrics) {
      assert.equal(metric.name, 'chatdsh_client_errors_total');
      assert.deepEqual(metric.sum.dataPoints[0].attributes.map((attribute) => attribute.key), ['error_type']);
    }
    assert.equal(await evaluate('window.__pwaErrors.length'), 0, JSON.stringify(await evaluate('window.__pwaErrors')));
  } finally {
    if (opened) {
      try {
        await cli('close');
      } catch {
        // 关闭失败不影响已经得到的验收结论。
      }
    }
    await front.close();
    releaseIndependentHome(home);
  }
});
