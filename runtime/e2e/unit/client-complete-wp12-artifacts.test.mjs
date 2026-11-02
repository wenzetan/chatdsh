// WP12 制品面板的数据层验收：真实制品服务、真实 HTTP 传输、真实多版本字节。
//
// 每个用例在 runtime/.run 下分配独立数据根，挂载真实的存储中枢、JSON 后端与存储域，制品内容
// 真实写进数据根的 `artifacts/` 下。客户端侧直接使用包内编译产物（筛选、预览判定、下载、
// 数据入口与遥测），传输层走本机 HTTP 到真实服务实例，不替换任何宿主依赖。
//
// 覆盖：两版写入后每版字节与磁盘文件逐字节一致、版本列表的当前版本标记、按会话/类型/名称
// 过滤、受限预览标记的客户端复核、HTML/SVG/图片/PDF/二进制/超限/损坏的判定分支、
// 删除范围的版本数与占用空间、删除全部版本后的磁盘状态、离线与内容缺失的错误码、遥测三路信号。
//
// 运行：node --test e2e/unit/client-complete-wp12-artifacts.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ensureDeps } from '../lib/ensure-deps.mjs';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';

const REPO = resolve(import.meta.dirname, '../../..');
const RUNTIME = resolve(import.meta.dirname, '../..');
ensureDeps(RUNTIME);
ensureDeps(resolve(REPO, 'dsh-adapter'));

const { Context } = await import('@deepseek-ai/cordis');
const { default: Storage } = await import('@deepseek-ai/dsh-storage');
const json = await import('@deepseek-ai/dsh-storage-json');
const domainPlugin = await import('@deepseek-ai/dsh-storage-domain');
const { TypertRemoteService } = await import('../../../dsh-adapter/lib/index.js');
const artifacts = await import('../../packages/host/artifacts/lib/index.js');

const state = await import('../../packages/client/artifacts/lib/client/state.js');
const download = await import('../../packages/client/artifacts/lib/client/download.js');
const gatewayModule = await import('../../packages/client/artifacts/lib/client/gateway.js');
const telemetryModule = await import('../../packages/client/artifacts/lib/client/telemetry.js');

/** 一张真实的 1×1 PNG，用来验证图片分支与缩放基准。 */
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** 一份带脚本与表单的 HTML 制品，用来核对受限预览的判定。 */
const HOSTILE_HTML = [
  '<!doctype html><html><head><meta charset="utf-8"><title>产物页</title></head><body>',
  '<h1>报告</h1>',
  '<script>parent.__chatdshHostTouched = true;</script>',
  '<form action="/submit"><input name="q"><button>提交</button></form>',
  '</body></html>',
].join('');

/** 一份带脚本的 SVG 制品，脚本在图片上下文里不会执行。 */
const HOSTILE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><script>parent.__chatdshSvgRan = true;</script><rect width="4" height="4" fill="currentColor"/></svg>';

/** 等待若干轮事件循环，让遥测上报到达收集器。 */
function settle(ms = 150) {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * 在独立数据根里运行一个用例。
 * @param {(paths: { home: string }) => Promise<void>} run - 用例主体。
 */
async function withHome(run) {
  const home = allocateIndependentHome('wp12-artifacts');
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    await run({ home });
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    releaseIndependentHome(home);
  }
}

/**
 * 挂载真实的存储与制品服务。
 * @param {string} home - 独立数据根。
 * @returns {Promise<{ ctx: object, service: object }>} 上下文与服务。
 */
async function openArtifactHost(home) {
  const ctx = new Context();
  await ctx.plugin(Storage);
  await ctx.plugin(json, { root: join(home, 'storages') });
  await ctx.plugin(domainPlugin, { backend: 'json' });
  const service = new artifacts.ChatdshArtifactsService(ctx);
  await service[TypertRemoteService.init]();
  return { ctx, service };
}

/** 把宿主抛出的失败编成线的信封；带错误码的对象保留错误码。 */
function wireFailureOf(error) {
  if (typeof error === 'object' && error !== null && typeof error.code === 'string') {
    return { code: error.code, message: error.message };
  }
  return { code: 'gateway/internal', message: error instanceof Error ? error.message : String(error) };
}

/**
 * 起一个页面端点：制品方法与遥测中继共用同一个服务。
 * @param {object} service - 真实制品服务。
 * @returns {Promise<{ origin: string, batches: { signal: string, body: object }[], close: () => Promise<void> }>} 端点。
 */
async function startEndpoint(service) {
  const batches = [];
  const handlers = {
    list: (args) => service.list(...args),
    read: (args) => service.read(...args),
    versionList: (args) => service.versionList(...args),
    deleteScope: (args) => service.deleteScope(...args),
    delete: (args) => service.remove(...args),
  };
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', async () => {
      const raw = chunks.length === 0 ? '' : Buffer.concat(chunks).toString('utf8');
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === '/chatdsh/telemetry/browser') {
        batches.push({ signal: request.headers['x-chatdsh-signal'], body: JSON.parse(raw) });
        response.writeHead(204).end();
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

/**
 * 造一个走真实 HTTP 的传输层。
 * @param {string} origin - 端点来源。
 * @returns {{ call: (endpoint: string, args: readonly unknown[]) => Promise<object> }} 传输层。
 */
function httpTransport(origin) {
  return {
    async call(endpoint, args) {
      const response = await fetch(`${origin}/api/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args }),
      });
      if (response.status !== 200) throw new Error(`端点返回 ${String(response.status)}`);
      return await response.json();
    },
  };
}

test('真实两版写入后每版字节与磁盘一致，版本列表标出当前版本', { timeout: 120000 }, async (t) => {
  await withHome(async ({ home }) => {
    const { service } = await openArtifactHost(home);
    const endpoint = await startEndpoint(service);
    t.after(() => endpoint.close());
    const gateway = gatewayModule.createArtifactsGateway({
      transport: httpTransport(endpoint.origin),
      telemetry: { run: async (_method, work) => work(), action: () => {}, failure: () => {} },
    });

    const v1 = Buffer.from('# 周报\n\n第一版内容：中文与符号 —— ok\n', 'utf8');
    const v2 = Buffer.from('<!doctype html><meta charset="utf-8"><p>第二版</p>', 'utf8');
    const record = await service.put({ sessionId: 'session-alpha', title: '周报', kind: 'document', mimeType: 'text/markdown', content: v1 });
    await service.put({ id: record.id, sessionId: 'session-alpha', title: '周报', mimeType: 'text/html', content: v2 });

    await t.test('版本列表：当前版本是第二版，两版都在列表里', async () => {
      const list = await gateway.versionList(record.id);
      assert.equal(list.currentVersion, 2);
      assert.deepEqual(list.versions.map((version) => version.version), [1, 2]);
      assert.equal(state.isCurrentVersion(list, 2), true);
      assert.equal(state.isCurrentVersion(list, 1), false);
      assert.equal(state.versionSummaryOf(list), '共 2 个版本，当前第 2 版');
      assert.equal(list.versions[0].immutable, true);
      assert.equal(list.versions[1].mimeType, 'text/html');
    });

    await t.test('每版下载字节与磁盘上的版本文件逐字节一致', async () => {
      const first = await gateway.read(record.id, 1);
      const second = await gateway.read(record.id, 2);
      assert.equal(first.contentType, 'text/markdown');
      assert.equal(second.contentType, 'text/html');
      assert.equal(first.preview.mode, 'text');
      assert.equal(second.preview.mode, 'html-sandbox');
      assert.equal(second.preview.scriptAllowed, false);
      assert.equal(second.preview.hostBridgeAllowed, false);
      assert.equal(second.preview.formSubmitAllowed, false);

      const storedFirst = readFileSync(join(home, 'artifacts', record.id, 'v1'));
      const storedSecond = readFileSync(join(home, 'artifacts', record.id, 'v2'));
      assert.deepEqual(Buffer.from(download.bytesOf(first)), storedFirst);
      assert.deepEqual(Buffer.from(download.bytesOf(second)), storedSecond);
      assert.equal(storedFirst.toString('utf8'), v1.toString('utf8'));
      assert.equal(storedSecond.toString('utf8'), v2.toString('utf8'));

      const urlFirst = download.objectUrlOf(download.blobOf(first));
      const fetched = Buffer.from(await (await fetch(urlFirst)).arrayBuffer());
      URL.revokeObjectURL(urlFirst);
      assert.deepEqual(fetched, storedFirst, '对象地址里的字节与磁盘一致');
      assert.equal(download.filenameOf('周报', 1, first.contentType), '周报-v1.md');
      assert.equal(download.filenameOf('周报', 2, second.contentType), '周报-v2.html');
    });

    await t.test('读取当前版本时省略版本号也落在第二版', async () => {
      const current = await gateway.read(record.id);
      assert.equal(current.version.version, 2);
    });
  });
});

test('筛选按名称、类型与会话三个口径生效', { timeout: 120000 }, async (t) => {
  await withHome(async ({ home }) => {
    const { service } = await openArtifactHost(home);
    const endpoint = await startEndpoint(service);
    t.after(() => endpoint.close());
    const gateway = gatewayModule.createArtifactsGateway({
      transport: httpTransport(endpoint.origin),
      telemetry: { run: async (_method, work) => work(), action: () => {}, failure: () => {} },
    });

    await service.put({ sessionId: 'session-alpha', title: '季度报告', kind: 'document', mimeType: 'text/markdown', content: '报告' });
    await service.put({ sessionId: 'session-beta', title: '折线图', kind: 'image', mimeType: 'image/png', content: PNG_1X1, encoding: 'base64' });
    await service.put({ sessionId: 'session-beta', title: '账单明细', kind: 'document', mimeType: 'text/csv', content: 'a,b\n1,2\n' });

    const records = await gateway.list();
    assert.equal(records.length, 3);

    await t.test('按名称与媒体类型做大小写不敏感的匹配', () => {
      assert.equal(state.filterArtifacts(records, { query: '报告', sessionId: '', mimeType: '' }).length, 1);
      assert.equal(state.filterArtifacts(records, { query: 'PNG', sessionId: '', mimeType: '' }).length, 1);
      assert.equal(state.filterArtifacts(records, { query: '没有这个', sessionId: '', mimeType: '' }).length, 0);
    });

    await t.test('按会话与类型过滤可以叠加', () => {
      assert.deepEqual(
        state.filterArtifacts(records, { query: '', sessionId: 'session-beta', mimeType: '' }).map((record) => record.title).sort(),
        ['折线图', '账单明细'].sort(),
      );
      assert.deepEqual(
        state.filterArtifacts(records, { query: '', sessionId: 'session-beta', mimeType: 'text/csv' }).map((record) => record.title),
        ['账单明细'],
      );
      assert.equal(state.filterArtifacts(records, { query: '', sessionId: 'session-alpha', mimeType: 'image/png' }).length, 0);
    });

    await t.test('下拉选项给出出现过的会话与类型及数量', () => {
      assert.deepEqual(state.sessionOptionsOf(records).map((option) => option.value), ['session-alpha', 'session-beta']);
      assert.deepEqual(state.typeOptionsOf(records).map((option) => option.value), ['image/png', 'text/csv', 'text/markdown']);
      assert.equal(state.typeOptionsOf(records)[2].label, 'text/markdown（1 个）');
    });

    await t.test('排序按更新时间从新到旧', () => {
      const sorted = state.sortArtifacts(records);
      assert.equal(sorted.length, 3);
      assert.ok(sorted[0].updatedAt >= sorted[2].updatedAt);
    });
  });
});

test('预览判定覆盖受限 HTML、SVG、图片、PDF、二进制、超限与损坏', { timeout: 120000 }, async (t) => {
  await withHome(async ({ home }) => {
    const { service } = await openArtifactHost(home);
    const endpoint = await startEndpoint(service);
    t.after(() => endpoint.close());
    const gateway = gatewayModule.createArtifactsGateway({
      transport: httpTransport(endpoint.origin),
      telemetry: { run: async (_method, work) => work(), action: () => {}, failure: () => {} },
    });

    const htmlRecord = await service.put({ sessionId: 'session-alpha', title: '产物页', kind: 'html', mimeType: 'text/html', content: HOSTILE_HTML });
    const svgRecord = await service.put({ sessionId: 'session-alpha', title: '矢量图', kind: 'svg', mimeType: 'image/svg+xml', content: HOSTILE_SVG });
    const pngRecord = await service.put({ sessionId: 'session-alpha', title: '折线图', kind: 'image', mimeType: 'image/png', content: PNG_1X1, encoding: 'base64' });
    const pdfRecord = await service.put({ sessionId: 'session-alpha', title: '合同', kind: 'document', mimeType: 'application/pdf', content: '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n' });
    const binaryRecord = await service.put({ sessionId: 'session-alpha', title: '打包', kind: 'other', mimeType: 'application/octet-stream', content: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]) });
    const textRecord = await service.put({ sessionId: 'session-alpha', title: '日志', kind: 'document', mimeType: 'text/plain', content: '第一行\n第二行\n' });
    const controlRecord = await service.put({ sessionId: 'session-alpha', title: '脏文本', kind: 'document', mimeType: 'text/plain', content: Buffer.from([0x61, 0x00, 0x62]) });

    await t.test('HTML 走沙箱预览，脚本原文交给 iframe 的沙箱隔离', async () => {
      const read = await gateway.read(htmlRecord.id);
      const plan = state.previewPlanOf(read);
      assert.equal(plan.kind, 'html');
      assert.equal(plan.html, HOSTILE_HTML);
      assert.equal(read.preview.mode, 'html-sandbox');
    });

    await t.test('SVG 以图片方式呈现，data URL 带原始字节', async () => {
      const read = await gateway.read(svgRecord.id);
      const plan = state.previewPlanOf(read);
      assert.equal(plan.kind, 'svg');
      assert.equal(plan.dataUrl, `data:image/svg+xml;base64,${Buffer.from(HOSTILE_SVG, 'utf8').toString('base64')}`);
    });

    await t.test('位图走图片查看器，data URL 与字节一致', async () => {
      const read = await gateway.read(pngRecord.id);
      const plan = state.previewPlanOf(read);
      assert.equal(plan.kind, 'image');
      assert.equal(plan.contentType, 'image/png');
      assert.equal(plan.dataUrl, `data:image/png;base64,${PNG_1X1}`);
    });

    await t.test('PDF 查看器依赖缺失给出错误码与下一步', async () => {
      const read = await gateway.read(pdfRecord.id);
      const plan = state.previewPlanOf(read);
      assert.equal(plan.kind, 'notice');
      assert.equal(plan.code, 'artifact/pdf-viewer-unavailable');
      assert.match(plan.message, /pdfjs-dist/u);
      assert.match(plan.message, /加密/u);
      assert.equal(state.describeFailure(new state.ArtifactClientError(plan.code, plan.message)).includes('artifact/pdf-viewer-unavailable'), true);
    });

    await t.test('二进制内容只提供下载并说明大小', async () => {
      const read = await gateway.read(binaryRecord.id);
      const plan = state.previewPlanOf(read);
      assert.equal(plan.kind, 'notice');
      assert.equal(plan.code, 'artifact/binary');
      assert.match(plan.message, /6 字节/u);
    });

    await t.test('文本可以预览', async () => {
      const read = await gateway.read(textRecord.id);
      const plan = state.previewPlanOf(read);
      assert.equal(plan.kind, 'text');
      assert.equal(plan.text, '第一行\n第二行\n');
    });

    await t.test('含控制字节的文本按二进制处理', async () => {
      const read = await gateway.read(controlRecord.id);
      const plan = state.previewPlanOf(read);
      assert.equal(plan.kind, 'notice');
      assert.equal(plan.code, 'artifact/binary');
    });

    await t.test('超出预览上限时给出上限与实际大小', async () => {
      const read = await gateway.read(textRecord.id);
      const plan = state.previewPlanOf(read, 8);
      assert.equal(plan.kind, 'notice');
      assert.equal(plan.code, 'artifact/preview-too-large');
      assert.match(plan.message, /8 字节/u);
    });

    await t.test('损坏的字节给出解码错误码，解码函数就地拒绝', async () => {
      const read = await gateway.read(textRecord.id);
      const broken = state.previewPlanOf({ ...read, base64: '这不是base64!!' });
      assert.equal(broken.kind, 'notice');
      assert.equal(broken.code, 'artifact/corrupt');
      assert.throws(
        () => state.decodeBase64('这不是base64!!'),
        (error) => error.code === 'artifact/corrupt',
      );
    });

    await t.test('缩放与键盘按键的换算', () => {
      assert.equal(state.zoomStepOf(100, 'in'), 125);
      assert.equal(state.zoomStepOf(100, 'out'), 75);
      assert.equal(state.zoomStepOf(400, 'in'), 400);
      assert.equal(state.zoomStepOf(25, 'out'), 25);
      assert.equal(state.clampZoomPercent(1), 25);
      assert.equal(state.fitPercentOf(600, 1200), 50);
      assert.equal(state.fitPercentOf(2400, 600), 400);
      assert.equal(state.fitPercentOf(0, 600), undefined);
      assert.equal(state.keyboardZoomOf('+'), 'in');
      assert.equal(state.keyboardZoomOf('='), 'in');
      assert.equal(state.keyboardZoomOf('-'), 'out');
      assert.equal(state.keyboardZoomOf('Home'), 'reset');
      assert.equal(state.keyboardZoomOf('a'), undefined);
    });
  });
});

test('删除范围列出全部版本与占用空间，删除后磁盘清空', { timeout: 120000 }, async (t) => {
  await withHome(async ({ home }) => {
    const { service } = await openArtifactHost(home);
    const endpoint = await startEndpoint(service);
    t.after(() => endpoint.close());
    const gateway = gatewayModule.createArtifactsGateway({
      transport: httpTransport(endpoint.origin),
      telemetry: { run: async (_method, work) => work(), action: () => {}, failure: () => {} },
    });

    const first = Buffer.from('a'.repeat(100), 'utf8');
    const second = Buffer.from('b'.repeat(300), 'utf8');
    const record = await service.put({ sessionId: 'session-alpha', title: '大文件', kind: 'document', mimeType: 'text/plain', content: first });
    await service.put({ id: record.id, sessionId: 'session-alpha', title: '大文件', mimeType: 'text/plain', content: second });

    await t.test('删除范围给出两个版本、合计 400 字节并要求确认', async () => {
      const scope = await gateway.deleteScope(record.id);
      assert.deepEqual(scope.affectedVersions, [1, 2]);
      assert.equal(scope.totalBytes, 400);
      assert.equal(scope.requiresConfirm, true);
      assert.equal(scope.allVersions, true);
      assert.equal(state.deleteScopeNoteOf(scope), '共 2 个版本，占用 400 字节');
    });

    await t.test('删除后记录与两个版本文件都不在了', async () => {
      assert.equal(await gateway.remove(record.id), true);
      assert.equal((await gateway.list()).length, 0);
      assert.equal(existsSync(join(home, 'artifacts', record.id)), false);
      assert.equal(await gateway.remove(record.id), false);
    });

    await t.test('内容被移除后读取失败给出离线或已移除的错误码', async () => {
      const gone = await service.put({ sessionId: 'session-beta', title: '临时', kind: 'document', mimeType: 'text/plain', content: '临时' });
      await service.remove(gone.id);
      await assert.rejects(
        () => gateway.read(gone.id),
        (error) => {
          assert.equal(error.code, 'object-not-found');
          assert.match(state.describeFailure(error), /源设备离线或制品内容已被移除/u);
          return true;
        },
      );
    });
  });
});

test('数据入口拒绝不符合约定的返回形状，离线折算成稳定错误码', { timeout: 60000 }, async (t) => {
  const telemetry = { run: async (_method, work) => work(), action: () => {}, failure: () => {} };
  const read = {
    record: { id: 'artifact-1', sessionId: 'session-1', title: '页', kind: 'html', mimeType: 'text/html', size: 4, version: 1, createdAt: 1, updatedAt: 2 },
    version: { artifactId: 'artifact-1', version: 1, mimeType: 'text/html', size: 4, createdAt: 1, immutable: true, sourceSessionId: 'session-1', downloadable: true },
    base64: Buffer.from('<p>x</p>').toString('base64'),
    contentType: 'text/html',
  };

  await t.test('宿主没有关闭脚本时拒绝渲染', async () => {
    const gateway = gatewayModule.createArtifactsGateway({
      transport: {
        call: async () => ({ ok: true, value: { ...read, preview: { mode: 'html-sandbox', scriptAllowed: true, hostBridgeAllowed: false, formSubmitAllowed: false } } }),
      },
      telemetry,
    });
    await assert.rejects(
      () => gateway.read('artifact-1'),
      (error) => {
        assert.equal(error.code, 'artifact/unsafe-preview');
        return true;
      },
    );
  });

  await t.test('预览方式不在登记取值里时拒绝', async () => {
    const gateway = gatewayModule.createArtifactsGateway({
      transport: {
        call: async () => ({ ok: true, value: { ...read, preview: { mode: 'inline-frame', scriptAllowed: false, hostBridgeAllowed: false, formSubmitAllowed: false } } }),
      },
      telemetry,
    });
    await assert.rejects(() => gateway.read('artifact-1'), (error) => error.code === 'gateway/internal');
  });

  await t.test('版本列表缺少当前版本时拒绝', async () => {
    const gateway = gatewayModule.createArtifactsGateway({
      transport: {
        call: async () => ({
          ok: true,
          value: { artifactId: 'artifact-1', currentVersion: 3, versions: [read.version] },
        }),
      },
      telemetry,
    });
    await assert.rejects(() => gateway.versionList('artifact-1'), (error) => error.code === 'gateway/internal');
  });

  await t.test('缺命名空间时按能力不可用返回', async () => {
    const gateway = gatewayModule.createArtifactsGateway({
      transport: gatewayModule.createRemoteTransport(() => undefined),
      telemetry,
    });
    await assert.rejects(() => gateway.list(), (error) => error.code === 'client/unavailable');
  });

  await t.test('传输层拒绝时折算成离线失败', async () => {
    const gateway = gatewayModule.createArtifactsGateway({
      transport: { call: async () => Promise.reject(new Error('连接被拒绝')) },
      telemetry,
    });
    await assert.rejects(
      () => gateway.read('artifact-1'),
      (error) => {
        assert.equal(error.code, 'client/offline');
        assert.match(state.describeFailure(error), /控制平面不可达/u);
        return true;
      },
    );
  });
});

test('面板遥测按登记的名字发出动作、错误与计数', { timeout: 120000 }, async (t) => {
  await withHome(async ({ home }) => {
    const { service } = await openArtifactHost(home);
    const endpoint = await startEndpoint(service);
    t.after(() => endpoint.close());
    const telemetry = telemetryModule.createPanelTelemetry({
      fetchImpl: (path, init) => fetch(`${endpoint.origin}${path}`, init),
    });
    const gateway = gatewayModule.createArtifactsGateway({ transport: httpTransport(endpoint.origin), telemetry });

    const record = await service.put({ sessionId: 'session-alpha', title: '周报', kind: 'document', mimeType: 'text/markdown', content: '# 周报\n' });
    await gateway.list();
    await gateway.read(record.id);
    gateway.noteAction('artifact.preview', 'ok');
    await assert.rejects(() => gateway.read('missing-artifact'), (error) => error.code === 'object-not-found');
    await settle();

    const logs = endpoint.batches.filter((batch) => batch.signal === 'logs').map((batch) => batch.body);
    const traces = endpoint.batches.filter((batch) => batch.signal === 'traces').map((batch) => batch.body);
    const metrics = endpoint.batches.filter((batch) => batch.signal === 'metrics').map((batch) => batch.body);

    await t.test('动作事件带动作名与结果', () => {
      const bodies = logs.flatMap((body) => body.resourceLogs[0].scopeLogs[0].logRecords).map((record_) => record_.body.stringValue);
      assert.ok(bodies.includes('chatdsh.client.ui.action'));
      const actionRecord = logs
        .flatMap((body) => body.resourceLogs[0].scopeLogs[0].logRecords)
        .find((record_) => record_.body.stringValue === 'chatdsh.client.ui.action');
      assert.deepEqual(actionRecord.attributes.map((attribute) => attribute.key), ['action', 'outcome']);
      assert.equal(actionRecord.attributes[0].value.stringValue, 'artifact.preview');
    });

    await t.test('失败事件带错误类型与错误码', () => {
      const failureRecord = logs
        .flatMap((body) => body.resourceLogs[0].scopeLogs[0].logRecords)
        .find((record_) => record_.body.stringValue === 'chatdsh.client.error');
      assert.equal(failureRecord.attributes[0].key, 'error.type');
      assert.equal(failureRecord.attributes[1].value.stringValue, 'object-not-found');
    });

    await t.test('每次调用一个 span，调用失败的计数也发出', () => {
      const spans = traces.flatMap((body) => body.resourceSpans[0].scopeSpans[0].spans);
      const ok = spans.filter((span) => span.status.code === 1);
      const failed = spans.filter((span) => span.status.code === 2);
      assert.equal(ok.length, 2);
      assert.equal(failed.length, 1);
      assert.deepEqual(spans[0].attributes.map((attribute) => attribute.key), ['rpc.method', 'outcome']);
      const counted = metrics
        .flatMap((body) => body.resourceMetrics[0].scopeMetrics[0].metrics)
        .filter((metric) => metric.name === 'chatdsh_client_errors_total');
      assert.equal(counted.length, 1);
      assert.equal(counted[0].sum.dataPoints[0].attributes[0].key, 'error_type');
    });
  });
});
