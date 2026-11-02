// WP18 自动化界面的真实浏览器验收：列表、条件表单、对话框焦点、投递与原会话定时任务。
//
// 页面用 esbuild 打包真实界面源码（`packages/client/automation/src/client/index.tsx`），由真实
// 控制平面 `createGatewayServer` 提供数据：自动化记录来自真实 `AutomationStore`（SQLite），
// 启停走真实 PATCH，投递记录与定时任务走真实路由。浏览器是 agent-browser 独立会话里的真实
// Chrome，使用独立 HOME、TMPDIR 与 profile，不截图；断言全部来自 DOM、可访问名称、焦点、
// 页面请求与磁盘数据库记录。
//
// 运行：node --test e2e/unit/client-complete-wp18-browser.test.mjs

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
import { GatewayStore, PushQueue, ReceiptStore, ReplicaStore, SettingsStore, ShareStore } from '../../gateway/lib/store.js';
import { createPushHub } from '../../gateway/lib/push.js';
import { DeviceLinkHub } from '../../gateway/lib/device-link.js';
import { createGatewayServer } from '../../gateway/lib/server.js';
import { AutomationStore } from '../../gateway/lib/automation.js';

const execute = promisify(execFile);
const NODE_BIN = '/usr/local/nvm/versions/node/v24.19.0/bin';
const AGENT_BROWSER = `${NODE_BIN}/agent-browser`;
const ROOT = new URL('../../', import.meta.url);

/** 页面入口：挂载真实的自动化区段，并暴露一个模拟真实输入事件的辅助函数。 */
const EXERCISE = `
import { createRoot } from 'react-dom/client';
import { AutomationSection } from '../../packages/client/automation/src/client/index.tsx';
window.__wp18Errors = [];
window.addEventListener('error', (event) => window.__wp18Errors.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) => window.__wp18Errors.push('rejection:' + String(event.reason)));
window.__wp18SetValue = (selector, value) => {
  const node = document.querySelector(selector);
  if (node === null) return false;
  const proto = node instanceof HTMLSelectElement
    ? HTMLSelectElement.prototype
    : node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, value);
  node.dispatchEvent(new Event('input', { bubbles: true }));
  node.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
};
createRoot(document.getElementById('root')).render(<AutomationSection />);
`;

/**
 * 等一个页面条件成立。
 * @param {object} cli - 浏览器命令。
 * @param {string} expression - 页面表达式。
 * @param {string} message - 超时说明。
 */
async function waitFor(cli, expression, message) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const { data } = await cli('eval', `Boolean(${expression})`);
    if (data.result === true) return;
    await new Promise((done) => setTimeout(done, 250));
  }
  const state = (await cli('eval', 'JSON.stringify({ active: document.activeElement && (document.activeElement.id || document.activeElement.tagName), text: document.getElementById("root").textContent, errors: window.__wp18Errors })')).data.result;
  assert.fail(`等待超时：${message}\n页面状态：${state}`);
}

/** 收集页面遥测里的界面动作。 */
function actionsOf(batches) {
  const actions = [];
  for (const batch of batches) {
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

test('自动化界面：列表、条件表单、删除确认、投递与原会话定时任务', async () => {
  const home = allocateIndependentHome('wp18-browser');
  const emptyHome = allocateIndependentHome('wp18-browser-empty');
  const session = `wp18-${randomUUID().slice(0, 8)}`;
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
  /** 可见分区里的文字。 */
  const visibleText = () => evaluate('(document.querySelector(\'[role="tabpanel"]:not([hidden])\') || {}).textContent || ""');
  /** 点选一个单选项，并确认它真的被选中。 */
  const checkRadio = async (selector) => {
    const checked = await evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (node === null) return false; node.click(); return node.checked; })()`);
    assert.equal(checked, true, `单选项没有选中：${selector}`);
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
  const settings = new SettingsStore(store.handle());
  const push = createPushHub({
    queue: new PushQueue(store.handle()),
    devices: store,
    mode: 'all-at-once',
    escalationMs: 1000,
    telemetry: { counter: (name, config) => telemetry.counter(name, config) },
  });
  const deviceLink = new DeviceLinkHub({ store, telemetry });
  const automations = new AutomationStore(store.handle());

  /** 用同一份存储装配一个真实控制平面。 */
  const makeServer = () => createGatewayServer({
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
      pairingCode: 'pair-wp18',
    },
    store,
    replica,
    share,
    receipts,
    settings,
    push,
    telemetry,
    deviceLink,
  });

  /** 空数据根上的第二套控制平面，用来验证空状态。 */
  const emptyStore = new GatewayStore(join(emptyHome, 'gateway.sqlite'));
  const emptyServer = createGatewayServer({
    config: {
      host: '127.0.0.1',
      port: 0,
      runtimeUrl: 'http://127.0.0.1:1',
      databasePath: join(emptyHome, 'gateway.sqlite'),
      environment: 'test',
      version: '0.0.0',
      pushMode: 'all-at-once',
      pushEscalationMs: 1000,
      llmGateway: { quota: {} },
      pairingCode: 'pair-wp18-empty',
    },
    store: emptyStore,
    replica: new ReplicaStore(emptyStore.handle()),
    share: new ShareStore(emptyStore.handle()),
    receipts: new ReceiptStore(emptyStore.handle()),
    settings: new SettingsStore(emptyStore.handle()),
    push: createPushHub({
      queue: new PushQueue(emptyStore.handle()),
      devices: emptyStore,
      mode: 'all-at-once',
      escalationMs: 1000,
      telemetry: { counter: (name, config) => telemetry.counter(name, config) },
    }),
    telemetry,
    deviceLink: new DeviceLinkHub({ store: emptyStore, telemetry }),
  });

  const telemetryBatches = [];
  const target = { url: '' };
  let front;
  let opened = false;
  const server = makeServer();
  try {
    await emptyServer.start();
    await server.start();
    target.url = server.url();
    const origin = new URL(target.url).origin;

    // 真实记录：一条启用的 webhook、一条停用的 webhook、一条定时触发。
    const base = Date.UTC(2026, 10, 1, 12, 0, 0);
    store.registerNode({
      id: 'device-alpha',
      name: '工作站 alpha',
      platform: 'linux',
      role: 'executor',
      capabilities: ['bash'],
      tokenHash: `hash-${randomUUID()}`,
    });
    store.upsertSession({ sessionId: 'session-alpha', deviceId: 'device-alpha', cwd: '/work/alpha', kind: 'work', createdAt: base });
    automations.create({
      id: 'auto-github',
      name: 'GitHub 推送',
      trigger: { kind: 'webhook', secretEnv: 'CHATDSH_WP18_HOOK' },
      action: { kind: 'start-session', prompt: '处理这次推送' },
      enabled: true,
      createdAt: base,
    });
    automations.create({
      id: 'auto-off',
      name: '已停用的投递',
      trigger: { kind: 'webhook', secretEnv: 'CHATDSH_WP18_HOOK' },
      action: { kind: 'start-session', prompt: '不会发生' },
      enabled: false,
      createdAt: base + 1,
    });
    automations.create({
      id: 'auto-nightly',
      name: '夜间构建',
      trigger: { kind: 'schedule', cron: '0 9 * * *' },
      action: { kind: 'start-session', prompt: '看一次夜间构建' },
      enabled: true,
      createdAt: base + 2,
    });

    const bundle = await build({
      stdin: { contents: EXERCISE, resolveDir: fileURLToPath(new URL('.', import.meta.url)), sourcefile: 'wp18-exercise.tsx', loader: 'tsx' },
      bundle: true,
      write: false,
      format: 'iife',
      jsx: 'automatic',
      target: 'es2022',
      loader: { '.css': 'text' },
      logLevel: 'warning',
    });
    const tokens = readFileSync(new URL('packages/client/theme/src/client/styles/tokens.css', ROOT), 'utf8');
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>自动化验收</title><style>${tokens}\n${UI_KIT_CSS}\nmain { padding:16px; max-width:100%; }</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`;

    /** 把控制平面路径转发给当前目标；按反向代理的语义改写传输头部，页面与控制平面因此同源。 */
    const proxy = (request, response) => {
      const upstream = new URL(target.url);
      const sent = httpRequest(
        { host: upstream.hostname, port: upstream.port, method: request.method, path: request.url, headers: { ...request.headers, host: upstream.host, origin: upstream.origin } },
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
      if (url.pathname.startsWith('/chatdsh/') || url.pathname.startsWith('/d/')) {
        proxy(request, response);
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(html);
    });
    front.listen(0, '127.0.0.1');
    await once(front, 'listening');
    const pageOrigin = `http://127.0.0.1:${front.address().port}`;

    await cli('open', `${pageOrigin}/`);
    opened = true;
    await cli('wait', '[role="tablist"]');
    await waitFor(cli, 'document.querySelector(\'[data-automation-id="auto-github"]\') !== null', '自动化列表载入');

    // 1. 列表：名称、启用状态、触发条件摘要、最近投递状态与可访问名称。
    const listText = await visibleText();
    assert.match(listText, /GitHub 推送/);
    assert.match(listText, /webhook 投递 · 签名密钥来自 CHATDSH_WP18_HOOK/);
    assert.match(listText, /执行目标未指定/);
    assert.match(listText, /还没有投递记录/);
    assert.match(listText, /定时触发 · cron 0 9 \* \* \*/);
    assert.match(await evaluate('document.querySelector(\'[data-automation-id="auto-off"]\').closest("li").textContent'), /已停用/);
    for (const label of ['编辑自动化：GitHub 推送', '停用自动化：GitHub 推送', '删除自动化：GitHub 推送', '复制 webhook 地址：GitHub 推送']) {
      assert.equal(
        await evaluate(`document.querySelector('[aria-label="${label}"]') !== null`),
        true,
        `行操作要有可访问名称：${label}`,
      );
    }

    // 2. 启停：真实 PATCH，数据库跟着变。
    await activate('#chdsh-automation-toggle-auto-off');
    await waitFor(cli, 'document.querySelector(\'[data-automation-id="auto-off"]\').closest("li").textContent.includes("已启用")', '停用记录变为已启用');
    assert.equal(automations.get('auto-off').enabled, true, '启停要写到控制平面');
    await activate('#chdsh-automation-toggle-auto-off');
    await waitFor(cli, 'document.querySelector(\'[data-automation-id="auto-off"]\').closest("li").textContent.includes("已停用")', '启用记录变回已停用');
    assert.equal(automations.get('auto-off').enabled, false);

    // 3. 地址复制：复制成功或给出可手动选择的地址，两者都来自真实点击。
    await activate('#chdsh-automation-copy-auto-github');
    await waitFor(cli, '/已复制到剪贴板|请手动选择地址复制|没有剪贴板接口|浏览器拒绝了剪贴板写入/.test(document.querySelector(\'[role="tabpanel"]:not([hidden])\').textContent)', '复制结论出现');
    const fallbackValue = await evaluate('document.querySelector("[data-webhook-fallback]") === null ? null : document.querySelector("[data-webhook-fallback]").value');
    if (fallbackValue !== null) {
      assert.equal(fallbackValue, `${origin}/chatdsh/gateway/webhook/auto-github`, '手动选择的地址要完整');
    }

    // 4. 删除确认：对话框约束焦点，Escape 关闭并把焦点还给触发按钮。
    await activate('#chdsh-automation-delete-auto-github');
    await waitFor(cli, 'document.querySelector("dialog[open]") !== null', '删除确认对话框出现');
    assert.match(await evaluate('document.querySelector("dialog[open]").textContent'), /删除之后外部投递不再命中这条记录/);
    assert.equal(await evaluate('document.querySelector("dialog[open]").contains(document.activeElement)'), true);
    for (let index = 0; index < 6; index += 1) {
      await cli('press', 'Tab');
      assert.equal(await evaluate('document.querySelector("dialog[open]").contains(document.activeElement)'), true, 'Tab 不能离开对话框');
    }
    await cli('press', 'Escape');
    await waitFor(cli, 'document.querySelector("dialog[open]") === null', 'Escape 关闭对话框');
    assert.equal(await evaluate('document.activeElement.id'), 'chdsh-automation-delete-auto-github', '关闭后焦点回到触发按钮');
    assert.equal(automations.get('auto-github') !== undefined, true, '取消删除之后记录仍在');

    // 5. 表单校验：提交失败之后焦点落到错误摘要，摘要里的链接把焦点送到字段。
    await cli('click', '[role="tablist"] button:nth-child(2)');
    await waitFor(cli, '(() => { const node = document.getElementById("chdsh-automation-save"); return node !== null && node.getClientRects().length > 0; })()', '编辑分区出现');
    await activate('#chdsh-automation-save');
    await waitFor(cli, 'document.querySelector("dialog[open]") === null && document.getElementById("chdsh-automation-error-summary") !== null', '错误摘要出现');
    assert.equal(await evaluate('document.activeElement.id'), 'chdsh-automation-error-summary', '焦点落到错误摘要');
    const summary = await evaluate('document.getElementById("chdsh-automation-error-summary").textContent');
    assert.match(summary, /请填写自动化名称/);
    assert.match(summary, /请选择执行设备/);
    assert.match(summary, /请填写交给会话的提示词/);
    await activate('#chdsh-automation-error-summary li:first-child a');
    assert.equal(await evaluate('document.activeElement.id'), 'chdsh-automation-name', '摘要链接把焦点送到第一个出错字段');

    // 6. 条件表单：时间方式互斥，夏令时提示与校验同时出现。
    await checkRadio('#chdsh-automation-trigger-schedule');
    await waitFor(cli, 'document.getElementById("chdsh-automation-mode-immediate") !== null', '条件表单出现');
    assert.equal(await evaluate('document.getElementById("chdsh-automation-cron") === null'), true, '立即方式没有 cron 字段');
    assert.equal(await evaluate('document.getElementById("chdsh-automation-interval-seconds") === null'), true, '立即方式没有间隔字段');
    await checkRadio('#chdsh-automation-mode-once');
    await waitFor(cli, 'document.getElementById("chdsh-automation-once-at") !== null', '定时方式出现日期字段');
    assert.equal(await evaluate('document.getElementById("chdsh-automation-interval-seconds") === null'), true, '定时方式没有间隔字段');
    await checkRadio('#chdsh-automation-mode-repeat');
    await waitFor(cli, 'document.getElementById("chdsh-automation-repeat") !== null', '重复方式出现重复选择');
    await cli('select', '#chdsh-automation-repeat', 'cron');
    await waitFor(cli, 'document.getElementById("chdsh-automation-cron") !== null', 'cron 表达式字段出现');
    await cli('select', '#chdsh-automation-repeat', 'interval');
    await waitFor(cli, 'document.getElementById("chdsh-automation-interval-seconds") !== null', '固定间隔字段出现');
    assert.equal(await evaluate('document.getElementById("chdsh-automation-cron") === null'), true, '固定间隔方式没有 cron 字段');

    await checkRadio('#chdsh-automation-mode-once');
    await waitFor(cli, 'document.getElementById("chdsh-automation-once-at") !== null', '回到定时方式');
    await cli('select', '#chdsh-automation-timezone', 'America/New_York');
    await waitFor(cli, 'document.getElementById("chdsh-automation-once-at") !== null', '时区切换完成');
    assert.equal(await evaluate('window.__wp18SetValue("#chdsh-automation-once-at", "2026-03-08T02:30")'), true);
    await waitFor(cli, '/夏令时切换跳过的时段/.test(document.querySelector(\'[role="tabpanel"]:not([hidden])\').textContent)', '夏令时提示出现');
    await activate('#chdsh-automation-save');
    await waitFor(cli, '/这个本地时刻在所选时区不存在/.test(document.getElementById("chdsh-automation-error-summary").textContent)', '夏令时空档进入错误摘要');

    // 7. 目标设备离线提示。
    await checkRadio('#chdsh-automation-mode-immediate');
    await waitFor(cli, 'document.getElementById("chdsh-automation-once-at") === null', '回到立即方式');
    await cli('select', '#chdsh-automation-device', 'device-alpha');
    await waitFor(cli, '/当前离线/.test(document.querySelector(\'[role="tabpanel"]:not([hidden])\').textContent)', '设备离线提示出现');
    assert.match(await visibleText(), /控制平面不建立离线重发任务/);

    // 8. 创建：目标设备离线时建立被拒绝，界面给出失败提示且不写入任何记录。
    await cli('fill', '#chdsh-automation-name', '从界面新建');
    await cli('fill', '#chdsh-automation-prompt', '从界面建立');
    const before = automations.list().length;
    await activate('#chdsh-automation-save');
    await waitFor(cli, '/离线|失败|被拒绝/.test(document.querySelector(\'[role="tabpanel"]:not([hidden])\').textContent)', '创建失败提示出现');
    assert.equal(automations.list().length, before, '创建失败之后数据库里没有新记录');

    // 9. 投递记录：分页接口由控制平面提供，页面读到记录或空状态。
    await cli('click', '[role="tablist"] button:nth-child(3)');
    await waitFor(cli, '/还没有投递记录|事件标识/.test(document.querySelector(\'[role="tabpanel"]:not([hidden])\').textContent)', '投递记录分区读取完成');
    assert.equal(
      await evaluate('(() => { const panel = document.querySelector(\'[role="tabpanel"]:not([hidden])\'); return panel.querySelector("table") !== null || /还没有投递记录/.test(panel.textContent); })()'),
      true,
      '投递记录给出表格或空状态',
    );

    // 10. 原会话定时任务：设备离线时明确失败，且不落到控制平面执行。
    await cli('click', '[role="tablist"] button:nth-child(4)');
    await waitFor(cli, '(() => { const node = document.getElementById("chdsh-automation-schedule-device"); return node !== null && node.getClientRects().length > 0; })()', '定时任务分区出现');
    await cli('select', '#chdsh-automation-schedule-device', 'device-alpha');
    await waitFor(cli, '/只补最近一次/.test(document.querySelector(\'[role="tabpanel"]:not([hidden])\').textContent)', '设备离线提示出现');
    await cli('select', '#chdsh-automation-schedule-session', 'session-alpha');
    await waitFor(cli, '/定时任务不可用|目标设备离线/.test(document.querySelector(\'[role="tabpanel"]:not([hidden])\').textContent)', '定时任务失败提示出现');
    assert.match(await visibleText(), /不建立离线重发任务|目标设备离线/);
    assert.equal(await evaluate('document.getElementById("chdsh-automation-schedule-new") === null'), true, '失败时不出现新建入口');
    assert.equal(automations.list().length, before, '定时任务失败没有写入控制平面记录');

    // 11. 读取失败之后的重试与空状态。
    await cli('click', '[role="tablist"] button:nth-child(1)');
    await waitFor(cli, '(() => { const node = document.getElementById("chdsh-automation-refresh"); return node !== null && node.getClientRects().length > 0; })()', '回到列表');
    target.url = 'http://127.0.0.1:1';
    await activate('#chdsh-automation-refresh');
    await waitFor(cli, '/自动化列表不可用/.test(document.querySelector(\'[role="tabpanel"]:not([hidden])\').textContent)', '列表失败提示出现');
    target.url = emptyServer.url();
    await activate('#chdsh-automation-reload');
    await waitFor(cli, '/还没有自动化/.test(document.querySelector(\'[role="tabpanel"]:not([hidden])\').textContent)', '空状态出现');
    assert.equal(await evaluate('document.getElementById("chdsh-automation-create-first") !== null'), true, '空状态给出新建入口');

    // 12. 界面动作遥测：真实事件经同源中继上报，且不带提示词与地址。
    const actions = actionsOf(telemetryBatches);
    for (const expected of ['automation-reload', 'automation-toggle', 'automation-copy-webhook', 'automation-create', 'automation-deliveries', 'schedule-reload']) {
      assert.ok(actions.some((entry) => entry.action === expected), `缺少动作 ${expected}：${JSON.stringify(actions)}`);
    }
    assert.ok(actions.some((entry) => entry.action === 'automation-create' && entry.outcome === 'failed'), '创建失败按真实结论记录');
    assert.ok(actions.some((entry) => entry.action === 'automation-toggle' && entry.outcome === 'ok'), '启停成功按真实结论记录');
    const serialized = JSON.stringify(telemetryBatches);
    assert.equal(serialized.includes('从界面建立'), false, '遥测里不出现提示词');
    assert.equal(serialized.includes('处理这次推送'), false, '遥测里不出现已有记录的提示词');
    assert.equal(serialized.includes('/chatdsh/gateway/webhook'), false, '遥测里不出现 webhook 地址');
    assert.equal(await evaluate('window.__wp18Errors.length'), 0, '页面没有未捕获的脚本错误');
  } finally {
    if (opened) await cli('close').catch(() => undefined);
    front?.closeAllConnections();
    if (front !== undefined) await new Promise((done) => front.close(done));
    await emptyServer.stop();
    await server.stop();
    store.close();
    emptyStore.close();
    releaseIndependentHome(home);
    releaseIndependentHome(emptyHome);
  }
});
