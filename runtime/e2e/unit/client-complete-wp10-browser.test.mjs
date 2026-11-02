// WP10 项目界面的真实浏览器验收：列表状态、新建向导、字段校验、版本冲突、删除确认与键盘焦点。
//
// 页面用 esbuild 打包真实界面源码（`packages/client/projects/src/client/panel.tsx` 与它的数据入口、
// 遥测模块），宿主侧是真实的项目服务实例（真实的存储中枢、JSON 后端、存储域、系统提示、模型
// 运行时、预设注册表、模型提供方服务），目录列举经设备前缀 `/d/<deviceId>/api/directoryPicker/list`
// 交给真实的目录浏览后端与 workspace 控制器，列举的是真实文件系统。浏览器是 agent-browser 独立
// 会话里的真实 Chrome，使用独立 HOME、TMPDIR 与 profile，不截图，断言全部来自 DOM、可访问属性、
// 焦点位置与宿主实况。
//
// 运行：node --test e2e/unit/client-complete-wp10-browser.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
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
const { default: Storage } = await import('@deepseek-ai/dsh-storage');
const json = await import('@deepseek-ai/dsh-storage-json');
const domainPlugin = await import('@deepseek-ai/dsh-storage-domain');
const { default: SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt');
const { default: LlmRuntime } = await import('@deepseek-ai/dsh-llm');
const { default: SessionProjectionRegistry } = await import('@deepseek-ai/dsh-session-projection');
const { default: Loader } = await import('@deepseek-ai/cordis-plugin-loader');
const { default: AgentPresetRegistry } = await import('@deepseek-ai/dsh-agent-preset-registry');
const { default: SessionPlugin } = await import('@deepseek-ai/dsh-session');
const { default: BrowseDirectoryPicker } = await import('@deepseek-ai/dsh-host-directory-picker-browse');
const { DirectoryPickerController } = await import('@deepseek-ai/dsh-api-workspace-controller');
const { ChatdshProjectsService } = await import('../../packages/host/projects/lib/index.js');
const { ChatdshModelProviderService } = await import('../../packages/host/model-provider/lib/index.js');
const { GatewayLlmAdapter } = await import('../../packages/host/llm-router/lib/index.js');
const { UI_KIT_CSS } = await import('../../packages/core/ui-kit/lib/index.js');

/** 设备标识；目录列举经它的前缀转发。 */
const DEVICE = 'device-wp10';

/** 页面脚本：真实面板组件 + 真实数据入口 + 真实遥测，传输层换成设备与宿主入口的 HTTP。 */
const PAGE_ENTRY = `
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ProjectsPanel } from ${JSON.stringify(join(RUNTIME, 'packages/client/projects/src/client/panel.tsx'))};
import { createProjectsGateway } from ${JSON.stringify(join(RUNTIME, 'packages/client/projects/src/client/gateway.ts'))};
import { createPanelTelemetry } from ${JSON.stringify(join(RUNTIME, 'packages/client/projects/src/client/telemetry.ts'))};

const DEVICE = ${JSON.stringify(DEVICE)};

async function call(endpoint, args) {
  if (endpoint.startsWith('directoryPicker/')) {
    const rpcId = crypto.randomUUID();
    const response = await fetch('/d/' + DEVICE + '/api/' + endpoint, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args: args[0] } }),
    });
    const frame = await response.json();
    if (frame.type !== 'server-response' || frame.rpcId !== rpcId) throw new Error('设备应答与请求不符');
    return frame.result;
  }
  const response = await fetch('/api/' + endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args }),
  });
  return response.json();
}

const transport = { call };
const telemetry = createPanelTelemetry();
const gateway = createProjectsGateway({ transport, telemetry });
createRoot(document.getElementById('root')).render(createElement(ProjectsPanel, { gateway }));
window.__wp10 = { ready: true, gateway };
`;

/** 等待插件树激活。 */
function settle(ms = 1200) {
  return new Promise((done) => setTimeout(done, ms));
}

/** 把服务端失败编成线的信封：只有 RemoteError 保留错误码。 */
function wireFailureOf(error) {
  if (typeof error === 'object' && error !== null && error.isDSHRemoteError === true) {
    return { code: error.code, message: error.message };
  }
  return { code: 'gateway/internal', message: error instanceof Error ? error.message : String(error) };
}

/**
 * 装配真实宿主：项目服务、模型提供方、预设名册与目录浏览后端。
 * @param {{ root: string }} paths 数据根。
 * @returns {Promise<import('@deepseek-ai/cordis').Context>} 上下文。
 */
async function openStack({ root }) {
  const ctx = new Context();
  ctx.plugin(Storage);
  ctx.plugin(json, { root: join(root, 'storages') });
  ctx.plugin(domainPlugin, { backend: 'json' });
  ctx.plugin(SystemPrompt);
  ctx.plugin(LlmRuntime);
  ctx.plugin(SessionProjectionRegistry);
  ctx.plugin(Loader, { baseUrl: `${RUNTIME}/` });
  ctx.plugin(AgentPresetRegistry, { default: 'chatdsh-work' });
  ctx.plugin(SessionPlugin);
  ctx.plugin(ChatdshModelProviderService, {
    providers: [{
      provider: 'gateway',
      displayName: '网关',
      baseUrl: 'http://127.0.0.1:1/llm',
      models: ['xhs/dots3-note-prev'],
    }],
  });
  ctx.plugin(BrowseDirectoryPicker, { maxEntries: 200 });
  ctx.plugin(DirectoryPickerController);
  ctx.plugin(ChatdshProjectsService);
  await settle();
  ctx.llm.registerAdapter(['gateway'], new GatewayLlmAdapter({ baseUrl: 'http://127.0.0.1:1/llm', provider: 'gateway', quota: {} }));
  await ctx.agentPresets.register({ id: 'assistant-alpha', name: '甲助手', description: '', order: 1, plugins: [] });
  await ctx.agentPresets.register({ id: 'assistant-beta', name: '乙助手', description: '', order: 2, plugins: [] });
  return ctx;
}

/**
 * 起页面与两个入口：宿主 Remote 入口、设备前缀的目录列举入口。
 * @param {{ ctx: import('@deepseek-ai/cordis').Context, script: string, origin: () => string }} options 依赖。
 * @returns {Promise<{ origin: string, batches: object[], close: () => Promise<void> }>} 服务信息。
 */
async function startPage({ ctx, script }) {
  const batches = [];
  const control = { failList: false, slowList: false, offline: false };
  const handlers = {
    'chatdshProjects/list': async () => {
      if (control.slowList) await new Promise((done) => setTimeout(done, 400));
      if (control.failList) throw new Error('项目存储暂时不可用');
      return ctx.chatdshProjects.list();
    },
    'chatdshProjects/get': ([path]) => ctx.chatdshProjects.get(path),
    'chatdshProjects/create': ([input]) => ctx.chatdshProjects.create(input),
    'chatdshProjects/set': ([input]) => ctx.chatdshProjects.set(input),
    'chatdshProjects/delete': ([path]) => ctx.chatdshProjects.remove(path),
    'agentPresets/list': () => ctx.agentPresets.remoteExportList(),
    'chatdshModelProviders/list': () => ctx.chatdshModelProviders.list(),
  };
  const tokens = readFileSync(join(RUNTIME, 'packages/client/theme/src/client/styles/tokens.css'), 'utf8');
  const html = [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>项目面板</title><style>',
    tokens,
    '\n',
    UI_KIT_CSS,
    '\ndialog { margin: auto; } main { padding: 16px; max-width: 720px; }\n</style></head><body>',
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
      const deviceMatch = /^\/d\/([^/]+)\/api\/(.+)$/u.exec(url.pathname);
      if (deviceMatch !== null) {
        const frame = JSON.parse(raw);
        try {
          assert.equal(deviceMatch[1], DEVICE);
          assert.equal(frame.type, 'client-request');
          assert.equal(frame.method, 'directoryPicker/list');
          const listing = await ctx.directoryPickerController.list(frame.payload?.args, new AbortController().signal);
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ type: 'server-response', rpcId: frame.rpcId, result: { ok: true, value: listing } }));
        } catch (error) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ type: 'server-response', rpcId: frame.rpcId, result: { ok: false, error: wireFailureOf(error) } }));
        }
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

test('真实 Chrome 完成列表、向导校验、目录列举、版本冲突、删除确认与键盘焦点', { timeout: 240000 }, async (t) => {
  const home = allocateIndependentHome('wp10-browser');
  const account = join(home, 'account');
  mkdirSync(join(account, 'alpha'), { recursive: true });
  mkdirSync(join(account, 'beta'), { recursive: true });
  const previousHome = process.env.HOME;
  process.env.HOME = account;

  const session = `wp10-${randomUUID().slice(0, 8)}`;
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
    const result = await execute(`${NODE_BIN}/agent-browser`, ['--session', session, '--json', ...args], { env, timeout: 40000, maxBuffer: 4 * 1024 * 1024 });
    const response = JSON.parse(result.stdout);
    assert.equal(response.success, true, `agent-browser ${args[0]}：${result.stdout}`);
    return response;
  };

  let ctx;
  let page;
  let opened = false;
  try {
    ctx = await openStack({ root: join(home, 'runtime') });
    const bundle = await build({
      stdin: { contents: PAGE_ENTRY, resolveDir: RUNTIME, loader: 'tsx', sourcefile: 'wp10-page.tsx' },
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
    page = await startPage({ ctx, script });
    const evaluate = async (expression) => {
      const result = await cli('eval', expression);
      return result.data.result;
    };
    const textHas = async (needle) => evaluate(`document.body.innerText.includes(${JSON.stringify(needle)})`);

    await cli('open', page.origin);
    opened = true;
    await cli('wait', '#wp10-project-create');
    await cli('wait', '--fn', 'window.__wp10 && window.__wp10.ready === true');
    assert.equal(await textHas('还没有项目'), true, '空数据根显示空状态');
    assert.equal(await evaluate('document.querySelectorAll(".chdsh-panel").length'), 1, '面板使用共享组件外壳');

    await t.test('列表的加载中与读取失败各有真实状态，失败后可重新加载', async () => {
      page.control.slowList = true;
      await cli('click', '#wp10-project-refresh');
      assert.equal(await evaluate('document.querySelectorAll(".chdsh-panel .chdsh-skeleton").length > 0'), true, '读取期间显示骨架');
      await cli('wait', '--text', '还没有项目');
      page.control.slowList = false;

      page.control.failList = true;
      await cli('click', '#wp10-project-refresh');
      await cli('wait', '--text', '项目存储暂时不可用');
      assert.equal(await evaluate('document.getElementById("wp10-project-reload") !== null'), true, '失败状态给出重新加载入口');
      page.control.failList = false;
      await cli('click', '#wp10-project-reload');
      await cli('wait', '--text', '还没有项目');
      assert.equal(await evaluate('document.getElementById("wp10-project-reload") === null'), true, '恢复后失败入口消失');

      page.control.offline = true;
      await cli('click', '#wp10-project-refresh');
      await cli('wait', '--text', '控制平面不可达');
      page.control.offline = false;
      await cli('click', '#wp10-project-reload');
      await cli('wait', '--text', '还没有项目');
      assert.equal(await textHas('控制平面不可达'), false, '恢复连接后离线提示消失');
    });

    await t.test('新建向导：目录经设备前缀真实列举，空目录提交有字段校验', async () => {
      await cli('click', '#wp10-project-create');
      await cli('wait', 'dialog[open]');
      await cli('wait', '#wp10-project-choose');
      assert.equal(await textHas('alpha'), true, '列举结果来自真实家目录');
      assert.equal(await textHas('beta'), true);
      assert.equal(await evaluate('document.getElementById("wp10-project-path").value'), '', '尚未选择目录时路径为空');

      await cli('click', '#wp10-project-submit');
      assert.equal(await evaluate('document.getElementById("wp10-project-path").getAttribute("aria-invalid")'), 'true');
      assert.equal(await evaluate('document.activeElement.classList.contains("chdsh-error-summary")'), true, '校验失败后焦点落在错误摘要');
      await cli('click', '.chdsh-error-summary a');
      assert.equal(await evaluate('document.activeElement.id'), 'wp10-project-path', '摘要链接把焦点交给目录字段');

      await cli('find', 'role', 'button', 'click', '--name', '打开 alpha');
      await cli('wait', '--text', '这个目录下没有子目录');
      await cli('click', '#wp10-project-choose');
      assert.equal(await evaluate('document.getElementById("wp10-project-path").value'), join(account, 'alpha'));

      await cli('fill', '#wp10-project-title', '字'.repeat(81));
      await cli('click', '#wp10-project-submit');
      assert.equal(await evaluate('document.getElementById("wp10-project-title").getAttribute("aria-invalid")'), 'true');
      assert.equal(await textHas('名称最多 80 个字符'), true, '名称超限给出字段说明');
      assert.equal(ctx.chatdshProjects.list().length, 0, '校验失败没有写入记录');
    });

    await t.test('名称留空按目录末段显示，提交后列表刷新并带默认值徽标', async () => {
      await cli('focus', '#wp10-project-title');
      await cli('press', 'Control+a');
      await cli('press', 'Delete');
      assert.equal(await evaluate('document.getElementById("wp10-project-title").value'), '', '名称被清空');
      await cli('select', '#wp10-project-model', 'gateway/xhs/dots3-note-prev');
      await cli('select', '#wp10-project-assistant', 'assistant-alpha');
      await cli('click', '#wp10-project-submit');
      await cli('wait', '--fn', '!document.querySelector("dialog[open]")');
      await cli('wait', '--text', '默认模型 gateway/xhs/dots3-note-prev');
      const records = ctx.chatdshProjects.list();
      assert.equal(records.length, 1);
      assert.equal(records[0].path, join(account, 'alpha'));
      assert.equal(records[0].title, '', '名称为空保存为空串');
      assert.equal(records[0].displayTitle, 'alpha', '展示名回退到目录末段');
      assert.equal(records[0].defaultModel, 'gateway/xhs/dots3-note-prev');
      assert.equal(records[0].defaultAssistant, 'assistant-alpha');
      assert.equal(await textHas('默认助手 甲助手'), true, '默认助手徽标用名册里的展示名');
      assert.equal(await textHas(join(account, 'alpha')), true, '列表行带绝对路径');
    });

    await t.test('Escape 关闭向导并把焦点还给触发按钮', async () => {
      await cli('click', '#wp10-project-create');
      await cli('wait', 'dialog[open]');
      await cli('wait', '#wp10-project-choose');
      await cli('press', 'Escape');
      await cli('wait', '--fn', '!document.querySelector("dialog[open]")');
      assert.equal(await evaluate('document.activeElement.id'), 'wp10-project-create');
    });

    await t.test('向导内 Tab 顺序与焦点约束', async () => {
      await cli('click', '#wp10-project-create');
      await cli('wait', 'dialog[open]');
      await cli('wait', '#wp10-project-choose');
      await cli('focus', '#wp10-project-path');
      const order = ['wp10-project-title', 'wp10-project-instructions', 'wp10-project-model', 'wp10-project-assistant'];
      for (const id of order) {
        await cli('press', 'Tab');
        assert.equal(await evaluate('document.activeElement.id'), id, `Tab 应当到 ${id}`);
      }
      await cli('press', 'Shift+Tab');
      assert.equal(await evaluate('document.activeElement.id'), 'wp10-project-model', 'Shift+Tab 退回上一个字段');
      for (let step = 0; step < 24; step += 1) {
        await cli('press', 'Tab');
        assert.equal(await evaluate('document.querySelector("dialog[open]").contains(document.activeElement)'), true, '焦点不能离开对话框');
      }
      await cli('press', 'Escape');
      await cli('wait', '--fn', '!document.querySelector("dialog[open]")');
    });

    await t.test('相同目录拒绝重复，错误摘要指向目录字段', async () => {
      await cli('click', '#wp10-project-create');
      await cli('wait', '#wp10-project-choose');
      await cli('find', 'role', 'button', 'click', '--name', '打开 alpha');
      await cli('wait', '--text', '这个目录下没有子目录');
      await cli('click', '#wp10-project-choose');
      await cli('click', '#wp10-project-submit');
      assert.equal(await textHas('该目录已经有项目记录'), true, '重复目录在提交前被拦下');
      await cli('click', '.chdsh-error-summary a');
      assert.equal(await evaluate('document.activeElement.id'), 'wp10-project-path');
      assert.equal(ctx.chatdshProjects.list().length, 1, '重复提交没有写入第二条记录');
      await cli('press', 'Escape');
      await cli('wait', '--fn', '!document.querySelector("dialog[open]")');
    });

    await t.test('目录在列举之后消失时显示真实列举失败', async () => {
      await cli('click', '#wp10-project-create');
      await cli('wait', '#wp10-project-choose');
      rmSync(join(account, 'beta'), { recursive: true, force: true });
      await cli('find', 'role', 'button', 'click', '--name', '打开 beta');
      await cli('wait', '#wp10-project-relist');
      assert.equal(await evaluate('document.querySelectorAll("dialog[open] [role=alert]").length >= 1'), true, '列举失败显示为警告');
      await cli('press', 'Escape');
      await cli('wait', '--fn', '!document.querySelector("dialog[open]")');
    });

    await t.test('搜索与排序作用于真实记录', async () => {
      await cli('fill', '#wp10-project-search', 'zzz');
      assert.equal(await textHas('没有符合条件的项目'), true);
      await cli('fill', '#wp10-project-search', 'alp');
      assert.equal(await textHas(join(account, 'alpha')), true, '按目录名筛选命中');
      await cli('focus', '#wp10-project-search');
      await cli('press', 'Control+a');
      await cli('press', 'Delete');
      assert.equal(await evaluate('document.getElementById("wp10-project-search").value'), '', '清空搜索词');
      await cli('select', '#wp10-project-sort', 'updated');
      assert.equal(await textHas(join(account, 'alpha')), true, '切换排序后记录仍在列表里');
      await cli('select', '#wp10-project-sort', 'name');
    });

    await t.test('revision 冲突提示并重新加载，不覆盖他人改动', async () => {
      await cli('find', 'role', 'button', 'click', '--name', '设置 alpha');
      await cli('wait', 'dialog[open]');
      const loaded = ctx.chatdshProjects.get(join(account, 'alpha'));
      const other = await ctx.chatdshProjects.set({ path: join(account, 'alpha'), title: '他人改名', revision: loaded.revision });
      assert.equal(other.revision, loaded.revision + 1);

      await cli('fill', '#wp10-project-title', '本地改名');
      await cli('click', '#wp10-settings-save');
      await cli('wait', '--text', '项目已被其他界面修改');
      assert.equal(ctx.chatdshProjects.get(join(account, 'alpha')).title, '他人改名', '冲突写入没有覆盖他人改动');
      assert.equal(await evaluate('document.getElementById("wp10-settings-save").disabled'), true, '冲突状态下保存被禁用');

      await cli('scrollintoview', '#wp10-settings-reload');
      await cli('click', '#wp10-settings-reload');
      await cli('wait', '--fn', 'document.getElementById("wp10-project-title").value === "他人改名"');
      assert.equal(await textHas('项目已被其他界面修改'), false, '重新加载后冲突提示消失');

      await cli('fill', '#wp10-project-title', '最终名称');
      await cli('click', '#wp10-settings-save');
      await cli('wait', '--fn', '!document.querySelector("dialog[open]")');
      const current = ctx.chatdshProjects.get(join(account, 'alpha'));
      assert.equal(current.title, '最终名称');
      assert.equal(current.revision, other.revision + 1);
      assert.equal(await textHas('最终名称'), true, '保存后列表刷新');
    });

    await t.test('记录被另一界面删除时提示并刷新列表', async () => {
      mkdirSync(join(account, 'gamma'), { recursive: true });
      await cli('click', '#wp10-project-create');
      await cli('wait', '#wp10-project-choose');
      await cli('find', 'role', 'button', 'click', '--name', '打开 gamma');
      await cli('wait', '--text', '这个目录下没有子目录');
      await cli('click', '#wp10-project-choose');
      await cli('fill', '#wp10-project-title', '临时项目');
      await cli('click', '#wp10-project-submit');
      await cli('wait', '--fn', '!document.querySelector("dialog[open]")');
      await cli('wait', '--text', '临时项目');
      assert.equal(ctx.chatdshProjects.list().length, 2);

      await cli('find', 'role', 'button', 'click', '--name', '设置 临时项目');
      await cli('wait', 'dialog[open]');
      assert.equal(await ctx.chatdshProjects.remove(join(account, 'gamma')), true);
      await cli('fill', '#wp10-project-title', '改名也晚了');
      await cli('click', '#wp10-settings-save');
      await cli('wait', '--text', '项目已被删除');
      assert.equal(ctx.chatdshProjects.get(join(account, 'gamma')), undefined, '已删除的记录没有被重新写回');
      await cli('scrollintoview', '#wp10-settings-gone');
      await cli('click', '#wp10-settings-gone');
      await cli('wait', '--fn', '!document.querySelector("dialog[open]")');
      await cli('wait', '--fn', '!document.body.textContent.includes("临时项目")');
      assert.equal(ctx.chatdshProjects.list().length, 1);
    });

    await t.test('删除二次确认只移除配置，焦点被约束在确认框内', async () => {
      await cli('find', 'role', 'button', 'click', '--name', '删除 最终名称');
      await cli('wait', 'dialog[open]');
      assert.equal(await textHas('删除只移除项目配置'), true, '确认框说明只删配置');
      assert.equal(await evaluate('document.querySelector("dialog[open]").contains(document.activeElement)'), true);
      for (let step = 0; step < 8; step += 1) {
        await cli('press', 'Tab');
        assert.equal(await evaluate('document.querySelector("dialog[open]").contains(document.activeElement)'), true, '确认框内焦点不逃逸');
      }
      await cli('press', 'Escape');
      await cli('wait', '--fn', '!document.querySelector("dialog[open]")');
      assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), '删除 最终名称', 'Escape 之后焦点回到删除按钮');

      await cli('find', 'role', 'button', 'click', '--name', '删除 最终名称');
      await cli('wait', 'dialog[open]');
      await cli('click', '#wp10-delete-confirm');
      await cli('wait', '--fn', '!document.querySelector("dialog[open]")');
      await cli('wait', '--text', '还没有项目');
      assert.equal(ctx.chatdshProjects.list().length, 0, '记录被移除');
      assert.equal(statSync(join(account, 'alpha')).isDirectory(), true, '工作目录仍在');
    });

    await t.test('遥测：动作 span、失败事件与界面动作都送到同源中继', async () => {
      const deadline = Date.now() + 5000;
      const logs = () => page.batches.filter((batch) => batch.signal === 'logs')
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
      const failures = records.filter((record) => record.name === 'chatdsh.client.error');
      assert.ok(failures.length >= 2, '失败分支各自有一条错误事件');
      assert.ok(failures.some((record) => record.attributes['error.code'] === 'gateway/internal'), '写入冲突按网关错误码上报');
      assert.ok(failures.some((record) => record.attributes['error.code'] === 'directory-picker/unreadable'), '目录列举失败按目录错误码上报');
      assert.ok(failures.every((record) => typeof record.attributes['error.type'] === 'string' && record.attributes['error.type'] !== ''));
      const actions = records.filter((record) => record.name === 'chatdsh.client.ui.action');
      assert.ok(actions.some((record) => record.attributes.action === 'project.create' && record.attributes.outcome === 'ok'));
      assert.ok(actions.some((record) => record.attributes.action === 'project.create' && record.attributes.outcome === 'rejected'), '字段校验失败记为 rejected');
      assert.ok(actions.some((record) => record.attributes.action === 'project.update' && record.attributes.outcome === 'failed'));
      assert.ok(actions.some((record) => record.attributes.action === 'project.delete' && record.attributes.outcome === 'ok'));
      assert.ok(actions.every((record) => record.attributes.action !== undefined && record.attributes.outcome !== undefined));
      const spans = page.batches.filter((batch) => batch.signal === 'traces')
        .flatMap((batch) => (batch.body.resourceSpans ?? []).flatMap((resource) => resource.scopeSpans ?? []))
        .flatMap((scope) => scope.spans ?? [])
        .map((span) => ({
          name: span.name,
          attributes: Object.fromEntries((span.attributes ?? []).map((entry) => [entry.key, entry.value.stringValue])),
        }));
      assert.ok(spans.length > 0, '每个 Remote 调用都有 span');
      assert.ok(spans.every((span) => span.name === 'chatdsh.client.remote.call'));
      assert.ok(spans.some((span) => span.attributes['rpc.method'] === 'chatdshProjects/set' && span.attributes.outcome === 'failed'));
      assert.ok(spans.some((span) => span.attributes['rpc.method'] === 'chatdshProjects/create' && span.attributes.outcome === 'ok'));
      assert.ok(spans.some((span) => span.attributes['rpc.method'] === 'directoryPicker/list' && span.attributes.outcome === 'ok'));
      assert.ok(spans.some((span) => span.attributes['rpc.method'] === 'directoryPicker/list' && span.attributes.outcome === 'failed'));
      const metrics = page.batches.filter((batch) => batch.signal === 'metrics')
        .flatMap((batch) => (batch.body.resourceMetrics ?? []).flatMap((resource) => resource.scopeMetrics ?? []))
        .flatMap((scope) => (scope.metrics ?? []).map((metric) => metric.name));
      assert.ok(metrics.includes('chatdsh_client_errors_total'), '失败计数上报');
    });

    const errors = await cli('errors');
    assert.deepEqual(errors.data.errors, [], '页面没有未捕获的错误');
  } finally {
    if (opened) await cli('close');
    if (page !== undefined) await page.close();
    if (ctx !== undefined) await ctx.fiber.dispose();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    releaseIndependentHome(home);
  }
});
