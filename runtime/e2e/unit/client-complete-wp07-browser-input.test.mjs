// WP07 的真实浏览器键盘与输入法验收：Enter/Shift+Enter/Escape、真实输入法组合、焦点管理、
// 类型触发面板、引用失效与草稿恢复。
//
// 页面用 esbuild 打包包内已编译的真实模块与真实 React 渲染入口；输入法组合通过 Chrome
// DevTools 协议的 `Input.imeSetComposition` 与 `Input.insertText` 真实触发，键盘按键走
// agent-browser 的真实按键注入。断言来自真实 DOM、真实事件日志与真实控制器状态。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { build } from 'esbuild';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';

const execute = promisify(execFile);
const NODE_BIN = '/usr/local/nvm/versions/node/v24.19.0/bin';
const AGENT_BROWSER = `${NODE_BIN}/agent-browser`;
const RUNTIME_ROOT = new URL('../..', import.meta.url).pathname;
const SSE_BREAK = String.fromCharCode(10, 10);

/** 页面入口：挂载席位，记录输入法事件与错误。 */
const PAGE_ENTRY = `
import { createRoot } from 'react-dom/client';
import { createSeatRuntime } from './packages/client/conversation/lib/index.js';

const errors = [];
window.__errors = errors;
window.addEventListener('error', (event) => errors.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)));
const log = [];
window.__log = log;

const runtime = createSeatRuntime(document.querySelector('#seat'), {
  sessionId: 'session-wp07',
  deviceId: 'device-alpha',
  deviceName: '本机设备',
  source: 'local',
  title: '输入验收',
  storage: window.localStorage,
  clientId: 'client-wp07',
  windowId: 'window-wp07',
  endpoints: { streamUrl: '/session-events', sendUrl: '/send', stopUrl: '/stop', queryUrl: '/query', feedbackUrl: '/feedback' },
  candidates: [
    { id: 'src/index.ts', kind: 'file', label: 'index.ts', group: '文件', origin: 'local', description: '入口文件' },
    { id: 'session-b', kind: 'session', label: '会话乙', group: '会话', origin: 'remote' },
    { id: 'memory-1', kind: 'memory', label: '偏好记忆', group: '记忆', origin: 'local' },
  ],
  runtimeCommands: [
    { id: 'compact', name: '压缩会话', group: '运行时', description: '压缩当前会话', scope: 'session', enabled: true },
  ],
});

const root = createRoot(document.querySelector('#seat'));
root.render(runtime.element());
window.__runtime = runtime;

const attach = () => {
  const input = document.querySelector('textarea');
  if (input === null) {
    setTimeout(attach, 20);
    return;
  }
  for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'input', 'keydown']) {
    input.addEventListener(type, (event) => {
      log.push({
        type,
        data: event.data === undefined ? null : event.data,
        isComposing: event.isComposing === undefined ? null : event.isComposing,
        key: event.key === undefined ? null : event.key,
      });
    });
  }
  window.__ready = true;
};
attach();
`;

/** 页面外壳。 */
const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>WP07 输入验收</title></head>
<body><main id="seat"></main><script type="module" src="/app.js"></script></body></html>`;

/** 起一个真实 HTTP 服务。 */
async function startServer(bundle) {
  const sends = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://local.invalid');
    if (url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(PAGE);
      return;
    }
    if (url.pathname === '/app.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      response.end(bundle);
      return;
    }
    if (url.pathname === '/session-events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
      response.write(`data: ${JSON.stringify({ type: 'snapshot', cursor: 0, hasMore: false, records: [] })}${SSE_BREAK}`);
      return;
    }
    if (url.pathname === '/send' && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      sends.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ accepted: true, seq: sends.length }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"accepted":true}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    sends,
    port: server.address().port,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * 连上页面目标的 DevTools 协议，用来真实触发输入法组合。
 * @param cli - agent-browser 调用。
 * @returns 发送协议命令的函数与关闭函数。
 */
async function connectCdp(cli) {
  const cdp = await cli('get', 'cdp-url');
  const tabs = await cli('tab', 'list', '--json');
  const list = tabs.data.tabs ?? [];
  const targetId = (list.find((tab) => tab.active === true) ?? list[0]).targetId;
  const pageUrl = String(cdp.data.cdpUrl).replace('/devtools/browser/', '/devtools/page/').replace(/[^/]+$/, targetId);
  const socket = new WebSocket(pageUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let nextId = 0;
  const send = (method, params) => new Promise((resolve) => {
    const id = (nextId += 1);
    const onMessage = (event) => {
      const payload = JSON.parse(event.data);
      if (payload.id !== id) return;
      socket.removeEventListener('message', onMessage);
      resolve(payload);
    };
    socket.addEventListener('message', onMessage);
    socket.send(JSON.stringify({ id, method, params }));
  });
  return { send, close: () => socket.close() };
}

test('真实 Chrome：快捷键、输入法组合、焦点、类型触发与草稿恢复', { timeout: 300000 }, async () => {
  const home = allocateIndependentHome('wp07-input');
  const session = `wp07-input-${randomUUID().slice(0, 8)}`;
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
    const result = await execute(AGENT_BROWSER, ['--session', session, '--json', ...args], {
      env,
      timeout: 60000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const response = JSON.parse(result.stdout);
    assert.equal(response.success, true, `agent-browser ${args[0]}：${result.stdout}`);
    return response;
  };
  const bundle = await build({
    stdin: { contents: PAGE_ENTRY, resolveDir: RUNTIME_ROOT, loader: 'js' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2023',
    write: false,
    logLevel: 'silent',
  });
  const server = await startServer(bundle.outputFiles[0].text);
  const origin = `http://127.0.0.1:${server.port}`;
  const evalJs = async (expression) => (await cli('eval', expression)).data.result;
  const waitFor = (expression) => cli('wait', '--fn', expression);
  const inputValue = () => evalJs('document.querySelector("textarea").value');
  const INPUT = 'textarea.chdsh-conv__input';

  let opened = false;
  let cdp;
  try {
    await cli('open', `${origin}/`);
    opened = true;
    await waitFor('window.__ready === true');
    cdp = await connectCdp(cli);
    await cli('click', INPUT);

    // 一：Shift+Enter 换行不发送，Enter 发送。
    await cli('type', INPUT, '第一行');
    await cli('press', 'Shift+Enter');
    await cli('type', INPUT, '第二行');
    assert.equal(await inputValue(), '第一行' + String.fromCharCode(10) + '第二行');
    assert.equal(server.sends.length, 0, '换行不发送');
    await cli('press', 'Enter');
    await waitFor('document.body.innerText.includes("已发送")');
    assert.equal(server.sends.length, 1);
    assert.equal(server.sends[0].content[0].text, '第一行' + String.fromCharCode(10) + '第二行');
    assert.equal(await inputValue(), '', '发送成功之后清空输入区');

    // 二：真实输入法组合。组合期间不提交，组合结束才更新正文。
    await cli('click', INPUT);
    await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
    await waitFor('document.querySelector("textarea").dataset.composing === "true"');
    assert.equal(
      await evalJs('window.__runtime.controller().state().composer.text'),
      '',
      '组合中的文本不进入正文'
    );
    assert.equal(
      await evalJs('window.__runtime.controller().state().composer.compositionBuffer'),
      'ni'
    );
    await cli('press', 'Enter');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(server.sends.length, 1, '组合期间 Enter 不发送');
    assert.equal(await inputValue(), 'ni', '组合期间不插入换行');
    await cdp.send('Input.insertText', { text: '你好' });
    await waitFor('document.querySelector("textarea").dataset.composing === "false"');
    assert.equal(await inputValue(), '你好', '组合结束之后写入正文');
    assert.equal(await evalJs('window.__runtime.controller().state().composer.text'), '你好');
    await cli('press', 'Enter');
    await waitFor('document.body.innerText.includes("已发送")');
    assert.equal(server.sends.length, 2);
    assert.equal(server.sends[1].content[0].text, '你好');

    // 三：焦点管理。Ctrl+K 打开命令面板，焦点进入面板；Tab 留在面板内；Escape 关闭并把焦点还给输入区。
    await cli('press', 'Control+k');
    await waitFor('document.querySelector("[data-palette]") !== null');
    assert.equal(await evalJs('document.activeElement.getAttribute("role")'), 'combobox');
    await cli('press', 'Tab');
    assert.equal(
      await evalJs('document.querySelector("[data-palette]").contains(document.activeElement)'),
      true,
      'Tab 把焦点约束在面板内'
    );
    await cli('press', 'Escape');
    await waitFor('document.querySelector("[data-palette]") === null');
    assert.equal(await evalJs('document.activeElement.tagName'), 'TEXTAREA', '关闭面板后焦点回到输入区');

    // 四：类型触发。斜杠列出运行时命令，回车插入命令；@ 列出引用对象，回车插入引用标记。
    await cli('click', INPUT);
    await cli('type', INPUT, '/');
    await waitFor('document.querySelector("[data-trigger-panel=\\"command\\"]") !== null');
    assert.equal(await evalJs('document.body.innerText.includes("压缩会话")'), true);
    await cli('press', 'Enter');
    assert.equal(await inputValue(), '/压缩会话 ');
    assert.equal(await evalJs('document.querySelector("[data-trigger-panel]") === null'), true);

    await cli('fill', INPUT, '');
    await cli('click', INPUT);
    await cli('type', INPUT, '@');
    await waitFor('document.querySelector("[data-trigger-panel=\\"reference\\"]") !== null');
    assert.equal(await evalJs('document.body.innerText.includes("文件")'), true);
    assert.equal(await evalJs('document.body.innerText.includes("记忆")'), true);
    await cli('press', 'Enter');
    await waitFor('document.querySelector("[data-reference-kind=\\"file\\"]") !== null');
    assert.equal(await inputValue(), '@index.ts');

    // 五：引用失效保留对象并阻止发送，移除之后恢复可发送。
    await evalJs('window.__runtime.controller().refreshReferences([{ kind: "session", id: "session-b" }])');
    await waitFor('document.querySelector("[data-reference-available=\\"false\\"]") !== null');
    assert.equal(await evalJs('document.querySelector("[data-reference-invalid]").textContent.includes("失效")'), true);
    assert.equal(await evalJs('document.querySelector("[data-action=\\"send\\"]").disabled'), true, '引用失效时阻止发送');
    assert.equal(await evalJs('document.body.innerText.includes("引用失效")'), true);
    await cli('find', 'text', '移除', 'click');
    await waitFor('document.querySelector("[data-reference-kind=\\"file\\"]") === null');

    // 六：草稿恢复。输入内容之后刷新页面，内容从本地草稿恢复。
    await cli('fill', INPUT, '草稿内容');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(
      await evalJs('window.localStorage.getItem("chatdsh-conversation.draft.v1:client-wp07:window-wp07:device-alpha:session-wp07") !== null'),
      true,
      '草稿写进本地存储'
    );
    await cli('reload');
    await waitFor('window.__ready === true');
    await waitFor('document.querySelector("textarea").value === "草稿内容"');
    assert.equal(await inputValue(), '草稿内容', '刷新之后草稿恢复');

    // 七：无障碍语义。消息列表是 log，实时播报是 polite 区域。
    assert.equal(await evalJs('document.querySelector("[role=\\"log\\"]").getAttribute("aria-live")'), 'off');
    assert.equal(await evalJs('document.querySelector("[data-announcer]").getAttribute("aria-live")'), 'polite');
    assert.deepEqual(JSON.parse(await evalJs('JSON.stringify(window.__errors)')), []);
  } finally {
    cdp?.close();
    if (opened) await cli('close');
    await server.close();
    releaseIndependentHome(home);
  }
});

