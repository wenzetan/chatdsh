// WP10 项目界面在节点侧的验收：面板纯逻辑、数据入口的失败分支与遥测载荷。
//
// 数据入口连到真实的项目服务实例（真实的存储中枢、JSON 后端、存储域、系统提示、模型运行时、
// 预设注册表与模型提供方服务），中间隔着与本仓库控制平面同形状的结果信封：业务失败只有
// RemoteError 保留错误码，其余按 `gateway/internal` 转出，与真实网关一致。传输层的命名空间
// 适配、离线映射与遥测载荷都在这里核对；界面与键盘焦点由真实 Chrome 的用例覆盖。
//
// 运行：node --test e2e/unit/client-complete-wp10-gateway.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tempHome } from '../../scripts/lib/cleanup.mjs';
import { ensureDeps } from '../lib/ensure-deps.mjs';

const REPO = resolve(import.meta.dirname, '../../..');
const RUNTIME = resolve(import.meta.dirname, '../..');
ensureDeps(RUNTIME);
ensureDeps(resolve(REPO, 'dsh-adapter'));

const { Context } = await import('@deepseek-ai/cordis');
const { default: Storage } = await import('@deepseek-ai/dsh-storage');
const json = await import('@deepseek-ai/dsh-storage-json');
const domainPlugin = await import('@deepseek-ai/dsh-storage-domain');
const { default: SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt');
const { default: LlmRuntime } = await import('@deepseek-ai/dsh-llm');
const { default: SessionProjectionRegistry } = await import('@deepseek-ai/dsh-session-projection');
const { default: Loader } = await import('@deepseek-ai/cordis-plugin-loader');
const { default: AgentPresetRegistry } = await import('@deepseek-ai/dsh-agent-preset-registry');
const { default: SessionPlugin } = await import('@deepseek-ai/dsh-session');
const { ChatdshProjectsService } = await import('../../packages/host/projects/lib/index.js');
const { ChatdshModelProviderService } = await import('../../packages/host/model-provider/lib/index.js');
const { GatewayLlmAdapter } = await import('../../packages/host/llm-router/lib/index.js');

const state = await import('../../packages/client/projects/lib/client/state.js');
const { createProjectsGateway, createRemoteTransport, ProjectCallError } = await import('../../packages/client/projects/lib/client/gateway.js');
const { createPanelTelemetry, RELAY_PATH } = await import('../../packages/client/projects/lib/client/telemetry.js');

/** 可选模型提供方与它的模型声明。 */
const PROVIDER = {
  provider: 'gateway',
  displayName: '网关',
  baseUrl: 'http://127.0.0.1:1/llm',
  models: ['xhs/dots3-note-prev'],
};

/** 等待插件树激活。 */
function settle(ms = 1200) {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * 装配一套真实宿主：项目服务、模型提供方服务与预设名册。
 * @param {{ root: string, workspace: string }} paths 数据根与工作目录。
 * @returns {Promise<import('@deepseek-ai/cordis').Context>} 上下文。
 */
async function openStack({ root, workspace }) {
  const ctx = new Context();
  ctx.plugin(Storage);
  ctx.plugin(json, { root: join(root, 'storages') });
  ctx.plugin(domainPlugin, { backend: 'json' });
  ctx.plugin(SystemPrompt);
  ctx.plugin(LlmRuntime);
  ctx.plugin(SessionProjectionRegistry);
  ctx.plugin(Loader, { baseUrl: `${RUNTIME}/` });
  ctx.plugin(AgentPresetRegistry, { default: 'chatdsh-work' });
  ctx.plugin(SessionPlugin);
  ctx.plugin(ChatdshModelProviderService, { providers: [PROVIDER] });
  ctx.plugin(ChatdshProjectsService);
  await settle();
  const adapter = new GatewayLlmAdapter({ baseUrl: 'http://127.0.0.1:1/llm', provider: 'gateway', quota: {} });
  ctx.llm.registerAdapter(['gateway'], adapter);
  await ctx.agentPresets.register({ id: 'assistant-alpha', name: '甲助手', description: '', order: 1, plugins: [] });
  await ctx.agentPresets.register({ id: 'assistant-beta', name: '乙助手', description: '', order: 2, plugins: [] });
  return ctx;
}

/**
 * 起一个把结果信封送到真实服务的入口，并收下浏览器侧遥测批次。
 * @param {import('@deepseek-ai/cordis').Context} ctx 上下文。
 * @returns {Promise<{ transport: object, origin: string, batches: object[], close: () => Promise<void> }>} 入口。
 */
async function startEntry(ctx) {
  const batches = [];
  const handlers = {
    'chatdshProjects/list': () => ctx.chatdshProjects.list(),
    'chatdshProjects/get': ([path]) => ctx.chatdshProjects.get(path),
    'chatdshProjects/create': ([input]) => ctx.chatdshProjects.create(input),
    'chatdshProjects/set': ([input]) => ctx.chatdshProjects.set(input),
    'chatdshProjects/delete': ([path]) => ctx.chatdshProjects.remove(path),
    'agentPresets/list': () => ctx.agentPresets.remoteExportList(),
    'chatdshModelProviders/list': () => ctx.chatdshModelProviders.list(),
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === RELAY_PATH) {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        batches.push({
          signal: request.headers['x-chatdsh-signal'],
          hasCsrf: request.headers['x-chatdsh-csrf'] === '1',
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        });
        response.writeHead(204).end();
      });
      return;
    }
    const endpoint = url.pathname.replace(/^\/api\//u, '');
    const handler = handlers[endpoint];
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', async () => {
      if (handler === undefined) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error: { code: 'object-not-found', message: endpoint } }));
        return;
      }
      const body = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'));
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
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    transport: {
      async call(endpoint, args) {
        const response = await fetch(`${origin}/api/${endpoint}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ args }),
        });
        return response.json();
      },
    },
    origin,
    batches,
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}

/**
 * 把服务端失败编成线的信封：只有 RemoteError 保留错误码。
 * @param {unknown} error 服务端抛出的失败。
 * @returns {{ code: string, message: string }} 信封里的失败。
 */
function wireFailureOf(error) {
  if (typeof error === 'object' && error !== null && error.isDSHRemoteError === true) {
    return { code: error.code, message: error.message };
  }
  return { code: 'gateway/internal', message: error instanceof Error ? error.message : String(error) };
}

/** 等待遥测批次达到预期数量。 */
async function waitBatches(batches, count, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (batches.length < count && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25));
  assert.ok(batches.length >= count, `遥测批次不够：收到 ${String(batches.length)}，期望 ${String(count)}`);
}

/** 把一份 OTLP 日志载荷摊平成 { name, attributes }。 */
function logsOf(batch) {
  const out = [];
  for (const resource of batch.body.resourceLogs ?? []) {
    for (const scope of resource.scopeLogs ?? []) {
      for (const record of scope.logRecords ?? []) {
        const attributes = {};
        for (const entry of record.attributes ?? []) {
          attributes[entry.key] = entry.value.stringValue ?? entry.value.intValue;
        }
        out.push({ name: record.body?.stringValue ?? '', attributes });
      }
    }
  }
  return out;
}

/** 把一份 OTLP 追踪载荷摊平成 { name, attributes }。 */
function spansOf(batch) {
  const out = [];
  for (const resource of batch.body.resourceSpans ?? []) {
    for (const scope of resource.scopeSpans ?? []) {
      for (const span of scope.spans ?? []) {
        const attributes = {};
        for (const entry of span.attributes ?? []) attributes[entry.key] = entry.value.stringValue;
        out.push({ name: span.name, attributes });
      }
    }
  }
  return out;
}

/** 把一份 OTLP 指标载荷摊平成 { name, attributes }。 */
function metricsOf(batch) {
  const out = [];
  for (const resource of batch.body.resourceMetrics ?? []) {
    for (const scope of resource.scopeMetrics ?? []) {
      for (const metric of scope.metrics ?? []) {
        for (const point of metric.sum?.dataPoints ?? []) {
          const attributes = {};
          for (const entry of point.attributes ?? []) attributes[entry.key] = entry.value.stringValue;
          out.push({ name: metric.name, attributes });
        }
      }
    }
  }
  return out;
}

test('展示名回退、排序、筛选与字段校验', () => {
  assert.equal(state.displayNameOf({ path: '/work/alpha/', title: '', displayTitle: '' }), 'alpha', '名称为空时用目录末段');
  assert.equal(state.displayNameOf({ path: '/', title: '', displayTitle: '' }), '/', '根目录保留为斜杠');
  assert.equal(state.lastSegmentOf('/home/acceptance'), 'acceptance');

  const rows = [
    { path: '/work/beta', title: 'beta', displayTitle: 'beta', instructions: '', revision: 1, updatedAt: 100 },
    { path: '/work/alpha', title: '', displayTitle: '', instructions: '', revision: 1, updatedAt: 300 },
    { path: '/work/gamma', title: 'gamma', displayTitle: 'gamma', instructions: '', revision: 1, updatedAt: 200 },
  ];
  assert.deepEqual(state.sortProjects(rows, 'name').map((row) => state.displayNameOf(row)), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(state.sortProjects(rows, 'updated').map((row) => row.path), ['/work/alpha', '/work/gamma', '/work/beta']);
  assert.deepEqual(state.sortProjects(rows, 'path').map((row) => row.path), ['/work/alpha', '/work/beta', '/work/gamma']);
  assert.deepEqual(state.filterProjects(rows, 'gam').map((row) => row.path), ['/work/gamma']);
  assert.deepEqual(state.filterProjects(rows, 'ALPHA').map((row) => row.path), ['/work/alpha'], '筛选不分大小写');
  assert.equal(state.filterProjects(rows, '').length, 3);

  const empty = { path: '', title: '', instructions: '', defaultModel: '', defaultAssistant: '' };
  assert.deepEqual(state.validateDraft(empty, [], 'create').map((entry) => entry.fieldId), [state.PATH_FIELD_ID]);
  assert.deepEqual(state.validateDraft({ ...empty, path: 'relative/dir' }, [], 'create').map((entry) => entry.message), ['目录必须是绝对路径']);
  assert.deepEqual(
    state.validateDraft({ ...empty, path: '/work/alpha' }, ['/work/alpha'], 'create').map((entry) => entry.message),
    ['该目录已经有项目记录'],
  );
  assert.deepEqual(state.validateDraft({ ...empty, path: '/work/alpha' }, ['/work/alpha'], 'edit'), [], '修改时不检查重复');
  const longTitle = state.validateDraft({ ...empty, path: '/work/alpha', title: '字'.repeat(81) }, [], 'create');
  assert.deepEqual(longTitle.map((entry) => entry.fieldId), [state.TITLE_FIELD_ID]);
  assert.deepEqual(state.validateDraft({ ...empty, path: '/work/alpha', title: '字'.repeat(80) }, [], 'create'), []);

  assert.equal(state.revisionVerdict(3, undefined), 'deleted');
  assert.equal(state.revisionVerdict(3, { revision: 3 }), 'unchanged');
  assert.equal(state.revisionVerdict(3, { revision: 4 }), 'conflict');

  assert.match(state.describeFailure({ code: 'client/offline', message: '' }), /控制平面不可达/u);
  assert.match(state.describeFailure(new ProjectCallError('gateway/internal', '项目记录版本已过期')), /版本已过期.*gateway\/internal/u);
  assert.match(state.describeFailure(new ProjectCallError('directory-picker/unreadable', '')), /没有读取权限/u);
  assert.equal(state.modelOptionsOf([{ provider: 'gateway', displayName: '网关', models: ['a', 'b'] }]).length, 2);
  assert.deepEqual(state.assistantOptionsOf([
    { id: 'broken-one', broken: '装配失败' },
    { id: 'ok-one', name: '可用' },
  ]).map((entry) => entry.id), ['ok-one'], '装配失败的预设不出现');
});

test('数据入口在真实服务上完成读取、新建、更新与删除', async () => {
  const root = tempHome('wp10-gateway');
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const ctx = await openStack({ root, workspace });
  const entry = await startEntry(ctx);
  const telemetry = createPanelTelemetry();
  const gateway = createProjectsGateway({ transport: entry.transport, telemetry });
  try {
    assert.deepEqual(await gateway.list(), [], '空数据根里没有项目');
    const created = await gateway.create({ path: workspace, title: '', instructions: '项目说明原文' });
    assert.equal(created.path, workspace);
    assert.equal(created.displayTitle, 'workspace', '名称为空时按目录末段展示');
    assert.equal(created.revision, 1);
    assert.equal((await gateway.list()).length, 1);
    assert.equal((await gateway.get(workspace)).instructions, '项目说明原文');
    assert.equal(await gateway.get(join(root, 'missing')), undefined, '不存在的路径读到空值');

    const updated = await gateway.set({ path: workspace, title: '改名', instructions: '第二次说明', revision: created.revision });
    assert.equal(updated.revision, 2);
    assert.equal(updated.displayTitle, '改名');

    await assert.rejects(
      () => gateway.set({ path: workspace, instructions: '落后版本', revision: created.revision }),
      (error) => {
        assert.ok(error instanceof ProjectCallError);
        assert.equal(error.code, 'gateway/internal', '业务错误码在线路上按网关规则变成 gateway/internal');
        assert.match(error.message, /版本已过期/u);
        return true;
      },
      '过期 revision 必须被拒绝',
    );
    assert.equal(ctx.chatdshProjects.get(workspace).instructions, '第二次说明', '被拒绝的写入不改内容');

    await assert.rejects(
      () => gateway.create({ path: workspace, title: '第二份' }),
      (error) => error instanceof ProjectCallError && error.code === 'gateway/internal',
      '同一目录不能新建第二份记录',
    );
    assert.equal(ctx.chatdshProjects.list().length, 1);

    assert.equal(await gateway.remove(workspace), true);
    assert.equal(await gateway.get(workspace), undefined);
    assert.equal(statSync(workspace).isDirectory(), true, '删除只移除配置，目录仍在');

    const models = await gateway.listModels();
    assert.deepEqual(models, ['gateway/xhs/dots3-note-prev']);
    const assistants = await gateway.listAssistants();
    assert.deepEqual(assistants.map((assistant) => assistant.id), ['assistant-alpha', 'assistant-beta']);
  } finally {
    await entry.close();
    await ctx.fiber.dispose();
  }
});

test('命名空间适配：端点拆分、缺失命名空间与离线映射', async () => {
  const transport = createRemoteTransport((name) => (name === 'chatdshProjects'
    ? {
      async list() {
        return { ok: true, value: [{ path: '/work/alpha' }] };
      },
    }
    : undefined));

  assert.deepEqual(await transport.call('chatdshProjects/list', []), { ok: true, value: [{ path: '/work/alpha' }] });
  assert.equal((await transport.call('chatdshProjects/get', ['/work/alpha'])).error.code, 'client/unavailable', '缺失方法按能力不可用报告');
  assert.equal((await transport.call('directoryPicker/list', [])).error.code, 'client/unavailable', '缺失命名空间按能力不可用报告');

  const offline = createRemoteTransport(() => ({
    async list() {
      throw new TypeError('fetch failed');
    },
  }));
  const offlineGateway = createProjectsGateway({
    transport: offline,
    telemetry: createPanelTelemetry({ fetchImpl: async () => new Response(null, { status: 204 }) }),
  });
  await assert.rejects(
    () => offlineGateway.list(),
    (error) => error instanceof ProjectCallError && error.code === 'client/offline',
    '传输层拒绝按离线失败报告',
  );
});

test('动作 span、失败事件与计数指标都送到同源中继', async () => {
  const root = tempHome('wp10-telemetry');
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const ctx = await openStack({ root, workspace });
  const entry = await startEntry(ctx);
  const telemetry = createPanelTelemetry({
    fetchImpl: (input, init) => fetch(new URL(input, entry.origin), init),
    now: () => Date.now(),
  });
  const gateway = createProjectsGateway({ transport: entry.transport, telemetry });
  try {
    await gateway.list();
    gateway.noteAction('project.create', 'ok');
    const created = await gateway.create({ path: workspace, title: '遥测' });
    await waitBatches(entry.batches, 3);
    await assert.rejects(() => gateway.set({ path: workspace, instructions: '落后版本', revision: created.revision - 1 }));
    await waitBatches(entry.batches, 5);

    const all = entry.batches;
    for (const batch of all) assert.equal(batch.hasCsrf, true, '上报必须带同源校验头');
    const spans = all.filter((batch) => batch.signal === 'traces').flatMap(spansOf);
    assert.ok(spans.length >= 2, '每次调用都有一个 span');
    assert.ok(spans.every((span) => span.name === 'chatdsh.client.remote.call'));
    assert.ok(spans.some((span) => span.attributes.outcome === 'ok'), '成功分支记 ok');
    assert.ok(spans.some((span) => span.attributes.outcome === 'failed'), '失败分支记 failed');
    assert.ok(spans.some((span) => span.attributes['rpc.method'] === 'chatdshProjects/list'), 'span 带方法名');

    const logs = all.filter((batch) => batch.signal === 'logs').flatMap(logsOf);
    const failure = logs.find((record) => record.name === 'chatdsh.client.error');
    assert.ok(failure !== undefined, '失败分支有一条错误事件');
    assert.equal(failure.attributes['error.type'], 'ProjectCallError');
    assert.equal(failure.attributes['error.code'], 'gateway/internal');
    const action = logs.find((record) => record.name === 'chatdsh.client.ui.action');
    assert.ok(action !== undefined, '界面动作有一条事件');
    assert.equal(action.attributes.action, 'project.create');
    assert.equal(action.attributes.outcome, 'ok');

    const metrics = all.filter((batch) => batch.signal === 'metrics').flatMap(metricsOf);
    const counted = metrics.find((metric) => metric.name === 'chatdsh_client_errors_total');
    assert.ok(counted !== undefined, '失败计数应当上报');
    assert.equal(counted.attributes.error_type, 'ProjectCallError');
    assert.ok(all.every((batch) => batch.body.resourceLogs === undefined || batch.body.resourceLogs[0].resource.attributes.some((entry) => entry.key === 'chatdsh.component')), '载荷带组件属性');
  } finally {
    await entry.close();
    await ctx.fiber.dispose();
  }
});
