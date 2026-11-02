// WP13 连接器与 MCP 完整界面的验收测试：真实宿主服务、真实控制平面、真实 MCP 探针与真实 Chrome。
//
// 宿主侧挂载真实的存储枢纽、JSON 后端、存储域表单、系统提示、工具注册表与加载器；连接器服务
// 按真实配置运行，加载器行指向 DSH 原生的 MCP 客户端插件，工具目录的变化来自真实的协议握手。
// 控制平面是完整装配的真实网关（真实 SQLite 注册表），本机端点与另一台设备的端点分别上报，
// 用于核对「本机按设备取端点，两台设备的端点互不覆盖」。浏览器是 agent-browser 独立会话里的
// 真实 Chrome，使用独立 HOME、TMPDIR 与 profile，不截图；断言全部来自 DOM、可访问属性、焦点
// 位置、宿主实况、落盘文件与探针日志。
//
// 覆盖：列表的来源分组与空状态、加载失败重试、条件表单与互斥校验、参数 JSON 校验、凭据只存
// 变量名、名称规范化冲突、配置已保存与同步失败的双重状态与重新同步、注册表刷新与按设备取用、
// MCP 连接状态与工具列表、工具调用测试与停用后的权限拒绝、启停与删除的二次确认、对话框焦点
// 约束与 Escape 恢复焦点、错误摘要跳转、遥测信号。
//
// 运行：node --test e2e/unit/client-complete-wp13-connectors.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { ensureDeps } from '../lib/ensure-deps.mjs';

const execute = promisify(execFile);
const NODE_BIN = '/usr/local/nvm/versions/node/v24.19.0/bin';
const REPO = resolve(import.meta.dirname, '../../..');
const RUNTIME = resolve(import.meta.dirname, '../..');
ensureDeps(RUNTIME);
ensureDeps(resolve(REPO, 'dsh-adapter'));

const { Context } = await import('@deepseek-ai/cordis');
const Storage = (await import('@deepseek-ai/dsh-storage')).default;
const jsonBackend = await import('@deepseek-ai/dsh-storage-json');
const domainPlugin = await import('@deepseek-ai/dsh-storage-domain');
const { SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt');
const { ToolRuntime } = await import('@deepseek-ai/dsh-tools');
const { Loader } = await import('@deepseek-ai/cordis-plugin-loader');
const { TypertRemoteService } = await import('../../../dsh-adapter/lib/index.js');
const connectors = await import('../../packages/host/connectors/lib/index.js');
const contracts = await import('../../packages/core/contracts/lib/index.js');
const { UI_KIT_CSS } = await import('../../packages/core/ui-kit/lib/index.js');
const { createTelemetryClient } = await import('../../packages/core/diagnostics/lib/client.js');
const { defaultTelemetryConfig } = await import('../../packages/core/diagnostics/lib/config.js');
const { GatewayStore, readConfig, ReplicaStore, ShareStore, ReceiptStore, PushQueue } = await import('../../gateway/lib/store.js');
const { createPushHub } = await import('../../gateway/lib/push.js');
const { createGatewayServer } = await import('../../gateway/lib/server.js');

/** 本机设备标识；注册表按它取端点。 */
const DEVICE = 'device-wp13';

/** 另一台设备；它的端点不能被本机取用。 */
const OTHER_DEVICE = 'device-wp13-other';

/** 探针服务器路径。 */
const MCP_PROBE = resolve(import.meta.dirname, '../fixtures/mcp-probe.mjs');

/** 不可达的 http 端点，连接被立刻拒绝，不会让同步等待超时。 */
const UNREACHABLE_URL = 'http://127.0.0.1:1/mcp';

/** 凭据变量名：测试期间由宿主进程环境提供值。 */
const CREDENTIAL_ENV = 'CHATDSH_WP13_TOKEN';

/** 凭据值：只能出现在装配后的加载器行里，不能进入记录与页面。 */
const CREDENTIAL_VALUE = 'wp13-secret-value';

/** 等待条件成立。 */
async function waitFor(predicate, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((stop) => setTimeout(stop, 100));
  }
  throw new Error(`等待超时：${label}`);
}

/** 把服务端失败编成线的信封：只有 RemoteError 保留错误码。 */
function wireFailureOf(error) {
  if (typeof error === 'object' && error !== null && error.isDSHRemoteError === true) {
    return { code: error.code, message: error.message };
  }
  return { code: 'gateway/internal', message: error instanceof Error ? error.message : String(error) };
}

/**
 * 起一个完整装配的真实控制平面。
 * @returns {Promise<{ server: object, store: object, base: string }>} 服务与地址。
 */
async function startGateway() {
  const telemetry = createTelemetryClient({
    config: defaultTelemetryConfig({ surface: 'gateway' }),
    component: '@chatdsh/gateway',
    env: { CHATDSH_TELEMETRY: 'off' },
  });
  const store = new GatewayStore(':memory:');
  const server = createGatewayServer({
    config: { ...readConfig(), port: 0, llmGateway: { quota: {} } },
    store,
    replica: new ReplicaStore(store.handle()),
    share: new ShareStore(store.handle()),
    receipts: new ReceiptStore(store.handle()),
    push: createPushHub({
      queue: new PushQueue(store.handle()),
      devices: store,
      mode: 'all-at-once',
      escalationMs: 1000,
      telemetry,
    }),
    telemetry,
  });
  await server.start();
  return { server, store, base: server.url() };
}

/**
 * 往注册表上报一台设备的端点。
 * @param {string} base - 控制平面地址。
 * @param {string} device - 设备标识。
 * @param {Record<string, unknown>} servers - VSCode 形状的 servers 字典。
 */
async function publish(base, device, servers) {
  const response = await fetch(`${base}/chatdsh/gateway/mcp`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-chatdsh-node-id': device },
    body: JSON.stringify({ servers }),
  });
  assert.equal(response.status, 200, `上报端点失败：HTTP ${response.status}`);
  return await response.json();
}

/**
 * 挂载真实宿主：存储、工具注册表、加载器与连接器服务。
 * @param {{ root: string, gatewayUrl?: string }} options 数据根与控制平面地址。
 * @returns {Promise<{ ctx: object, service: object }>} 上下文与服务。
 */
async function openConnectorHost({ root, gatewayUrl }) {
  const ctx = new Context();
  await ctx.plugin(Storage);
  await ctx.plugin(jsonBackend, { root: join(root, 'storages') });
  await ctx.plugin(domainPlugin, { backend: 'json' });
  new SystemPrompt(ctx, {});
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(Loader);
  const service = new connectors.ChatdshConnectorService(ctx, gatewayUrl === undefined
    ? { deviceId: DEVICE }
    : { gatewayUrl, deviceId: DEVICE });
  await service[TypertRemoteService.init]();
  return { ctx, service };
}

/** 页面脚本：真实面板组件、真实数据入口与真实遥测，传输层走本机 HTTP 入口。 */
const PAGE_ENTRY = `
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ConnectorsPanel } from ${JSON.stringify(join(RUNTIME, 'packages/client/connectors/src/client/panel.tsx'))};
import { createConnectorsGateway } from ${JSON.stringify(join(RUNTIME, 'packages/client/connectors/src/client/gateway.ts'))};
import { createPanelTelemetry } from ${JSON.stringify(join(RUNTIME, 'packages/client/connectors/src/client/telemetry.ts'))};

async function call(endpoint, args) {
  const response = await fetch('/api/' + endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args }),
  });
  return response.json();
}

const gateway = createConnectorsGateway({ transport: { call }, telemetry: createPanelTelemetry() });
createRoot(document.getElementById('root')).render(createElement(ConnectorsPanel, { gateway }));
window.__wp13 = { ready: true };
`;

/**
 * 起页面与 Remote 入口。
 * @param {{ service: object, script: string }} options 宿主服务与页面脚本。
 * @returns {Promise<object>} 服务信息。
 */
async function startPage({ service, script }) {
  const batches = [];
  const control = { failList: false, offline: false, slowList: false };
  const handlers = {
    'chatdshConnectors/list': async () => {
      if (control.slowList) await new Promise((done) => setTimeout(done, 400));
      if (control.failList) throw new Error('连接器存储暂时不可用');
      return service.list();
    },
    'chatdshConnectors/get': ([id]) => service.get(id),
    'chatdshConnectors/states': () => service.states(),
    'chatdshConnectors/state': ([id]) => service.state(id),
    'chatdshConnectors/save': ([input]) => service.save(input),
    'chatdshConnectors/delete': ([id]) => service.remove(id),
    'chatdshConnectors/setEnabled': ([id, enabled]) => service.setEnabled(id, enabled),
    'chatdshConnectors/syncMcpRows': () => service.syncMcpRows(),
    'chatdshConnectors/refreshMcpRegistry': () => service.refreshMcpRegistry(),
    'chatdshConnectors/mcpStatus': () => service.mcpStatus(),
    'chatdshConnectors/mcpRows': () => service.mcpRows(),
    'chatdshConnectors/mcpTools': () => service.mcpTools(),
    'chatdshConnectors/callMcpTool': ([name, args]) => service.callMcpTool(name, args),
  };
  const tokens = readFileSync(join(RUNTIME, 'packages/client/theme/src/client/styles/tokens.css'), 'utf8');
  const html = [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>连接器面板</title><style>',
    tokens,
    '\n',
    UI_KIT_CSS,
    '\ndialog { margin: auto; } main { padding: 16px; max-width: 820px; }\n</style></head><body>',
    '<main><div id="root"></div></main>',
    '<script>',
    script,
    '</script></body></html>',
  ].join('');
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', async () => {
      const raw = chunks.length === 0 ? '' : Buffer.concat(chunks).toString('utf8');
      if (control.offline && url.pathname.startsWith('/api/')) {
        response.socket?.destroy();
        return;
      }
      if (url.pathname === '/chatdsh/telemetry/browser') {
        batches.push({ signal: request.headers['x-chatdsh-signal'], body: JSON.parse(raw) });
        response.writeHead(204).end();
        return;
      }
      if (url.pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(html);
        return;
      }
      const endpoint = url.pathname.replace(/^\/api\//u, '');
      const handler = handlers[endpoint];
      if (handler === undefined) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error: { code: 'object-not-found', message: endpoint } }));
        return;
      }
      const body = raw === '' ? {} : JSON.parse(raw);
      let payload;
      try {
        payload = { ok: true, value: await handler(body.args ?? []) };
      } catch (error) {
        payload = { ok: false, error: wireFailureOf(error) };
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    batches,
    control,
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}

/** 读一份落盘的 JSON 记录文件；数据根下的存储目录是 `<home>/runtime/storages`。 */
function readStore(home, unit) {
  return JSON.parse(readFileSync(join(home, 'runtime', 'storages', `${unit}.json`), 'utf8'));
}

test('真实 Chrome 完成列表、条件表单、双重状态、注册表、工具测试与启停删除', { timeout: 420000 }, async (t) => {
  const home = allocateIndependentHome('wp13-connectors');
  const probeLog = join(home, 'mcp-probe.log');
  const previousHome = process.env.HOME;
  const previousDshHome = process.env.DSH_HOME;
  const previousProbeLog = process.env.MCP_PROBE_LOG;
  const previousCredential = process.env[CREDENTIAL_ENV];
  process.env.HOME = home;
  process.env.DSH_HOME = home;
  process.env.MCP_PROBE_LOG = probeLog;
  delete process.env[CREDENTIAL_ENV];

  const session = `wp13-${randomUUID().slice(0, 8)}`;
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
    const result = await execute(`${NODE_BIN}/agent-browser`, ['--session', session, '--json', ...args], {
      env,
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const response = JSON.parse(result.stdout);
    assert.equal(response.success, true, `agent-browser ${args[0]}：${result.stdout}`);
    return response;
  };

  let gateway;
  let host;
  let page;
  let opened = false;
  const cleanups = [];
  try {
    gateway = await startGateway();
    // 两台设备各自上报端点：同一台服务器在两端的连接方式不同；另一台设备还有独占的服务器。
    await publish(gateway.base, DEVICE, {
      'notes-server': { type: 'stdio', command: process.execPath, args: [MCP_PROBE], credentialEnv: 'MCP_PROBE_LOG' },
      'remote-docs': { type: 'http', url: UNREACHABLE_URL },
    });
    await publish(gateway.base, OTHER_DEVICE, {
      'notes-server': { type: 'http', url: 'https://other.test/mcp' },
      'other-only': { type: 'http', url: 'https://other.test/only' },
    });

    host = await openConnectorHost({ root: join(home, 'runtime'), gatewayUrl: gateway.base });
    cleanups.push(async () => {
      for (const record of host.service.list()) await host.service.remove(record.id);
      await new Promise((stop) => setTimeout(stop, 500));
    });

    const bundle = await build({
      stdin: { contents: PAGE_ENTRY, resolveDir: RUNTIME, loader: 'tsx', sourcefile: 'wp13-page.tsx' },
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
    const script = bundle.outputFiles[0].text;
    assert.ok(script.length > 5000, `页面脚本大小异常：${String(script.length)}`);
    page = await startPage({ service: host.service, script });

    const evaluate = async (expression) => {
      const result = await cli('eval', expression);
      return result.data.result;
    };
    const textHas = async (needle) => evaluate(`document.body.innerText.includes(${JSON.stringify(needle)})`);
    const activeId = async () => evaluate('document.activeElement && document.activeElement.id');

    await cli('open', page.origin);
    opened = true;
    await cli('wait', '#wp13-connector-create');
    await cli('wait', '--fn', 'window.__wp13 && window.__wp13.ready === true');

    await t.test('列表：来源分组、注册表按设备取端点、空状态与端点计数', async () => {
      assert.equal(await evaluate('document.querySelectorAll(".chdsh-panel").length'), 1, '面板使用共享组件外壳');
      assert.equal(await textHas('还没有登记外部连接器'), true, '没有记录时显示空状态');
      assert.equal(await textHas('本机连接器（0）'), true, '本机连接器分组有一行小标题');
      assert.equal(await textHas('注册表端点（2）'), true, '本机只取自己的两个端点');
      assert.equal(await textHas('notes-server'), true, '注册表端点按服务器名列出');
      assert.equal(await textHas('remote-docs'), true);
      assert.equal(await textHas('other-only'), false, '另一台设备独占的服务器不出现在本机分组');
      assert.equal(await textHas('控制平面注册表 3 台服务器 · 本机端点 2 个'), true, '计数来自真实注册表与真实行');
      assert.equal(await evaluate('document.querySelectorAll(".chdsh-skeleton").length'), 0, '加载完成后没有骨架');
      const status = await host.service.mcpStatus();
      assert.equal(status.servers, 3, '注册表里三台服务器（含另一台设备的独占项）');
      assert.deepEqual(
        [...status.rows].sort(),
        ['chatdsh-mcp-endpoint-notes-server', 'chatdsh-mcp-endpoint-remote-docs'],
        '本机行只来自本设备端点',
      );
    });

    await t.test('加载失败与离线各有真实状态，重试后恢复', async () => {
      page.control.slowList = true;
      await cli('click', '#wp13-connector-refresh');
      assert.equal(await evaluate('document.querySelectorAll(".chdsh-skeleton").length > 0'), true, '读取期间显示骨架');
      await cli('wait', '--text', '还没有登记外部连接器');
      page.control.slowList = false;

      page.control.failList = true;
      await cli('click', '#wp13-connector-refresh');
      await cli('wait', '--text', '连接器存储暂时不可用');
      assert.equal(await evaluate('document.getElementById("wp13-connector-reload") !== null'), true, '失败状态给出重新加载入口');
      page.control.failList = false;
      await cli('click', '#wp13-connector-reload');
      await cli('wait', '--text', '注册表端点（2）');
      assert.equal(await evaluate('document.getElementById("wp13-connector-reload") === null'), true, '恢复后失败入口消失');

      page.control.offline = true;
      await cli('click', '#wp13-connector-refresh');
      await cli('wait', '--text', '控制平面不可达');
      page.control.offline = false;
      await cli('click', '#wp13-connector-reload');
      await cli('wait', '--text', '注册表端点（2）');
      assert.equal(await textHas('控制平面不可达'), false, '恢复连接后离线提示消失');
    });

    await t.test('条件表单：空提交、参数 JSON、凭据变量名与互斥字段都给出字段错误', async () => {
      await cli('click', '#wp13-connector-create');
      await cli('wait', 'dialog[open]');
      await cli('click', '#wp13-connector-submit');
      assert.equal(await evaluate('document.getElementById("wp13-connector-name").getAttribute("aria-invalid")'), 'true');
      assert.equal(await evaluate('document.getElementById("wp13-connector-command").getAttribute("aria-invalid")'), 'true');
      assert.equal(await evaluate('document.activeElement.classList.contains("chdsh-error-summary")'), true, '校验失败后焦点落在错误摘要');
      await cli('click', '.chdsh-error-summary a');
      assert.equal(await activeId(), 'wp13-connector-name', '摘要链接把焦点交给名称字段');

      await cli('fill', '#wp13-connector-name', 'probe server');
      await cli('fill', '#wp13-connector-command', process.execPath);
      await cli('fill', '#wp13-connector-args', '{');
      await cli('click', '#wp13-connector-submit');
      await cli('wait', '--text', '参数必须是 JSON 字符串数组，当前文本无法解析');
      await cli('fill', '#wp13-connector-args', '["ok",3]');
      await cli('click', '#wp13-connector-submit');
      await cli('wait', '--text', '参数必须是 JSON 字符串数组，例如');
      await cli('fill', '#wp13-connector-args', '');
      await cli('fill', '#wp13-connector-credential', 'token=abc');
      await cli('click', '#wp13-connector-submit');
      await cli('wait', '--text', '凭据只填环境变量名');
      assert.equal(await evaluate('document.getElementById("wp13-connector-credential").getAttribute("aria-invalid")'), 'true');
      assert.equal(await textHas('凭据值从本机环境读取，界面不回显也不保存值'), true, '凭据一栏说明值来自本机环境');
      assert.equal(host.service.list().length, 0, '校验失败没有写入记录');

      await cli('select', '#wp13-connector-transport', 'http');
      assert.equal(await evaluate('document.getElementById("wp13-connector-command") === null'), true, '切到 http 后命令字段不再渲染');
      assert.equal(await evaluate('document.getElementById("wp13-connector-url") !== null'), true, '切到 http 后出现地址字段');
      await cli('click', '#wp13-connector-submit');
      await cli('wait', '--text', 'http 方式的连接器必须给出地址');
      await cli('fill', '#wp13-connector-url', 'ftp://example.test/mcp');
      await cli('click', '#wp13-connector-submit');
      await cli('wait', '--text', '地址只支持 http 与 https');
      assert.equal(host.service.list().length, 0, '条件校验失败没有写入记录');
      await cli('press', 'Escape');
      await cli('wait', '--fn', '!document.querySelector("dialog[open]")');
    });

    await t.test('对话框焦点约束与 Escape 恢复焦点，错误摘要跳回首个问题字段', async () => {
      await cli('click', '#wp13-connector-create');
      await cli('wait', 'dialog[open]');
      await cli('click', '#wp13-connector-submit');
      await cli('click', '.chdsh-error-summary a');
      assert.equal(await activeId(), 'wp13-connector-name');
      for (let step = 0; step < 20; step += 1) {
        await cli('press', 'Tab');
        assert.equal(
          await evaluate('document.querySelector("dialog[open]").contains(document.activeElement)'),
          true,
          '焦点不能离开对话框',
        );
      }
      await cli('press', 'Shift+Tab');
      assert.equal(
        await evaluate('document.querySelector("dialog[open]").contains(document.activeElement)'),
        true,
        'Shift+Tab 也不能离开对话框',
      );
      await cli('press', 'Escape');
      await cli('wait', '--fn', '!document.querySelector("dialog[open]")');
      assert.equal(await activeId(), 'wp13-connector-create', 'Escape 之后焦点回到新建按钮');
    });

    await t.test('名称规范化后冲突时阻止保存，记录没有被写入', async () => {
      await cli('click', '#wp13-connector-create');
      await cli('wait', 'dialog[open]');
      await cli('fill', '#wp13-connector-name', 'probe server');
      await cli('fill', '#wp13-connector-command', process.execPath);
      await cli('fill', '#wp13-connector-args', JSON.stringify([MCP_PROBE]));
      await cli('fill', '#wp13-connector-credential', 'MCP_PROBE_LOG');
      await cli('click', '#wp13-connector-submit');
      await cli('wait', '--fn', '!document.querySelector("dialog[open]")');
      await cli('wait', '--text', 'probe server');
      assert.equal(host.service.list().length, 1, '第一条记录写入成功');

      await cli('click', '#wp13-connector-create');
      await cli('wait', 'dialog[open]');
      await cli('fill', '#wp13-connector-name', 'probe-server');
      await cli('fill', '#wp13-connector-command', process.execPath);
      await cli('click', '#wp13-connector-submit');
      await cli('wait', '--text', '名称规范化后与「probe server」冲突');
      assert.equal(await evaluate('document.getElementById("wp13-connector-name").getAttribute("aria-invalid")'), 'true');
      assert.equal(host.service.list().length, 1, '规范化冲突没有写入第二条记录');
      await cli('press', 'Escape');
      await cli('wait', '--fn', '!document.querySelector("dialog[open]")');
    });

    await t.test('编辑：改名保存，改成已占用的名称被拦下', async () => {
      await cli('click', '#wp13-connector-create');
      await cli('wait', 'dialog[open]');
      await cli('fill', '#wp13-connector-name', 'editable-connector');
      await cli('fill', '#wp13-connector-command', '/bin/true');
      await cli('click', '#wp13-connector-submit');
      await cli('wait', '--fn', '!document.querySelector("dialog[open]")');
      await cli('wait', '--text', 'editable-connector');
      const editable = host.service.list().find((item) => item.name === 'editable-connector');
      assert.ok(editable !== undefined, '第二条记录写入成功');

      await cli('find', 'role', 'button', 'click', '--name', '编辑 editable-connector');
      await cli('wait', 'dialog[open]');
      assert.equal(await evaluate('document.getElementById("wp13-connector-name").value'), 'editable-connector', '表单带回原名称');
      await cli('fill', '#wp13-connector-name', 'probe server');
      await cli('click', '#wp13-connector-submit');
      await cli('wait', '--text', '连接器名称 probe server 已被占用');
      assert.equal(host.service.get(editable.id).name, 'editable-connector', '重名没有写入');

      await cli('fill', '#wp13-connector-name', 'editable-renamed');
      await cli('click', '#wp13-connector-submit');
      await cli('wait', '--fn', '!document.querySelector("dialog[open]")');
      await cli('wait', '--text', 'editable-renamed');
      assert.equal(host.service.get(editable.id).name, 'editable-renamed', '改名写入了同一条记录');
      assert.equal(host.service.list().length, 2, '编辑没有新增记录');
    });

    await t.test('保存后同时显示配置已保存与同步结果，工具从真实握手进入目录', async () => {
      assert.equal(await textHas('已保存'), true, '列表显示配置已保存');
      assert.equal(await textHas('同步成功'), true, '加载器同步成功');
      const record = host.service.list().find((item) => item.name === 'probe server');
      assert.equal(record.name, 'probe server');
      assert.equal(record.transport, 'stdio');
      assert.deepEqual(record.args, [MCP_PROBE]);
      assert.equal(record.credentialEnv, 'MCP_PROBE_LOG');
      assert.equal(record.enabled, true);
      assert.equal(host.service.state(record.id).sync.status, 'ok');

      await waitFor(() => (host.service.mcpTools()['probe-server'] ?? []).length === 1, '探针服务器握手并注册工具');
      await cli('click', '#wp13-connector-refresh');
      await cli('wait', '--text', '已连接');
      assert.equal(await textHas('工具 1 个'), false, '工具数量只在详情里显示');
      assert.equal(existsSync(probeLog), true, '子进程通过注入的环境变量写了探针日志');
    });

    await t.test('注册表刷新按本设备端点重建行，另一台设备的端点不覆盖本机', async () => {
      await publish(gateway.base, DEVICE, {
        'notes-server': { type: 'stdio', command: process.execPath, args: [MCP_PROBE], credentialEnv: 'MCP_PROBE_LOG' },
        'remote-docs': { type: 'http', url: UNREACHABLE_URL },
        'late-server': { type: 'http', url: UNREACHABLE_URL },
      });
      await publish(gateway.base, OTHER_DEVICE, {
        'notes-server': { type: 'http', url: 'https://other.test/mcp' },
        'other-only': { type: 'http', url: 'https://other.test/only' },
      });
      await cli('click', '#wp13-connector-registry');
      await cli('wait', '--text', '注册表端点（3）');
      assert.equal(await textHas('控制平面注册表 4 台服务器 · 本机端点 3 个'), true, '注册表服务器与本机端点分别计数');
      assert.equal(await textHas('late-server'), true, '新端点按服务器名进入本机分组');
      const status = await host.service.mcpStatus();
      assert.equal(status.servers, 4);
      assert.equal(status.endpoints, 3);
      assert.equal(status.rows.includes('chatdsh-mcp-endpoint-other-only'), false, '另一台设备的端点没有进入本机行');
    });

    await t.test('详情：连接状态、工具列表、同步结果与工具调用测试', async () => {
      await cli('find', 'role', 'button', 'click', '--name', '详情 probe server');
      await cli('wait', 'dialog[open]');
      await cli('wait', '#wp13-detail-call');
      assert.equal(await evaluate('document.querySelector("#wp13-detail-connection").textContent'), '已连接');
      assert.equal(await textHas('工具 1 个'), true, '详情显示工具数量');
      assert.equal(await evaluate('document.querySelectorAll("#wp13-detail-tools li").length'), 1);
      assert.equal(await evaluate('document.querySelector("#wp13-detail-tools li").textContent'), 'mcp__probe-server__probe-tool');
      assert.equal(await textHas('同步成功'), true, '同步状态带最近时间');
      assert.equal(await textHas('凭据变量 MCP_PROBE_LOG：只保存变量名'), true, '凭据说明可见');
      assert.equal(await evaluate('document.getElementById("wp13-detail-endpoint").textContent.startsWith("行配置 stdio")'), true, '详情显示加载器行配置');
      assert.equal(await evaluate(`document.getElementById("wp13-detail-endpoint").textContent.includes(${JSON.stringify(process.execPath)})`), true, '行配置带真实命令');
      assert.equal(await evaluate('document.getElementById("wp13-detail-endpoint").textContent.includes("凭据变量 MCP_PROBE_LOG")'), true, '行配置里的凭据只有变量名');

      assert.equal(await evaluate('document.getElementById("wp13-detail-call").disabled'), true, '没有执行确认时调用按钮不可用');
      await cli('click', '#wp13-detail-confirm');
      await cli('fill', '#wp13-detail-args', '{');
      await cli('click', '#wp13-detail-call');
      await cli('wait', '--text', '参数不是合法的 JSON');
      await cli('fill', '#wp13-detail-args', '[]');
      await cli('click', '#wp13-detail-call');
      await cli('wait', '--text', '参数必须是 JSON 对象');
      const beforeCall = existsSync(probeLog) ? readFileSync(probeLog, 'utf8') : '';
      assert.equal(beforeCall.includes('"method":"tools/call"'), false, '参数非法时没有调用工具');

      await cli('fill', '#wp13-detail-args', '{}');
      await cli('click', '#wp13-detail-call');
      await cli('wait', '--text', '状态：调用成功');
      assert.equal(await evaluate('document.getElementById("wp13-call-structured").textContent.includes("\\"isError\\": false")'), true);
      assert.equal(await evaluate('document.getElementById("wp13-call-status").textContent'), '状态：调用成功');
      assert.equal(await textHas('耗时'), true, '调用结果带耗时');
      assert.equal(await evaluate('document.getElementById("wp13-call-full") !== null'), true, '完整结果读取入口存在');
      await waitFor(() => readFileSync(probeLog, 'utf8').includes('"method":"tools/call"'), '调用到达真实 MCP 服务器');
      await cli('press', 'Escape');
      await cli('wait', '--fn', '!document.querySelector("dialog[open]")');
      assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), '详情 probe server', 'Escape 之后焦点回到详情按钮');
    });

    await t.test('停用与启用：二次确认、工具离开目录、停用后宿主拒绝调用', async () => {
      await cli('find', 'role', 'button', 'click', '--name', '停用 probe server');
      await cli('wait', 'dialog[open]');
      assert.equal(await textHas('工具从目录移除'), true, '确认框说明停用的后果');
      assert.equal(
        await evaluate('document.querySelector("dialog[open]").contains(document.activeElement)'),
        true,
        '确认框打开后焦点在其中',
      );
      await cli('press', 'Escape');
      await cli('wait', '--fn', '!document.querySelector("dialog[open]")');
      assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), '停用 probe server');

      await cli('find', 'role', 'button', 'click', '--name', '停用 probe server');
      await cli('wait', 'dialog[open]');
      await cli('click', '#wp13-toggle-confirm');
      await cli('wait', '--fn', '!document.querySelector("dialog[open]")');
      await cli('wait', '--text', '已停用');
      const record = host.service.list().find((item) => item.name === 'probe server');
      const disabled = host.service.state(record.id);
      assert.equal(disabled.enabled, false);
      assert.deepEqual(disabled.rows, []);
      await waitFor(() => (host.service.mcpTools()['probe-server'] ?? []).length === 0, '停用后工具从目录消失');
      assert.deepEqual(host.service.state(record.id).tools, []);
      await assert.rejects(
        async () => host.service.callMcpTool('mcp__probe-server__probe-tool', {}),
        (error) => {
          assert.equal(error.code, contracts.CHATDSH_ERROR_CODES.permissionDenied, '停用后宿主拒绝调用');
          return true;
        },
      );

      await cli('find', 'role', 'button', 'click', '--name', '详情 probe server');
      await cli('wait', 'dialog[open]');
      await cli('wait', '#wp13-detail-call');
      assert.equal(await textHas('这个连接器已停用'), true, '详情说明停用后不可调用的原因');
      assert.equal(await textHas('加载器里没有这一行'), true, '停用后详情说明行已被移除');
      assert.equal(await evaluate('document.getElementById("wp13-detail-call").disabled'), true, '停用后调用按钮不可用');
      await cli('press', 'Escape');
      await cli('wait', '--fn', '!document.querySelector("dialog[open]")');

      await cli('find', 'role', 'button', 'click', '--name', '启用 probe server');
      await cli('wait', 'dialog[open]');
      await cli('click', '#wp13-toggle-confirm');
      await cli('wait', '--fn', '!document.querySelector("dialog[open]")');
      await cli('wait', '--text', '同步成功');
      await waitFor(() => (host.service.mcpTools()['probe-server'] ?? []).length === 1, '启用后工具回到目录');
      assert.equal(host.service.state(record.id).enabled, true);
    });

    await t.test('配置已保存而同步失败时同时显示两种结果，补齐凭据后重新同步成功', async () => {
      const recordsBefore = host.service.list().length;
      await cli('click', '#wp13-connector-create');
      await cli('wait', 'dialog[open]');
      await cli('fill', '#wp13-connector-name', 'credential-bound');
      await cli('select', '#wp13-connector-transport', 'http');
      await cli('fill', '#wp13-connector-url', UNREACHABLE_URL);
      await cli('fill', '#wp13-connector-credential', CREDENTIAL_ENV);
      await cli('click', '#wp13-connector-submit');
      await cli('wait', '--fn', '!document.querySelector("dialog[open]")');
      await cli('wait', '--text', 'connector-credential-missing');
      assert.equal(host.service.list().length, recordsBefore + 1, '配置已经落盘');
      assert.equal(await textHas('已保存'), true, '同步失败时仍然显示配置已保存');
      assert.equal(await textHas('同步失败'), true, '同步失败单独显示');
      assert.equal(await textHas('connector-credential-missing'), true, '同步失败带错误码与最近时间');
      const failed = host.service.list().find((item) => item.name === 'credential-bound');
      const failedState = host.service.state(failed.id);
      assert.equal(failedState.configSaved, true);
      assert.equal(failedState.sync.status, 'failed');
      assert.equal(failedState.sync.errorCode, contracts.CHATDSH_ERROR_CODES.connectorCredentialMissing);
      assert.equal(readStore(home, 'connectors_sync_store').tables.states[failed.id].status, 'failed', '同步状态真实落盘');

      // 凭据变量仍然没有值时重新同步会失败：失败提示与失败 span 都来自这一次真实调用。
      await cli('click', '#wp13-connector-resync');
      await cli('wait', '--text', '连接器声明的凭据环境变量在本机没有值');
      assert.equal(host.service.state(failed.id).sync.status, 'failed', '缺少凭据变量时同步仍然失败');

      process.env[CREDENTIAL_ENV] = CREDENTIAL_VALUE;
      await cli('click', '#wp13-connector-resync');
      await cli('wait', '--text', '同步成功');
      assert.equal(host.service.state(failed.id).sync.status, 'ok');
      const store = readFileSync(join(home, 'runtime', 'storages', 'connectors_store.json'), 'utf8');
      assert.ok(store.includes(CREDENTIAL_ENV), '记录里保存变量名');
      assert.equal(store.includes(CREDENTIAL_VALUE), false, '记录里不出现凭据值');
      assert.equal(await textHas(CREDENTIAL_VALUE), false, '页面不回显凭据值');
      assert.equal(host.service.mcpRows().some((item) => item.credentialEnv === CREDENTIAL_ENV), true, '行配置只带变量名');
    });

    await t.test('启停失败给出提示并刷新状态', async () => {
      const target = host.service.list().find((item) => item.name === 'credential-bound');
      await cli('find', 'role', 'button', 'click', '--name', '停用 credential-bound');
      await cli('wait', 'dialog[open]');
      assert.equal(await host.service.remove(target.id), true, '记录在确认之前被另一处删除');
      await cli('click', '#wp13-toggle-confirm');
      await cli('wait', '--text', `连接器 ${target.id} 不存在`);
      assert.equal(await textHas(`连接器 ${target.id} 不存在`), true, '失败提示来自宿主返回的说明');
      assert.equal(await textHas('connector-credential-missing'), false, '刷新后旧的同步失败说明消失');
      await cli('press', 'Escape');
      await cli('wait', '--fn', '!document.querySelector("dialog[open]")');
      await cli('wait', '--fn', '!document.body.innerText.includes("credential-bound")');
      assert.equal(host.service.list().some((item) => item.name === 'credential-bound'), false);
    });

    await t.test('删除：二次确认后记录与工具一并移除', async () => {
      await cli('find', 'role', 'button', 'click', '--name', '删除 editable-renamed');
      await cli('wait', 'dialog[open]');
      await cli('click', '#wp13-delete-confirm');
      await cli('wait', '--fn', '!document.querySelector("dialog[open]")');
      await cli('wait', '--fn', '!document.body.innerText.includes("editable-renamed")');
      assert.equal(host.service.list().length, 1, '只剩探针连接器');

      await cli('find', 'role', 'button', 'click', '--name', '删除 probe server');
      await cli('wait', 'dialog[open]');
      assert.equal(await textHas('删除移除配置并同步加载器行'), true, '确认框说明删除范围');
      for (let step = 0; step < 6; step += 1) {
        await cli('press', 'Tab');
        assert.equal(
          await evaluate('document.querySelector("dialog[open]").contains(document.activeElement)'),
          true,
          '删除确认框内焦点不逃逸',
        );
      }
      await cli('click', '#wp13-delete-confirm');
      await cli('wait', '--fn', '!document.querySelector("dialog[open]")');
      await cli('wait', '--text', '还没有登记外部连接器');
      assert.equal(host.service.list().length, 0);
      await waitFor(() => (host.service.mcpTools()['probe-server'] ?? []).length === 0, '删除后工具从目录消失');
      assert.equal(
        [...host.ctx.loader.entries()].some((entry) => String(entry.options.id) === connectors.rowIdOf('probe-server')),
        false,
        '删除后加载器里没有该连接器的行',
      );
      assert.equal(statSync(join(home, 'runtime', 'storages', 'connectors_store.json')).isFile(), true, '记录文件真实存在');
    });

    await t.test('遥测：动作事件、调用 span、失败事件与失败计数都送到同源中继', async () => {
      const deadline = Date.now() + 8000;
      const logs = () => page.batches
        .filter((batch) => batch.signal === 'logs')
        .flatMap((batch) => (batch.body.resourceLogs ?? []).flatMap((resource) => resource.scopeLogs ?? []))
        .flatMap((scope) => scope.logRecords ?? [])
        .map((record) => ({
          name: record.body?.stringValue ?? '',
          attributes: Object.fromEntries((record.attributes ?? []).map((entry) => [entry.key, entry.value.stringValue ?? entry.value.intValue])),
        }));
      while (Date.now() < deadline && !logs().some((record) => record.name === 'chatdsh.client.error')) {
        await new Promise((done) => setTimeout(done, 50));
      }
      const records = logs();
      const actions = records.filter((record) => record.name === 'chatdsh.client.ui.action');
      assert.ok(actions.some((record) => record.attributes.action === 'connector.create' && record.attributes.outcome === 'ok'), '新建成功有界面动作');
      assert.ok(actions.some((record) => record.attributes.action === 'connector.create' && record.attributes.outcome === 'rejected'), '表单校验失败记为 rejected');
      assert.ok(actions.some((record) => record.attributes.action === 'connector.update' && record.attributes.outcome === 'ok'), '编辑保存有界面动作');
      assert.ok(actions.some((record) => record.attributes.action === 'connector.disable' && record.attributes.outcome === 'ok'), '停用成功');
      assert.ok(actions.some((record) => record.attributes.action === 'connector.enable' && record.attributes.outcome === 'ok'), '启用成功');
      assert.ok(actions.some((record) => record.attributes.action === 'connector.sync' && record.attributes.outcome === 'ok'), '重新同步成功');
      assert.ok(actions.some((record) => record.attributes.action === 'connector.call' && record.attributes.outcome === 'ok'), '工具调用成功');
      assert.ok(actions.some((record) => record.attributes.action === 'connector.call' && record.attributes.outcome === 'rejected'), '参数非法时调用被界面拦下');
      assert.ok(actions.some((record) => record.attributes.action === 'connector.delete' && record.attributes.outcome === 'ok'), '删除成功');
      assert.ok(actions.some((record) => record.attributes.action === 'connector.registry.refresh' && record.attributes.outcome === 'ok'), '注册表刷新成功');
      assert.ok(actions.every((record) => typeof record.attributes.action === 'string' && typeof record.attributes.outcome === 'string'));

      const failures = records.filter((record) => record.name === 'chatdsh.client.error');
      assert.ok(failures.length >= 2, '失败分支各自有一条错误事件');
      assert.ok(failures.some((record) => record.attributes['error.code'] === 'gateway/internal'), '读取失败与同步失败都按边界错误码上报');
      assert.ok(failures.every((record) => typeof record.attributes['error.type'] === 'string' && record.attributes['error.type'] !== ''));

      const spans = page.batches
        .filter((batch) => batch.signal === 'traces')
        .flatMap((batch) => (batch.body.resourceSpans ?? []).flatMap((resource) => resource.scopeSpans ?? []))
        .flatMap((scope) => scope.spans ?? [])
        .map((span) => ({
          name: span.name,
          attributes: Object.fromEntries((span.attributes ?? []).map((entry) => [entry.key, entry.value.stringValue])),
        }));
      assert.ok(spans.length > 0, '每个 Remote 调用都有 span');
      assert.ok(spans.every((span) => span.name === 'chatdsh.client.remote.call'));
      assert.ok(spans.some((span) => span.attributes['rpc.method'] === 'chatdshConnectors/save' && span.attributes.outcome === 'ok'));
      assert.ok(spans.some((span) => span.attributes['rpc.method'] === 'chatdshConnectors/syncMcpRows' && span.attributes.outcome === 'failed'), '失败的同步有失败 span');
      assert.ok(spans.some((span) => span.attributes['rpc.method'] === 'chatdshConnectors/callMcpTool' && span.attributes.outcome === 'ok'));
      const metrics = page.batches
        .filter((batch) => batch.signal === 'metrics')
        .flatMap((batch) => (batch.body.resourceMetrics ?? []).flatMap((resource) => resource.scopeMetrics ?? []))
        .flatMap((scope) => (scope.metrics ?? []).map((metric) => metric.name));
      assert.ok(metrics.includes('chatdsh_client_errors_total'), '失败计数上报');
    });

    const errors = await cli('errors');
    assert.deepEqual(errors.data.errors, [], '页面没有未捕获的错误');
  } finally {
    if (opened) await cli('close');
    if (page !== undefined) await page.close();
    for (const cleanup of cleanups.reverse()) await cleanup();
    if (host !== undefined) await host.ctx.fiber.dispose();
    if (gateway !== undefined) {
      await gateway.server.stop();
      gateway.store.close();
    }
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousDshHome;
    if (previousProbeLog === undefined) delete process.env.MCP_PROBE_LOG;
    else process.env.MCP_PROBE_LOG = previousProbeLog;
    if (previousCredential === undefined) delete process.env[CREDENTIAL_ENV];
    else process.env[CREDENTIAL_ENV] = previousCredential;
    releaseIndependentHome(home);
  }
});
