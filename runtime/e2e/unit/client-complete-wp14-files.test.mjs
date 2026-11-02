// WP14 文件浏览与预览的验收。
//
// 目录列举与文件读取走宿主真实的 `WorkspaceFiles` 服务与真实本地文件系统后端，根目录是
// 独立数据根下的真实工作区；不存在、二进制、超大与无权限四类失败都来自真实文件与真实的
// 内核拒绝（权限一项由 uid 65534 的子进程读取 0600 文件产生）。界面模型的断言来自真实
// 列举结果，不构造假的目录数据。
//
// 运行：node --test e2e/unit/client-complete-wp14-files.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { ensureDeps } from '../lib/ensure-deps.mjs';

const execute = promisify(execFile);
const RUNTIME = resolve(import.meta.dirname, '../..');
ensureDeps(RUNTIME);
ensureBuilt();

const { Context } = await import('@deepseek-ai/cordis');
const { LocalFileSystem } = await import('@deepseek-ai/dsh-fs-local');
const { SandboxPolicyService } = await import('@deepseek-ai/dsh-sandbox-policy');
const { default: SessionStore } = await import('@deepseek-ai/dsh-session');
const { default: TypertRegistry } = await import('@deepseek-ai/dsh-typert-registry');
const { WorkspaceFiles } = await import('@deepseek-ai/dsh-api-workspace-files');
const {
  FileTreeModel,
  PREVIEW_BRANCHES,
  TEXT_PREVIEW_MAX_BYTES,
  classifyPreview,
  describeFileFailure,
  entryLabel,
  mimeTypeOfName,
  textLines,
} = await import('../../packages/client/workspace-tools/lib/files.js');
const { createWorkspaceGateway } = await import('../../packages/client/workspace-tools/lib/gateway.js');
const { createWorkspaceTelemetry } = await import('../../packages/client/workspace-tools/lib/telemetry.js');

/** 1×1 的 PNG，真实图片字节。 */
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * 构建本工作包的 TypeScript 产物。
 *
 * 工作区根配置由 WP39 维护，这里按包自己的 tsconfig 构建；多个测试文件同时运行时用
 * 目录锁串行，构建完成后后续文件直接使用产物。
 */
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

/** 等待插件树激活。 */
function settle(ms = 300) {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * 装配真实的工作区文件服务。
 * @param {string} root - 真实工作区目录。
 * @returns {Promise<{ files: object, scope: object }>} 服务与作用域。
 */
async function openFiles(root) {
  const ctx = new Context();
  ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: root });
  ctx.plugin(SessionStore);
  ctx.plugin(TypertRegistry);
  await settle();
  new LocalFileSystem(ctx, { cwd: root, diffBasisMaxBytes: 1024 * 1024 });
  const files = new WorkspaceFiles(ctx, {
    maxBytes: 2 * 1024 * 1024,
    maxFileBytes: 32 * 1024 * 1024,
    maxLines: 2000,
    maxEntries: 2000,
  });
  return { files, scope: { sessionId: 'session-wp14', workspaceRoot: root } };
}

/**
 * 把真实服务接到数据入口的传输层。
 * @param {{ files: object, scope: object }} stack - 真实服务。
 * @param {object[]} batches - 遥测批次收集。
 * @returns {object} 传输层。
 */
function transportOf(stack, batches) {
  return {
    async call(endpoint, args) {
      try {
        if (endpoint === 'workspaceFiles/list') {
          return { ok: true, value: await stack.files.list(stack.scope, args[0], new AbortController().signal) };
        }
        if (endpoint === 'workspaceFiles/read') {
          return { ok: true, value: await stack.files.read(stack.scope, args[0], args[1], new AbortController().signal) };
        }
        if (endpoint === 'workspaceFiles/readBytes') {
          return { ok: true, value: await stack.files.readBytes(stack.scope, args[0], args[1], new AbortController().signal) };
        }
        return { ok: false, error: { code: 'client/unavailable', message: endpoint } };
      } catch (error) {
        return { ok: false, error: { code: error.code ?? 'gateway/internal', message: error.message } };
      }
    },
  };
}

/** 建一个带真实文件的独立工作区。 */
function workspaceFixture(home) {
  const root = join(home, 'workspace');
  mkdirSync(join(root, 'src', 'nested'), { recursive: true });
  writeFileSync(join(root, 'note.txt'), '第一行\n第二行\n第三行\n');
  writeFileSync(join(root, 'README.md'), '# 说明\n');
  writeFileSync(join(root, 'src', 'main.ts'), 'export const 答案 = 42;\n');
  writeFileSync(join(root, 'src', 'nested', '.keep'), '');
  writeFileSync(join(root, 'image.png'), Buffer.from(PNG_1X1, 'base64'));
  writeFileSync(join(root, 'data.bin'), Buffer.from([0x00, 0x01, 0x02, 0x03]));
  writeFileSync(join(root, 'big.log'), '超长内容'.repeat(400_000));
  writeFileSync(join(root, 'locked.txt'), '机密内容\n');
  chmodSync(join(root, 'locked.txt'), 0o600);
  chmodSync(root, 0o755);
  return root;
}

test('真实目录列举与预览分支', { timeout: 120_000 }, async () => {
  const home = allocateIndependentHome('wp14-files');
  const root = workspaceFixture(home);
  const stack = await openFiles(root);
  const batches = [];
  const telemetry = createWorkspaceTelemetry({
    fetchImpl: async (url, init) => {
      batches.push({ url, signal: init.headers['x-chatdsh-signal'], body: JSON.parse(init.body) });
      return new Response(null, { status: 204 });
    },
    now: () => 1_700_000_000_000,
    randomHex: (bytes) => 'a'.repeat(bytes * 2),
  });
  const gateway = createWorkspaceGateway({ transport: transportOf(stack, batches), telemetry });

  const listing = await gateway.listDirectory('');
  const onDisk = readdirSync(root).filter((name) => name !== '.');
  assert.deepEqual(
    listing.entries.map((entry) => entry.name).sort(),
    onDisk.sort(),
    '目录列举与真实目录一致',
  );
  assert.equal(listing.entries.find((entry) => entry.name === 'src')?.type, 'directory');
  assert.equal(listing.truncated, false);

  const note = await gateway.readText('note.txt');
  assert.equal(note.lines, 3);
  assert.equal(note.eof, true);
  assert.deepEqual(textLines(note.text).map((line) => line.number), [1, 2, 3]);
  assert.equal(textLines(note.text)[1].text, '第二行');

  const image = await gateway.readBytes('image.png');
  const imageBytes = readFileSync(join(root, 'image.png'));
  assert.deepEqual(Buffer.from(image.base64, 'base64'), imageBytes, '图片字节与磁盘一致');
  assert.equal(classifyPreview({ name: 'image.png', mimeType: 'image/png', size: imageBytes.byteLength }).branch, 'image');

  const bigSize = statSync(join(root, 'big.log')).size;
  const big = classifyPreview({ name: 'big.log', size: bigSize });
  assert.equal(big.branch, 'too-large');
  assert.equal(big.limitBytes, TEXT_PREVIEW_MAX_BYTES);
  assert.match(big.notice, new RegExp(String(bigSize)));

  const binary = classifyPreview({ name: 'data.bin', size: 4 });
  assert.equal(binary.branch, 'binary');
  assert.ok(PREVIEW_BRANCHES.includes('binary'));

  const notText = await gateway.readText('data.bin').then(() => undefined, (error) => error);
  assert.equal(describeFileFailure(notText).code, 'file-binary', '二进制文件按真实回绝分类');

  const missing = await gateway.readText('missing.txt').then(() => undefined, (error) => error);
  assert.equal(missing.code, 'workspace-file/not-found');
  const missingFailure = describeFileFailure(missing);
  assert.equal(missingFailure.code, 'file-not-found');
  assert.equal(missingFailure.retryable, true);

  const spans = batches.filter((batch) => batch.signal === 'traces').map((batch) => batch.body);
  const readSpan = spans.find((payload) => payload.resourceSpans[0].scopeSpans[0].spans[0].attributes
    .some((item) => item.key === 'rpc.method' && item.value.stringValue === 'workspaceFiles/read'));
  assert.ok(readSpan, '读取动作写了远端调用 span');
  const failureEvents = batches
    .filter((batch) => batch.signal === 'logs')
    .map((batch) => batch.body.resourceLogs[0].scopeLogs[0].logRecords[0]);
  assert.ok(
    failureEvents.some((record) => record.body.stringValue === 'chatdsh.client.error'
      && record.attributes.some((item) => item.key === 'error.code' && item.value.stringValue === 'workspace-file/not-found')),
    '缺失文件的失败写了错误事件',
  );

  releaseIndependentHome(home);
});

test('无权限读取来自真实内核拒绝', { timeout: 120_000 }, async () => {
  const home = allocateIndependentHome('wp14-perm');
  const root = workspaceFixture(home);
  const script = join(home, 'denied.mjs');
  chmodSync(home, 0o755);
  writeFileSync(script, `
import { Context } from '@deepseek-ai/cordis';
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local';
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy';
import SessionStore from '@deepseek-ai/dsh-session';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import { WorkspaceFiles } from '@deepseek-ai/dsh-api-workspace-files';
const root = ${JSON.stringify(root)};
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
  const output = await execute(process.execPath, [script], {
    cwd: RUNTIME,
    uid: 65534,
    gid: 65534,
    encoding: 'utf8',
  });
  const result = JSON.parse(output.stdout.trim());
  assert.equal(result.ok, false, `没有权限的读取必须失败：${output.stdout}`);
  assert.equal(result.code, 'EACCES', `子进程的实际结果：${JSON.stringify(result)}`);
  const failure = describeFileFailure({ code: result.code });
  assert.equal(failure.code, 'file-permission-denied');
  assert.equal(failure.retryable, false);
  assert.match(failure.message, /权限/);
  releaseIndependentHome(home);
});

test('目录树模型与共享组件节点', { timeout: 60_000 }, async () => {
  const home = allocateIndependentHome('wp14-tree');
  const root = workspaceFixture(home);
  const stack = await openFiles(root);
  const gateway = createWorkspaceGateway({
    transport: transportOf(stack, []),
    telemetry: createWorkspaceTelemetry({ fetchImpl: async () => new Response(null, { status: 204 }) }),
  });
  const model = new FileTreeModel();
  model.setRoot(await gateway.listDirectory(''));
  const rootRows = model.visibleRows();
  assert.equal(rootRows[0].kind, 'directory', '目录排在文件之前');
  assert.ok(rootRows.some((row) => row.name === 'src' && row.kind === 'directory'));
  assert.ok(rootRows.some((row) => row.name === 'note.txt' && row.label.includes('字节')));

  model.beginLoad('src');
  model.finishLoad('src', await gateway.listDirectory('src'));
  const rows = model.visibleRows();
  const srcIndex = rows.findIndex((row) => row.path === 'src');
  assert.equal(rows[srcIndex].expanded, true);
  assert.equal(rows[srcIndex + 1].level, 2);
  assert.ok(rows.some((row) => row.path === 'src/main.ts'));

  const nodes = model.treeNodes();
  const srcNode = nodes.find((node) => node.id === 'src');
  assert.ok(Array.isArray(srcNode.children), '目录节点带 children');
  assert.equal(srcNode.children.some((child) => child.id === 'src/main.ts'), true);

  assert.equal(model.toggle('src'), false);
  assert.equal(model.visibleRows().some((row) => row.path === 'src/main.ts'), false, '折叠后子项不再可见');

  model.failLoad('src', { code: 'workspace-file/not-found' });
  assert.equal(model.failureOf('src').code, 'file-not-found');

  assert.equal(entryLabel({ name: 'solo', type: 'file', size: 12 }), 'solo，文件，12 字节');
  assert.equal(entryLabel({ name: '目录', type: 'directory' }), '目录，目录');
  assert.equal(mimeTypeOfName('a.PNG'), 'image/png');
  assert.equal(mimeTypeOfName('a.unknown'), '');
  assert.throws(() => model.select('不存在'), /目录树里没有/);
  releaseIndependentHome(home);
});
