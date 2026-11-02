// WP12 查看器的真实浏览器验收：筛选、版本展开、沙箱预览、图片键盘缩放、PDF 依赖提示、
// 删除全部版本的确认与键盘焦点。
//
// 页面用 esbuild 打包真实界面源码（`packages/client/artifacts/src/client/panel.tsx` 与它的数据
// 入口、遥测模块），宿主侧是真实的制品服务实例（真实的存储中枢、JSON 后端与存储域），制品内容
// 真实写进独立数据根的 `artifacts/` 下。浏览器是 agent-browser 独立会话里的真实 Chrome，使用
// 独立 HOME、TMPDIR 与 profile，不截图，断言全部来自 DOM、可访问属性、焦点位置与宿主实况。
//
// 运行：node --test e2e/unit/client-complete-wp12-viewer.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, readFileSync } from 'node:fs';
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
const { TypertRemoteService } = await import('../../../dsh-adapter/lib/index.js');
const { ChatdshArtifactsService } = await import('../../packages/host/artifacts/lib/index.js');
const { UI_KIT_CSS } = await import('../../packages/core/ui-kit/lib/index.js');

/** 一张真实的 1×1 PNG。 */
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** 第二版 HTML 制品：带脚本与表单，用来证明沙箱里拿不到宿主接口。 */
const HOSTILE_HTML = [
  '<!doctype html><html><head><meta charset="utf-8"><title>产物页</title></head><body>',
  '<h1 id="artifact-heading">报告第二版</h1>',
  '<script>parent.__chatdshHostTouched = true; top.__chatdshTopTouched = true;</script>',
  '<form action="/submit"><input name="q"><button id="artifact-submit">提交</button></form>',
  '</body></html>',
].join('');

/** 带脚本的 SVG：作为图片呈现时脚本不会执行。 */
const HOSTILE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><script>parent.__chatdshSvgRan = true;</script><rect width="4" height="4" fill="currentColor"/></svg>';

/** 页面脚本：真实面板组件 + 真实数据入口 + 真实遥测，传输层换成本机 HTTP。 */
const PAGE_ENTRY = `
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ArtifactsPanel } from ${JSON.stringify(join(RUNTIME, 'packages/client/artifacts/src/client/panel.tsx'))};
import { createArtifactsGateway } from ${JSON.stringify(join(RUNTIME, 'packages/client/artifacts/src/client/gateway.ts'))};
import { createPanelTelemetry } from ${JSON.stringify(join(RUNTIME, 'packages/client/artifacts/src/client/telemetry.ts'))};

const transport = {
  async call(endpoint, args) {
    const response = await fetch('/api/' + endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args }),
    });
    return response.json();
  },
};
const telemetry = createPanelTelemetry();
const gateway = createArtifactsGateway({ transport, telemetry });
createRoot(document.getElementById('root')).render(createElement(ArtifactsPanel, { gateway }));
window.__wp12 = { ready: true };
`;

/** 等待插件树激活。 */
function settle(ms = 1200) {
  return new Promise((done) => setTimeout(done, ms));
}

/** 把宿主抛出的失败编成线的信封。 */
function wireFailureOf(error) {
  if (typeof error === 'object' && error !== null && typeof error.code === 'string') {
    return { code: error.code, message: error.message };
  }
  return { code: 'gateway/internal', message: error instanceof Error ? error.message : String(error) };
}

/**
 * 装配真实的制品服务。
 * @param {string} root - 数据根。
 * @returns {Promise<{ ctx: object, service: object }>} 上下文与服务。
 */
async function openStack(root) {
  const ctx = new Context();
  await ctx.plugin(Storage);
  await ctx.plugin(json, { root: join(root, 'storages') });
  await ctx.plugin(domainPlugin, { backend: 'json' });
  const service = new ChatdshArtifactsService(ctx);
  await service[TypertRemoteService.init]();
  return { ctx, service };
}

/**
 * 写入验收用的制品。
 * @param {object} service - 真实制品服务。
 * @returns {Promise<Record<string, object>>} 按名称索引的制品记录。
 */
async function seedArtifacts(service) {
  const html = await service.put({
    sessionId: 'session-alpha',
    title: '产物页',
    kind: 'html',
    mimeType: 'text/html',
    content: '<!doctype html><p>第一版</p>',
  });
  await service.put({ id: html.id, sessionId: 'session-alpha', title: '产物页', mimeType: 'text/html', content: HOSTILE_HTML });

  const svg = await service.put({ sessionId: 'session-alpha', title: '矢量图', kind: 'svg', mimeType: 'image/svg+xml', content: HOSTILE_SVG });
  const png = await service.put({ sessionId: 'session-beta', title: '折线图', kind: 'image', mimeType: 'image/png', content: PNG_1X1, encoding: 'base64' });
  const pdf = await service.put({ sessionId: 'session-alpha', title: '合同', kind: 'document', mimeType: 'application/pdf', content: '%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n' });
  const packed = await service.put({ sessionId: 'session-beta', title: '打包', kind: 'other', mimeType: 'application/octet-stream', content: Buffer.from([0x50, 0x4b, 0x03, 0x04]) });
  const report = await service.put({ sessionId: 'session-beta', title: '周报', kind: 'document', mimeType: 'text/markdown', content: '# 周报\n\n第一版正文\n' });
  await service.put({ id: report.id, sessionId: 'session-beta', title: '周报', mimeType: 'text/markdown', content: '# 周报\n\n第二版正文\n' });
  const huge = await service.put({ sessionId: 'session-alpha', title: '超限日志', kind: 'document', mimeType: 'text/plain', content: 'x'.repeat(9 * 1024 * 1024) });

  return { html, svg, png, pdf, packed, report, huge };
}

/**
 * 起页面端点：制品方法与遥测中继。
 * @param {{ service: object, script: string, control: { offline: boolean } }} options - 依赖。
 * @returns {Promise<{ origin: string, batches: object[], close: () => Promise<void> }>} 端点。
 */
async function startPage({ service, script, control }) {
  const batches = [];
  const handlers = {
    list: (args) => service.list(...args),
    read: (args) => service.read(...args),
    versionList: (args) => service.versionList(...args),
    deleteScope: (args) => service.deleteScope(...args),
    delete: (args) => service.remove(...args),
  };
  const tokens = readFileSync(join(RUNTIME, 'packages/client/theme/src/client/styles/tokens.css'), 'utf8');
  const html = [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>制品面板</title><style>',
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
      if (url.pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(html);
        return;
      }
      if (url.pathname === '/chatdsh/telemetry/browser') {
        batches.push({ signal: request.headers['x-chatdsh-signal'], body: JSON.parse(raw) });
        response.writeHead(204).end();
        return;
      }
      if (control.offline && url.pathname.startsWith('/api/')) {
        response.socket?.destroy();
        return;
      }
      const endpoint = url.pathname.replace(/^\/api\/chatdshArtifacts\//u, '');
      const handler = handlers[endpoint];
      if (handler === undefined) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end('{}');
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
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}

test('真实 Chrome 完成筛选、版本展开、沙箱预览、图片缩放、PDF 提示与删除确认', { timeout: 300000 }, async (t) => {
  const home = allocateIndependentHome('wp12-viewer');
  const previousHome = process.env.HOME;
  const previousDshHome = process.env.DSH_HOME;
  process.env.HOME = home;
  process.env.DSH_HOME = home;

  const session = `wp12-${randomUUID().slice(0, 8)}`;
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
    const result = await execute(`${NODE_BIN}/agent-browser`, ['--session', session, '--json', ...args], { env, timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
    const response = JSON.parse(result.stdout);
    assert.equal(response.success, true, `agent-browser ${args[0]}：${result.stdout}`);
    return response;
  };

  let ctx;
  let service;
  let page;
  let opened = false;
  try {
    mkdirSync(join(home, 'downloads'), { recursive: true });
    const stack = await openStack(join(home, 'runtime'));
    ctx = stack.ctx;
    service = stack.service;
    const seeded = await seedArtifacts(service);
    const control = { offline: false };

    const bundle = await build({
      stdin: { contents: PAGE_ENTRY, resolveDir: RUNTIME, loader: 'tsx', sourcefile: 'wp12-page.tsx' },
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
    page = await startPage({ service, script, control });
    const evaluate = async (expression) => {
      const result = await cli('eval', expression);
      return result.data.result;
    };
    const textHas = async (needle) => evaluate(`document.body.innerText.includes(${JSON.stringify(needle)})`);
    const closeDialog = async () => {
      await cli('press', 'Escape');
      await cli('wait', '--fn', '!document.querySelector("dialog[open]")');
    };

    await cli('open', page.origin);
    opened = true;
    await cli('wait', '#wp12-artifact-search');
    await cli('wait', '--fn', 'window.__wp12 && window.__wp12.ready === true');
    await cli('wait', '--text', '产物页');

    await t.test('列表按会话、类型与名称过滤，并标出当前版本', async () => {
      assert.equal(await evaluate('document.querySelectorAll(".chdsh-panel").length'), 1, '面板使用共享组件外壳');
      assert.equal(await textHas('第 2 版'), true, '列表行标出当前版本');
      const rowCount = await evaluate('document.querySelectorAll(".chdsh-list > .chdsh-row").length');
      assert.equal(rowCount, 7, '七个制品各占一行');

      await cli('select', '#wp12-artifact-type', 'text/markdown');
      assert.equal(await textHas('周报'), true);
      assert.equal(await textHas('产物页'), false, '类型过滤排除其他媒体类型');

      await cli('select', '#wp12-artifact-session', 'session-alpha');
      await cli('wait', '--text', '没有符合当前筛选条件的制品');
      assert.equal(await textHas('合同'), false, '两个口径叠加后没有命中');

      await cli('reload');
      await cli('wait', '#wp12-artifact-session');
      await cli('wait', '--text', '产物页');
      await cli('select', '#wp12-artifact-session', 'session-alpha');
      assert.equal(await textHas('合同'), true);
      assert.equal(await textHas('折线图'), false, '会话过滤排除其他会话');

      await cli('reload');
      await cli('wait', '#wp12-artifact-search');
      await cli('wait', '--text', '产物页');
      await cli('fill', '#wp12-artifact-search', '折线');
      assert.equal(await textHas('折线图'), true);
      assert.equal(await textHas('周报'), false, '名称过滤收起其他行');
      await cli('fill', '#wp12-artifact-search', '没有这个制品');
      assert.equal(await textHas('没有符合当前筛选条件的制品'), true);
      await cli('focus', '#wp12-artifact-search');
      await cli('press', 'Control+a');
      await cli('press', 'Delete');
      assert.equal(await textHas('周报'), true, '清空搜索词后恢复全部行');
    });

    await t.test('版本列表展开给出两版、当前版本标记与逐版下载入口', async () => {
      await cli('find', 'role', 'button', 'click', '--name', '版本 周报');
      await cli('wait', '--text', '共 2 个版本，当前第 2 版');
      assert.equal(await textHas('第 1 版 ·'), true, '展开后列出第一版');
      assert.equal(await textHas('当前版本'), true, '当前版本有文字标记');
      assert.equal(await evaluate('document.querySelectorAll("[aria-expanded=true]").length'), 1, '展开按钮保留展开状态');
      await cli('find', 'role', 'button', 'click', '--name', '下载 周报 第 1 版');
      await cli('wait', '--text', '已保存 周报-v1.md');
      assert.equal(await textHas('共 26 字节'), true, '下载提示带第一版的实际字节数');
      await cli('find', 'role', 'button', 'click', '--name', '版本 周报');
    });

    await t.test('HTML 预览：沙箱没有同源与脚本权限，页面拿不到宿主接口', async () => {
      await cli('find', 'role', 'button', 'click', '--name', '预览 产物页');
      await cli('wait', 'dialog[open]');
      await cli('wait', '--fn', 'document.getElementById("wp12-html-frame") !== null');
      const frame = 'document.getElementById("wp12-html-frame")';
      assert.equal(await evaluate(`${frame}.getAttribute("sandbox")`), '', '沙箱标记为空，没有 allow-same-origin 与 allow-scripts');
      assert.equal(await evaluate(`${frame}.getAttribute("sandbox")?.includes("allow") ?? false`), false, '沙箱里没有任何放行项');
      assert.equal(await evaluate(`${frame}.contentDocument === null`), true, '同源访问被拒绝');
      assert.equal(await evaluate('window.__chatdshHostTouched === undefined'), true, '页面里的脚本没有执行');
      assert.equal(await evaluate('window.__chatdshTopTouched === undefined'), true, '脚本没有碰到顶层页面');
      assert.equal(await textHas('受限预览'), true, '界面明确说明预览受限');

      await cli('select', '#wp12-artifact-version', '2');
      await cli('wait', '--fn', `document.getElementById("wp12-html-frame").getAttribute("srcdoc").includes("__chatdshHostTouched")`);
      assert.equal(await evaluate('window.__chatdshHostTouched === undefined'), true, '第二版的脚本同样没有执行');
      await closeDialog();
    });

    await t.test('SVG 以图片呈现，脚本不执行', async () => {
      await cli('find', 'role', 'button', 'click', '--name', '预览 矢量图');
      await cli('wait', 'dialog[open]');
      await cli('wait', '#wp12-svg');
      assert.equal(await evaluate('document.getElementById("wp12-svg").getAttribute("src").startsWith("data:image/svg+xml;base64,")'), true);
      assert.equal(await evaluate('document.getElementById("wp12-html-frame") === null'), true, 'SVG 不走 HTML 预览');
      assert.equal(await evaluate('window.__chatdshSvgRan === undefined'), true, 'SVG 里的脚本没有执行');
      assert.equal(await textHas('安全图片'), true);
      await closeDialog();
    });

    await t.test('图片工具栏：键盘缩放、Home 复位、适应宽度与原尺寸', async () => {
      await cli('find', 'role', 'button', 'click', '--name', '预览 折线图');
      await cli('wait', 'dialog[open]');
      await cli('wait', '#wp12-image-viewer');
      assert.equal(await evaluate('document.getElementById("wp12-zoom-percent").textContent'), '100%');

      const names = await evaluate('[...document.querySelectorAll("[role=toolbar] button")].map((node) => node.getAttribute("aria-label"))');
      assert.deepEqual(names, ['缩小图片', '放大图片', '适应宽度', '原始大小']);
      const linkNames = await evaluate('[...document.querySelectorAll("[role=toolbar] a")].map((node) => node.getAttribute("aria-label"))');
      assert.equal(linkNames.length, 2, '工具栏带下载与外部打开');
      assert.match(linkNames[0], /^下载图片 /u);
      assert.match(linkNames[1], /^外部打开图片 /u);

      await cli('focus', '#wp12-image-viewer');
      await cli('press', '+');
      assert.equal(await evaluate('document.getElementById("wp12-zoom-percent").textContent'), '125%', '加号放大一档');
      await cli('press', '-');
      assert.equal(await evaluate('document.getElementById("wp12-zoom-percent").textContent'), '100%', '减号缩小一档');
      await cli('press', 'Home');
      assert.equal(await evaluate('document.getElementById("wp12-zoom-percent").textContent'), '100%', 'Home 复位到原尺寸');
      await cli('find', 'role', 'button', 'click', '--name', '适应宽度');
      assert.equal(await evaluate('document.getElementById("wp12-zoom-percent").textContent'), '400%', '一像素宽的图片按容器放大到上限');
      assert.equal(await evaluate('document.getElementById("wp12-image").style.width'), '100%', '适应宽度按容器铺满');
      await cli('find', 'role', 'button', 'click', '--name', '原始大小');
      assert.equal(await evaluate('document.getElementById("wp12-zoom-percent").textContent'), '100%');
      assert.equal(await evaluate('document.getElementById("wp12-image").style.width'), '1px', '原尺寸是图片的自然宽度');
      const downloadName = await evaluate('document.querySelector("[role=toolbar] a").getAttribute("download")');
      assert.equal(downloadName, '折线图-v1.png', '下载文件名带版本与后缀');
      await closeDialog();
    });

    await t.test('PDF 查看器依赖缺失给出错误码，二进制与超限各有实际结果', async () => {
      await cli('find', 'role', 'button', 'click', '--name', '预览 合同');
      await cli('wait', 'dialog[open]');
      await cli('wait', '#wp12-preview-code');
      assert.equal(await evaluate('document.getElementById("wp12-preview-code").textContent'), 'artifact/pdf-viewer-unavailable');
      assert.equal(await textHas('pdfjs-dist'), true, '提示里说明缺失的库');
      await closeDialog();

      await cli('find', 'role', 'button', 'click', '--name', '预览 打包');
      await cli('wait', '#wp12-preview-code');
      assert.equal(await evaluate('document.getElementById("wp12-preview-code").textContent'), 'artifact/binary');
      await closeDialog();

      await cli('find', 'role', 'button', 'click', '--name', '预览 超限日志');
      await cli('wait', '#wp12-preview-code');
      assert.equal(await evaluate('document.getElementById("wp12-preview-code").textContent'), 'artifact/preview-too-large');
      assert.equal(await textHas('9.0 MB'), true, '提示里给出实际大小');
      await closeDialog();
    });

    await t.test('文本预览可选择，指定版本的下载字节与磁盘一致', async () => {
      await cli('find', 'role', 'button', 'click', '--name', '预览 周报');
      await cli('wait', 'dialog[open]');
      await cli('wait', '#wp12-text');
      assert.equal(await evaluate('document.getElementById("wp12-text").textContent'), '# 周报\n\n第二版正文\n');
      assert.equal(await textHas('预览方式 text'), true);
      assert.equal(await evaluate('document.getElementById("wp12-artifact-download").getAttribute("download")'), '周报-v2.md');
      assert.equal(await evaluate('document.getElementById("wp12-artifact-external").getAttribute("target")'), '_blank');
      assert.equal(await evaluate('document.getElementById("wp12-artifact-external").getAttribute("href").startsWith("blob:")'), true, '外部打开指向内容的对象地址');

      const storedV1 = readFileSync(join(home, 'artifacts', seeded.report.id, 'v1'));
      const storedV2 = readFileSync(join(home, 'artifacts', seeded.report.id, 'v2'));
      const secondPath = join(home, 'downloads', '周报-v2.md');
      await cli('download', '#wp12-artifact-download', secondPath);
      assert.deepEqual(readFileSync(secondPath), storedV2, '当前版本的下载字节与磁盘一致');

      await cli('select', '#wp12-artifact-version', '1');
      await cli('wait', '--fn', 'document.getElementById("wp12-text").textContent.includes("第一版正文")');
      assert.equal(await evaluate('document.getElementById("wp12-artifact-download").getAttribute("download")'), '周报-v1.md');
      const firstPath = join(home, 'downloads', '周报-v1.md');
      await cli('download', '#wp12-artifact-download', firstPath);
      assert.deepEqual(readFileSync(firstPath), storedV1, '指定版本的下载字节与磁盘一致');
      await closeDialog();
    });

    await t.test('Escape 关闭详情并把焦点还给触发按钮，Tab 不离开对话框', async () => {
      await cli('find', 'role', 'button', 'click', '--name', '预览 周报');
      await cli('wait', 'dialog[open]');
      await cli('wait', '#wp12-text');
      for (let step = 0; step < 16; step += 1) {
        await cli('press', 'Tab');
        assert.equal(await evaluate('document.querySelector("dialog[open]").contains(document.activeElement)'), true, '焦点不能离开对话框');
      }
      await closeDialog();
      assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), '预览 周报', 'Escape 之后焦点回到预览按钮');
    });

    await t.test('控制平面不可达与内容被移除各有明确提示', async () => {
      control.offline = true;
      await cli('click', '#wp12-artifact-refresh');
      await cli('wait', '--text', '控制平面不可达');
      assert.equal(await evaluate('document.getElementById("wp12-artifact-reload") !== null'), true, '离线时给出重新加载入口');
      control.offline = false;
      await cli('click', '#wp12-artifact-reload');
      await cli('wait', '--text', '产物页');

      await service.remove(seeded.svg.id);
      await cli('find', 'role', 'button', 'click', '--name', '预览 矢量图');
      await cli('wait', '--text', '源设备离线或制品内容已被移除');
      assert.equal(await textHas('object-not-found'), true, '提示里带宿主错误码');
      await closeDialog();
    });

    await t.test('删除全部版本先显示版本数与占用空间，确认后清空存储', async () => {
      const scope = await service.deleteScope(seeded.report.id);
      const note = `共 ${String(scope.affectedVersions.length)} 个版本`;
      await cli('find', 'role', 'button', 'click', '--name', '预览 周报');
      await cli('wait', 'dialog[open]');
      await cli('click', '#wp12-artifact-delete');
      await cli('wait', '--text', '删除全部版本');
      await cli('wait', '#wp12-delete-summary');
      assert.equal(await textHas(note), true, '确认框显示版本数');
      assert.equal(await textHas('占用'), true, '确认框显示占用空间');
      assert.equal(await textHas('第 1 版、第 2 版'), true, '确认框列出涉及的版本');
      await cli('click', '#wp12-delete-cancel');
      await cli('wait', '--fn', 'document.querySelectorAll("dialog[open]").length === 1');
      assert.equal(await textHas('共 2 个版本'), true, '取消之后详情仍然打开');

      await cli('click', '#wp12-artifact-delete');
      await cli('wait', '#wp12-delete-confirm');
      assert.equal(await textHas(note), true, '确认框仍然显示版本数');
      await cli('click', '#wp12-delete-confirm');
      await cli('wait', '--fn', '!document.querySelector("dialog[open]")');
      await cli('wait', '--fn', '!document.body.innerText.includes("周报")');
      assert.equal(scope.totalBytes > 0, true, '删除前占用空间大于零');
      assert.equal(service.list().map((record) => record.title).includes('周报'), false);
    });

    await t.test('界面动作与失败事件都送到同源中继', async () => {
      const deadline = Date.now() + 5000;
      const records = () => page.batches.filter((batch) => batch.signal === 'logs')
        .flatMap((batch) => (batch.body.resourceLogs ?? []).flatMap((resource) => resource.scopeLogs ?? []))
        .flatMap((scope) => scope.logRecords ?? [])
        .map((record) => ({
          name: record.body?.stringValue ?? '',
          attributes: Object.fromEntries((record.attributes ?? []).map((entry) => [entry.key, entry.value.stringValue ?? entry.value.intValue])),
        }));
      while (Date.now() < deadline && !records().some((record) => record.attributes.action === 'artifact.delete')) {
        await new Promise((done) => setTimeout(done, 50));
      }
      const actions = records().filter((record) => record.name === 'chatdsh.client.ui.action');
      assert.ok(actions.some((record) => record.attributes.action === 'artifact.preview' && record.attributes.outcome === 'ok'));
      assert.ok(actions.some((record) => record.attributes.action === 'artifact.preview' && record.attributes.outcome === 'failed'));
      assert.ok(actions.some((record) => record.attributes.action === 'artifact.download' && record.attributes.outcome === 'ok'));
      assert.ok(actions.some((record) => record.attributes.action === 'artifact.delete' && record.attributes.outcome === 'ok'));
      const failures = records().filter((record) => record.name === 'chatdsh.client.error');
      assert.ok(failures.some((record) => record.attributes['error.code'] === 'object-not-found'), '内容缺失按宿主错误码上报');
    });

    const errors = await cli('errors');
    assert.deepEqual(errors.data.errors, [], '页面没有未捕获的错误');
   } finally {
    if (opened) await cli('close');
    if (page !== undefined) await page.close();
    if (ctx !== undefined) await ctx.fiber.dispose();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousDshHome;
    releaseIndependentHome(home);
  }
});
