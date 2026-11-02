// WP09-A1 项目宿主的验收测试。
//
// 每个用例在 runtime/.run 下分配独立数据根，用真实的存储中枢、JSON 后端、存储域、系统提示、
// 模型运行时、预设注册表与会话注册表构造项目服务，不替身任何宿主依赖。覆盖目录路径校验与
// 规范化、名称为空回退目录末段、相同目录拒绝重复、过期 revision 拒绝、并发写入只成功一次、
// 默认模型与默认助手引用校验、删除只影响配置、实例重建后数据保留，以及失败分支的遥测。
//
// 运行：node --test e2e/unit/client-complete-wp09-projects.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
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
const { GatewayLlmAdapter } = await import('../../packages/host/llm-router/lib/index.js');
const { CHATDSH_ERROR_CODES } = await import('../../packages/core/contracts/lib/index.js');
const { createTelemetryClient } = await import('../../packages/core/diagnostics/lib/index.js');
const { defaultTelemetryConfig } = await import('../../packages/core/diagnostics/lib/config.js');

/** 等待插件树激活。 */
function settle(ms = 1200) {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * 按真实宿主注册方式装配一套项目服务的运行环境。
 * @param {{ root: string, telemetry?: object }} options 数据根与可选遥测客户端。
 * @returns {Promise<import('@deepseek-ai/cordis').Context>} 上下文。
 */
async function openStack({ root, telemetry }) {
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
  if (telemetry !== undefined) ctx.provide('chatdshTelemetry', telemetry);
  ctx.plugin(ChatdshProjectsService);
  await settle();
  return ctx;
}

/**
 * 在模型运行时上注册一条真实的网关路由，让模型目录里有可引用的 provider。
 * @param {import('@deepseek-ai/cordis').Context} ctx 上下文。
 * @returns {() => void} 注销函数。
 */
function registerGatewayRoute(ctx) {
  const adapter = new GatewayLlmAdapter({ baseUrl: 'http://127.0.0.1:1/llm', provider: 'gateway', quota: {} });
  return ctx.llm.registerAdapter(['gateway'], adapter);
}

/**
 * 准备一个工作目录与数据根。
 * @param {string} prefix 数据根前缀。
 * @returns {{ root: string, workspace: string }} 路径。
 */
function makeWorkspace(prefix) {
  const root = tempHome(prefix);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  return { root, workspace };
}

/**
 * 起一个真实接收 OTLP/HTTP 请求的收集器，返回收到的三段信号。
 * @returns {Promise<{ url: string, records: () => { logs: object[], traces: object[], metrics: object[] }, close: () => Promise<void> }>} 收集器。
 */
async function startCollector() {
  const bodies = { logs: [], traces: [], metrics: [] };
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const signal = request.url?.includes('/v1/logs') ? 'logs' : request.url?.includes('/v1/traces') ? 'traces' : 'metrics';
      try {
        bodies[signal].push(JSON.parse(text));
      } catch {
        bodies[signal].push({ unparsed: text });
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{}');
    });
  });
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    records: () => bodies,
    close: () => new Promise((done) => server.close(done)),
  };
}

/** 把 OTLP 日志载荷摊平成 { name, attributes } 列表。 */
function flattenLogs(payloads) {
  const out = [];
  for (const payload of payloads) {
    for (const resource of payload.resourceLogs ?? []) {
      for (const scope of resource.scopeLogs ?? []) {
        for (const record of scope.logRecords ?? []) {
          const attributes = {};
          for (const entry of record.attributes ?? []) {
            const value = entry.value ?? {};
            attributes[entry.key] = value.stringValue ?? value.intValue ?? value.boolValue ?? value.doubleValue;
          }
          out.push({ name: record.body?.stringValue ?? '', attributes });
        }
      }
    }
  }
  return out;
}

/** 把 OTLP 指标载荷摊平成 { name, attributes } 列表。 */
function flattenMetrics(payloads) {
  const out = [];
  for (const payload of payloads) {
    for (const resource of payload.resourceMetrics ?? []) {
      for (const scope of resource.scopeMetrics ?? []) {
        for (const metric of scope.metrics ?? []) {
          out.push({ name: metric.name, attributes: {} });
        }
      }
    }
  }
  return out;
}

/** 把 OTLP 追踪载荷摊平成 { name, attributes } 列表。 */
function flattenTraces(payloads) {
  const out = [];
  for (const payload of payloads) {
    for (const resource of payload.resourceSpans ?? []) {
      for (const scope of resource.scopeSpans ?? []) {
        for (const span of scope.spans ?? []) {
          const attributes = {};
          for (const entry of span.attributes ?? []) {
            const value = entry.value ?? {};
            attributes[entry.key] = value.stringValue ?? value.intValue ?? value.boolValue ?? value.doubleValue;
          }
          out.push({ name: span.name, attributes });
        }
      }
    }
  }
  return out;
}

test('新建项目：名称为空回退目录末段，路径规范化为绝对路径', async () => {
  const { root, workspace } = makeWorkspace('wp09-projects-create');
  const ctx = await openStack({ root });
  try {
    const created = await ctx.chatdshProjects.create({
      path: `${workspace}/./`,
      title: '   ',
      instructions: '项目说明原文\n第二行保留原样',
    });
    assert.equal(created.path, workspace, '末尾斜杠与点段应当被规范化掉');
    assert.equal(created.title, '', '全空白的名称按空名称保存');
    assert.equal(created.displayTitle, 'workspace', '名称为空时展示目录末段');
    assert.equal(created.instructions, '项目说明原文\n第二行保留原样', '项目说明保留完整文本');
    assert.equal(created.revision, 1, '新建记录从版本 1 开始');

    const listed = ctx.chatdshProjects.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].path, workspace, '列表返回规范化后的路径');
    assert.equal(ctx.chatdshProjects.get(`${workspace}/`).displayTitle, 'workspace', '读取同样接受未规范化的写法');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('路径校验：相对路径、非目录与不存在目录都被拒绝', async () => {
  const { root, workspace } = makeWorkspace('wp09-projects-path');
  const ctx = await openStack({ root });
  try {
    await assert.rejects(
      () => ctx.chatdshProjects.create({ path: 'relative/dir', instructions: '' }),
      (error) => error.code === CHATDSH_ERROR_CODES.requestInvalid,
      '相对路径必须被拒绝',
    );
    const filePath = join(workspace, 'note.txt');
    writeFileSync(filePath, '内容');
    await assert.rejects(
      () => ctx.chatdshProjects.create({ path: filePath, instructions: '' }),
      (error) => error.code === CHATDSH_ERROR_CODES.requestInvalid,
      '文件路径不能作为项目目录',
    );
    await assert.rejects(
      () => ctx.chatdshProjects.create({ path: join(workspace, 'missing'), instructions: '' }),
      (error) => error.code === CHATDSH_ERROR_CODES.requestInvalid,
      '不存在的目录不能新建项目',
    );
    await assert.rejects(
      () => ctx.chatdshProjects.create({ path: ` ${workspace}`, instructions: '' }),
      (error) => error.code === CHATDSH_ERROR_CODES.requestInvalid,
      '前后带空白的路径必须被拒绝',
    );
    assert.equal(ctx.chatdshProjects.list().length, 0, '被拒绝的创建不留下记录');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('同名目录拒绝重复新建，已有记录不被改写', async () => {
  const { root, workspace } = makeWorkspace('wp09-projects-duplicate');
  const ctx = await openStack({ root });
  try {
    const first = await ctx.chatdshProjects.create({ path: workspace, title: '第一个', instructions: '原文' });
    await assert.rejects(
      () => ctx.chatdshProjects.create({ path: `${workspace}/`, title: '第二份', instructions: '覆盖' }),
      (error) => error.code === CHATDSH_ERROR_CODES.requestInvalid,
      '同一目录不能有第二份记录',
    );
    const current = ctx.chatdshProjects.get(workspace);
    assert.equal(current.title, '第一个');
    assert.equal(current.revision, first.revision, '被拒绝的创建不改版本');
    assert.equal(ctx.chatdshProjects.list().length, 1);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('过期 revision 抛 revision-conflict，并发写入只成功一次', async () => {
  const { root, workspace } = makeWorkspace('wp09-projects-revision');
  const ctx = await openStack({ root });
  try {
    const created = await ctx.chatdshProjects.create({ path: workspace, instructions: '初始说明' });
    const updated = await ctx.chatdshProjects.set({ path: workspace, instructions: '第二次说明', revision: created.revision });
    assert.equal(updated.revision, 2, '写入成功后版本递增');
    await assert.rejects(
      () => ctx.chatdshProjects.set({ path: workspace, instructions: '落后版本', revision: created.revision }),
      (error) => error.code === CHATDSH_ERROR_CODES.revisionConflict,
      '落后版本必须被拒绝',
    );
    assert.equal(ctx.chatdshProjects.get(workspace).instructions, '第二次说明', '被拒绝的写入不改内容');

    const results = await Promise.allSettled([
      ctx.chatdshProjects.set({ path: workspace, instructions: '并发甲', revision: updated.revision }),
      ctx.chatdshProjects.set({ path: workspace, instructions: '并发乙', revision: updated.revision }),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    assert.equal(fulfilled.length, 1, '同一版本的两个并发写入只成功一个');
    assert.equal(rejected.length, 1, '另一个并发写入被拒绝');
    assert.equal(rejected[0].reason.code, CHATDSH_ERROR_CODES.revisionConflict);
    assert.equal(ctx.chatdshProjects.get(workspace).revision, 3, '只前进一步');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('默认模型与默认助手引用校验', async () => {
  const { root, workspace } = makeWorkspace('wp09-projects-references');
  const ctx = await openStack({ root });
  try {
    await assert.rejects(
      () => ctx.chatdshProjects.set({ path: workspace, defaultModel: 'missing-provider/some-model' }),
      (error) => error.code === CHATDSH_ERROR_CODES.requestInvalid,
      '未注册的模型路由必须被拒绝',
    );
    await assert.rejects(
      () => ctx.chatdshProjects.set({ path: workspace, defaultModel: 'gateway' }),
      (error) => error.code === CHATDSH_ERROR_CODES.requestInvalid,
      '不带模型标识的引用必须被拒绝',
    );
    await assert.rejects(
      () => ctx.chatdshProjects.set({ path: workspace, defaultAssistant: 'assistant-not-registered' }),
      (error) => error.code === CHATDSH_ERROR_CODES.requestInvalid,
      '未注册的默认助手必须被拒绝',
    );

    const releaseRoute = registerGatewayRoute(ctx);
    await ctx.agentPresets.register({ id: 'assistant-demo', name: '示例助手', description: '', order: 3, plugins: [] });
    const record = await ctx.chatdshProjects.set({
      path: workspace,
      instructions: '引用齐全',
      defaultModel: 'gateway/xhs/dots3-note-prev',
      defaultAssistant: 'assistant-demo',
    });
    assert.equal(record.defaultModel, 'gateway/xhs/dots3-note-prev');
    assert.equal(record.defaultAssistant, 'assistant-demo');
    releaseRoute();
  } finally {
    await ctx.fiber.dispose();
  }
});

test('删除只移除配置：目录内容与既有会话保持原样', async () => {
  const { root, workspace } = makeWorkspace('wp09-projects-delete');
  const ctx = await openStack({ root });
  try {
    const record = await ctx.chatdshProjects.create({ path: workspace, title: '待删', instructions: '说明' });
    const session = ctx.sessions.create('session-wp09-project', { meta: { cwd: workspace, agentPreset: 'chatdsh-work' } });
    writeFileSync(join(workspace, 'keep.txt'), '保留内容');

    const removed = await ctx.chatdshProjects.remove(workspace);
    assert.equal(removed, true);
    assert.equal(ctx.chatdshProjects.get(workspace), undefined, '记录被移除');
    assert.equal(ctx.chatdshProjects.list().length, 0);
    assert.equal(statSync(workspace).isDirectory(), true, '目录仍在');
    assert.equal(statSync(join(workspace, 'keep.txt')).size, Buffer.byteLength('保留内容'), '目录内容原样保留');
    assert.equal(ctx.sessions.get('session-wp09-project').header.cwd, workspace, '既有会话仍指向该目录');
    assert.equal(session.header.agentPreset, 'chatdsh-work');

    assert.equal(await ctx.chatdshProjects.remove(workspace), false, '再次删除不报错也不生效');
    assert.equal(record.revision, 1);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('实例重建后记录、版本与内容都保留', async () => {
  const { root, workspace } = makeWorkspace('wp09-projects-restart');
  const first = await openStack({ root });
  let created;
  try {
    created = await first.chatdshProjects.create({ path: workspace, title: '重建前', instructions: '持久化说明' });
    await first.chatdshProjects.set({ path: workspace, instructions: '第二次说明', revision: created.revision });
  } finally {
    await first.fiber.dispose();
    await settle(300);
  }

  const second = await openStack({ root });
  try {
    const listed = second.chatdshProjects.list();
    assert.equal(listed.length, 1, '重建后仍能读到记录');
    assert.equal(listed[0].path, workspace);
    assert.equal(listed[0].title, '重建前');
    assert.equal(listed[0].instructions, '第二次说明');
    assert.equal(listed[0].revision, 2, '版本随数据一起持久化');
    await assert.rejects(
      () => second.chatdshProjects.set({ path: workspace, instructions: '落后版本', revision: 1 }),
      (error) => error.code === CHATDSH_ERROR_CODES.revisionConflict,
      '重建后仍然拒绝过期 revision',
    );
  } finally {
    await second.fiber.dispose();
  }
});

test('失败分支写出拒绝事件、动作 span 与计数指标', async () => {
  const { root, workspace } = makeWorkspace('wp09-projects-telemetry');
  const collector = await startCollector();
  let telemetry;
  let ctx;
  try {
    telemetry = createTelemetryClient({
      config: defaultTelemetryConfig({
        endpoint: collector.url,
        exportIntervalMs: 100,
        exportIntervalMsMetrics: 100,
        exportTimeoutMs: 50,
      }),
      component: '@chatdsh/host-projects',
    });
    assert.equal(telemetry.enabled, true, '遥测客户端应当在开启状态');
    ctx = await openStack({ root, telemetry });
    await assert.rejects(
      () => ctx.chatdshProjects.set({ path: workspace, instructions: '', revision: 9 }),
      (error) => error.code === CHATDSH_ERROR_CODES.revisionConflict,
    );
    await ctx.chatdshProjects.set({ path: workspace, instructions: '成功写入' });
    await telemetry.flush(3000);

    const logs = flattenLogs(collector.records().logs);
    const rejection = logs.find((entry) => entry.name === 'chatdsh.runtime.project.rejected');
    assert.ok(rejection !== undefined, '拒绝分支应当写出一条事件');
    assert.equal(rejection.attributes['error.code'], CHATDSH_ERROR_CODES.revisionConflict);
    assert.equal(rejection.attributes.outcome, 'failed');
    assert.equal(rejection.attributes.action, 'set');
    assert.ok(rejection.attributes['error.type'] !== undefined, '事件带 error.type');

    const metrics = flattenMetrics(collector.records().metrics);
    assert.ok(
      metrics.some((entry) => entry.name === 'chatdsh_runtime_project_writes_total'),
      '计数指标应当被导出',
    );

    const spans = flattenTraces(collector.records().traces);
    const span = spans.find((entry) => entry.name === 'chatdsh.runtime.project.write');
    assert.ok(span !== undefined, '动作 span 应当被导出');
    assert.equal(span.attributes.action, 'set');
    assert.equal(span.attributes.outcome, 'failed');
  } finally {
    if (telemetry !== undefined) await telemetry.shutdown();
    await collector.close();
    if (ctx !== undefined) await ctx.fiber.dispose();
  }
});
