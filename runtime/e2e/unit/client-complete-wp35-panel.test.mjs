// WP35 验收：导出面板、数据入口与客户端包清单。
//
// 面板由 esbuild 从真实源码打包，装进真实 Chrome；数据入口走真实 HTTP，服务端是导出宿主的
// `createExportHttpHandler` 与真实 `ExportService`，会话、附件与数据库全部来自真实实现。
// 断言来自 DOM、磁盘上的导出包与浏览器发出的界面动作遥测。宿主侧入口按包清单编译之后在
// Node 里直接导入，核对清单字段与纯函数结论。
//
// 运行：node --test e2e/unit/client-complete-wp35-panel.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { UI_KIT_CSS } from '../../packages/core/ui-kit/lib/index.js';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';

const execute = promisify(execFile);
const RUNTIME = resolve(import.meta.dirname, '../..');
const PACKAGE = join(RUNTIME, 'packages/client/exports');
const NODE_BIN = '/usr/local/nvm/versions/node/v24.19.0/bin';
const AGENT_BROWSER = `${NODE_BIN}/agent-browser`;
const ROOT = new URL('../../', import.meta.url);
const BASE = Date.UTC(2026, 10, 1, 12, 0, 0);

const { GatewayStore, ReplicaStore } = await import('../../gateway/lib/store.js');
const { ExportService } = await import('../../gateway/lib/exports/service.js');
const { createExportHttpHandler } = await import('../../gateway/lib/exports/http.js');

/** 面板入口：从真实源码打包，挂到页面上。 */
const ENTRY = `
import { createRoot } from 'react-dom/client';
import { bindExportsPanel, createExportGateway, browserTelemetry } from '../../packages/client/exports/src/client/index.ts';
window.__wp35Errors = [];
window.addEventListener('error', (event) => window.__wp35Errors.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) => window.__wp35Errors.push('rejection:' + String(event.reason)));
const Panel = bindExportsPanel({ gateway: createExportGateway({ telemetry: browserTelemetry }) });
createRoot(document.getElementById('root')).render(<Panel source={{ kind: 'session', sessionId: 'wp35-panel' }} turnBounds={{ turnFrom: 1, turnTo: 4 }} />);
`;

/** 等一个页面条件成立。 */
async function waitFor(cli, expression, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { data } = await cli('eval', `Boolean(${expression})`);
    if (data.result === true) return;
    await new Promise((done) => setTimeout(done, 250));
  }
  assert.fail(`等待超时：${message}`);
}

/** 造四个完整回合的会话。 */
function panelEvents() {
  const events = [];
  let seq = 0;
  const push = (kind, data) => {
    events.push({ seq, kind, time: BASE + seq * 1_000, bytes: 128, payload: { seq, type: kind, time: BASE + seq * 1_000, data } });
    seq += 1;
  };
  push('session/title', { title: '面板验收会话' });
  for (let turn = 1; turn <= 4; turn += 1) {
    push('turn/start', { turn });
    push('user/message', {
      content: [{
        type: 'text',
        text: turn === 2
          ? '第二回合请核对报表 [附件 att-report report.csv text/csv 21 字节]，另外 [附件 att-missing plan.md text/markdown 9 字节] 已经丢了。'
          : `第 ${turn} 回合的提问：面板按完整回合导出。`,
      }],
    });
    push('assistant/message', { message: { content: [{ type: 'text', text: `第 ${turn} 回合的回答。` }] } });
    push('turn/end', { turn });
  }
  return events;
}

/** 建立本包的依赖链接，内容与 pnpm 安装之后一致。 */
function ensureWorkspaceLinks() {
  const modules = join(PACKAGE, 'node_modules', '@chatdsh');
  mkdirSync(modules, { recursive: true });
  const link = join(modules, 'core-ui-kit');
  if (existsSync(link)) return;
  symlinkSync('../../../../core/ui-kit', link, 'dir');
}

test('导出面板、数据入口与客户端包清单', { timeout: 300_000 }, async (t) => {
  const home = allocateIndependentHome('wp35-panel');
  const session = `wp35-panel-${randomUUID().slice(0, 8)}`;
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
  const click = async (selector) => {
    const clicked = await evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (node === null) return false; node.click(); return true; })()`);
    assert.equal(clicked, true, `找不到可以点击的元素：${selector}`);
  };

  const root = join(home, 'root');
  const dataRoot = join(root, 'data');
  mkdirSync(dataRoot, { recursive: true });
  const store = new GatewayStore(join(root, 'gateway', 'gateway.sqlite'));
  let server;
  let opened = false;
  try {
    const replicas = new ReplicaStore(store.handle());
    store.upsertSession({
      sessionId: 'wp35-panel',
      workspaceId: 'ws-wp35',
      deviceId: 'owner-device',
      cwd: '/workspace/chatdsh',
      kind: 'work',
      createdAt: BASE,
    });
    const appended = replicas.append('wp35-panel', panelEvents());
    assert.equal(appended.written, panelEvents().length);
    const attachmentDir = join(dataRoot, 'attachments', 'att-report');
    mkdirSync(attachmentDir, { recursive: true });
    writeFileSync(join(attachmentDir, 'report.csv'), 'name,total\nNorth,120\n');

    const exportsRoot = join(root, 'exports');
    const service = new ExportService({
      database: store.handle(),
      dataRoot,
      exportsRoot,
      localDeviceId: 'owner-device',
      timeZone: 'Asia/Shanghai',
    });
    const authorize = (request, action) => (action === 'write' && request.headers['x-chatdsh-csrf'] !== '1'
      ? undefined
      : { deviceId: 'owner-device', privateExport: false });
    const handler = createExportHttpHandler({ service, authorize });
    const relayed = [];
    server = createServer(async (request, response) => {
      if (request.url === '/chatdsh/telemetry/browser') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        relayed.push(Buffer.concat(chunks).toString('utf8'));
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method === 'GET' && request.url === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(page);
        return;
      }
      if (await handler(request, response)) return;
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'object-not-found' }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;

    const bundle = await build({
      stdin: { contents: ENTRY, resolveDir: fileURLToPath(new URL('.', import.meta.url)), sourcefile: 'wp35-panel-entry.tsx', loader: 'tsx' },
      bundle: true,
      write: false,
      format: 'iife',
      jsx: 'automatic',
      target: 'es2022',
      logLevel: 'warning',
    });
    const tokens = readFileSync(new URL('packages/client/theme/src/client/styles/tokens.css', ROOT), 'utf8');
    const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>导出面板验收</title><style>${tokens}\n${UI_KIT_CSS}\nmain{padding:16px;max-width:100%}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`;

    await t.test('面板按来源列出格式，附件逐项列出状态', async () => {
      await cli('open', `${origin}/`);
      opened = true;
      await waitFor(cli, 'document.querySelector("#chdsh-export-format") !== null', '面板渲染');
      await waitFor(cli, 'document.body.textContent.includes("预计")', '预估完成');
      const format = JSON.parse(await evaluate('JSON.stringify([...document.querySelectorAll("#chdsh-export-format option")].map((option) => ({ value: option.value, disabled: option.disabled })))'));
      assert.deepEqual(format.map((item) => item.value), ['markdown', 'jsonl', 'html', 'pdf']);
      assert.equal(format[1].disabled, true, '没有私有导出权限时原始 JSONL 不可选');
      assert.equal(format.filter((item) => item.disabled === false).length, 3);
      const attachments = JSON.parse(await evaluate('JSON.stringify({ rows: [...document.querySelectorAll("section[aria-label=附件清单] li")].map((row) => row.textContent), confirm: [...document.querySelectorAll("label")].some((label) => label.textContent.includes("我确认把不可下载的附件逐项列进导出清单")) })'));
      assert.equal(attachments.rows.length, 2, '两份附件各占一行');
      assert.ok(attachments.rows[0].includes('report.csv'));
      assert.ok(attachments.rows[0].includes('可下载'));
      assert.ok(attachments.rows[1].includes('plan.md'));
      assert.ok(attachments.rows[1].includes('缺失'));
      assert.equal(attachments.confirm, true, '存在缺失附件时提供确认项');
      const estimateText = await evaluate('document.body.textContent');
      assert.ok(estimateText.includes('预计'), '显示预估体积');
      assert.ok(estimateText.includes('16 个事件'), '范围按完整回合计数，控制事件一并计入');
      const errors = await cli('errors');
      assert.deepEqual(errors.data.errors, []);
    });

    await t.test('缺失附件未确认时不提交生成', async () => {
      await click('button.chdsh-btn--primary');
      await waitFor(cli, 'document.querySelector(".chdsh-error") !== null', '缺失确认提示');
      const note = await evaluate('document.querySelector(".chdsh-error").textContent');
      assert.ok(note.includes('不可下载'), `提示文字：${note}`);
      assert.ok(note.includes('缺失 1'), `提示文字：${note}`);
      const jobs = await service.list();
      assert.equal(jobs.length, 0, '未确认时没有建立任务');
    });

    await t.test('确认之后生成、下载并再次生成新文件', async () => {
      const confirmed = await evaluate(`(() => {
        const label = [...document.querySelectorAll('label')].find((node) => node.textContent.includes('我确认把不可下载的附件逐项列进导出清单'));
        const box = label?.querySelector('input[type=checkbox]');
        if (box === undefined || box === null) return false;
        box.click();
        return box.checked;
      })()`);
      assert.equal(confirmed, true, '确认项被勾选');
      await click('button.chdsh-btn--primary');
      await waitFor(cli, 'document.body.textContent.includes("已完成")', '导出完成');
      const label = await evaluate('document.querySelector("section[aria-label=导出任务状态]").textContent');
      assert.ok(label.includes('已完成'), label);
      assert.ok(label.includes('下载'), label);
      await waitFor(cli, '[...document.querySelectorAll("button")].some((node) => node.textContent === "下载文件")', '下载按钮出现');
      const downloadClicked = await evaluate('(() => { const node = [...document.querySelectorAll("button")].find((item) => item.textContent === "下载文件"); if (node === undefined) return false; node.click(); return true; })()');
      assert.equal(downloadClicked, true);
      await waitFor(cli, 'document.body.textContent.includes("已开始下载")', '下载被触发');
      const completion = await evaluate('document.body.textContent');
      assert.ok(/已开始下载 会话-wp35-panel-\d+\.md/.test(completion), `下载文案：${completion.slice(0, 400)}`);

      const jobs = await service.list();
      assert.equal(jobs.length, 1, '一次生成只建立一个任务');
      const downloaded = await service.download(jobs[0].jobId);
      assert.equal(new TextDecoder('utf-8').decode(downloaded.bytes).includes('第 4 回合的回答'), true);

      await waitFor(cli, '[...document.querySelectorAll("button")].some((node) => node.textContent === "再生成一份")', '重新生成入口出现');
      const regenerate = await evaluate('(() => { const node = [...document.querySelectorAll("button")].find((item) => item.textContent === "再生成一份"); if (node === undefined) return false; node.click(); return true; })()');
      assert.equal(regenerate, true);
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if ((await service.list()).length === 2) break;
        await new Promise((done) => setTimeout(done, 100));
      }
      const after = await service.list();
      assert.equal(after.length, 2, '重新生成建立了第二个任务');
      assert.notEqual(after[0].jobId, after[1].jobId, '重新生成换了新的任务标识');
    });

    await t.test('界面动作写进浏览器遥测', async () => {
      assert.ok(relayed.length > 0, '中继收到界面动作');
      const bodies = relayed.join('\n');
      assert.ok(bodies.includes('chatdsh.client.ui.action'));
      assert.ok(bodies.includes('export-estimate'));
      assert.ok(bodies.includes('export-create'));
      assert.ok(bodies.includes('export-download'));
      assert.ok(bodies.includes('"ok"'));
      assert.equal(bodies.includes('面板验收会话'), false, '遥测里没有会话标题');
      assert.equal(bodies.includes('report.csv'), false, '遥测里没有附件文件名');
      const errors = await cli('errors');
      assert.deepEqual(errors.data.errors, []);
    });

    await t.test('客户端包清单与宿主侧入口', async () => {
      ensureWorkspaceLinks();
      execFileSync(join(RUNTIME, 'node_modules/.bin/tsc'), ['-b', join(PACKAGE, 'tsconfig.json')], { cwd: RUNTIME, stdio: 'inherit' });
      const manifest = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8'));
      assert.equal(manifest.name, '@chatdsh/client-exports');
      assert.equal(manifest.main, 'lib/index.js');
      assert.equal(manifest.exports['.'].default, './lib/index.js');
      assert.equal(manifest.exports['./client'].default, './lib/client.js');
      assert.equal(manifest.dsh.client.platform, 'web');
      assert.deepEqual(manifest.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-settings']);
      assert.deepEqual(manifest.chatdsh.telemetry, { events: ['chatdsh.client.ui.action'], spans: [], metrics: [] });
      assert.equal(manifest.dependencies['@chatdsh/core-ui-kit'], 'workspace:*');
      const tsconfig = JSON.parse(readFileSync(join(PACKAGE, 'tsconfig.json'), 'utf8'));
      assert.equal(tsconfig.extends, '../../../tsconfig.base.json');
      assert.deepEqual(tsconfig.compilerOptions.lib, ['ES2023', 'DOM', 'DOM.Iterable']);
      assert.equal(tsconfig.compilerOptions.jsx, 'react-jsx');

      const host = await import(join(PACKAGE, 'lib/index.js'));
      assert.equal(host.CLIENT_ENTRY, './client');
      assert.equal(host.PANEL_ID, 'chatdsh-exports');
      assert.equal(typeof host.apply, 'function');
      assert.deepEqual(host.formatsFor({ kind: 'session', sessionId: 's' }, false), ['markdown', 'html', 'pdf']);
      assert.deepEqual(host.formatsFor({ kind: 'session', sessionId: 's' }, true), ['markdown', 'jsonl', 'html', 'pdf']);
      assert.deepEqual(host.formatsFor({ kind: 'artifact', artifactId: 'a', version: 2 }, true), ['markdown', 'html', 'pdf']);
      assert.throws(
        () => host.selectionOf({ source: { kind: 'session', sessionId: 's' }, turnFrom: 1, turnTo: 2, format: 'jsonl', includeToolReads: false, attachmentPolicy: 'include-missing-list', timeDisplay: 'local', redaction: 'default', privateExport: false }),
        (error) => error.reason === 'private-export-required',
        '没有私有导出权限时拒绝原始 JSONL',
      );
      assert.throws(
        () => host.selectionOf({ source: { kind: 'session', sessionId: 's' }, turnFrom: 3, turnTo: 2, format: 'markdown', includeToolReads: false, attachmentPolicy: 'include-missing-list', timeDisplay: 'local', redaction: 'default', privateExport: false }),
        (error) => error.reason === 'range-order',
      );
      const attachments = [
        { id: 'a', filename: 'a.txt', state: 'downloadable', size: 12 },
        { id: 'b', filename: 'b.txt', state: 'missing', size: 9 },
      ];
      assert.equal(host.needsMissingConfirmation('include-missing-list', attachments), true);
      assert.equal(host.missingDecision('exclude', attachments, false).action, 'generate');
      assert.equal(host.missingDecision('available-only', [{ id: 'b', filename: 'b.txt', state: 'missing' }], false).action, 'blocked');
      assert.equal(host.missingDecision('include-missing-list', attachments, false).action, 'confirm');
      assert.equal(host.missingDecision('include-missing-list', attachments, true).action, 'generate');
      assert.equal(host.tallyOf(attachments).missing, 1);
      const view = host.describeJob({
        jobId: 'j',
        state: 'cancelling',
        scope: { source: { kind: 'session', sessionId: 's' }, scope: { turnFrom: 1, turnTo: 2, eventCount: 4, charCount: 40, compressed: true, attachmentsComplete: true }, format: 'markdown', includeToolReads: false, attachmentPolicy: 'include-missing-list', timeDisplay: 'local', redaction: 'default', privateExport: false },
        estimate: { eventCount: 4, charCount: 40, bytes: 160, attachments: [] },
        createdAt: BASE,
        completedAt: BASE + 1_000,
      }, BASE + 2_000);
      assert.equal(view.label, '已取消');
      assert.equal(view.canDownload, false);
      assert.equal(view.canRegenerate, true);
      const printScope = host.printScopeOf(host.defaultPrintInput('公开页打印'));
      assert.equal(printScope.pageNumbers, true);
      assert.deepEqual(printScope.excluded, ['navigation', 'composer', 'interaction-buttons']);
      assert.ok(host.printPreviewSummary(printScope).includes('打印并显示页码'));
      assert.equal(host.formatBytes(2048), '2.0 KB');
      assert.deepEqual(host.formatChoices({ kind: 'artifact', artifactId: 'a', version: 1 }, false).filter((item) => item.available === false).map((item) => item.format), ['jsonl']);
    });
  } finally {
    if (opened) await cli('close');
    if (server !== undefined) {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
    store.close();
    releaseIndependentHome(home);
  }
});
