// WP16 记忆组与未确认写入的真实浏览器验收。
//
// 页面用 esbuild 打包真实界面源码，记忆组与未确认写入来自真实 `ChatdshMemoryService` 实例与
// 真实文件存储；版本冲突由另一个真实记忆组注册表写入制造。浏览器是 agent-browser 独立
// 会话里的真实 Chrome，使用独立 HOME、TMPDIR 与 profile，不截图。
//
// 运行：node --test e2e/unit/client-complete-wp16-groups.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { UI_KIT_CSS } from '../../packages/core/ui-kit/lib/index.js';
import { ensureDeps } from '../lib/ensure-deps.mjs';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';

const REPO = resolve(import.meta.dirname, '../../..');
ensureDeps(resolve(import.meta.dirname, '../..'));
ensureDeps(resolve(REPO, 'dsh-adapter'));

const { Context } = await import('@deepseek-ai/cordis');
const { remoteMethods } = await import('@deepseek-ai/dsh-typert-protocol');
const {
  ChatdshMemoryService,
  GROUPS_STORE,
  MemoryGroupRegistry,
  MemoryStore,
  UnconfirmedWrites,
  WRITES_STORE,
} = await import('../../packages/host/memory/lib/index.js');
const { TypertRemoteService } = await import('../../../dsh-adapter/lib/index.js');

const execute = promisify(execFile);
const NODE_BIN = '/usr/local/nvm/versions/node/v24.19.0/bin';
const AGENT_BROWSER = `${NODE_BIN}/agent-browser`;
const UNREACHABLE = 'http://127.0.0.1:1';
const ROOT = new URL('../../', import.meta.url);

/** 未注册方法时网关返回的失败码。 */
const DEFINITION_UNAVAILABLE = 'gateway/definition-unavailable';

/** 带服务面的页面脚本。 */
const EXERCISE = `
import { createRoot } from 'react-dom/client';
import { MemorySection } from '../../packages/client/memory/src/client/index.tsx';

const rpc = async (method, args) => {
  const response = await fetch('/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, args }),
  });
  const payload = await response.json();
  if (payload.ok) return payload.value;
  const error = new Error(payload.error?.message ?? '远端调用失败');
  error.code = payload.error?.code;
  throw error;
};
const methods = [
  'settings', 'search', 'listGroups', 'saveGroup', 'detachWorkspace', 'removeGroup',
  'writeQueue', 'discardWrite', 'updateEntry', 'deleteEntry', 'deleteEntries',
];
const face = {};
for (const method of methods) face[method] = (...args) => rpc(method, args);
createRoot(document.getElementById('root')).render(<MemorySection remote={face} />);
`;

/** 没有服务面的页面脚本：宿主未注册记忆服务。 */
const EXERCISE_NO_FACE = `
import { createRoot } from 'react-dom/client';
import { MemorySection } from '../../packages/client/memory/src/client/index.tsx';
createRoot(document.getElementById('root')).render(<MemorySection />);
`;

/**
 * 在独立数据根里运行一个浏览器验收。
 * @param {object} options - 前缀、页面脚本、种子与主体。
 */
async function withBrowser(options) {
  const home = allocateIndependentHome(options.prefix);
  const session = `${options.prefix}-${randomUUID().slice(0, 8)}`;
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const env = {
    ...process.env,
    PATH: `${NODE_BIN}:${process.env.PATH}`,
    HOME: home,
    TMPDIR: home,
    AGENT_BROWSER_SESSION: session,
    AGENT_BROWSER_EXECUTABLE_PATH: '/usr/bin/google-chrome',
    AGENT_BROWSER_PROFILE: join(home, 'chrome'),
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
  const telemetryBatches = [];
  let server;
  let opened = false;
  const bundle = await build({
    stdin: {
      contents: options.withoutRemote === true ? EXERCISE_NO_FACE : EXERCISE,
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      sourcefile: 'wp16-groups-exercise.tsx',
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    target: 'es2022',
    logLevel: 'warning',
  });
  const tokens = readFileSync(new URL('packages/client/theme/src/client/styles/tokens.css', ROOT), 'utf8');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>记忆组验收</title><style>${tokens}\n${UI_KIT_CSS}\nmain { padding:16px; max-width:100%; }</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`;
  const memoryRoot = join(home, 'memory');
  const store = new MemoryStore(memoryRoot);
  const service = new ChatdshMemoryService(new Context(), {
    hindsightUrl: UNREACHABLE,
    maxTokens: 1024,
    requestTimeoutMs: 2000,
    mirrorToOwnBank: false,
    additionalBanks: [],
    deviceId: 'device-wp16',
  });
  await service[TypertRemoteService.init]();
  const endpoints = new Map(remoteMethods(service).map((marker) => [marker.exportName ?? marker.method, marker.method]));
  server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'POST' && url.pathname === '/rpc') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const target = endpoints.get(payload.method);
      let answer;
      if (target === undefined) {
        answer = { ok: false, error: { code: DEFINITION_UNAVAILABLE, message: `宿主没有注册记忆接口 chatdshMemory/${String(payload.method)}` } };
      } else {
        try {
          answer = { ok: true, value: await service[target](...payload.args) };
        } catch (error) {
          answer = { ok: false, error: { code: typeof error?.code === 'string' ? error.code : 'gateway/internal', message: error instanceof Error ? error.message : String(error) } };
        }
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/chatdsh/telemetry/browser') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      telemetryBatches.push({ signal: request.headers['x-chatdsh-signal'], body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      response.writeHead(204).end();
      return;
    }
    if (url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html);
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not-found');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await cli('open', `${origin}/`);
    opened = true;
    await cli('set', 'viewport', '1280', '2400');
    await options.run({ cli, evaluate, service, store, home, memoryRoot, telemetryBatches, origin });
  } finally {
    if (opened) await cli('close');
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    releaseIndependentHome(home);
  }
}

/**
 * 等一个页面条件成立。
 * @param {object} cli - 浏览器命令。
 * @param {string} expression - 页面表达式。
 * @param {string} message - 超时说明。
 */
async function waitFor(cli, expression, message) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const { data } = await cli('eval', `Boolean(${expression})`);
    if (data.result === true) return;
    await new Promise((done) => setTimeout(done, 250));
  }
  assert.fail(`等待超时：${message}`);
}

/**
 * 收集页面遥测里的界面动作。
 * @param {Array<object>} telemetryBatches - 遥测批次。
 */
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

test('真实 Chrome：记忆组新建、重命名、版本冲突重载、关联、解除、删除与未确认写入丢弃', { timeout: 600000 }, async () => {
  await withBrowser({
    prefix: 'wp16-groups',
    run: async ({ cli, evaluate, store, home, memoryRoot, telemetryBatches }) => {
      const groupsFile = () => JSON.parse(readFileSync(join(home, 'memory', `${GROUPS_STORE}.json`), 'utf8')).groups;
      const writesFile = () => JSON.parse(readFileSync(join(home, 'memory', `${WRITES_STORE}.json`), 'utf8'));
      await cli('wait', '[role="tablist"]');
      await waitFor(cli, 'document.querySelector("[data-memory-state]") !== null', '配置读取完成');
      await cli('click', '[role="tablist"] button:nth-child(3)');
      await waitFor(cli, 'document.querySelector("#memory-group-new-name") !== null && document.querySelector("#memory-group-new-name").offsetParent !== null', '记忆组分页可见');

      // 空表单提交：字段校验与焦点。
      await cli('click', '#memory-group-create');
      await waitFor(cli, 'document.querySelector("[role=alert]") !== null', '新建校验提示');
      assert.match(await evaluate('document.querySelector("[role=alert]").textContent'), /显示名称不能为空/);
      assert.equal(await evaluate('document.activeElement.id'), 'memory-group-new-name');

      await cli('fill', '#memory-group-new-name', '工程记忆');
      await cli('fill', '#memory-group-new-device', 'device-wp16');
      await cli('fill', '#memory-group-new-path', '/srv/wp16/project');
      await cli('click', '#memory-group-create');
      await waitFor(cli, 'document.querySelector("[data-group-id]") !== null', '记忆组出现');
      assert.match(await evaluate('document.querySelector("[data-group-id]").closest("li").textContent'), /工程记忆/);
      assert.match(await evaluate('document.getElementById("root").textContent'), /revision 1/);
      assert.match(await evaluate('document.querySelector("[data-group-id]").textContent'), /memoryGroupId：mg_[0-9a-f]{24}/);
      assert.match(await evaluate('document.getElementById("root").textContent'), /条目数读取未完成/);
      const created = groupsFile();
      assert.equal(created.length, 1);
      assert.equal(created[0].displayName, '工程记忆');
      assert.equal(created[0].revision, 1);
      assert.deepEqual(created[0].workspaces, [{ deviceId: 'device-wp16', path: '/srv/wp16/project' }]);

      // 重命名：对话框获得焦点，保存后列表与文件都更新。
      await cli('focus', '[data-group-action="rename"]');
      await cli('press', 'Enter');
      await waitFor(cli, 'document.activeElement.id === "memory-group-name"', '重命名对话框聚焦');
      await cli('fill', '#memory-group-name', '工程记忆（改）');
      await cli('click', '#memory-group-save');
      await waitFor(cli, 'document.getElementById("root").textContent.includes("已重命名")', '重命名完成');
      await waitFor(cli, 'document.getElementById("root").textContent.includes("revision 2")', '列表 revision 更新');
      assert.match(await evaluate('document.getElementById("root").textContent'), /revision 2/);
      assert.equal(groupsFile()[0].displayName, '工程记忆（改）');
      assert.equal(groupsFile()[0].revision, 2);

      // 版本冲突：另一个真实注册表写入之后，界面按旧 revision 保存被拒绝。
      const external = new MemoryGroupRegistry(new MemoryStore(memoryRoot));
      await external.save({
        memoryGroupId: created[0].memoryGroupId,
        displayName: '外部改名',
        workspaces: created[0].workspaces,
        revision: 2,
      });
      assert.equal(groupsFile()[0].revision, 3);
      await cli('focus', '[data-group-action="rename"]');
      await cli('press', 'Enter');
      await waitFor(cli, 'document.activeElement.id === "memory-group-name"', '冲突对话框聚焦');
      await cli('fill', '#memory-group-name', '冲突改名');
      await cli('click', '#memory-group-save');
      await waitFor(cli, 'document.getElementById("root").textContent.includes("记忆组版本已过期")', '冲突提示');
      assert.match(await evaluate('document.getElementById("root").textContent'), /revision-conflict/);
      assert.equal(await evaluate('document.getElementById("memory-group-name").value'), '冲突改名');
      await cli('click', '#memory-group-conflict-reload');
      await waitFor(cli, 'document.getElementById("root").textContent.includes("外部改名")', '重载后列表更新');
      await cli('click', '#memory-group-save');
      await waitFor(cli, 'document.getElementById("root").textContent.includes("已重命名")', '冲突重试完成');
      assert.equal(groupsFile()[0].displayName, '冲突改名');
      assert.equal(groupsFile()[0].revision, 4);

      // 关联工作区：对话框聚焦设备标识，保存后工作区集合增加。
      await cli('click', '[data-group-action="attach"]');
      await waitFor(cli, 'document.activeElement.id === "memory-group-device"', '关联对话框聚焦');
      await cli('fill', '#memory-group-device', 'device-wp16');
      await cli('fill', '#memory-group-path', '/srv/wp16/second');
      await cli('click', '#memory-group-save');
      await waitFor(cli, 'document.querySelectorAll("[data-group-action=detach]").length === 2', '两个工作区');
      assert.equal(groupsFile()[0].revision, 5);
      assert.equal(groupsFile()[0].workspaces.length, 2);

      // 解除一个工作区：确认对话框聚焦确认按钮。
      await cli('click', '[data-group-action="detach"]');
      await waitFor(cli, 'document.activeElement.id === "memory-group-confirm"', '解除确认聚焦');
      await cli('click', '#memory-group-confirm');
      await waitFor(cli, 'document.querySelectorAll("[data-group-action=detach]").length === 1', '一个工作区');
      assert.equal(groupsFile()[0].revision, 6);
      assert.deepEqual(groupsFile()[0].workspaces.map((entry) => entry.path), ['/srv/wp16/second']);

      // 删除记忆组：确认之后列表清空、映射文件清空、焦点回到列表标题。
      await cli('click', '[data-group-action="remove"]');
      await waitFor(cli, 'document.activeElement.id === "memory-group-confirm"', '删除确认聚焦');
      await cli('click', '#memory-group-confirm');
      await waitFor(cli, 'document.getElementById("root").textContent.includes("已删除记忆组")', '删除完成');
      await waitFor(cli, 'document.querySelector("[data-group-id]") === null', '列表清空');
      assert.equal(await evaluate('document.querySelector("[data-group-id]")'), null);
      assert.deepEqual(groupsFile(), []);
      assert.equal(await evaluate('document.activeElement.id'), 'memory-groups-heading');

      // 未确认写入：只有数量、时间与错误码，不含正文。
      const secret = `wp16-secret-${randomUUID()}`;
      const record = await new UnconfirmedWrites(store).register({ bank: 'acct', content: `正文标记 ${secret}`, context: 'turn-summary' });
      await cli('click', '[role="tablist"] button:nth-child(4)');
      await waitFor(cli, 'document.querySelector("#memory-queue-reload") !== null && document.querySelector("#memory-queue-reload").offsetParent !== null', '未确认写入分页可见');
      await cli('click', '#memory-queue-reload');
      await waitFor(cli, 'document.getElementById("root").textContent.includes("待写入任务")', '计数视图出现');
      await waitFor(cli, 'document.getElementById("root").textContent.includes("1 项")', '待写入计数更新');
      assert.match(await evaluate('document.getElementById("root").textContent'), /1 项/);
      assert.match(await evaluate('document.getElementById("root").textContent'), /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
      assert.equal(await evaluate(`document.getElementById("root").textContent.includes(${JSON.stringify(secret)})`), false);

      // 记录不存在时明确失败，对话框保留。
      await cli('fill', '#memory-discard-id', 'missing-record');
      await cli('click', '#memory-discard-open');
      await waitFor(cli, 'document.querySelector("#memory-discard-confirm") !== null', '丢弃确认');
      await cli('click', '#memory-discard-confirm');
      await waitFor(cli, 'document.querySelector("[data-dialog-kind=discard] [role=alert]") !== null', '丢弃失败提示');
      assert.match(await evaluate('document.querySelector("[data-dialog-kind=discard] [role=alert]").textContent'), /记录不存在或已经被处理/);
      await cli('press', 'Escape');
      await waitFor(cli, 'document.querySelector("[data-dialog-kind=discard]") === null', '丢弃对话框关闭');

      // 真实记录丢弃成功：待处理归零、已丢弃加一。
      await cli('fill', '#memory-discard-id', record.id);
      await cli('click', '#memory-discard-open');
      await waitFor(cli, 'document.querySelector("#memory-discard-confirm") !== null', '丢弃确认第二次');
      await cli('click', '#memory-discard-confirm');
      await waitFor(cli, 'document.getElementById("root").textContent.includes("已丢弃 1 条未确认写入记录")', '丢弃完成');
      await waitFor(cli, 'document.getElementById("root").textContent.includes("0 待处理")', '待处理计数归零');
      assert.match(await evaluate('document.getElementById("root").textContent'), /0 待处理/);
      assert.equal(writesFile().records.length, 0);
      assert.equal(writesFile().discardedCount, 1);

      await new Promise((done) => setTimeout(done, 400));
      const actions = actionsOf(telemetryBatches);
      for (const expected of [
        { action: 'memory-group-create', outcome: 'ok' },
        { action: 'memory-group-rename', outcome: 'ok' },
        { action: 'memory-group-rename', outcome: 'failed' },
        { action: 'memory-group-attach', outcome: 'ok' },
        { action: 'memory-group-detach', outcome: 'ok' },
        { action: 'memory-group-remove', outcome: 'ok' },
        { action: 'memory-write-discard', outcome: 'failed' },
        { action: 'memory-write-discard', outcome: 'ok' },
      ]) {
        assert.ok(
          actions.some((entry) => entry.action === expected.action && entry.outcome === expected.outcome),
          `缺少遥测动作：${JSON.stringify(expected)}，实际 ${JSON.stringify(actions)}`,
        );
      }
      assert.deepEqual((await cli('errors')).data.errors, []);
    },
  });
});

test('真实 Chrome：宿主没有注册记忆服务时四个分页都明确不可用', { timeout: 300000 }, async () => {
  await withBrowser({
    prefix: 'wp16-unavailable',
    withoutRemote: true,
    run: async ({ cli, evaluate }) => {
      await cli('wait', '[role="tablist"]');
      await waitFor(cli, 'document.getElementById("root").textContent.includes("记忆未启用")', '未启用提示');
      for (let index = 1; index <= 4; index += 1) {
        await cli('click', `[role="tablist"] button:nth-child(${String(index)})`);
        await new Promise((done) => setTimeout(done, 200));
        const text = await evaluate('document.querySelector("[role=tabpanel]:not([hidden])").textContent');
        assert.match(text, /未启用|不可用/, `第 ${String(index)} 个分页应当显示不可用`);
      }
      assert.equal(await evaluate('document.querySelectorAll("[role=alert]").length > 0'), true);
      assert.equal(await evaluate('document.getElementById("memory-query")'), null);
      assert.equal(await evaluate('document.getElementById("memory-group-create")'), null);
      assert.equal(await evaluate('document.getElementById("memory-discard-id")'), null);
      assert.equal(await evaluate('document.getElementById("root").textContent.includes("已启用可用")'), false);
      assert.deepEqual((await cli('errors')).data.errors, []);
    },
  });
});
