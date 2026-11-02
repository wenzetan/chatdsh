// WP30 验收：通用、模型、插件与运行设置界面。
//
// 控制平面是真实网关进程（真实 SQLite 与真实 HTTP）；设备是真实 `dsh` Web 运行时，使用
// 独立数据根、真实 profile 副本与真实补丁层，设置增强包作为真实客户端插件行挂进装载树。
// 页面把仓库里的真实区段源码打成浏览器产物，数据入口只把请求转给同一台运行时：设置读写走
// `settings/describe`、`settings/update` 与设置同步插件的设备接口，模型与上下文占用走
// 宿主的 `chatdshModelProviders` 与 `chatdshContextInsights`，插件清单走真实的
// `pluginInventory`、`pluginManager`。浏览器是 agent-browser 独立会话里的真实 Chrome，使用
// 独立 HOME、TMPDIR 与 profile，不截图；断言全部来自 DOM、可访问属性、真实 HTTP 应答与
// 磁盘上的 profile 补丁。
//
// 覆盖：通用字段与作用范围、逐字段保存状态、未保存离开提示、字段校验与错误摘要焦点、
// 快捷键录入不执行命令与冲突/系统保留键、跨客户端版本冲突与逐字段采用服务器值、运行参数
// 写入与路径校验、默认模型与额度拒绝、上下文占用的窗口来源与降级原因、真实插件清单与
// 启停/卸载入口、重启读回、白名单同步与设备范围设置不上报、浏览器遥测信号。
//
// 运行：node --test e2e/unit/client-complete-wp30-settings.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, execFileSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { ensureDeps } from '../lib/ensure-deps.mjs';
import { UI_KIT_CSS } from '../../packages/core/ui-kit/lib/index.js';

const execute = promisify(execFile);
const RUNTIME = resolve(import.meta.dirname, '../..');
const REPO = resolve(RUNTIME, '..');
const NODE_BIN = '/usr/local/nvm/versions/node/v24.19.0/bin';
const PROFILE = 'chatdsh-web';
const SETTINGS_PACKAGE = join(RUNTIME, 'packages/host/settings-enhancements');
const MODEL_PACKAGE = join(RUNTIME, 'packages/client/model-provider/src/client');
const CONTEXT_PACKAGE = join(RUNTIME, 'packages/client/context-insights/src/client');
const PAGE_TIMEOUT = 180_000;
const TEST_TIMEOUT = 600_000;

ensureDeps(RUNTIME);
ensureDeps(resolve(REPO, 'dsh-adapter'));
ensureBuild(SETTINGS_PACKAGE, join(SETTINGS_PACKAGE, 'lib/index.js'), 'wp30-settings-build');
ensureBuild(join(RUNTIME, 'gateway'), join(RUNTIME, 'gateway/lib/main.js'), 'wp30-gateway-build');

/**
 * 编译一个工程；多个测试同时运行时用目录锁串行。
 * @param {string} projectDir - 工程目录。
 * @param {string} artifact - 就绪判定用的产物路径。
 * @param {string} lockName - 锁目录名。
 */
function ensureBuild(projectDir, artifact, lockName) {
  if (existsSync(artifact)) return;
  const lock = join(RUNTIME, '.verify', `${lockName}.lock`);
  mkdirSync(join(RUNTIME, '.verify'), { recursive: true });
  const deadline = Date.now() + 240_000;
  for (;;) {
    if (existsSync(artifact)) return;
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > 300_000) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error('等待构建锁超时');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
    }
  }
  try {
    execFileSync(join(RUNTIME, 'node_modules/.bin/tsc'), ['-b', projectDir], { cwd: RUNTIME, stdio: 'inherit' });
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

const { findFreePort } = await import('../../gateway/lib/runtime.js');

/** 等一段时间。 */
function settle(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * 反复执行一个检查直到成立。
 * @param {() => Promise<{ ok: boolean, value?: unknown, detail?: unknown }>} check - 检查函数。
 * @param {number} timeoutMs - 超时毫秒数。
 * @param {string} label - 失败时报告的等待对象。
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
 * 起一个真实控制平面进程。
 * @param {string} home - 控制平面的数据根。
 * @param {string} pairingCode - 配对码。
 */
async function startGateway(home, pairingCode) {
  const port = await findFreePort(20410);
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
    if (child.exitCode !== null) return { ok: false, detail: `控制平面已退出：${output.text.slice(-800)}` };
    const response = await fetch(`${base}/healthz`).catch(() => undefined);
    return { ok: response?.ok === true, detail: response?.status ?? '不可达' };
  }, 30_000, '控制平面监听');
  return {
    base,
    port,
    output: () => output.text,
    async stop() {
      child.kill('SIGTERM');
      await waitFor(async () => ({ ok: child.exitCode !== null }), 15_000, '控制平面退出').catch(() => undefined);
    },
  };
}

/**
 * 配对一台设备。
 * @param {string} base - 控制平面地址。
 * @param {string} name - 设备名称。
 * @param {string} code - 配对码。
 */
async function pairDevice(base, name, code) {
  const response = await fetch(`${base}/chatdsh/gateway/devices/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, name, platform: 'linux', role: 'both', capabilities: ['shell'] }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, `配对 ${name} 失败：${JSON.stringify(body)}`);
  return { deviceId: body.deviceId, token: body.token };
}

/**
 * 把仓库 profile 复制成测试自己的数据根：包清单与补丁层复制，依赖目录用符号链接投影，
 * 设置增强包链进 profile 的 node_modules。
 * @param {string} home - 独立数据根。
 * @param {{ controlUrl: string, token: string, deviceId: string }} device - 设备与控制平面。
 */
function prepareProfile(home, device) {
  const repoProfile = join(RUNTIME, 'profiles', PROFILE);
  const target = join(home, 'profiles', PROFILE);
  mkdirSync(target, { recursive: true });
  for (const file of ['package.json', 'cordis.yml', 'cordis.patch.yml']) {
    copyFileSync(join(repoProfile, file), join(target, file));
  }
  const linkFarm = (source, destination) => {
    mkdirSync(destination, { recursive: true });
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      if (entry.name.startsWith('@')) {
        const scopeDir = join(destination, entry.name);
        mkdirSync(scopeDir, { recursive: true });
        for (const scoped of readdirSync(join(source, entry.name))) {
          symlinkSync(join(source, entry.name, scoped), join(scopeDir, scoped), 'dir');
        }
        continue;
      }
      symlinkSync(join(source, entry.name), join(destination, entry.name), 'dir');
    }
  };
  linkFarm(join(repoProfile, 'node_modules'), join(target, 'node_modules'));
  const settingsLink = join(target, 'node_modules/@chatdsh/host-settings-enhancements');
  // 组合包的补丁层已经引用这个包，profile 的链接在 linkFarm 里带过来；缺失时才补。
  if (!existsSync(settingsLink)) symlinkSync(SETTINGS_PACKAGE, settingsLink, 'dir');
  const patchPath = join(target, 'cordis.patch.yml');
  writeFileSync(patchPath, [
    readFileSync(patchPath, 'utf8'),
    '',
    '# WP30 验收：本设备的模型路由、提供方与设置增强行。',
    '- id: chatdsh-llm-router',
    "  name: '@chatdsh/host-llm-router'",
    '  config:',
    "    baseUrl: 'http://127.0.0.1:1/llm'",
    '    routes:',
    '      - provider: gateway',
    '        limit: 0',
    '',
    '- id: chatdsh-model-provider',
    "  name: '@chatdsh/host-model-provider'",
    '  config:',
    '    providers:',
    '      - provider: gateway',
    '        displayName: 模型网关',
    "        baseUrl: 'http://127.0.0.1:1/llm'",
    '        models:',
    '          - chatdsh-wp30-model',
    '      - provider: alt',
    '        displayName: 备用端点',
    "        baseUrl: 'http://127.0.0.1:1/v1'",
    '',
  ].join('\n'));
  return { patchPath, controlUrl: device.controlUrl };
}

/**
 * 起一台真实的 dsh Web 运行时。
 * @param {{ home: string, device: { controlUrl: string, token: string, deviceId: string } }} options 设备参数。
 */
async function startRuntime({ home, device }) {
  const port = await findFreePort(3720);
  const child = spawn(`${NODE_BIN}/dsh`, ['--profile', PROFILE, '--port', String(port), '--no-open'], {
    cwd: RUNTIME,
    env: {
      ...process.env,
      PATH: `${NODE_BIN}:${process.env.PATH ?? ''}`,
      DSH_HOME: home,
      CHATDSH_TELEMETRY: 'off',
      CHATDSH_CONTROL_URL: device.controlUrl,
      CHATDSH_NODE_TOKEN: device.token,
      CHATDSH_DEVICE_ID: device.deviceId,
      CHATDSH_GATEWAY_PORT: String(new URL(device.controlUrl).port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { text: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output.text += chunk; });
  child.stderr.on('data', (chunk) => { output.text += chunk; });
  const url = await waitFor(async () => {
    if (child.exitCode !== null) return { ok: false, detail: `运行时已退出：${output.text.slice(-2000)}` };
    const match = output.text.match(/dsh web: (http:\S+)/u);
    return match === null ? { ok: false, detail: output.text.slice(-400) } : { ok: true, value: match[1] };
  }, PAGE_TIMEOUT, '运行时监听');
  const origin = new URL(url).origin;
  const login = await fetch(url, { redirect: 'manual' });
  const setCookie = login.headers.get('set-cookie');
  if (setCookie === null) throw new Error(`界面凭据交换失败：${login.status}`);
  const cookie = setCookie.split(';')[0];
  const api = async (endpoint, args = {}) => {
    const response = await fetch(`${origin}/api/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: `wp30-${randomUUID()}`, method: endpoint, payload: { args } }),
    });
    return await response.json();
  };
  await waitFor(async () => {
    const reply = await api('settings/describe').catch(() => undefined);
    return { ok: reply?.result?.ok === true, detail: reply?.result?.error ?? '未就绪' };
  }, PAGE_TIMEOUT, '设置服务就绪');
  return {
    origin,
    cookie,
    api,
    output: () => output.text,
    async stop() {
      child.kill('SIGTERM');
      await waitFor(async () => ({ ok: child.exitCode !== null }), 30_000, '运行时退出').catch(() => {
        child.kill('SIGKILL');
      });
      await settle(500);
    },
  };
}

/** 读设置描述里的命名空间。 */
async function namespacesOf(runtime) {
  const reply = await runtime.api('settings/describe');
  if (reply.result?.ok !== true) throw new Error(`设置描述失败：${JSON.stringify(reply.result)}`);
  return reply.result.value.namespaces;
}

/** 取一个命名空间的读数。 */
function readingOf(namespaces, ns) {
  const found = namespaces.find((entry) => entry.ns === ns);
  if (found === undefined) throw new Error(`设置描述里没有 ${ns}`);
  return found;
}

/**
 * 读控制平面的设置快照。
 * @param {string} base - 控制平面地址。
 */
async function settingsSnapshot(base) {
  const response = await fetch(`${base}/chatdsh/gateway/settings`);
  assert.equal(response.status, 200);
  return (await response.json()).namespaces;
}

/** 页面脚本：真实区段源码、真实数据入口与真实遥测面。 */
function pageScript(sessionId) {
  return `
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { createGateways, GeneralSettingsSection, RuntimeSettingsSection, PluginsSection } from ${JSON.stringify(join(SETTINGS_PACKAGE, 'src/client/index.tsx'))};
import { createModelGateway, ModelProviderSection } from ${JSON.stringify(join(MODEL_PACKAGE, 'index.tsx'))};
import { createContextGateway, ContextInsightsPanel } from ${JSON.stringify(join(CONTEXT_PACKAGE, 'index.tsx'))};

const gateways = createGateways();
const models = createModelGateway();
const context = createContextGateway();
window.__wp30 = { commands: 0 };
document.addEventListener('keydown', () => { window.__wp30.commands += 1; });
createRoot(document.getElementById('root')).render(
  createElement('main', null,
    createElement(GeneralSettingsSection, { gateway: gateways.settings, onAction: gateways.telemetry.action }),
    createElement(RuntimeSettingsSection, { gateway: gateways.settings, onAction: gateways.telemetry.action }),
    createElement(PluginsSection, { gateway: gateways.plugins, onAction: gateways.telemetry.action }),
    createElement(ModelProviderSection, { gateway: models }),
    createElement(ContextInsightsPanel, { gateway: context, sessionId: ${JSON.stringify(sessionId)} }),
  ),
);
window.__wp30.ready = true;
`;
}

/**
 * 起页面服务：页面、浏览器遥测接收与运行时接口转发。
 * @param {{ runtime: object, script: string }} options 运行时与页面脚本。
 */
async function startPage({ runtime, script }) {
  const bundle = await build({
    stdin: { contents: script, resolveDir: RUNTIME, sourcefile: 'wp30-page.tsx', loader: 'tsx' },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    loader: { '.css': 'text' },
    alias: { '@chatdsh/core-ui-kit': join(RUNTIME, 'packages/core/ui-kit/src/index.ts') },
    logLevel: 'warning',
  });
  const tokens = readFileSync(join(RUNTIME, 'packages/client/theme/src/client/styles/tokens.css'), 'utf8');
  const html = [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>WP30 设置</title><style>',
    tokens,
    '\n',
    UI_KIT_CSS,
    '\nmain { padding: 16px; max-width: 1000px; } section.chdsh-panel { margin-block: 16px; }</style></head><body>',
    '<main><div id="root"></div></main>',
    '<script>',
    bundle.outputFiles[0].text,
    '</script></body></html>',
  ].join('');
  const batches = [];
  const proxy = (request, response) => {
    const upstream = new URL(runtime.origin);
    const headers = { ...request.headers, host: upstream.host, cookie: runtime.cookie };
    // 页面来源与运行时不在一处：丢掉带来源的请求头，只保留转发所需的部分。
    for (const name of ['origin', 'referer', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest']) delete headers[name];
    const sent = httpRequest({
      host: upstream.hostname,
      port: upstream.port,
      method: request.method,
      path: request.url,
      headers,
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    sent.on('error', () => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'upstream-unavailable' }));
    });
    request.pipe(sent);
  };
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (path === '/chatdsh/telemetry/browser') {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        batches.push({ signal: request.headers['x-chatdsh-signal'], body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        response.writeHead(204).end();
      });
      return;
    }
    if (path === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(html);
      return;
    }
    proxy(request, response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    origin: `http://127.0.0.1:${String(server.address().port)}`,
    batches,
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}

/**
 * 建一个 agent-browser 调用器：独立会话、独立 HOME、独立 profile、不截图。
 * @param {{ session: string, home: string }} options 会话名与独立数据根。
 */
function browserOf({ session, home }) {
  const env = {
    ...process.env,
    TMPDIR: home,
    HOME: home,
    AGENT_BROWSER_SESSION: session,
    AGENT_BROWSER_EXECUTABLE_PATH: '/usr/bin/google-chrome',
    AGENT_BROWSER_PROFILE: join(home, 'chrome'),
    AGENT_BROWSER_ARGS: '--no-sandbox',
  };
  return async (name, ...args) => {
    const result = await execute(`${NODE_BIN}/agent-browser`, ['--session', session, '--json', name, ...args], {
      env,
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const response = JSON.parse(result.stdout);
    assert.equal(response.success, true, `agent-browser ${name} 失败：${result.stdout}`);
    return response;
  };
}

test('设置增强界面：通用、运行、插件、默认模型与上下文占用', { timeout: TEST_TIMEOUT }, async (t) => {
  const home = allocateIndependentHome('wp30-settings');
  const pairingCode = randomBytes(9).toString('base64url');
  const session = `wp30-${randomUUID().slice(0, 8)}`;
  const cli = browserOf({ session, home });
  const evaluate = async (expression) => (await cli('eval', expression)).data.result;
  let gateway;
  let runtime;
  let page;
  let opened = false;
  mkdirSync(join(home, 'workspace'), { recursive: true });
  try {
    gateway = await startGateway(join(home, 'control-plane'), pairingCode);
    const device = await pairDevice(gateway.base, 'device-wp30', pairingCode);
    const prepared = prepareProfile(home, { controlUrl: gateway.base, token: device.token, deviceId: device.deviceId });
    runtime = await startRuntime({ home, device: { controlUrl: gateway.base, token: device.token, deviceId: device.deviceId } });

    const created = await runtime.api('session/create', { request: { cwd: join(home, 'workspace') } });
    assert.equal(created.result?.ok, true, `创建会话失败：${JSON.stringify(created.result)}`);
    const sessionId = created.result.value.sessionId;
    const initialSpace = await namespacesOf(runtime);
    const enhancements = readingOf(initialSpace, 'chatdsh-settings-enhancements');
    assert.equal(enhancements.value.motion, 'system', '设置增强命名空间由真实插件行提供');
    assert.equal(enhancements.revision, 0);

    page = await startPage({ runtime, script: pageScript(sessionId) });
    await cli('open', `${page.origin}/`);
    opened = true;
    await waitFor(async () => {
      const ready = await evaluate('Boolean(document.querySelector("[data-chdsh-savebar]")) && Boolean(document.querySelector("[data-chdsh-plugin-count]"))');
      return { ok: ready === true, detail: await evaluate('document.body.textContent.slice(0, 200)') };
    }, 60_000, '页面区段挂载');

    await t.test('通用设置：真实读数、作用范围与未保存离开提示', async () => {
      await waitFor(async () => {
        const value = await evaluate('document.getElementById("chdsh-setting-ui-theme-preference").value');
        return { ok: value === 'system', detail: value };
      }, 30_000, '主题偏好载入');
      assert.equal(await evaluate('document.getElementById("chdsh-setting-ui-theme-fontSize").value'), '14');
      assert.equal(await evaluate('document.getElementById("chdsh-setting-chatdsh-settings-enhancements-motion").value'), 'system');
      assert.equal(await evaluate('document.getElementById("chdsh-setting-chatdsh-settings-enhancements-shortcutSend").value'), 'Enter');
      const scope = await evaluate('document.querySelector("[data-chdsh-field=\\"bash-sandbox.timeoutMs\\"] [data-chdsh-scope]").textContent');
      assert.match(scope, /设备范围，不同步/u);
      const languageScope = await evaluate('document.querySelector("[data-chdsh-field=\\"locale.preference\\"] [data-chdsh-scope]").textContent');
      assert.match(languageScope, /设备范围，不同步/u, '白名单没有覆盖的命名空间按设备范围显示');

      await cli('select', '#chdsh-setting-ui-theme-preference', 'dark');
      assert.equal(await evaluate('document.querySelector("[data-chdsh-field-status=\\"ui-theme.preference\\"]").dataset.state'), 'dirty');
      assert.match(await evaluate('document.querySelector("[data-chdsh-unsaved]").textContent'), /未保存/u);
      const allowed = await evaluate('(() => { const event = new Event("beforeunload", { cancelable: true }); return window.dispatchEvent(event); })()');
      assert.equal(allowed, false, '有未保存字段时离开页面被拦截');

      await cli('click', '[data-chdsh-save]');
      await waitFor(async () => {
        const state = await evaluate('document.querySelector("[data-chdsh-field-status=\\"ui-theme.preference\\"]").dataset.state');
        return { ok: state === 'saved', detail: state };
      }, 30_000, '主题保存');
      const afterSave = await namespacesOf(runtime);
      assert.equal(readingOf(afterSave, 'ui-theme').value.preference, 'dark');
      assert.match(readFileSync(prepared.patchPath, 'utf8'), /preference: dark/u);

      await cli('select', '#chdsh-setting-chatdsh-settings-enhancements-motion', 'reduced');
      assert.equal(await evaluate('document.documentElement.getAttribute("data-chdsh-motion")'), 'reduced');
      await cli('click', '[data-chdsh-save]');
      await waitFor(async () => {
        const value = (await namespacesOf(runtime)).find((entry) => entry.ns === 'chatdsh-settings-enhancements')?.value.motion;
        return { ok: value === 'reduced', detail: value };
      }, 30_000, '动效偏好保存');
    });

    await t.test('字段校验与错误摘要焦点', async () => {
      await cli('fill', '#chdsh-setting-ui-theme-fontSize', '99');
      await cli('click', '[data-chdsh-save]');
      await waitFor(async () => {
        const text = await evaluate('document.querySelector("[data-chdsh-error-summary-host] .chdsh-error-summary")?.textContent ?? ""');
        return { ok: text.includes('正文字号'), detail: text };
      }, 15_000, '校验错误摘要出现');
      const focused = await evaluate('document.activeElement.id');
      assert.equal(focused, 'chdsh-summary-通用设置', '焦点移到错误摘要');
      assert.match(await evaluate('document.querySelector("[data-chdsh-field-status=\\"ui-theme.fontSize\\"]").textContent'), /不能大于 22/u);
      await cli('fill', '#chdsh-setting-ui-theme-fontSize', '15');
      await cli('click', '[data-chdsh-save]');
      await waitFor(async () => {
        const value = (await namespacesOf(runtime)).find((entry) => entry.ns === 'ui-theme')?.value.fontSize;
        return { ok: value === 15, detail: value };
      }, 30_000, '字号保存');
    });

    await t.test('快捷键录入：不执行命令、冲突与系统保留键', async () => {
      await cli('click', '[data-chdsh-shortcut="chatdsh-settings-enhancements.shortcutSend"] button');
      await cli('press', 'Control+k');
      await waitFor(async () => {
        const notice = await evaluate('document.querySelector("[data-chdsh-shortcut-notice=\\"chatdsh-settings-enhancements.shortcutSend\\"]").textContent');
        return { ok: notice.includes('冲突'), detail: notice };
      }, 10_000, '冲突提示');
      assert.equal(await evaluate('document.getElementById("chdsh-setting-chatdsh-settings-enhancements-shortcutSend").value'), 'Enter', '冲突时保留原值');

      await evaluate(`(() => {
        const button = document.querySelector('[data-chdsh-shortcut="chatdsh-settings-enhancements.shortcutSend"] button');
        button.focus();
        button.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, bubbles: true, cancelable: true }));
        return true;
      })()`);
      await waitFor(async () => {
        const notice = await evaluate('document.querySelector("[data-chdsh-shortcut-notice=\\"chatdsh-settings-enhancements.shortcutSend\\"]").textContent');
        return { ok: notice.includes('系统') || notice.includes('保留') || notice.includes('不能录入'), detail: notice };
      }, 10_000, '系统保留键提示');
      assert.equal(await evaluate('window.__wp30.commands'), 0, '录入按键没有执行任何命令');

      await cli('click', '[data-chdsh-shortcut="chatdsh-settings-enhancements.shortcutSend"] button');
      await cli('press', 'Control+Enter');
      await waitFor(async () => {
        const value = await evaluate('document.getElementById("chdsh-setting-chatdsh-settings-enhancements-shortcutSend").value');
        return { ok: value === 'Ctrl+Enter', detail: value };
      }, 10_000, '快捷键录入');
      assert.equal(await evaluate('window.__wp30.commands'), 0, '录入成功同样没有执行命令');
      await cli('click', '[data-chdsh-save]');
      await waitFor(async () => {
        const value = (await namespacesOf(runtime)).find((entry) => entry.ns === 'chatdsh-settings-enhancements')?.value.shortcutSend;
        return { ok: value === 'Ctrl+Enter', detail: value };
      }, 30_000, '快捷键保存');
    });

    await t.test('跨客户端版本冲突：逐字段呈现、保留编辑与采用服务器值', async () => {
      const space = await namespacesOf(runtime);
      const theme = readingOf(space, 'ui-theme');
      const external = await runtime.api('settings/update', { ns: 'ui-theme', patch: { fontSize: 18 }, expectedRevision: theme.revision });
      assert.equal(external.result?.ok, true, JSON.stringify(external.result));

      await cli('fill', '#chdsh-setting-ui-theme-fontSize', '20');
      await cli('click', '[data-chdsh-save]');
      await waitFor(async () => {
        const shown = await evaluate('Boolean(document.querySelector("[data-chdsh-conflict]"))');
        return { ok: shown === true, detail: await evaluate('document.body.textContent.includes("另一客户端已修改设置")') };
      }, 30_000, '冲突面板出现');
      assert.match(await evaluate('document.querySelector("[data-chdsh-conflict-server]").textContent'), /18/u);
      assert.match(await evaluate('document.querySelector("[data-chdsh-conflict-user]").textContent'), /20/u);
      await cli('find', 'role', 'button', 'click', '--name', '保留我的');
      await cli('click', '[data-chdsh-save]');
      await waitFor(async () => {
        const value = (await namespacesOf(runtime)).find((entry) => entry.ns === 'ui-theme')?.value.fontSize;
        return { ok: value === 20, detail: value };
      }, 30_000, '用最新版本重新提交');

      const second = readingOf(await namespacesOf(runtime), 'ui-theme');
      const externalAgain = await runtime.api('settings/update', { ns: 'ui-theme', patch: { fontSize: 21 }, expectedRevision: second.revision });
      assert.equal(externalAgain.result?.ok, true, JSON.stringify(externalAgain.result));
      await cli('fill', '#chdsh-setting-ui-theme-fontSize', '22');
      await cli('click', '[data-chdsh-save]');
      await waitFor(async () => {
        const shown = await evaluate('Boolean(document.querySelector("[data-chdsh-conflict]"))');
        return { ok: shown === true, detail: shown };
      }, 30_000, '第二次冲突出现');
      await cli('find', 'role', 'button', 'click', '--name', '采用服务器值');
      await waitFor(async () => {
        const value = await evaluate('document.getElementById("chdsh-setting-ui-theme-fontSize").value');
        return { ok: value === '21', detail: value };
      }, 15_000, '采用服务器值');
      assert.equal(await evaluate('Boolean(document.querySelector("[data-chdsh-conflict]"))'), false);
    });

    await t.test('运行设置：路径校验、Agent 与子代理上限、检索与日志', async () => {
      await evaluate('document.querySelectorAll("[data-chdsh-reload]")[1].click()');
      await waitFor(async () => {
        const value = await evaluate('document.getElementById("chdsh-setting-chatdsh-settings-enhancements-shellProgram").value');
        return { ok: value === '', detail: value };
      }, 15_000, '运行设置重新读取');
      await settle(300);
      const runtimeSave = async () => {
        await evaluate('document.querySelectorAll("[data-chdsh-save]")[1].click()');
      };
      const editField = async (selector, value, fieldKey) => {
        await cli('fill', selector, value);
        await settle(250);
        await waitFor(async () => {
          const current = await evaluate(`document.querySelector(${JSON.stringify(selector)})?.value ?? ""`);
          const state = await evaluate(`document.querySelector('[data-chdsh-field-status="${fieldKey}"]')?.dataset.state ?? ""`);
          return { ok: current === value && state === 'dirty', detail: { current, state } };
        }, 15_000, `${fieldKey} 进入未保存`);
      };
      await editField('#chdsh-setting-chatdsh-settings-enhancements-shellProgram', 'fish', 'chatdsh-settings-enhancements.shellProgram');
      await runtimeSave();
      await waitFor(async () => {
        const text = await evaluate('document.querySelector("[data-chdsh-error-summary-host] .chdsh-error-summary")?.textContent ?? ""');
        return { ok: text.includes('绝对路径'), detail: text };
      }, 15_000, '相对路径被拒绝');
      await editField('#chdsh-setting-chatdsh-settings-enhancements-shellProgram', '/usr/bin/fish', 'chatdsh-settings-enhancements.shellProgram');
      await runtimeSave();
      await waitFor(async () => {
        const value = (await namespacesOf(runtime)).find((entry) => entry.ns === 'chatdsh-settings-enhancements')?.value.shellProgram;
        return { ok: value === '/usr/bin/fish', detail: value };
      }, 30_000, '终端程序路径保存');

      await editField('#chdsh-setting-subagent-maxActiveSubagents', '12', 'subagent.maxActiveSubagents');
      await editField('#chdsh-setting-web-searchProvider', 'http', 'web.searchProvider');
      await cli('select', '#chdsh-setting-session-log-deepseek-enabled', 'false');
      await waitFor(async () => {
        const state = await evaluate('document.querySelector(\'[data-chdsh-field-status="session-log-deepseek.enabled"]\')?.dataset.state ?? ""');
        return { ok: state === 'dirty', detail: state };
      }, 15_000, '日志开关进入未保存');
      await editField('#chdsh-setting-bash-sandbox-timeoutMs', '90000', 'bash-sandbox.timeoutMs');
      await runtimeSave();
      await waitFor(async () => {
        const space = await namespacesOf(runtime);
        const subagent = readingOf(space, 'subagent').value.maxActiveSubagents;
        const search = readingOf(space, 'web').value.searchProvider;
        const log = readingOf(space, 'session-log-deepseek').value.enabled;
        const timeout = readingOf(space, 'bash-sandbox').value.timeoutMs;
        return { ok: subagent === 12 && search === 'http' && log === false && timeout === 90000, detail: { subagent, search, log, timeout } };
      }, 30_000, '运行参数保存');
    });

    await t.test('插件清单：真实装配行、启停与安装入口说明', async () => {
      await waitFor(async () => {
        const text = await evaluate('document.querySelector("[data-chdsh-plugin-count]").textContent');
        const count = Number(text.match(/(\d+) 行/u)?.[1] ?? '0');
        return { ok: count > 200, detail: text };
      }, 30_000, '装配清单载入');
      assert.match(await evaluate('document.querySelector("[data-chdsh-install]").textContent'), /SYS07/u);
      assert.equal(await evaluate('document.querySelector("[data-chdsh-install] input").disabled'), true);
      assert.equal(await evaluate('document.querySelector("[data-chdsh-install] button").disabled'), true);

      await cli('fill', '#chdsh-plugin-search', 'settings-enhancements');
      await waitFor(async () => {
        const text = await evaluate('document.body.textContent');
        return { ok: text.includes('@chatdsh/host-settings-enhancements'), detail: text.includes('settings-enhancements') };
      }, 15_000, '搜索设置增强行');
      await cli('fill', '#chdsh-plugin-search', 'plugin-manager/tools');
      await waitFor(async () => {
        const text = await evaluate('document.body.textContent');
        return { ok: text.includes('插件管理工具'), detail: text.slice(0, 200) };
      }, 15_000, '搜索插件管理工具');
      await cli('find', 'role', 'button', 'click', '--name', '启用 插件管理工具');
      await waitFor(async () => {
        const reply = await runtime.api('pluginInventory/list');
        const entry = reply.result.value.entries.find((item) => item.entryId === 'include:tool-plugin-manager');
        return { ok: entry?.enabled === true, detail: entry?.enabled };
      }, 30_000, '插件行启用');
      await waitFor(async () => {
        const labels = await evaluate('JSON.stringify([...document.querySelectorAll("button")].map((node) => node.textContent))');
        return { ok: labels.includes('停用 插件管理工具'), detail: labels.slice(0, 300) };
      }, 30_000, '插件行按钮回到停用');
      await cli('find', 'role', 'button', 'click', '--name', '停用 插件管理工具');
      await waitFor(async () => {
        const reply = await runtime.api('pluginInventory/list');
        const entry = reply.result.value.entries.find((item) => item.entryId === 'include:tool-plugin-manager');
        return { ok: entry?.enabled === false, detail: entry?.enabled };
      }, 30_000, '插件行停用');

      await cli('fill', '#chdsh-plugin-search', 'dsh-acp-app');
      await waitFor(async () => {
        const text = await evaluate('document.body.textContent');
        return { ok: text.includes('@deepseek-ai/dsh-acp-app'), detail: text.slice(0, 400) };
      }, 15_000, '搜索组合包');
      const uninstallText = await evaluate('document.body.textContent');
      assert.match(uninstallText, /卸载|不可卸载/u, '组合行给出卸载入口或明确的不可卸载原因');
    });

    await t.test('模型设置：提供方、清单来源、额度拒绝与默认模型写入', async () => {
      await waitFor(async () => {
        const text = await evaluate('document.body.textContent');
        return { ok: text.includes('2 个模型提供方') && text.includes('会话模型在首轮之后固定'), detail: text.includes('模型网关') };
      }, 30_000, '模型面板载入');
      await cli('find', 'role', 'button', 'click', '--name', '查看模型与额度 gateway');
      await waitFor(async () => {
        const text = await evaluate('document.querySelector("[data-chdsh-provider-detail=\\"gateway\\"]")?.textContent ?? ""');
        return { ok: text.includes('chatdsh-wp30-model') && text.includes('适配器没有发布模型目录'), detail: text };
      }, 30_000, '模型清单与来源');
      assert.match(await evaluate('document.querySelector("[data-chdsh-quota]").textContent'), /上限 0/u);
      assert.match(await evaluate('document.querySelector("[data-chdsh-quota]").textContent'), /额度不足/u);

      await cli('find', 'role', 'button', 'click', '--name', '查看模型与额度 alt');
      await waitFor(async () => {
        const text = await evaluate('document.querySelector("[data-chdsh-provider-detail=\\"alt\\"]")?.textContent ?? ""');
        return { ok: text.includes('路由没有注册'), detail: text };
      }, 30_000, '未注册路由的提供方');

      await cli('select', '#chdsh-model-provider', 'gateway');
      await waitFor(async () => {
        const present = await evaluate("document.querySelector('#chdsh-model-name option[value=\"chatdsh-wp30-model\"]') !== null");
        return { ok: present === true, detail: await evaluate('document.getElementById("chdsh-model-name").innerHTML.slice(0, 300)') };
      }, 30_000, '默认模型候选');
      await cli('select', '#chdsh-model-name', 'chatdsh-wp30-model');
      await cli('find', 'role', 'button', 'click', '--name', '保存默认模型');
      await waitFor(async () => {
        const value = readingOf(await namespacesOf(runtime), 'agent-default-model').value.model;
        return { ok: value === 'chatdsh-wp30-model', detail: value };
      }, 30_000, '默认模型写入');
      await waitFor(async () => {
        const snapshot = await settingsSnapshot(gateway.base);
        const row = snapshot['agent-default-model']?.find((entry) => entry.key === 'model');
        return { ok: row !== undefined && row.value.includes('chatdsh-wp30-model'), detail: row?.value };
      }, 30_000, '白名单同步到控制平面');
      const snapshot = await settingsSnapshot(gateway.base);
      assert.equal(JSON.stringify(snapshot).includes('90000'), false, '设备范围的路径与超时不上报');
      assert.equal(snapshot['bash-sandbox'], undefined);
    });

    await t.test('上下文占用：比例、剩余、窗口来源与降级原因', async () => {
      await waitFor(async () => {
        const text = await evaluate('document.querySelector("[data-chdsh-context-window]")?.textContent ?? ""');
        return { ok: text.includes('部署配置'), detail: text };
      }, 30_000, '上下文占用载入');
      assert.match(await evaluate('document.querySelector("[data-chdsh-context-remaining]").textContent'), /剩余 131072 token/u);
      assert.match(await evaluate('document.querySelector("[data-chdsh-context-window]").textContent'), /已降级：会话还没有固定模型/u);
      assert.match(await evaluate('document.querySelector("[data-chdsh-context-tokens]").textContent'), /用量投影/u);
    });

    await t.test('浏览器遥测：调用 span、界面动作与错误事件', async () => {
      await waitFor(async () => page.batches.length > 0 ? { ok: true } : { ok: false, detail: page.batches.length }, 30_000, '遥测上报');
      const text = JSON.stringify(page.batches);
      assert.ok(text.includes('chatdsh.client.remote.call'), '调用 span 已上报');
      assert.ok(text.includes('settings/describe') && text.includes('settings/update'), 'span 带调用方法');
      assert.ok(text.includes('chatdsh.client.ui.action'), '界面动作事件已上报');
      assert.ok(text.includes('settings-save') && text.includes('shortcut-record'), '动作名覆盖保存与快捷键录入');
      assert.ok(text.includes('chatdsh_client_errors_total'), '错误计数指标已上报');
      assert.ok(text.includes('settings/conflict'), '冲突错误码进入事件');
      assert.equal(text.includes('/usr/bin/fish'), false, '遥测里没有设置取值');
      assert.equal(text.includes('Ctrl+Enter'), false, '遥测里没有快捷键取值');
    });

    await t.test('重启读回：设置与默认模型持久化', async () => {
      await runtime.stop();
      runtime = await startRuntime({ home, device: { controlUrl: gateway.base, token: device.token, deviceId: device.deviceId } });
      const space = await namespacesOf(runtime);
      assert.equal(readingOf(space, 'ui-theme').value.preference, 'dark');
      assert.equal(readingOf(space, 'ui-theme').value.fontSize, 21);
      assert.equal(readingOf(space, 'chatdsh-settings-enhancements').value.shellProgram, '/usr/bin/fish');
      assert.equal(readingOf(space, 'chatdsh-settings-enhancements').value.shortcutSend, 'Ctrl+Enter');
      assert.equal(readingOf(space, 'subagent').value.maxActiveSubagents, 12);
      assert.equal(readingOf(space, 'session-log-deepseek').value.enabled, false);
      assert.equal(readingOf(space, 'agent-default-model').value.model, 'chatdsh-wp30-model');
    });
  } finally {
    if (opened) await cli('close').catch(() => undefined);
    if (page !== undefined) await page.close();
    if (runtime !== undefined) await runtime.stop();
    if (gateway !== undefined) await gateway.stop();
    releaseIndependentHome(home);
  }
});
