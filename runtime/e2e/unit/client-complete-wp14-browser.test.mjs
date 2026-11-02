// WP14 真实浏览器验收：文件树键盘导航、文本与图片预览、真实文件上传、失败重试、发送拦截
// 与录音按钮可访问名称。
//
// 页面用 esbuild 打包真实界面源码（`packages/client/workspace-tools/src/panel.tsx` 与数据入口、
// 遥测模块），宿主侧是真实的工作区文件服务、附件服务与录音服务：目录列举与文件读取走真实
// 文件系统，附件内容写进独立数据根的真实文件与制品库，录音能力探测来自真实部署。浏览器是
// agent-browser 独立会话里的真实 Chrome，使用独立 HOME、TMPDIR 与 profile，不截图，断言全部
// 来自 DOM、可访问属性、焦点位置、宿主实况与真实文件。麦克风权限由真实 Chrome 权限策略拒绝，
// 无权限读取由 uid 65534 的子进程读取 0600 文件产生真实内核拒绝。
//
// 运行：node --test e2e/unit/client-complete-wp14-browser.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { ensureDeps } from '../lib/ensure-deps.mjs';

const execute = promisify(execFile);
const RUNTIME = resolve(import.meta.dirname, '../..');
const REPO = resolve(RUNTIME, '..');
const NODE_BIN = '/usr/local/nvm/versions/node/v24.19.0/bin';
ensureDeps(RUNTIME);
ensureDeps(resolve(REPO, 'dsh-adapter'));
ensureBuilt();

const { Context } = await import('@deepseek-ai/cordis');
const { default: Storage } = await import('@deepseek-ai/dsh-storage');
const json = await import('@deepseek-ai/dsh-storage-json');
const domainPlugin = await import('@deepseek-ai/dsh-storage-domain');
const { LocalFileSystem } = await import('@deepseek-ai/dsh-fs-local');
const { SandboxPolicyService } = await import('@deepseek-ai/dsh-sandbox-policy');
const { default: SessionStore } = await import('@deepseek-ai/dsh-session');
const { default: TypertRegistry } = await import('@deepseek-ai/dsh-typert-registry');
const { WorkspaceFiles } = await import('@deepseek-ai/dsh-api-workspace-files');
const { TypertRemoteService } = await import('../../../dsh-adapter/lib/index.js');
const { ChatdshArtifactsService } = await import('../../packages/host/artifacts/lib/index.js');
const { ChatdshAttachmentsService } = await import('../../packages/host/attachments/lib/index.js');
const { ChatdshVoiceService } = await import('../../packages/host/voice/lib/index.js');
const { UI_KIT_CSS } = await import('../../packages/core/ui-kit/lib/index.js');

/** 1×1 的 PNG，真实图片字节。 */
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** 构建本工作包的 TypeScript 产物，多个测试文件同时运行时串行。 */
function ensureBuilt() {
  const packages = ['packages/host/attachments', 'packages/host/voice', 'packages/client/workspace-tools'];
  const ready = () => packages.every((path) => existsSync(join(RUNTIME, path, 'lib/index.js')));
  if (ready()) return;
  const lock = join(RUNTIME, '.verify', 'wp14-build.lock');
  mkdirSync(join(RUNTIME, '.verify'), { recursive: true });
  const deadline = Date.now() + 240_000;
  for (;;) {
    if (ready()) return;
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > 300_000) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error('等待构建锁超时');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
    }
  }
  try {
    execFileSync(join(RUNTIME, 'node_modules/.bin/tsc'), ['-b', '--force', ...packages.map((path) => join(RUNTIME, path, 'tsconfig.json'))], {
      cwd: RUNTIME,
      stdio: 'inherit',
    });
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** 等待固定时间。 */
function settle(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * 装配宿主：真实工作区文件服务、附件服务与录音服务。
 * @param {{ dataRoot: string, workspace: string }} paths - 数据根与工作区。
 * @returns {Promise<object>} 服务集合。
 */
async function openStack({ dataRoot, workspace }) {
  const ctx = new Context();
  await ctx.plugin(Storage);
  await ctx.plugin(json, { root: join(dataRoot, 'storages') });
  await ctx.plugin(domainPlugin, { backend: 'json' });
  ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: workspace });
  ctx.plugin(SessionStore);
  ctx.plugin(TypertRegistry);
  await settle(200);
  new LocalFileSystem(ctx, { cwd: workspace, diffBasisMaxBytes: 1024 * 1024 });
  const files = new WorkspaceFiles(ctx, {
    maxBytes: 2 * 1024 * 1024,
    maxFileBytes: 32 * 1024 * 1024,
    maxLines: 2000,
    maxEntries: 2000,
  });
  const artifacts = new ChatdshArtifactsService(ctx);
  await artifacts[TypertRemoteService.init]();
  const attachments = new ChatdshAttachmentsService(ctx);
  await attachments[TypertRemoteService.init]();
  const voice = new ChatdshVoiceService(ctx);
  await voice[TypertRemoteService.init]();
  return { ctx, files, scope: { sessionId: 'session-wp14', workspaceRoot: workspace }, artifacts, attachments, voice };
}

/** 建真实工作区。 */
function workspaceFixture(root) {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'note.txt'), '第一行\n第二行\n第三行\n');
  writeFileSync(join(root, 'src', 'main.ts'), 'export const 答案 = 42;\n');
  writeFileSync(join(root, 'image.png'), Buffer.from(PNG_1X1, 'base64'));
  writeFileSync(join(root, 'big.log'), '超长内容'.repeat(400_000));
  writeFileSync(join(root, 'locked.txt'), '机密内容\n');
  chmodSync(join(root, 'locked.txt'), 0o600);
  chmodSync(root, 0o755);
}

/**
 * 起页面与宿主入口。
 * @param {object} options - 服务、脚本与控制开关。
 * @returns {Promise<object>} 页面信息。
 */
async function startPage({ stack, script, control, deniedReadOf }) {
  const batches = [];
  const handlers = {
    'workspaceFiles/list': ([path]) => stack.files.list(stack.scope, path, new AbortController().signal),
    'workspaceFiles/read': async ([path, range]) => {      if (path === 'locked.txt') {
        const denied = await deniedReadOf();
        const error = new Error(denied.message);
        error.code = denied.code;
        throw error;
      }
      return stack.files.read(stack.scope, path, range, new AbortController().signal);
    },
    'workspaceFiles/readBytes': async ([path, options]) => {
      const page = await stack.files.readBytes(stack.scope, path, options, new AbortController().signal);
      return { ...page, data: Buffer.from(page.data).toString('base64') };
    },
    'workspaceFiles/stat': ([path]) => stack.files.stat(stack.scope, path, new AbortController().signal),
    'chatdshAttachments/limits': () => stack.attachments.limits(),
    'chatdshAttachments/put': ([input]) => stack.attachments.put(input),
    'chatdshAttachments/read': ([id]) => stack.attachments.read(id),
    'chatdshAttachments/context': ([ids]) => stack.attachments.context(ids),
    'chatdshVoice/capability': () => stack.voice.capability(),
    'chatdshVoice/put': ([input]) => stack.voice.put(input),
    'chatdshVoice/transcribe': ([id, options]) => stack.voice.transcribe(id, options),
    'chatdshVoice/delete': ([id]) => stack.voice.remove(id),
  };
  const tokens = readFileSync(join(RUNTIME, 'packages/client/theme/src/client/styles/tokens.css'), 'utf8');
  const { WORKSPACE_CSS } = await import('../../packages/client/workspace-tools/lib/styles.js');
  const html = [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>工作区工具</title><style>',
    tokens,
    '\n',
    UI_KIT_CSS,
    '\n',
    WORKSPACE_CSS,
    '\nmain { padding: 16px; max-width: 860px; }\n</style></head><body>',
    '<main><textarea id="draft" aria-label="消息输入" rows="3"></textarea><div id="root"></div></main>',
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
      const endpoint = url.pathname.replace(/^\/api\//u, '');
      if (endpoint === 'chatdshAttachments/put' && control.failUploads) {
        request.socket.destroy();
        return;
      }
      const handler = handlers[endpoint];
      if (handler === undefined) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error: { code: 'client/unavailable', message: endpoint } }));
        return;
      }
      const body = raw === '' ? {} : JSON.parse(raw);
      let payload;
      try {
        payload = { ok: true, value: await handler(body.args ?? []) };
      } catch (error) {
        payload = { ok: false, error: { code: error.code ?? 'gateway/internal', message: error.message } };
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

test('真实 Chrome 完成文件导航、预览、上传、重试、发送拦截与录音权限', { timeout: 300_000 }, async (t) => {
  const home = allocateIndependentHome('wp14-browser');
  chmodSync(home, 0o755);
  const dataRoot = join(home, 'runtime');
  const workspace = join(home, 'workspace');
  mkdirSync(dataRoot, { recursive: true });
  workspaceFixture(workspace);
  const previousDSHHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dataRoot;

  const attachmentFile = join(home, '报告.md');
  writeFileSync(attachmentFile, '# 报告\n上传正文\n');
  const retryFile = join(home, '问题.txt');
  writeFileSync(retryFile, '待重试的正文\n');
  const oversizeFile = join(home, '超限.txt');
  writeFileSync(oversizeFile, Buffer.alloc(33 * 1024 * 1024, 0x61));

  const stack = await openStack({ dataRoot, workspace });

  /** 无权限读取由 uid 65534 的子进程产生真实内核拒绝。 */
  let deniedPromise;
  const deniedReadOf = () => {
    if (deniedPromise !== undefined) return deniedPromise;
    const script = join(home, 'denied.mjs');
    chmodSync(home, 0o755);
    writeFileSync(script, `
import { Context } from '@deepseek-ai/cordis';
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local';
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy';
import SessionStore from '@deepseek-ai/dsh-session';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import { WorkspaceFiles } from '@deepseek-ai/dsh-api-workspace-files';
const root = ${JSON.stringify(workspace)};
const ctx = new Context();
ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: root });
ctx.plugin(SessionStore);
ctx.plugin(TypertRegistry);
await new Promise((done) => setTimeout(done, 200));
new LocalFileSystem(ctx, { cwd: root, diffBasisMaxBytes: 1048576 });
const files = new WorkspaceFiles(ctx, { maxBytes: 2097152, maxFileBytes: 8388608, maxLines: 2000, maxEntries: 2000 });
try {
  await files.read({ sessionId: 'session-wp14', workspaceRoot: root }, 'locked.txt', {}, new AbortController().signal);
  console.log(JSON.stringify({ ok: true }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error.code, message: error.message }));
}
`);
    chmodSync(script, 0o644);
    deniedPromise = (async () => {
      const output = await execute(process.execPath, [script], { cwd: RUNTIME, uid: 65534, gid: 65534, encoding: 'utf8' });
      const parsed = JSON.parse(output.stdout.trim());
      assert.equal(parsed.ok, false, '子进程读取必须被拒绝');
      return parsed;
    })();
    return deniedPromise;
  };

  const ptyOutput = (await execute('script', ['-qec', `cd ${JSON.stringify(workspace)} && ls --color=always && printf '\\033[32m完成\\033[0m\\n'`, '/dev/null'], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  })).stdout;

  const control = { failUploads: false };
  const pageEntry = `
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspacePanel, TerminalView } from ${JSON.stringify(join(RUNTIME, 'packages/client/workspace-tools/src/panel.tsx'))};
import { createWorkspaceGateway } from ${JSON.stringify(join(RUNTIME, 'packages/client/workspace-tools/src/gateway.ts'))};
import { createWorkspaceTelemetry } from ${JSON.stringify(join(RUNTIME, 'packages/client/workspace-tools/src/telemetry.ts'))};
import { TerminalSession } from ${JSON.stringify(join(RUNTIME, 'packages/client/workspace-tools/src/terminal.ts'))};

const call = async (endpoint, args) => {
  const response = await fetch('/api/' + endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args }),
  });
  return response.json();
};
const draft = document.getElementById('draft');
const composerTarget = { insert(text) { draft.value = draft.value + text; } };
const gateway = createWorkspaceGateway({ transport: { call }, telemetry: createWorkspaceTelemetry() });
const session = new TerminalSession('terminal-browser', ${JSON.stringify(workspace)});
session.connected();
session.submit('ls --color=always');
session.append(${JSON.stringify(ptyOutput)});
const terminal = createElement(TerminalView, { session });
createRoot(document.getElementById('root')).render(createElement(WorkspacePanel, {
  gateway,
  sessionId: 'session-wp14',
  composerTarget,
  onInsertText: (text) => { draft.value = draft.value + text; },
  terminal,
}));
window.__wp14 = { ready: true };
`;
  const bundle = await build({
    stdin: { contents: pageEntry, resolveDir: RUNTIME, loader: 'tsx', sourcefile: 'wp14-page.tsx' },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    logLevel: 'warning',
  });
  const script = bundle.outputFiles[0].text;
  assert.ok(script.length > 20000, `页面脚本大小异常：${String(script.length)}`);

  const page = await startPage({ stack, script, control, deniedReadOf });
  const session = `wp14-${randomUUID().slice(0, 8)}`;
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
    const result = await execute(`${NODE_BIN}/agent-browser`, ['--session', session, '--json', ...args], { env, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    const response = JSON.parse(result.stdout);
    assert.equal(response.success, true, `agent-browser ${args[0]}：${result.stdout}`);
    return response;
  };
  const evaluate = async (expression) => (await cli('eval', expression)).data.result;
  let opened = false;
  try {
    await cli('open', page.origin);
    opened = true;
    await cli('wait', '--fn', 'window.__wp14 && window.__wp14.ready === true');
    await cli('wait', '[role="treeitem"]');

    await t.test('文件树按真实目录呈现，键盘可展开并聚焦子项', async () => {
      const labels = await evaluate('[...document.querySelectorAll("[role=\\"treeitem\\"]")].map((node) => node.getAttribute("aria-label"))');
      assert.ok(labels.some((label) => label.startsWith('src，目录')), `目录标签：${labels.join(' | ')}`);
      assert.ok(labels.some((label) => label.startsWith('note.txt，文件') && label.includes('字节')), '文件标签带类型与大小');

      await cli('focus', '[role="treeitem"]');
      assert.match(await evaluate('document.activeElement.getAttribute("aria-label")'), /^src/u);
      await cli('press', 'ArrowRight');
      await cli('wait', '--fn', 'document.querySelectorAll("[role=\\"treeitem\\"]").length > 1');
      assert.equal(await evaluate('document.querySelector("[role=\\"treeitem\\"]").getAttribute("aria-expanded")'), 'true');
      await cli('press', 'ArrowDown');
      assert.match(await evaluate('document.activeElement.getAttribute("aria-label")'), /main\.ts/u, '方向键把焦点移到子项');
      await cli('press', 'Enter');
      await cli('wait', '[data-line="1"]');
      assert.equal(await evaluate('document.querySelector("[data-line=\\"1\\"] .chdsh-wp14__linetext").textContent'), 'export const 答案 = 42;');
      const meta = await evaluate('document.querySelector("[data-preview-meta]").textContent');
      assert.match(meta, /只读/);
      assert.match(meta, /UTF-8/);
    });

    await t.test('文本、图片、超大、缺失与无权限预览来自真实文件', async () => {
      await cli('fill', '[data-field="path"]', 'note.txt');
      await cli('click', '[data-action="path-open"]');
      await cli('wait', '--fn', 'document.querySelectorAll("[data-line]").length === 3');
      assert.equal(await evaluate('document.querySelector("[data-line=\\"2\\"] .chdsh-wp14__linetext").textContent'), '第二行');

      await cli('fill', '[data-field="path"]', 'image.png');
      await cli('click', '[data-action="path-open"]');
      await cli('wait', '[data-image-preview]');
      const src = await evaluate('document.querySelector("[data-image-preview]").getAttribute("src")');
      assert.match(src, /^data:image\/png;base64,/u);
      const alt = await evaluate('document.querySelector("[data-image-preview]").getAttribute("alt")');
      assert.match(alt, /image\.png/u);

      await cli('fill', '[data-field="path"]', 'big.log');
      await cli('click', '[data-action="path-open"]');
      await cli('wait', '--fn', 'document.body.innerText.includes("超过预览上限")');
      const bigText = await evaluate('document.body.innerText');
      assert.match(bigText, /2097152/u, '超大提示给出真实上限');

      await cli('fill', '[data-field="path"]', 'missing.txt');
      await cli('click', '[data-action="path-open"]');
      await cli('wait', '--fn', 'document.body.innerText.includes("文件或目录不存在")');
      assert.match(await evaluate('document.body.innerText'), /file-not-found/u);

      await cli('fill', '[data-field="path"]', 'locked.txt');
      await cli('click', '[data-action="path-open"]');
      await cli('wait', '--fn', 'document.body.innerText.includes("没有读取这个路径的权限")', { timeout: 60000 });
      assert.match(await evaluate('document.body.innerText'), /file-permission-denied/u);
    });

    await t.test('真实文件上传、引用插入与宿主落盘', async () => {
      await cli('upload', 'input[data-field="attachment-input"]', attachmentFile);
      await cli('wait', '[data-attachment-state="uploaded"]');
      const draft = await evaluate('document.getElementById("draft").value');
      assert.match(draft, /\[附件 [0-9a-f-]+ 报告\.md\]/u);
      await cli('focus', '[data-attachment-id]');
      assert.equal(await evaluate('document.activeElement.hasAttribute("data-attachment-id")'), true, '附件列表条目可获得焦点');

      const attachmentDir = join(dataRoot, 'attachments');
      const ids = readFileSync(join(dataRoot, 'storages', 'attachments_store.json'), 'utf8');
      assert.match(ids, /报告\.md/u);
      const record = stack.attachments.list('session-wp14').find((item) => item.filename === '报告.md');
      assert.ok(record, '宿主记录存在');
      assert.deepEqual(
        readFileSync(join(attachmentDir, record.storageKey)),
        readFileSync(attachmentFile),
        '附件字节与源文件一致',
      );
      const artifact = await stack.artifacts.read(record.artifactId);
      assert.deepEqual(Buffer.from(artifact.base64, 'base64'), readFileSync(attachmentFile), '制品库内容一致');
    });

    await t.test('上传失败阻止发送，重试成功后恢复', async () => {
      control.failUploads = true;
      await cli('upload', 'input[data-field="attachment-input"]', retryFile);
      await cli('wait', '[data-attachment-state="failed"]');
      assert.equal(await evaluate('document.querySelector("[data-can-send]").getAttribute("data-can-send")'), 'false');
      assert.match(await evaluate('document.querySelector("[data-can-send]").textContent'), /还有附件没有上传完成/u);
      control.failUploads = false;
      await cli('click', '[data-action="attachment-retry"]');
      await cli('wait', '--fn', 'document.querySelectorAll("[data-attachment-state=\\"failed\\"]").length === 0');
      await cli('wait', '--fn', 'document.querySelector("[data-can-send]").getAttribute("data-can-send") === "true"');
      const states = await evaluate('[...document.querySelectorAll("[data-attachment-state]")].map((node) => node.getAttribute("data-attachment-state"))');
      assert.deepEqual(states, ['uploaded', 'uploaded'], '两个附件都已上传');
    });

    await t.test('超出大小上限的附件被真实限制拒绝', async () => {
      await cli('upload', 'input[data-field="attachment-input"]', oversizeFile);
      await cli('wait', '[data-rejected-code="attachment-too-large"]');
      const message = await evaluate('document.querySelector("[data-rejected-code=\\"attachment-too-large\\"]").textContent');
      assert.match(message, /33554432/u, '拒绝提示给出真实上限');
    });

    await t.test('录音按钮有可访问名称，权限拒绝与取消都有状态', async () => {
      const label = await evaluate('document.querySelector("[data-action=\\"recording-primary\\"]").getAttribute("aria-label")');
      assert.equal(label, '录音：开始录音');
      const describedBy = await evaluate('document.querySelector("[data-action=\\"recording-primary\\"]").getAttribute("aria-describedby")');
      assert.ok(describedBy, '录音按钮关联用途说明');
      assert.match(await evaluate('document.querySelector(".chdsh-wp14__purpose").textContent'), /语音识别接口/u);

      const cdp = (await cli('get', 'cdp-url')).data.cdpUrl;
      const socket = new WebSocket(cdp);
      await new Promise((done, fail) => {
        socket.onopen = done;
        socket.onerror = fail;
      });
      await new Promise((done) => {
        socket.onmessage = (event) => {
          const message = JSON.parse(event.data);
          if (message.id === 1) done();
        };
        socket.send(JSON.stringify({
          id: 1,
          method: 'Browser.setPermission',
          params: { permission: { name: 'microphone' }, setting: 'denied', origin: page.origin },
        }));
      });
      socket.close();

      await cli('click', '[data-action="recording-primary"]');
      await cli('wait', '--fn', 'document.body.innerText.includes("浏览器拒绝了麦克风权限") || document.body.innerText.includes("没有可用的麦克风输入")', { timeout: 30000 });
      const state = await evaluate('document.querySelector("[data-recording-state]").textContent');
      assert.equal(state, '麦克风权限被拒绝');
      const deniedText = await evaluate('document.body.innerText');
      assert.match(deniedText, /当前部署没有转写能力/u);
      assert.match(deniedText, /speech-to-text/u);

      await cli('click', '[data-action="recording-cancel"]');
      await cli('wait', '--fn', 'document.body.innerText.includes("录音已取消，麦克风与定时器已经释放")');
    });

    await t.test('终端命令与输出分开，读屏文本可读', async () => {
      const kinds = await evaluate('[...document.querySelectorAll("[data-terminal-kind]")].map((node) => node.getAttribute("data-terminal-kind"))');
      assert.equal(kinds.filter((kind) => kind === 'command').length, 1, '命令单独成项');
      assert.ok(kinds.filter((kind) => kind === 'output').length >= 2, '输出单独成项');
      const terminalText = await evaluate('document.querySelector("[data-terminal-entries]").textContent');
      assert.equal(terminalText.includes('\u001B'), false, '转义序列不出现在展示里');
      assert.match(terminalText, /note\.txt/u);
      const announcements = await evaluate('[...document.querySelectorAll(".chdsh-wp14__sr")].map((node) => node.textContent)');
      assert.ok(announcements.some((text) => text.startsWith('命令：ls --color=always')), '命令的读屏文本');
      assert.ok(announcements.some((text) => text.startsWith('输出：')), '输出的读屏文本');
    });

    const telemetryBatches = page.batches;
    const spans = telemetryBatches.filter((batch) => batch.signal === 'traces').map((batch) => batch.body);
    assert.ok(
      spans.some((payload) => payload.resourceSpans[0].scopeSpans[0].spans[0].name === 'chatdsh.client.remote.call'
        && payload.resourceSpans[0].scopeSpans[0].spans[0].attributes.some((item) => item.key === 'rpc.method' && item.value.stringValue === 'workspaceFiles/read')),
      '浏览器侧读文件写了远端调用 span',
    );
    assert.ok(
      telemetryBatches.some((batch) => batch.signal === 'logs'
        && batch.body.resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue === 'chatdsh.client.error'),
      '失败分支写了错误事件',
    );
  } finally {
    if (opened) await execute(`${NODE_BIN}/agent-browser`, ['--session', session, '--json', 'close'], { env, timeout: 30_000 }).catch(() => undefined);
    await page.close();
    if (previousDSHHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousDSHHome;
    releaseIndependentHome(home);
  }
});
