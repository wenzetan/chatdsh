// WP14 附件的验收：宿主真实落盘与制品库登记、实例重建后读取、客户端校验与发送拦截。
//
// 宿主侧装配真实的结构化存储、JSON 后端、存储域、真实制品服务与真实附件服务，内容写进
// 独立数据根的真实文件系统；实例重建用同一数据根上的新上下文与新服务对象读取同一份字节。
// 客户端校验使用宿主回报的真实上限，插入引用交给真实的会话输入区实现。宿主遥测用真实
// 遥测客户端接本地 OTLP 接收端，断言 span、指标与内容边界。
//
// 运行：node --test e2e/unit/client-complete-wp14-attachments.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { ensureDeps } from '../lib/ensure-deps.mjs';

const RUNTIME = resolve(import.meta.dirname, '../..');
const REPO = resolve(RUNTIME, '..');
ensureDeps(RUNTIME);
ensureDeps(resolve(REPO, 'dsh-adapter'));
ensureBuilt();

const { Context } = await import('@deepseek-ai/cordis');
const { default: Storage } = await import('@deepseek-ai/dsh-storage');
const json = await import('@deepseek-ai/dsh-storage-json');
const domainPlugin = await import('@deepseek-ai/dsh-storage-domain');
const { TypertRemoteService } = await import('../../../dsh-adapter/lib/index.js');
const { ChatdshArtifactsService } = await import('../../packages/host/artifacts/lib/index.js');
const { ChatdshAttachmentsService } = await import('../../packages/host/attachments/lib/index.js');
const { AttachmentUploader, attachmentToken } = await import('../../packages/client/workspace-tools/lib/attachments.js');
const { Composer } = await import('../../packages/client/conversation/lib/index.js');
const { createTelemetryClient } = await import('../../packages/core/diagnostics/lib/client.js');
const { defaultTelemetryConfig } = await import('../../packages/core/diagnostics/lib/config.js');

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

/** 等待插件树激活。 */
function settle(ms = 200) {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * 装配宿主：真实存储域、制品服务与附件服务。
 * @param {string} root - 独立数据根。
 * @returns {Promise<object>} 上下文与两个服务。
 */
async function openHost(root) {
  const ctx = new Context();
  await ctx.plugin(Storage);
  await ctx.plugin(json, { root: join(root, 'storages') });
  await ctx.plugin(domainPlugin, { backend: 'json' });
  const artifacts = new ChatdshArtifactsService(ctx);
  await artifacts[TypertRemoteService.init]();
  const attachments = new ChatdshAttachmentsService(ctx);
  await attachments[TypertRemoteService.init]();
  return { ctx, artifacts, attachments };
}

/** 起一个接收 OTLP/HTTP JSON 的本地端点。 */
async function startOtlpReceiver() {
  const records = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      records.push({ path: request.url, body: Buffer.concat(chunks).toString('utf8') });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    records,
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}

test('附件写入真实文件与制品库，实例重建后仍可读取', { timeout: 120_000 }, async () => {
  const home = allocateIndependentHome('wp14-attach');
  const previousHome = process.env.DSH_HOME;
  const root = join(home, 'runtime');
  mkdirSync(root, { recursive: true });
  process.env.DSH_HOME = root;
  const receiver = await startOtlpReceiver();
  let telemetry;
  try {
    telemetry = createTelemetryClient({
      config: defaultTelemetryConfig({
        endpoint: receiver.endpoint,
        surface: 'runtime',
        exportIntervalMs: 2000,
        exportIntervalMsMetrics: 3000,
        exportTimeoutMs: 500,
      }),
      component: '@chatdsh/host-attachments',
      env: { CHATDSH_TELEMETRY: 'on' },
    });
    const host = await openHost(root);
    host.ctx.provide('chatdshTelemetry');
    host.ctx.set('chatdshTelemetry', telemetry);
    const limits = host.attachments.limits();
    assert.equal(limits.maxBytes, 32 * 1024 * 1024);

    const content = '# 需求\n附件正文\n';
    const record = await host.attachments.put({
      sessionId: 'session-wp14',
      filename: '需求.md',
      mimeType: 'text/markdown; charset=utf-8',
      content,
    });
    assert.equal(record.filename, '需求.md');
    assert.equal(record.mimeType, 'text/markdown');
    assert.equal(record.size, Buffer.byteLength(content, 'utf8'));
    assert.equal(record.artifactVersion, 1);

    const stored = join(root, 'attachments', record.id, '需求.md');
    assert.equal(existsSync(stored), true, '内容写在真实文件系统');
    assert.deepEqual(readFileSync(stored, 'utf8'), content);

    const read = await host.attachments.read(record.id);
    assert.equal(Buffer.from(read.base64, 'base64').toString('utf8'), content);
    assert.equal(read.contentType, 'text/markdown');

    const integrity = await host.attachments.verify(record.id);
    assert.deepEqual(integrity, {
      attachmentId: record.id,
      declaredBytes: record.size,
      contentBytes: record.size,
      digestMatches: true,
      filePresent: true,
    });

    const artifacts = host.artifacts.list('session-wp14');
    assert.equal(artifacts.length, 1, '同一份内容登记到制品库');
    assert.equal(artifacts[0].id, record.artifactId);
    assert.equal(artifacts[0].title, '需求.md');
    const artifactContent = await host.artifacts.read(record.artifactId);
    assert.equal(Buffer.from(artifactContent.base64, 'base64').toString('utf8'), content);

    const context = host.attachments.context([record.id]);
    assert.equal(context.entries.length, 1);
    assert.equal(context.entries[0].attachmentId, record.id);
    assert.match(context.entries[0].marker, /需求\.md/u);
    assert.equal(context.text, context.entries[0].marker);

    const tooLarge = await host.attachments.put({
      sessionId: 'session-wp14',
      filename: 'big.txt',
      mimeType: 'text/plain',
      content: Buffer.alloc(limits.maxBytes + 1, 0x61),
    }).then(() => undefined, (error) => error);
    assert.equal(tooLarge.code, 'attachment-too-large');
    assert.match(tooLarge.message, new RegExp(String(limits.maxBytes)));

    const badType = await host.attachments.put({
      sessionId: 'session-wp14',
      filename: 'setup.exe',
      mimeType: 'application/x-msdownload',
      content: 'x',
    }).then(() => undefined, (error) => error);
    assert.equal(badType.code, 'attachment-type-rejected');

    const badName = await host.attachments.put({
      sessionId: 'session-wp14',
      filename: '../越界.txt',
      mimeType: 'text/plain',
      content: 'x',
    }).then(() => undefined, (error) => error);
    assert.equal(badName.code, 'attachment-name-invalid');

    await telemetry.flush(5000);
    const traceBodies = receiver.records.filter((item) => item.path.includes('/v1/traces')).map((item) => item.body);
    assert.ok(
      traceBodies.some((body) => body.includes('chatdsh.runtime.remote.call')
        && body.includes('chatdshAttachments/put')
        && body.includes('"outcome"')),
      `附件写入写了远端调用 span：${receiver.records.map((item) => item.path).join(' ')}`,
    );
    const metricBodies = receiver.records.filter((item) => item.path.includes('/v1/metrics')).map((item) => item.body);
    assert.ok(metricBodies.some((body) => body.includes('chatdsh_remote_calls_total')), '计数指标已导出');
    assert.ok(metricBodies.some((body) => body.includes('error_code') && body.includes('attachment-too-large')), '失败分支按错误码计数');
    const allPayloads = receiver.records.map((item) => item.body).join('\n');
    assert.equal(allPayloads.includes('附件正文'), false, '遥测里没有文件内容');

    const rebuilt = await openHost(root);
    const again = await rebuilt.attachments.read(record.id);
    assert.deepEqual(Buffer.from(again.base64, 'base64').toString('utf8'), content);
    assert.equal(rebuilt.attachments.list('session-wp14').length, 1);
    const rebuiltArtifact = await rebuilt.artifacts.read(record.artifactId);
    assert.equal(Buffer.from(rebuiltArtifact.base64, 'base64').toString('utf8'), content);
  } finally {
    if (telemetry !== undefined) await telemetry.shutdown();
    await receiver.close();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    releaseIndependentHome(home);
  }
});

test('客户端按真实上限校验、重试、取消并阻拦发送', { timeout: 60_000 }, async () => {
  const home = allocateIndependentHome('wp14-uploader');
  const previousHome = process.env.DSH_HOME;
  const root = join(home, 'runtime');
  mkdirSync(root, { recursive: true });
  process.env.DSH_HOME = root;
  try {
    const host = await openHost(root);
    const limits = host.attachments.limits();
    const uploader = new AttachmentUploader(limits);
    const selection = uploader.select([
      { name: '说明.md', type: 'text/markdown', size: 12 },
      { name: '安装包.exe', type: 'application/x-msdownload', size: 12 },
      { name: '超限.txt', type: 'text/plain', size: limits.maxBytes + 1 },
    ]);
    assert.equal(selection.accepted.length, 1);
    assert.equal(selection.accepted[0].state, 'queued');
    assert.deepEqual(selection.rejected.map((item) => item.code), ['attachment-type-rejected', 'attachment-too-large']);
    assert.match(selection.rejected[1].message, new RegExp(String(limits.maxBytes)), '超限提示给出真实上限');

    const slot = selection.accepted[0];
    uploader.begin(slot.id);
    assert.equal(uploader.sendCheck().canSend, false, '上传中阻止发送');
    assert.equal(uploader.sendCheck().blockers[0], 'attachment-pending');

    const record = await host.attachments.put({
      sessionId: 'session-wp14',
      filename: slot.filename,
      mimeType: slot.mimeType,
      content: 'x'.repeat(slot.size),
    });
    uploader.complete(slot.id, record);
    assert.equal(uploader.sendCheck().canSend, true);

    const composer = new Composer();
    const token = uploader.insertReference(composer, slot.id);
    assert.equal(token, attachmentToken({ remoteId: record.id, id: slot.id, filename: '说明.md' }));
    assert.equal(composer.value.includes('说明.md'), true, '引用插入到真实输入区');
    assert.equal(uploader.insertedCount, 1);
    assert.equal(uploader.contextPreview()[0].attachmentId, record.id);

    const failing = uploader.select([{ name: '失败的.png', type: 'image/png', size: 8 }]).accepted[0];
    uploader.begin(failing.id);
    uploader.fail(failing.id, { code: 'attachment-too-large' });
    assert.equal(uploader.sendCheck().canSend, false, '失败附件阻止发送');
    assert.equal(uploader.slotOf(failing.id).attempts, 1);
    uploader.retry(failing.id);
    assert.equal(uploader.slotOf(failing.id).state, 'uploading');
    assert.equal(uploader.slotOf(failing.id).attempts, 2);
    uploader.cancel(failing.id);
    assert.equal(uploader.slotOf(failing.id).state, 'cancelled');
    assert.equal(uploader.sendCheck().canSend, true, '取消后的附件不再阻拦发送');
    assert.throws(() => uploader.insertReference(composer, failing.id), /还没有上传完成/);
    uploader.remove(failing.id);
    assert.equal(uploader.state.length, 1);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    releaseIndependentHome(home);
  }
});

test('宿主拒绝未挂载制品库的写入', { timeout: 60_000 }, async () => {
  const home = allocateIndependentHome('wp14-noartifact');
  const previousHome = process.env.DSH_HOME;
  const root = join(home, 'runtime');
  mkdirSync(root, { recursive: true });
  process.env.DSH_HOME = root;
  try {
    const ctx = new Context();
    await ctx.plugin(Storage);
    await ctx.plugin(json, { root: join(root, 'storages') });
    await ctx.plugin(domainPlugin, { backend: 'json' });
    const attachments = new ChatdshAttachmentsService(ctx);
    await attachments[TypertRemoteService.init]();
    const failure = await attachments.put({
      sessionId: 'session-wp14',
      filename: '孤立.txt',
      mimeType: 'text/plain',
      content: '正文',
    }).then(() => undefined, (error) => error);
    assert.equal(failure.code, 'attachment-store-unavailable');
    assert.equal(existsSync(join(root, 'attachments')), false, '没有制品库时不留下孤立内容');
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    releaseIndependentHome(home);
  }
});
