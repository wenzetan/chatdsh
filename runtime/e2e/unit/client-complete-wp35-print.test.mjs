// WP35 验收：公开页打印视图、打印样式与分页规则。
//
// 会话内容、附件字节与公开快照都来自真实实现：副本事件写进真实 SQLite，附件是真实目录里的
// 文件，分享记录由真实 ShareService 建立，公开页模型由 `publicAccess` 读出。打印视图用
// 导出宿主的 `renderSharePrintPage` 渲染，样式来自 `printStylesheet`；计算样式在真实 Chrome
// 里按 `Emulation.setEmulatedMedia` 切到打印媒体之后读取，PDF 由同一条 Chrome 打印管线生成，
// 再用 poppler 读出页数与可选中的中文。
//
// 运行：node --test e2e/unit/client-complete-wp35-print.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { ensureDeps } from '../lib/ensure-deps.mjs';
import { startShareDomain } from './client-complete-wp20-support.mjs';

const execute = promisify(execFile);
const RUNTIME = resolve(import.meta.dirname, '../..');
ensureDeps(RUNTIME);

const { GatewayStore, ReplicaStore } = await import('../../gateway/lib/store.js');
const { PUBLIC_PRINT_SCOPE, printStylesheet, renderSharePrintPage } = await import('../../gateway/lib/exports/print.js');
const { createTelemetryClient } = await import('../../packages/core/diagnostics/lib/client.js');
const { defaultTelemetryConfig } = await import('../../packages/core/diagnostics/lib/config.js');

const NODE_BIN = '/usr/local/nvm/versions/node/v24.19.0/bin';
const AGENT_BROWSER = `${NODE_BIN}/agent-browser`;
const BASE = Date.UTC(2026, 10, 1, 12, 0, 0);
const ATTACHMENT = { id: 'attach-print', filename: '分页核对报告.txt', bytes: Buffer.from('第一行\n第二行\n', 'utf8') };

/** 一段中文正文，用来撑出多页。 */
const PARAGRAPH = '这一段用来确认打印视图里的中文分页与换行：正文、标题与标点都保持原样，'
  + '长句在行末自动换行，消息整块不跨页切断，长表格跨页时重复表头。';

/** 造三个完整回合的会话事件。 */
function shareEvents() {
  const events = [];
  let seq = 0;
  const push = (kind, data) => {
    events.push({ seq, kind, time: BASE + seq * 1_000, bytes: 128, payload: { seq, type: kind, time: BASE + seq * 1_000, data } });
    seq += 1;
  };
  push('session/title', { title: '公开页打印核对' });
  for (let turn = 1; turn <= 3; turn += 1) {
    push('turn/start', { turn });
    push('user/message', {
      role: 'user',
      source: { kind: 'user' },
      content: [
        { type: 'text', text: `第 ${turn} 回合的提问：${PARAGRAPH}` },
        ...(turn === 2
          ? [{
            type: 'file',
            attachment: {
              attachmentId: ATTACHMENT.id,
              filename: ATTACHMENT.filename,
              mimeType: 'text/plain; charset=utf-8',
              size: ATTACHMENT.bytes.byteLength,
            },
          }]
          : []),
      ],
    });
    for (let index = 0; index < 4; index += 1) {
      push('assistant/message', {
        message: { content: [{ type: 'text', text: `第 ${turn} 回合第 ${index + 1} 段回答：${PARAGRAPH}` }] },
      });
    }
    push('turn/end', { turn, reason: { kind: 'completed' } });
  }
  return events;
}

/** 等一个页面条件成立。 */
async function waitFor(cli, expression, message) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const { data } = await cli('eval', `Boolean(${expression})`);
    if (data.result === true) return;
    await new Promise((done) => setTimeout(done, 250));
  }
  assert.fail(`等待超时：${message}`);
}

/**
 * 连一个 CDP 会话，用来切换媒体类型。
 * @param {object} cli - 浏览器命令。
 * @param {string} pageUrl - 当前页面地址。
 * @returns {Promise<{setMedia: (media: string) => Promise<void>, close: () => Promise<void>}>}
 */
async function connectMedia(cli, pageUrl) {
  const endpoint = await cli('get', 'cdp-url');
  const socket = new WebSocket(endpoint.data.cdpUrl);
  await once(socket, 'open');
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const response = JSON.parse(data);
    const request = pending.get(response.id);
    if (request === undefined) return;
    pending.delete(response.id);
    if (response.error !== undefined) request.reject(new Error(`CDP ${request.method}：${JSON.stringify(response.error)}`));
    else request.resolve(response.result);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolveCall, rejectCall) => {
    const id = ++sequence;
    pending.set(id, { resolve: resolveCall, reject: rejectCall, method });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
  });
  const { targetInfos } = await send('Target.getTargets');
  const target = targetInfos.find((entry) => entry.type === 'page' && entry.url === pageUrl);
  assert.ok(target, '媒体会话必须属于当前页面');
  const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  return {
    async setMedia(media) {
      await send('Emulation.setEmulatedMedia', { media, features: [] }, sessionId);
    },
    async close() {
      await send('Target.detachFromTarget', { sessionId });
      socket.close();
      await once(socket, 'close');
    },
  };
}

/** 读 PDF 的页数与可选中的文本。 */
function readPdf(pdfPath) {
  const info = execFileSync('pdfinfo', [pdfPath], { encoding: 'utf8', timeout: 30_000 });
  const pages = Number.parseInt(/^Pages:\s+(\d+)$/mu.exec(info)?.[1] ?? '0', 10);
  const text = execFileSync('pdftotext', ['-layout', '-enc', 'UTF-8', pdfPath, '-'], { encoding: 'utf8', timeout: 30_000 });
  return { pages, text };
}

test('公开页打印视图、打印样式与分页规则', { timeout: 300_000 }, async (t) => {
  const home = allocateIndependentHome('wp35-print');
  const session = `wp35-print-${randomUUID().slice(0, 8)}`;
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

  const telemetry = createTelemetryClient({
    config: defaultTelemetryConfig({ surface: 'gateway' }),
    component: '@chatdsh/gateway',
    env: { CHATDSH_TELEMETRY: 'off' },
  });
  const root = join(home, 'root');
  mkdirSync(root, { recursive: true });
  const store = new GatewayStore(join(root, 'gateway', 'gateway.sqlite'));
  let domain;
  let media;
  let server;
  let opened = false;
  try {
    const replicas = new ReplicaStore(store.handle());
    store.upsertSession({
      sessionId: 'wp35-share',
      workspaceId: 'ws-wp35',
      deviceId: 'owner-device',
      cwd: '/workspace/chatdsh',
      kind: 'work',
      createdAt: BASE,
    });
    const appended = replicas.append('wp35-share', shareEvents());
    assert.ok(appended.written > 0);

    const attachmentRoot = join(home, 'attachments', ATTACHMENT.id);
    mkdirSync(attachmentRoot, { recursive: true });
    writeFileSync(join(attachmentRoot, ATTACHMENT.filename), ATTACHMENT.bytes);

    domain = await startShareDomain({
      home,
      store,
      replica: replicas,
      telemetry,
      authorize: () => ({ deviceId: 'owner-device' }),
    });
    const created = await domain.service.create({
      sessionId: 'wp35-share',
      range: { mode: 'session' },
      includeUserText: true,
      includeAssistantText: true,
      attachmentIds: [ATTACHMENT.id],
    });
    const token = created.shareId;
    assert.equal(typeof token, 'string', '建立分享返回令牌');
    assert.equal(created.path, `/s/${token}`);
    const access = domain.service.publicAccess(token);
    assert.equal(access.state, 'active');
    const page = access.page;
    assert.ok(page.messages.length >= 12, `公开页模型有 ${page.messages.length} 条消息`);

    const css = printStylesheet({ title: page.title, scope: page.scope, ...PUBLIC_PRINT_SCOPE });
    const printHtml = renderSharePrintPage(page, { timeDisplay: 'utc', timeZone: 'UTC' });
    assert.ok(printHtml.includes('第 2 回合第 1 段回答'), '打印视图含正文');

    const shellCss = printStylesheet({
      title: page.title,
      scope: page.scope,
      pageNumbers: false,
      codeWrapping: 'scroll',
      repeatTableHeader: false,
      excluded: ['navigation', 'composer', 'interaction-buttons'],
    });
    const hostPage = [
      '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
      '<title>宿主页面</title>',
      `<style>${css}</style></head><body>`,
      '<nav class="chdsh-app-nav">应用导航</nav>',
      '<div class="chdsh-composer"><textarea aria-label="输入"></textarea></div>',
      '<div class="chdsh-actions"><button type="button">发送</button></div>',
      '<main><article class="chdsh-print-msg"><header><span class="role">用户</span><time datetime="2026-11-01T12:00:00.000Z">2026-11-01 12:00:00</time></header><p>打印正文段落</p><pre>代码块</pre></article></main>',
      '<footer>页脚说明</footer>',
      '</body></html>',
    ].join('\n');
    const scrollPage = [
      '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
      '<title>代码换行</title>',
      `<style>${shellCss}</style></head><body>`,
      '<main><pre>不换行的代码</pre></main>',
      '</body></html>',
    ].join('\n');

    server = createServer((request, response) => {
      if (request.url === '/host') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(hostPage);
        return;
      }
      if (request.url === '/scroll') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(scrollPage);
        return;
      }
      if (request.url === '/print.html') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(printHtml);
        return;
      }
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('没有这个地址');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;

    await t.test('打印视图在浏览器里结构正确，没有交互元素', async () => {
      await cli('open', `${origin}/print.html`);
      opened = true;
      await waitFor(cli, 'document.querySelectorAll(".chdsh-print-msg").length > 0', '打印视图渲染');
      const facts = await evaluate('JSON.stringify({ title: document.querySelector("h1").textContent, messages: document.querySelectorAll(".chdsh-print-msg").length, roles: [...document.querySelectorAll(".chdsh-print-msg .role")].slice(0, 2).map((node) => node.textContent), times: document.querySelectorAll(".chdsh-print-msg time").length, tables: document.querySelectorAll("table").length, scripts: document.querySelectorAll("script").length, forms: document.querySelectorAll("form, input, textarea, button").length, footer: document.querySelector("footer")?.textContent ?? "", attachments: document.querySelectorAll("tbody tr").length })');
      const factsValue = JSON.parse(facts);
      assert.equal(factsValue.title, '公开页打印核对');
      assert.equal(factsValue.messages, page.messages.length, '每条公开消息一篇文章块');
      assert.deepEqual(factsValue.roles, ['用户', '助手']);
      assert.equal(factsValue.times, page.messages.length, '每条消息带时刻');
      assert.equal(factsValue.scripts, 0, '打印视图没有脚本');
      assert.equal(factsValue.forms, 0, '打印视图没有输入与按钮');
      assert.ok(factsValue.footer.includes('应用导航、输入区与交互按钮都不出现在纸上'));
      assert.equal(factsValue.attachments, 1, '附件清单逐项列出');
      const errors = await cli('errors');
      assert.deepEqual(errors.data.errors, []);
    });

    await t.test('@media print 的计算样式按分页规则生效', async () => {
      await cli('open', `${origin}/host`);
      await waitFor(cli, 'document.querySelector(".chdsh-print-msg") !== null', '宿主页面加载');
      media = await connectMedia(cli, `${origin}/host`);
      const screen = JSON.parse(await evaluate('JSON.stringify({ messageBreak: getComputedStyle(document.querySelector(".chdsh-print-msg")).breakInside, navDisplay: getComputedStyle(document.querySelector(".chdsh-app-nav")).display })'));
      assert.equal(screen.messageBreak, 'avoid', '屏幕样式里消息整块不跨页');
      assert.equal(screen.navDisplay, 'none', '应用导航在任何媒体下都不打印');
      await media.setMedia('print');
      const print = JSON.parse(await evaluate(`JSON.stringify({
        matches: matchMedia('print').matches,
        nav: getComputedStyle(document.querySelector('.chdsh-app-nav')).display,
        composer: getComputedStyle(document.querySelector('.chdsh-composer')).display,
        actions: getComputedStyle(document.querySelector('.chdsh-actions')).display,
        messageBreak: getComputedStyle(document.querySelector('.chdsh-print-msg')).breakInside,
        headerBreak: getComputedStyle(document.querySelector('.chdsh-print-msg > header')).breakAfter,
        paragraphOrphans: getComputedStyle(document.querySelector('.chdsh-print-msg p')).orphans,
        paragraphWidows: getComputedStyle(document.querySelector('.chdsh-print-msg p')).widows,
        codeWrap: getComputedStyle(document.querySelector('.chdsh-print-msg pre')).whiteSpace,
        footerMargin: getComputedStyle(document.querySelector('footer')).marginTop,
        bodyBackground: getComputedStyle(document.body).backgroundColor
      })`));
      assert.equal(print.matches, true, '打印媒体已经生效');
      assert.equal(print.nav, 'none', '打印时去掉应用导航');
      assert.equal(print.composer, 'none', '打印时去掉输入区');
      assert.equal(print.actions, 'none', '打印时去掉交互按钮');
      assert.equal(print.messageBreak, 'avoid', '打印时消息整块不跨页');
      assert.equal(print.headerBreak, 'avoid', '消息头部不落在页尾');
      assert.equal(print.paragraphOrphans, '2', '段落保留孤行下限');
      assert.equal(print.paragraphWidows, '2', '段落保留寡行下限');
      assert.equal(print.codeWrap, 'pre-wrap', '代码自动换行');
      assert.equal(print.bodyBackground, 'rgb(255, 255, 255)', '打印使用白底');
      assert.ok(print.footerMargin !== '0px', '页脚保留间距');
      await media.setMedia('screen');
      const back = await evaluate("matchMedia('print').matches");
      assert.equal(back, false, '媒体类型可以切回屏幕');
    });

    await t.test('分页规则与代码换行方式体现在样式里', async () => {
      const rules = JSON.parse(await evaluate(`JSON.stringify({
        page: [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]).filter((rule) => rule.cssText.startsWith('@page')).map((rule) => rule.cssText),
        removal: [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]).filter((rule) => rule.cssText.includes('chdsh-app-nav')).map((rule) => rule.cssText).join(' ')
      })`));
      assert.equal(rules.page.length, 1, '浏览器只解析出一个 @page 规则');
      assert.ok(css.includes('@page{size:A4'), '样式里规定 A4 纸张');
      assert.ok(css.includes('counter(pages)'), '页码带总页数');
      assert.ok(css.includes('counter(page)'), '页码带当前页');
      assert.ok(rules.removal.includes('.chdsh-app-nav'), '样式里去掉了应用导航');
      assert.ok(rules.removal.includes('.chdsh-composer'), '样式里去掉了输入区');
      assert.ok(rules.removal.includes('.chdsh-actions'), '样式里去掉了交互按钮');
      assert.ok(css.includes('@media print'), '样式里有打印媒体块');
      assert.ok(css.includes('thead{display:table-header-group}'), '长表格跨页重复表头');

      await cli('open', `${origin}/scroll`);
      await waitFor(cli, 'document.querySelector("pre") !== null', '代码换行页面加载');
      const scroll = JSON.parse(await evaluate(`JSON.stringify({
        whiteSpace: getComputedStyle(document.querySelector('pre')).whiteSpace,
        overflowX: getComputedStyle(document.querySelector('pre')).overflowX
      })`));
      assert.equal(scroll.whiteSpace, 'pre', '代码保持原样');
      assert.equal(scroll.overflowX, 'auto', '超出部分横向查看');
      assert.equal(shellCss.includes('counter(pages)'), false, '关闭页码之后没有页码规则');
      assert.ok(shellCss.includes('@page{size:A4;margin:18mm 16mm}'), '关闭页码之后只保留纸张与页边距');
      assert.ok(shellCss.includes('thead{display:table-row-group}'), '关闭重复表头之后按普通行组处理');
      assert.ok(shellCss.includes('pre{white-space:pre;overflow-x:auto'), '代码不换行的样式规则存在');
    });

    await t.test('打印视图输出多页 PDF，中文可选择', async () => {
      const profileDir = join(home, 'chrome-pdf');
      mkdirSync(profileDir, { recursive: true });
      const pdfPath = join(home, 'print', 'public.pdf');
      mkdirSync(resolve(pdfPath, '..'), { recursive: true });
      const htmlPath = join(home, 'print', 'public.html');
      writeFileSync(htmlPath, printHtml);
      execFileSync('/usr/bin/google-chrome', [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--no-first-run',
        `--user-data-dir=${profileDir}`,
        '--virtual-time-budget=10000',
        '--no-pdf-header-footer',
        `--print-to-pdf=${pdfPath}`,
        `file://${htmlPath}`,
      ], { env: { ...process.env, HOME: profileDir }, timeout: 120_000, stdio: 'ignore' });
      const { pages, text } = readPdf(pdfPath);
      assert.ok(pages >= 2, `公开页打印视图输出 ${pages} 页`);
      assert.ok(text.includes('公开页打印核对'), 'PDF 里能读出标题');
      assert.ok(text.includes('第 3 回合第 4 段回答'), 'PDF 里能读出末段中文');
      assert.ok(text.includes('分页与换行'), 'PDF 里中文字符可选');
    });
  } finally {
    if (media !== undefined) await media.close();
    if (opened) await cli('close');
    if (server !== undefined) {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
    if (domain !== undefined) await domain.close();
    await telemetry.shutdown();
    store.close();
    releaseIndependentHome(home);
  }
});
