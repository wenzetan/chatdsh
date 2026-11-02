// WP16 记忆检索与条目管理的真实浏览器验收。
//
// 页面用 esbuild 打包真实界面源码（`packages/client/memory/src/client/index.tsx`），记忆数据
// 来自真实 `ChatdshMemoryService` 实例与真实 Hindsight 服务。浏览器是 agent-browser 独立
// 会话里的真实 Chrome，使用独立 HOME、TMPDIR 与 profile，不截图；断言全部来自 DOM、
// 可访问属性、页面状态与磁盘文件。
//
// 页面与宿主之间只有一条测试传输：`POST /rpc` 把方法名与参数交给真实服务实例，端点集合由
// 服务类上真实的 Remote 标记推导；宿主没有注册的方法按网关的失败形状返回。检索、记忆组、
// 错误码与存储都来自真实宿主代码。
//
// 运行：node --test e2e/unit/client-complete-wp16-search.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { UI_KIT_CSS } from '../../packages/core/ui-kit/lib/index.js';
import { ensureDeps } from '../lib/ensure-deps.mjs';
import { allocateIndependentHome, probeHttpService, releaseIndependentHome } from '../lib/environment.mjs';

const REPO = resolve(import.meta.dirname, '../../..');
ensureDeps(resolve(import.meta.dirname, '../..'));
ensureDeps(resolve(REPO, 'dsh-adapter'));

const { Context } = await import('@deepseek-ai/cordis');
const { remoteMethods } = await import('@deepseek-ai/dsh-typert-protocol');
const { ChatdshMemoryService, MemoryStore } = await import('../../packages/host/memory/lib/index.js');
const { createMemoryClient } = await import('../../packages/host/memory/lib/client.js');
const { TypertRemoteService } = await import('../../../dsh-adapter/lib/index.js');

const execute = promisify(execFile);
const NODE_BIN = '/usr/local/nvm/versions/node/v24.19.0/bin';
const AGENT_BROWSER = `${NODE_BIN}/agent-browser`;
const HINDSIGHT = process.env.HINDSIGHT_URL ?? 'http://127.0.0.1:8889';
const UNREACHABLE = 'http://127.0.0.1:1';
const ROOT = new URL('../../', import.meta.url);

/** 未注册方法时网关返回的失败码。 */
const DEFINITION_UNAVAILABLE = 'gateway/definition-unavailable';

/** 写入 bank 的事实，每条互不相同，便于分页。 */
const FACTS = [
  '蓝鲸的体长约为三十米',
  '珠穆朗玛峰的海拔约为八千八百米',
  '长江的全长约为六千三百公里',
  '光在真空中的速度约为每秒三十万公里',
  '地球到月球的平均距离约为三十八万公里',
  '一标准大气压约为一百零一点三千帕',
  '水的沸点在一个标准大气压下是一百摄氏度',
  '非洲象的成年体重可达六吨',
  '亚马逊河的年径流量居世界首位',
  '太阳表面的温度约为五千五百摄氏度',
  '人类的基因组约有三万个蛋白编码基因',
  '南极冰盖的平均厚度约为一点九公里',
  '太平洋的面积约为一点六五亿平方公里',
  '马里亚纳海沟的最深处约为十一公里',
  '撒哈拉沙漠的面积约为九百二十万平方公里',
  '安第斯山脉的全长约为七千公里',
];

/** 服务配置。 */
function configFor(hindsightUrl, additionalBanks) {
  return {
    hindsightUrl,
    maxTokens: 4096,
    requestTimeoutMs: 60_000,
    mirrorToOwnBank: false,
    additionalBanks,
    deviceId: 'device-wp16',
  };
}

/** 页面脚本：把 Remote 调用转发到测试传输，并记录导出状态变化。 */
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
window.__exportStates = [];
new MutationObserver(() => {
  const node = document.querySelector('[data-export-state]');
  if (node === null) return;
  const state = node.getAttribute('data-export-state');
  const states = window.__exportStates;
  if (states[states.length - 1] !== state) states.push(state);
}).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['data-export-state'] });
createRoot(document.getElementById('root')).render(<MemorySection remote={face} />);
`;

/**
 * 在独立数据根里运行一个浏览器验收。
 * @param {object} options - 前缀、后端地址、额外 bank、种子与主体。
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
    stdin: { contents: EXERCISE, resolveDir: fileURLToPath(new URL('.', import.meta.url)), sourcefile: 'wp16-exercise.tsx', loader: 'tsx' },
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    target: 'es2022',
    loader: { '.css': 'text' },
    logLevel: 'warning',
  });
  const tokens = readFileSync(new URL('packages/client/theme/src/client/styles/tokens.css', ROOT), 'utf8');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>记忆检索验收</title><style>${tokens}\n${UI_KIT_CSS}\nmain { padding:16px; max-width:100%; }</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`;
  const store = new MemoryStore(join(home, 'memory'));
  const service = new ChatdshMemoryService(new Context(), configFor(options.hindsightUrl, options.additionalBanks ?? []));
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
  const client = createMemoryClient({
    hindsightUrl: options.hindsightUrl,
    maxTokens: 4096,
    requestTimeoutMs: 60_000,
  });
  try {
    await options.seed({ service, store, client });
    await cli('open', `${origin}/`);
    opened = true;
    await cli('set', 'viewport', '1280', '2400');
    await options.run({ cli, evaluate, service, store, telemetryBatches, origin });
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

/**
 * 提交检索并等待结果；后端慢响应时重试，慢响应不当作通过。
 * @param {object} cli - 浏览器命令。
 * @returns {Promise<number>} 第一页的行数。
 */
async function submitSearch(cli) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await cli('click', '#memory-search-submit');
    for (let tick = 0; tick < 60; tick += 1) {
      const state = (await cli('eval', `({
        rows: document.querySelectorAll("tbody tr[data-row-key]").length,
        busy: document.getElementById("memory-search-submit").textContent.includes("正在检索"),
        degraded: document.getElementById("root").textContent.includes("记忆检索降级"),
        failed: document.getElementById("root").textContent.includes("记忆检索未被受理"),
      })`)).data.result;
      if (!state.busy && state.rows > 0) return state.rows;
      if (state.degraded || state.failed) break;
      await new Promise((done) => setTimeout(done, 500));
    }
    await new Promise((done) => setTimeout(done, 1000));
  }
  return 0;
}

test('真实 Chrome：记忆检索、分页游标、选择与批量操作、导出与页面内存', { timeout: 600000 }, async (t) => {
  const probe = await probeHttpService({ name: 'hindsight', url: `${HINDSIGHT}/version` });
  if (probe.ready !== true) {
    t.skip(`Hindsight 不可达：GET ${HINDSIGHT}/version ${probe.reachable === true ? `HTTP ${String(probe.status)}` : '连接失败'}`);
    return;
  }
  const bank = `ws:test-wp16-${randomBytes(8).toString('hex')}`;
  const groupBank = { value: '' };
  const marker = `wp16${randomBytes(6).toString('hex')}`;
  const query = `验收编号 ${marker} 的事实`;
  const groupQuery = `验收编号 ${marker} 太平洋 面积`;
  try {
    await withBrowser({
      prefix: 'wp16-search',
      hindsightUrl: HINDSIGHT,
      additionalBanks: [bank],
      seed: async ({ service, client }) => {
        for (const [index, fact] of FACTS.entries()) {
          await client.write(bank, { content: `验收编号 ${marker} 的第 ${index} 条：${fact}。`, context: 'chatdsh-wp16-acceptance', async: false });
        }
        const group = await service.saveGroup({
          displayName: '工程记忆',
          workspaces: [{ deviceId: 'device-wp16', path: '/srv/wp16/project' }],
        });
        groupBank.value = `ws:${group.memoryGroupId}`;
        await client.write(groupBank.value, {
          content: `验收编号 ${marker} 的工作区事实：太平洋的面积约为一点六五亿平方公里。`,
          context: 'chatdsh-wp16-acceptance',
          async: false,
        });
      },
      run: async ({ cli, evaluate, telemetryBatches }) => {
        await cli('wait', '[role="tablist"]');
        await waitFor(cli, 'document.querySelector("[data-memory-state]") !== null', '记忆配置读取完成');
        assert.match(await evaluate('document.querySelector("[data-memory-state]").parentElement.textContent'), /已启用可用/);

        await cli('click', '[role="tablist"] button:nth-child(2)');
        await waitFor(cli, 'document.querySelector("#memory-query") !== null && document.querySelector("#memory-query").offsetParent !== null', '检索分页可见');

        // 必选范围校验：没有选择范围时提交，焦点移到范围分组。
        await cli('click', '#memory-search-submit');
        await waitFor(cli, 'document.querySelector("[role=alert]") !== null', '范围校验提示');
        assert.match(await evaluate('document.querySelector("[role=alert]").textContent'), /至少选择一个检索范围/);
        assert.equal(await evaluate('document.activeElement.id'), 'memory-scopes');

        assert.match(await evaluate('document.getElementById("root").textContent'), /额外 bank：/);
        assert.match(await evaluate('document.getElementById("root").textContent'), /工作区记忆：工程记忆/);
        await cli('check', `input[value="${bank}"]`);
        await cli('fill', '#memory-query', query);
        await cli('select', '#memory-limit', '5');
        const counted = await submitSearch(cli);
        assert.equal(counted, 5, '第一页正好五行');
        assert.match(await evaluate('document.querySelector("#memory-results-caption").textContent'), /第 1 页/);
        assert.match(await evaluate('document.querySelector("table[data-cursor]").dataset.cursor'), /^\d+:0$/);
        assert.equal(await evaluate('document.getElementById("memory-select-all").indeterminate'), false);

        // 行内键盘：向下移动焦点，空格切换选择。
        await cli('focus', '[data-row-action="true"][data-row-index="0"]');
        await cli('press', 'ArrowDown');
        assert.equal(await evaluate('document.activeElement.dataset.rowIndex'), '1');
        await cli('press', ' ');
        await waitFor(cli, 'document.querySelector("[aria-label=\'选择第 2 条记忆\']").checked === true', '空格选择第二行');
        await waitFor(cli, 'document.getElementById("root").textContent.includes("已选 1 条")', '已选一条');
        await cli('press', 'Control+a');
        await waitFor(cli, 'document.getElementById("root").textContent.includes("已选 5 条")', '全选当前页');
        await waitFor(cli, 'document.getElementById("memory-select-all").checked === true', '全选框勾选');
        await cli('press', 'Escape');
        await waitFor(cli, 'document.getElementById("root").textContent.includes("已选 0 条")', 'Escape 清空选择');
        assert.equal(await evaluate('document.getElementById("memory-select-all").checked'), false);
        await cli('click', '#memory-select-all');
        await waitFor(cli, 'document.getElementById("root").textContent.includes("已选 5 条")', '点全选框选中当前页');
        await cli('click', '#memory-select-all');
        await waitFor(cli, 'document.getElementById("root").textContent.includes("已选 0 条")', '再点全选框取消当前页');
        await cli('check', '[aria-label="选择第 1 条记忆"]');
        await cli('check', '[aria-label="选择第 2 条记忆"]');
        await waitFor(cli, 'document.getElementById("root").textContent.includes("已选 2 条")', '部分选择两条');
        await waitFor(cli, 'document.getElementById("memory-select-all").indeterminate === true', '部分选择显示为不确定状态');
        assert.equal(await evaluate('document.getElementById("memory-select-all").indeterminate'), true);

        // 详情与来源。
        await cli('focus', '[data-row-action="true"][data-row-index="0"]');
        await cli('press', 'Enter');
        await waitFor(cli, 'document.querySelector("[data-detail-for]") !== null', '详情展开');
        assert.equal(await evaluate('document.querySelector("[data-row-action=true][data-row-index=\'0\']").getAttribute("aria-expanded")'), 'true');
        const detail = await evaluate('document.querySelector("[data-detail-for]").textContent');
        assert.match(detail, /bank：/);
        assert.match(detail, /来源：/);
        assert.match(detail, /相关性：/);
        await cli('press', 'Enter');
        await waitFor(cli, 'document.querySelector("[data-detail-for]") === null', '详情收起');

        // 分页：下一页重新向宿主读取更多结果，游标按页前进，直到没有更多。
        const nextPage = async () => {
          const pageOf = String.raw`(() => { const matched = (document.querySelector("#memory-results-caption")?.textContent ?? "").match(/第 (\d+) 页/); return matched === null ? 0 : Number(matched[1]); })()`;
          const before = await evaluate(pageOf);
          await waitFor(cli, '!document.getElementById("memory-next-page").disabled', '下一页可用');
          await cli('click', '#memory-next-page');
          for (let tick = 0; tick < 80; tick += 1) {
            const state = (await cli('eval', `({
              noMore: document.getElementById("root").textContent.includes("没有更多结果"),
              page: ${pageOf},
            })`)).data.result;
            if (state.noMore) return { noMore: true, page: before };
            if (state.page !== before) return { noMore: false, page: state.page };
            await new Promise((done) => setTimeout(done, 250));
          }
          assert.fail('翻页没有完成');
        };
        const second = await nextPage();
        assert.equal(second.page, 2);
        assert.match(await evaluate('document.querySelector("table[data-cursor]").dataset.cursor'), /^\d+:5$/);
        const secondRows = await evaluate('document.querySelectorAll("tbody tr[data-row-key]").length');
        assert.ok(secondRows >= 1 && secondRows <= 5, `第二页行数应当在 1 到 5 之间，实际 ${String(secondRows)}`);
        let last = second;
        let guard = 0;
        while (!last.noMore && guard < 6) {
          last = await nextPage();
          guard += 1;
        }
        assert.equal(last.noMore, true, '翻到最后一页之后应当报告没有更多结果');
        assert.match(await evaluate('document.getElementById("root").textContent'), /没有更多结果/);
        assert.equal(await evaluate('document.getElementById("memory-next-page").disabled'), true);

        // 编辑单条：宿主没有条目编辑接口，明确失败并保留输入。
        await cli('click', '[aria-label="编辑第 1 条记忆"]');
        await waitFor(cli, 'document.activeElement.id === "memory-entry-text"', '编辑对话框聚焦');
        await cli('fill', '#memory-entry-text', '验收用编辑后的记忆内容');
        await cli('click', '#memory-entry-confirm');
        await waitFor(cli, 'document.querySelector("[data-dialog-kind=edit] [role=alert]") !== null', '编辑失败提示');
        assert.match(await evaluate('document.querySelector("[data-dialog-kind=edit] [role=alert]").textContent'), /gateway\/definition-unavailable/);
        assert.equal(await evaluate('document.getElementById("memory-entry-text").value'), '验收用编辑后的记忆内容');
        await cli('press', 'Escape');
        await waitFor(cli, 'document.querySelector("[data-dialog-kind=edit]") === null', '编辑对话框关闭');
        assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), '编辑第 1 条记忆');

        // 删除单条：同样明确失败，焦点回到触发按钮。
        await cli('click', '[aria-label="删除第 1 条记忆"]');
        await waitFor(cli, 'document.querySelector("[data-dialog-kind=delete]") !== null', '删除对话框');
        await cli('click', '#memory-entry-confirm');
        await waitFor(cli, 'document.querySelector("[data-dialog-kind=delete] [role=alert]") !== null', '删除失败提示');
        assert.match(await evaluate('document.querySelector("[data-dialog-kind=delete] [role=alert]").textContent'), /gateway\/definition-unavailable/);
        await cli('press', 'Escape');
        await waitFor(cli, 'document.querySelector("[data-dialog-kind=delete]") === null', '删除对话框关闭');
        assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), '删除第 1 条记忆');

        // 批量删除：键盘 Delete 打开确认，失败后保留选择。
        await cli('focus', '[data-row-action="true"][data-row-index="0"]');
        await cli('press', 'Delete');
        await waitFor(cli, 'document.querySelector("[data-dialog-kind=batch]") !== null', '批量删除对话框');
        assert.match(await evaluate('document.querySelector("[data-dialog-kind=batch]").textContent'), /删除选中的 2 条记忆/);
        await cli('click', '#memory-entry-confirm');
        await waitFor(cli, 'document.querySelector("[data-dialog-kind=batch] [role=alert]") !== null', '批量删除失败提示');
        await cli('press', 'Escape');
        await waitFor(cli, 'document.querySelector("[data-dialog-kind=batch]") === null', '批量删除对话框关闭');
        assert.match(await evaluate('document.getElementById("root").textContent'), /已选 2 条/);

        // 导出：范围与格式可选，状态经过进行中后完成，内容不含查询文本。
        await cli('select', '#memory-export-scope', 'query');
        await cli('select', '#memory-export-format', 'markdown');
        await cli('click', '#memory-export-submit');
        await waitFor(cli, 'document.querySelector("[data-export-state=done]") !== null', '导出完成');
        const exportStates = await evaluate('window.__exportStates');
        assert.ok(exportStates.includes('exporting'), `导出没有经过进行中状态：${JSON.stringify(exportStates)}`);
        assert.ok(exportStates.includes('done'), `导出没有完成状态：${JSON.stringify(exportStates)}`);
        await cli('eval', `(async () => { const link = document.querySelector('a[download]'); const text = await (await fetch(link.href)).text(); window.__exported = { name: link.download, text }; })()`);
        await waitFor(cli, 'window.__exported !== undefined', '导出内容读取');
        const exported = await evaluate('window.__exported');
        assert.match(exported.name, /^chatdsh-memory-\d+\.md$/);
        assert.ok(exported.text.includes(marker), '导出内容应当包含记忆正文');
        assert.equal(exported.text.includes(query), false, '导出内容不应包含查询文本');
        assert.match(await evaluate('document.querySelector("[data-export-state=done]").textContent'), /导出已生成：\d+ 条/);

        // 已选范围为空时导出明确失败。
        await cli('focus', '[data-row-action="true"][data-row-index="0"]');
        await cli('press', 'Escape');
        await cli('select', '#memory-export-scope', 'selected');
        await cli('click', '#memory-export-submit');
        await waitFor(cli, 'document.querySelector("[data-export-state=failed]") !== null', '导出失败状态');
        assert.match(await evaluate('document.querySelector("[data-export-state=failed]").textContent'), /没有可导出的结果/);

        // 工作区记忆组范围检索：命中来自组 bank。
        await cli('click', '#memory-clear');
        await waitFor(cli, 'document.querySelector("#memory-results-caption") === null', '清空上一条查询结果');
        await cli('uncheck', `input[value="${bank}"]`);
        await cli('check', `input[value="${groupBank.value}"]`);
        await cli('fill', '#memory-query', groupQuery);
        const groupCounted = await submitSearch(cli);
        assert.ok(groupCounted >= 1, '工作区记忆组范围应当返回命中');
        assert.match(await evaluate('document.getElementById("root").textContent'), /太平洋/);

        // 查询内容只在页面内存：本地存储与 IndexedDB 都没有记忆内容。
        assert.equal(await evaluate('localStorage.length'), 0);
        assert.equal(await evaluate('sessionStorage.length'), 0);
        await cli('eval', 'indexedDB.databases().then((items) => { window.__dbCount = items.length; })');
        await waitFor(cli, 'window.__dbCount !== undefined', 'IndexedDB 计数');
        assert.equal(await evaluate('window.__dbCount'), 0);

        // 刷新后记忆内容与查询都消失。
        await cli('reload');
        await cli('wait', '[role="tablist"]');
        await waitFor(cli, 'document.querySelector("[data-memory-state]") !== null', '刷新后配置读取完成');
        assert.equal(await evaluate(`document.getElementById("root").textContent.includes(${JSON.stringify(marker)})`), false);
        assert.equal(await evaluate('document.querySelector("#memory-results-caption")'), null);
        await cli('click', '[role="tablist"] button:nth-child(2)');
        await waitFor(cli, 'document.querySelector("#memory-query") !== null && document.querySelector("#memory-query").offsetParent !== null', '刷新后检索分页可见');
        assert.equal(await evaluate('document.getElementById("memory-query").value'), '');

        const actions = actionsOf(telemetryBatches);
        for (const expected of [
          { action: 'memory-search', outcome: 'ok' },
          { action: 'memory-entry-edit', outcome: 'failed' },
          { action: 'memory-entry-delete', outcome: 'failed' },
          { action: 'memory-entries-delete', outcome: 'failed' },
          { action: 'memory-export', outcome: 'ok' },
          { action: 'memory-export', outcome: 'failed' },
        ]) {
          assert.ok(
            actions.some((entry) => entry.action === expected.action && entry.outcome === expected.outcome),
            `缺少遥测动作：${JSON.stringify(expected)}，实际 ${JSON.stringify(actions)}`,
          );
        }
        assert.deepEqual((await cli('errors')).data.errors, []);
      },
    });
  } finally {
    const deletion = await fetch(`${HINDSIGHT}/v1/default/banks/${encodeURIComponent(bank)}`, { method: 'DELETE', signal: AbortSignal.timeout(10_000) });
    await deletion.body?.cancel();
    if (groupBank.value !== '') {
      const groupDeletion = await fetch(`${HINDSIGHT}/v1/default/banks/${encodeURIComponent(groupBank.value)}`, { method: 'DELETE', signal: AbortSignal.timeout(10_000) });
      await groupDeletion.body?.cancel();
    }
  }
});

test('真实 Chrome：后端不可达时检索明确降级并保留查询', { timeout: 300000 }, async () => {
  await withBrowser({
    prefix: 'wp16-degraded',
    hindsightUrl: UNREACHABLE,
    seed: async () => undefined,
    run: async ({ cli, evaluate, telemetryBatches }) => {
      await cli('wait', '[role="tablist"]');
      await waitFor(cli, 'document.querySelector("[data-memory-state]") !== null', '配置读取完成');
      assert.match(await evaluate('document.querySelector("[data-memory-state]").parentElement.textContent'), /已启用不可达/);
      await cli('click', '[role="tablist"] button:nth-child(2)');
      await waitFor(cli, 'document.querySelector("#memory-query") !== null && document.querySelector("#memory-query").offsetParent !== null', '检索分页可见');
      await cli('check', 'input[value="acct"]');
      await cli('fill', '#memory-query', '后端不可达时的查询内容');
      await cli('click', '#memory-search-submit');
      await waitFor(cli, 'document.getElementById("root").textContent.includes("记忆检索降级")', '降级提示');
      assert.match(await evaluate('document.getElementById("root").textContent'), /memory-backend-unreachable/);
      assert.equal(await evaluate('document.getElementById("memory-query").value'), '后端不可达时的查询内容');
      assert.equal(await evaluate('document.querySelectorAll("tbody tr[data-row-key]").length'), 0);
      assert.equal(await evaluate('document.querySelector("#memory-results-caption")'), null);
      assert.equal(await evaluate('document.getElementById("memory-next-page")'), null);
      const actions = actionsOf(telemetryBatches);
      assert.ok(actions.some((entry) => entry.action === 'memory-search' && entry.outcome === 'degraded'), `缺少降级遥测：${JSON.stringify(actions)}`);
      assert.deepEqual((await cli('errors')).data.errors, []);
    },
  });
});
