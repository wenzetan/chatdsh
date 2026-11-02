// WP20 分享完整界面的浏览器验收：创建、附件逐项授权、四种范围、完整预览、记录统计、复制
// 替代操作、窄屏公开阅读与键盘焦点。
//
// 页面用 esbuild 打包真实界面源码（`packages/client/share/src/client/index.tsx`）。分享接口由
// 按 WP19 `createShareHttpHandler` 装配的真实分享域服务提供：记录与快照写在真实 SQLite 里，
// 附件字节写在真实目录里，公开页由真实渲染函数生成；会话聚合、副本与导入走真实的控制平面
// `createGatewayServer`。浏览器是 agent-browser 独立会话里的真实 Chrome，使用独立 HOME、
// TMPDIR 与 profile，不截图；断言全部来自 DOM、可访问属性、地址、真实 HTTP 应答与磁盘记录。
// 剪贴板写入由页面响应头的权限策略禁止，浏览器真实抛出 `NotAllowedError`，界面必须保留可
// 选择的替代文本。
//
// 运行：node --test e2e/unit/client-complete-wp20-panel.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
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
import {
  ATTACHMENT_MISSING_ID,
  ATTACHMENT_PUBLIC,
  ATTACHMENT_SECOND,
  buildEvents,
  ownerAuthorize,
  startShareDomain,
  writeAttachment,
} from './client-complete-wp20-support.mjs';

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
  const state = (await cli('eval', 'JSON.stringify({ url: location.href, active: document.activeElement && (document.activeElement.id || document.activeElement.tagName), text: document.getElementById("root").textContent, errors: window.__wp20Errors })')).data.result;
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

/** 页面里超出视口右边的元素。 */
const OVERFLOW_SCRIPT = `(() => {
  const width = document.documentElement.clientWidth;
  const offenders = [...document.querySelectorAll('body *')]
    .filter((node) => node.getBoundingClientRect().right > width + 0.5)
    .map((node) => node.tagName + '#' + node.id + '.' + String(node.className));
  return JSON.stringify({ width, scroll: document.documentElement.scrollWidth, offenders: offenders.slice(0, 8) });
})()`;

test('分享完整界面：附件授权、四种范围、完整预览、记录统计、复制替代、窄屏与键盘', async () => {
  const home = allocateIndependentHome('wp20-browser');
  const session = `wp20-${randomUUID().slice(0, 8)}`;
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
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
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

  const telemetry = createTelemetryClient({
    config: defaultTelemetryConfig({ surface: 'gateway' }),
    component: '@chatdsh/gateway',
    env: { CHATDSH_TELEMETRY: 'off' },
  });
  const store = new GatewayStore(join(home, 'gateway.sqlite'));
  const replica = new ReplicaStore(store.handle());
  const cookieName = 'chatdsh-owner';
  const cookieValue = randomBytes(16).toString('hex');
  let frontOrigin = '';
  const domain = await startShareDomain({
    home,
    store,
    replica,
    telemetry,
    authorize: ownerAuthorize({ cookieName, cookieValue, getOrigin: () => frontOrigin }),
  });
  await writeAttachment(domain.attachmentsRoot, ATTACHMENT_PUBLIC);
  await writeAttachment(domain.attachmentsRoot, ATTACHMENT_SECOND);

  const shareStore = new ShareStore(store.handle());
  const receipts = new ReceiptStore(store.handle());
  const push = createPushHub({
    queue: new PushQueue(store.handle()),
    devices: store,
    mode: 'all-at-once',
    escalationMs: 1000,
    telemetry: { counter: (name, config) => telemetry.counter(name, config) },
  });
  const deviceLink = new DeviceLinkHub({ store, telemetry });
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
      pairingCode: 'pair-wp20',
    },
    store,
    replica,
    share: shareStore,
    receipts,
    push,
    telemetry,
    deviceLink,
  });

  const telemetryBatches = [];
  let front;
  let opened = false;
  try {
    await gatewayServer.start();
    const gatewayUrl = gatewayServer.url();

    // 真实归属与真实副本：会话在控制平面 SQLite 里，事件经真实端点写入。
    store.upsertSession({ sessionId: 'session-wp20', deviceId: 'device-alpha', cwd: '/workspace/wp20', kind: 'work', createdAt: BASE });
    const published = await fetch(`${gatewayUrl}/chatdsh/gateway/replica`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-wp20', events: buildEvents(BASE) }),
    });
    assert.equal(published.status, 200);

    // 一条已经过期的分享与一条附件副本缺失的分享：记录里必须给出结论，且不产生链接。
    const expired = await domain.service.create({
      sessionId: 'session-wp20',
      range: { mode: 'turns', turns: [1] },
      includeUserText: true,
      includeAssistantText: true,
      attachmentIds: [],
      ttlMs: 120,
    });
    const broken = await domain.service.create({
      sessionId: 'session-wp20',
      range: { mode: 'turns', turns: [2] },
      includeUserText: true,
      includeAssistantText: true,
      attachmentIds: [ATTACHMENT_PUBLIC.id],
    });
    await rm(join(domain.sharesRoot, broken.shareId), { recursive: true, force: true });
    const scopeRow = store.handle().prepare('select scope from share_posts where token = ?').get(broken.shareId);
    store.handle()
      .prepare('update share_posts set scope = ? where token = ?')
      .run(JSON.stringify({ ...JSON.parse(scopeRow.scope), attachmentsComplete: false }), broken.shareId);
    await new Promise((done) => setTimeout(done, 160));

    const bundle = await build({
      stdin: { contents: EXERCISE, resolveDir: fileURLToPath(new URL('.', import.meta.url)), sourcefile: 'wp20-exercise.tsx', loader: 'tsx' },
      bundle: true,
      write: false,
      format: 'iife',
      jsx: 'automatic',
      target: 'es2022',
      loader: { '.css': 'text' },
      logLevel: 'warning',
    });
    const tokens = readFileSync(new URL('packages/client/theme/src/client/styles/tokens.css', ROOT), 'utf8');
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>分享验收</title><style>${tokens}\n${UI_KIT_CSS}\nmain { padding:16px; max-width:100%; }</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`;

    /** 把非页面路径转发给真实服务。 */
    const proxy = (request, response, target) => {
      const upstream = new URL(target);
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

    front = createServer(async (request, response) => {
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (url.pathname === '/chatdsh/telemetry/browser') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        telemetryBatches.push({ body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        response.writeHead(204).end();
        return;
      }
      // 分享接口与公开页来自按 WP19 装配的真实分享域；其余控制平面接口来自真实网关。
      if (url.pathname.startsWith('/chatdsh/gateway/share') || url.pathname === '/chatdsh/gateway/shares' || url.pathname.startsWith('/s/')) {
        proxy(request, response, domain.origin);
        return;
      }
      if (url.pathname.startsWith('/chatdsh/')) {
        proxy(request, response, gatewayUrl);
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'set-cookie': `${cookieName}=${cookieValue}; Path=/; SameSite=Lax`,
        // 宿主页面禁止剪贴板写入：浏览器真实拒绝写入，面板必须给出替代文本。
        'permissions-policy': 'clipboard-write=()',
      });
      response.end(html);
    });
    front.listen(0, '127.0.0.1');
    await once(front, 'listening');
    frontOrigin = `http://127.0.0.1:${front.address().port}`;

    await cli('open', `${frontOrigin}/`);
    opened = true;
    await cli('wait', '[role="tablist"]');
    await waitFor(cli, 'document.querySelector("#chdsh-share-session") && document.querySelector("#chdsh-share-session").options.length >= 2', '会话选项载入');

    const clipboardOutcome = await evaluate('navigator.clipboard.writeText("wp20-probe").then(() => "ok", (error) => error.name)');
    assert.equal(clipboardOutcome, 'NotAllowedError', `浏览器必须拒绝剪贴板写入，实际：${clipboardOutcome}`);

    // 1. 创建表单：选会话之后列出这个范围里的附件候选。
    await cli('select', '#chdsh-share-session', 'session-wp20');
    await waitFor(cli, 'document.getElementById("chdsh-share-attachment-attach-report") !== null', '附件候选载入');
    const attachmentIds = await evaluate('JSON.stringify([...document.querySelectorAll("[data-share-attachment-list] input")].map((node) => node.id))');
    assert.deepEqual(JSON.parse(attachmentIds), [
      `chdsh-share-attachment-${ATTACHMENT_PUBLIC.id}`,
      `chdsh-share-attachment-${ATTACHMENT_SECOND.id}`,
      `chdsh-share-attachment-${ATTACHMENT_MISSING_ID}`,
    ]);
    assert.match(await evaluate('document.querySelector("[data-share-attachment-choice]").textContent'), /没有勾选的附件不出现在公开页，也无法按路径猜测下载/);
    assert.match(await evaluate('document.querySelector("[data-share-attachment-summary]").textContent'), /已勾选 0 份附件/);

    // 1.1 附件多选走键盘：空格切换勾选，Tab 移动到下一项。
    await cli('focus', `#chdsh-share-attachment-${ATTACHMENT_PUBLIC.id}`);
    await cli('press', 'Space');
    assert.equal(await evaluate(`document.getElementById("chdsh-share-attachment-${ATTACHMENT_PUBLIC.id}").checked`), true, '空格键勾选附件');
    assert.equal(await evaluate('document.activeElement.id'), `chdsh-share-attachment-${ATTACHMENT_PUBLIC.id}`, '勾选之后焦点留在这一项');
    assert.match(await evaluate('document.querySelector("[data-share-attachment-summary]").textContent'), /已勾选 1 份附件/);

    // 2. 四种范围：指定回合集合、完整回合边界与截止上界各自请求一次真实预览。
    await cli('select', '#chdsh-share-scope', 'turns');
    await waitFor(cli, 'document.getElementById("chdsh-share-turn-2") !== null', '回合勾选列表出现');
    assert.equal(await evaluate('document.querySelectorAll("[data-share-turn-choice] input").length'), 3);
    await cli('uncheck', '#chdsh-share-turn-3');
    await cli('focus', '#chdsh-share-turn-2');
    await cli('press', 'Space');
    assert.equal(await evaluate('document.getElementById("chdsh-share-turn-2").checked'), true, '空格键勾选回合');
    await activate('#chdsh-share-preview');
    await waitFor(cli, 'document.querySelector("[data-share-facts]") !== null', '回合集合预览出现');
    assert.match(await evaluate('document.querySelector("[data-share-turns]").textContent'), /回合 2/);
    assert.equal(await evaluate('document.querySelectorAll("[data-share-turn]").length'), 1);
    await activate('#chdsh-share-back');
    await waitFor(cli, 'document.getElementById("chdsh-share-scope") !== null', '回到创建表单');

    await cli('select', '#chdsh-share-scope', 'range');
    await waitFor(cli, 'document.getElementById("chdsh-share-turn-from") !== null', '边界选择出现');
    await cli('select', '#chdsh-share-turn-from', '1');
    await cli('select', '#chdsh-share-turn-to', '2');
    await activate('#chdsh-share-preview');
    await waitFor(cli, 'document.querySelector("[data-share-turns]") !== null', '边界预览出现');
    assert.equal(await evaluate('document.querySelectorAll("[data-share-turn]").length'), 2);
    const rangeTurns = await evaluate('document.querySelector("[data-share-turns]").textContent');
    assert.match(rangeTurns, /回合 1/);
    assert.match(rangeTurns, /回合 2/);
    await activate('#chdsh-share-back');
    await waitFor(cli, 'document.getElementById("chdsh-share-scope") !== null', '回到创建表单');

    await cli('select', '#chdsh-share-scope', 'bound');
    await waitFor(cli, 'document.getElementById("chdsh-share-bound-turn") !== null', '截止回合选择出现');
    await cli('select', '#chdsh-share-bound-turn', '2');
    await activate('#chdsh-share-preview');
    await waitFor(cli, 'document.querySelector("[data-share-turns]") !== null', '上界预览出现');
    assert.match(await evaluate('document.querySelector("[data-share-facts]").textContent'), /回合 1 至 2/);
    await activate('#chdsh-share-back');
    await waitFor(cli, 'document.getElementById("chdsh-share-scope") !== null', '回到创建表单');

    // 3. 完整预览：过滤计数、脱敏计数、排除项与回合清单逐项呈现，且没有可交互控件。
    await cli('select', '#chdsh-share-scope', 'session');
    assert.equal(await evaluate('document.querySelectorAll("[data-share-attachment-list] input").length'), 3, '会话全部的附件候选回到全部');
    await activate('#chdsh-share-preview');
    await waitFor(cli, 'document.querySelector("[data-share-count]") !== null', '会话全部预览出现');
    const previewCount = await evaluate('Number(document.querySelector("[data-share-count]").textContent.replace(/[^0-9]/g, ""))');
    assert.ok(previewCount >= 6, `预览要给出公开消息数：${previewCount}`);
    assert.match(await evaluate('document.querySelector("[data-share-chars]").textContent'), /公开文本字符数：\d+ 个/);
    assert.match(await evaluate('document.querySelector("[data-share-events]").textContent'), /范围内事件数：\d+ 条/);
    assert.match(await evaluate('document.querySelector("[data-share-redact-paths]").textContent'), /内部路径脱敏：[1-9]\d* 处/);
    assert.match(await evaluate('document.querySelector("[data-share-redact-credentials]").textContent'), /凭据脱敏：[1-9]\d* 处/);
    assert.equal(await evaluate('document.querySelectorAll("[data-share-exclusions] li").length'), 5);
    const exclusions = await evaluate('document.querySelector("[data-share-exclusions]").textContent');
    for (const label of ['相关记忆：已排除', '工具参数与结果原文：已排除', '内部路径：已排除', '敏感元数据与思考过程：已排除', '副本水位：已排除']) {
      assert.match(exclusions, new RegExp(label));
    }
    assert.equal(await evaluate('document.querySelectorAll("[data-share-turns] li").length'), 3);
    assert.match(await evaluate('document.querySelector("[data-share-attachments]").textContent'), new RegExp(ATTACHMENT_PUBLIC.filename));
    assert.match(await evaluate('document.querySelector("[data-share-attachments]").textContent'), /可下载/);
    const previewControls = await evaluate('document.querySelector("[data-share-facts]").closest(".chdsh-panel").querySelectorAll("input, select, textarea, button").length');
    assert.equal(previewControls, 0, '预览本身没有输入与动作');

    // 4. 确认发布：地址来自真实创建结果，占用、附件与有效期都来自响应。
    await activate('#chdsh-share-confirm');
    await waitFor(cli, 'document.getElementById("chdsh-share-url") !== null', '分享结果出现');
    const shareUrl = await evaluate('document.getElementById("chdsh-share-url").value');
    assert.match(shareUrl, new RegExp(`^${frontOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/s/[A-Za-z0-9_-]{20,}$`));
    const token = shareUrl.slice(shareUrl.lastIndexOf('/') + 1);
    assert.equal(await evaluate('document.activeElement.id'), 'chdsh-share-url', '结果出现后焦点落在分享地址');
    assert.match(await evaluate('document.querySelector("[data-share-expiry]").textContent'), /24 小时后过期/);
    assert.match(await evaluate('document.querySelector("[data-share-size]").textContent'), /\d+ 字节/);
    assert.match(await evaluate('document.querySelector("[data-share-attachment-count]").textContent'), new RegExp(`已复制 1 份：${ATTACHMENT_PUBLIC.filename}`));
    assert.equal(await evaluate('document.getElementById("chdsh-share-open").getAttribute("href")'), `/s/${token}`);

    // 4.1 复制被拒绝：说明文字与可选择文本同时出现。
    await activate('[aria-label="复制分享链接"]');
    await waitFor(cli, 'document.querySelector("[data-share-copy-text]") !== null', '复制替代文本出现');
    const copyExplanation = await evaluate('document.querySelector("[data-share-copy-fallback]").textContent');
    assert.match(copyExplanation, /浏览器拒绝了剪贴板写入/);
    assert.match(copyExplanation, /可以直接选中复制/);
    assert.equal(await evaluate('document.querySelector("[data-share-copy-text]").value'), shareUrl);
    assert.equal(await evaluate('document.querySelector("[data-share-copy-text]").readOnly'), true);
    await cli('focus', '[data-share-copy-text]');
    assert.equal(await evaluate('document.querySelector("[data-share-copy-text]").selectionEnd'), shareUrl.length, '替代文本获得焦点时整段被选中');

    // 5. 公开页与预览一致：真实页面里的消息条数等于预览给出的条数。
    const publicPage = await fetch(`${frontOrigin}/s/${token}`);
    assert.equal(publicPage.status, 200);
    const publicHtml = await publicPage.text();
    const pageMessages = (publicHtml.match(/<article class="message">/g) ?? []).length;
    assert.equal(pageMessages, previewCount, '公开页消息条数与预览一致');
    assert.match(publicHtml, new RegExp(ATTACHMENT_PUBLIC.filename));

    // 6. 记录与统计：状态、剩余有效期、访问次数、占用字节、总量，以及不可访问的记录。
    await activate('[role="tablist"] button:nth-child(2)');
    await waitFor(cli, `document.querySelector("[data-share-id=\\"${token}\\"]") !== null`, '分享记录出现');
    await waitFor(cli, 'document.querySelector("[data-share-stats]") !== null', '总量统计出现');
    const statsText = await evaluate('document.querySelector("[data-share-stats]").textContent');
    assert.match(statsText, /共 3 条/);
    assert.match(statsText, /可访问 1 条/);
    assert.match(statsText, /访问合计 \d+ 次/);
    assert.match(statsText, /占用合计 [\d.]+ (字节|KB|MB)/);
    const activeRow = await evaluate(`document.querySelector("[data-share-id=\\"${token}\\"]").closest("li").textContent`);
    assert.match(activeRow, /有效/);
    assert.match(activeRow, /访问 1 次/);
    assert.match(activeRow, /占用 /);
    assert.match(activeRow, /后过期/);
    assert.ok(await evaluate(`document.getElementById("chdsh-share-open-${token}") !== null`), '可访问的记录给出打开动作');

    const expiredRowText = await evaluate(`document.querySelector("[data-share-id=\\"${expired.shareId}\\"]").closest("li").textContent`);
    assert.match(expiredRowText, /已过期/);
    assert.equal(await evaluate(`document.getElementById("chdsh-share-open-${expired.shareId}")`), null, '过期记录没有打开动作');
    assert.equal(await evaluate(`document.getElementById("chdsh-share-copy-${expired.shareId}")`), null, '过期记录没有复制动作');
    assert.match(await evaluate(`document.querySelector("[data-share-blocked=\\"${expired.shareId}\\"]").textContent`), /不产生可访问链接/);

    const brokenRowText = await evaluate(`document.querySelector("[data-share-id=\\"${broken.shareId}\\"]").closest("li").textContent`);
    assert.match(brokenRowText, /附件副本缺失/);
    assert.equal(await evaluate(`document.getElementById("chdsh-share-open-${broken.shareId}")`), null, '附件副本缺失的记录没有打开动作');
    assert.match(await evaluate(`document.querySelector("[data-share-blocked=\\"${broken.shareId}\\"]").textContent`), /不产生可访问链接/);

    // 6.1 记录里的复制同样保留可选择文本。
    await activate(`#chdsh-share-copy-${token}`);
    await waitFor(cli, `document.querySelector("[data-share-copy-state=\\"${token}\\"] [data-share-copy-text]") !== null`, '记录里的复制替代文本出现');
    assert.match(await evaluate(`document.querySelector("[data-share-copy-state=\\"${token}\\"]").textContent`), /可以直接选中复制/);
    assert.equal(await evaluate(`document.querySelector("[data-share-copy-state=\\"${token}\\"] [data-share-copy-text]").value`), shareUrl);

    // 7. 窄屏公开阅读：320 px 宽度下面板与公开页都没有横向溢出，公开页只读。
    await cli('set', 'viewport', '320', '800');
    await cli('open', `${frontOrigin}/`);
    await waitFor(cli, 'document.getElementById("chdsh-share-session") !== null', '窄屏下面板重新载入');
    const narrowPanel = JSON.parse(await evaluate(OVERFLOW_SCRIPT));
    assert.equal(narrowPanel.width, 320);
    assert.deepEqual(narrowPanel.offenders, [], `窄屏面板不能有横向溢出：${JSON.stringify(narrowPanel)}`);
    assert.ok(narrowPanel.scroll <= 320, `面板宽度不能超过视口：${narrowPanel.scroll}`);

    await cli('select', '#chdsh-share-session', 'session-wp20');
    await waitFor(cli, 'document.getElementById("chdsh-share-attachment-attach-report") !== null', '窄屏下附件候选载入');
    await activate('#chdsh-share-preview');
    await waitFor(cli, 'document.querySelector("[data-share-facts]") !== null', '窄屏下预览出现');
    const narrowPreview = JSON.parse(await evaluate(OVERFLOW_SCRIPT));
    assert.deepEqual(narrowPreview.offenders, [], `窄屏预览不能有横向溢出：${JSON.stringify(narrowPreview)}`);

    await cli('open', `${frontOrigin}/s/${token}`);
    await waitFor(cli, 'document.querySelector("main") !== null', '公开页在窄屏下打开');
    const narrowPage = JSON.parse(await evaluate(OVERFLOW_SCRIPT));
    assert.deepEqual(narrowPage.offenders, [], `窄屏公开页不能有横向溢出：${JSON.stringify(narrowPage)}`);
    assert.ok(narrowPage.scroll <= 320, `公开页宽度不能超过视口：${narrowPage.scroll}`);
    const typography = JSON.parse(await evaluate('JSON.stringify((() => { const block = document.querySelector("main .message pre"); const style = getComputedStyle(block); return { width: block.getBoundingClientRect().width, fontSize: style.fontSize, lineHeight: style.lineHeight, whiteSpace: style.whiteSpace, wordBreak: style.wordBreak }; })())'));
    assert.ok(typography.width <= 288.5, `正文行宽要在 320 px 视口里留出边距：${typography.width}`);
    assert.equal(typography.fontSize, '16px');
    assert.equal(typography.whiteSpace, 'pre-wrap');
    assert.notEqual(typography.lineHeight, 'normal', '正文行高要由样式表给出');
    assert.equal(await evaluate('document.querySelectorAll("input, select, textarea, button, form").length'), 0, '公开页没有任何输入与动作');
    assert.equal(await evaluate('document.querySelectorAll("script").length'), 0, '公开页没有脚本');
    assert.match(await evaluate('document.body.textContent'), /只读快照/);
    assert.equal(await evaluate('document.querySelectorAll("[data-share-facts], [data-share-url]").length'), 0, '公开页没有面板控件');

    // 8. 撤销：对话框约束焦点，Escape 关闭并回到触发元素，撤销之后公开页立即失效。
    await cli('set', 'viewport', '1280', '900');
    await cli('open', `${frontOrigin}/`);
    await waitFor(cli, 'document.querySelector("[role=\\"tablist\\"] button:nth-child(2)") !== null', '窄屏之后回到面板');
    await activate('[role="tablist"] button:nth-child(2)');
    await waitFor(cli, `document.getElementById("chdsh-share-revoke-${token}") !== null`, '可撤销的记录出现');
    await activate(`#chdsh-share-revoke-${token}`);
    await waitFor(cli, 'document.querySelector("dialog[open]") !== null', '撤销确认对话框出现');
    assert.match(await evaluate('document.querySelector("dialog[open]").textContent'), /撤销之后这条链接立即失效/);
    assert.equal(await evaluate('document.querySelector("dialog[open]").contains(document.activeElement)'), true);
    for (let index = 0; index < 8; index += 1) {
      await cli('press', 'Tab');
      assert.equal(await evaluate('document.querySelector("dialog[open]").contains(document.activeElement)'), true, 'Tab 不能离开对话框');
    }
    await cli('press', 'Escape');
    await waitFor(cli, 'document.querySelector("dialog[open]") === null', 'Escape 关闭对话框');
    assert.equal(await evaluate('document.activeElement.id'), `chdsh-share-revoke-${token}`, '关闭后焦点回到触发按钮');

    await activate(`#chdsh-share-revoke-${token}`);
    await waitFor(cli, 'document.getElementById("chdsh-share-revoke-confirm") !== null', '确认按钮出现');
    await activate('#chdsh-share-revoke-confirm');
    await waitFor(cli, 'document.getElementById("root").textContent.includes("已撤销，公开页立即返回失效页面")', '撤销结果出现');
    assert.equal((await fetch(`${frontOrigin}/s/${token}`)).status, 410, '撤销之后公开页立即失效');
    assert.match(await evaluate(`document.querySelector("[data-share-id=\\"${token}\\"]").closest("li").textContent`), /已撤销/);
    assert.equal(await evaluate(`document.getElementById("chdsh-share-open-${token}")`), null, '撤销之后不再给出打开动作');
    assert.match(await evaluate('document.querySelector("[data-share-stats]").textContent'), /可访问 0 条/);

    // 9. 界面动作遥测：真实事件经同源中继上报，且不带令牌与消息内容。
    const actions = actionsOf(telemetryBatches);
    for (const expected of ['share-preview', 'share-create', 'share-copy', 'share-reload', 'share-revoke']) {
      assert.ok(actions.some((entry) => entry.action === expected), `缺少动作 ${expected}：${JSON.stringify(actions)}`);
    }
    assert.ok(actions.some((entry) => entry.action === 'share-copy' && entry.outcome === 'failed'), '复制失败要按真实结论记录');
    const serialized = JSON.stringify(telemetryBatches);
    assert.equal(serialized.includes(token), false, '遥测里不出现分享令牌');
    assert.equal(serialized.includes('工具输出原文不应出现'), false, '遥测里不出现消息内容');
  } finally {
    if (opened) await cli('close').catch(() => undefined);
    front?.closeAllConnections();
    if (front !== undefined) await new Promise((done) => front.close(done));
    await domain.close();
    await gatewayServer.stop();
    store.close();
    releaseIndependentHome(home);
  }
});
