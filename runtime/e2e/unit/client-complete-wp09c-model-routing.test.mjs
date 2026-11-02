// WP09-B 模型提供方、模型路由与上下文占用宿主的验收测试。
//
// 每个用例在 runtime/.run 下分配独立数据根，用真实的存储中枢、JSON 后端、存储域、模型运行时、
// 会话注册表、会话投影注册表、会话插件与默认模型服务装配。路由插件自己把网关适配器注册进
// 模型运行时，入口地址指向本机一个未监听的端口：请求在网络层失败，业务判定不依赖任何替身。
//
// 覆盖提供方注册与凭据状态、模型清单来源与不支持报告、额度与用量查询及重启恢复、路由选择与
// 额度回退、会话模型首轮固定与过期版本拒绝、上下文占用的比例与窗口来源及降级原因、以及
// 失败分支的事件、动作 span 与计数指标。
//
// 运行：node --test e2e/unit/client-complete-wp09c-model-routing.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
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
const { default: LlmRuntime } = await import('@deepseek-ai/dsh-llm');
const { default: SessionProjectionRegistry } = await import('@deepseek-ai/dsh-session-projection');
const { default: SessionPlugin } = await import('@deepseek-ai/dsh-session');
const { default: AgentDefaultModel } = await import('@deepseek-ai/dsh-agent-default-model');
const sessionIndex = await import('../../packages/core/session-index/lib/index.js');
const usageProjection = await import('../../packages/host/usage/lib/index.js');
const llmRouter = await import('../../packages/host/llm-router/lib/index.js');
const modelProvider = await import('../../packages/host/model-provider/lib/index.js');
const contextInsights = await import('../../packages/host/context-insights/lib/index.js');
const { CHATDSH_ERROR_CODES } = await import('../../packages/core/contracts/lib/index.js');
const { createTelemetryClient } = await import('../../packages/core/diagnostics/lib/index.js');
const { defaultTelemetryConfig } = await import('../../packages/core/diagnostics/lib/config.js');

/** 网关入口地址：本机未监听的端口，请求在网络层失败。 */
const GATEWAY_URL = 'http://127.0.0.1:1/llm';

/** 等待插件树激活。 */
function settle(ms = 1200) {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * 按真实宿主注册方式装配一套模型相关服务的运行环境。
 * @param {object} options 路由、提供方、默认模型与遥测客户端。
 * @returns {Promise<import('@deepseek-ai/cordis').Context>} 上下文。
 */
async function openStack(options = {}) {
  const {
    root,
    routes = [{ provider: 'gateway' }],
    providers = [],
    baseUrl = GATEWAY_URL,
    defaultModel,
    telemetry,
    router = true,
    catalog = true,
    insights = true,
    usage = true,
    windowTokens = 131072,
  } = options;
  const ctx = new Context();
  ctx.plugin(Storage);
  ctx.plugin(json, { root: join(root, 'storages') });
  ctx.plugin(domainPlugin, { backend: 'json' });
  ctx.plugin(LlmRuntime);
  ctx.plugin(SessionProjectionRegistry);
  ctx.plugin(SessionPlugin);
  ctx.plugin(sessionIndex);
  if (usage) ctx.plugin(usageProjection);
  if (defaultModel !== undefined) ctx.plugin(AgentDefaultModel, defaultModel);
  if (telemetry !== undefined) ctx.provide('chatdshTelemetry', telemetry);
  if (router) ctx.plugin(llmRouter.ChatdshLlmRouterService, { baseUrl, routes });
  if (catalog) ctx.plugin(modelProvider.ChatdshModelProviderService, { providers });
  if (insights) ctx.plugin(contextInsights.ChatdshContextInsightsService, { windowTokens });
  await settle();
  return ctx;
}

/**
 * 只装载存储域的上下文，用来在服务之外写入并读回用量账本。
 * @param {string} root 数据根。
 * @returns {Promise<{ ctx: import('@deepseek-ai/cordis').Context, domain: object }>} 上下文与域。
 */
async function openStorage(root) {
  const ctx = new Context();
  ctx.plugin(Storage);
  ctx.plugin(json, { root: join(root, 'storages') });
  ctx.plugin(domainPlugin, { backend: 'json' });
  await settle(600);
  const domain = await ctx.storageDomain.open(llmRouter.LLM_ROUTER_DOMAIN);
  return { ctx, domain };
}

/**
 * 通过真实用量账本写入一次用量，随后关闭存储。
 * @param {string} root 数据根。
 * @param {string} provider provider 路由标识。
 * @param {{ inputTokens: number, outputTokens: number }} delta 用量增量。
 */
async function seedUsage(root, provider, delta) {
  const { ctx, domain } = await openStorage(root);
  const ledger = new llmRouter.UsageLedger(() => domain.table('usage'));
  ledger.load();
  const failure = await ledger.record(provider, delta);
  assert.equal(failure, undefined, '用量应当写进存储');
  await domain.close();
  await ctx.fiber.dispose();
}

/**
 * 消费一个模型请求，返回最后一个分块。请求在网络层失败或业务拒绝时都是终止分块。
 * @param {import('@deepseek-ai/cordis').Context} ctx 上下文。
 * @param {object} options 请求。
 * @returns {Promise<object | undefined>} 终止分块。
 */
async function lastChunk(ctx, options) {
  let last;
  for await (const chunk of ctx.llm.stream(options)) last = chunk;
  return last;
}

/** 构造一次普通对话请求。 */
function request(provider, model, sessionId) {
  return {
    provider,
    model,
    ...(sessionId === undefined ? {} : { sessionId }),
    messages: [{ role: 'user', content: [{ type: 'text', text: '只回复两个字：收到' }] }],
  };
}

/** 起一个真实接收 OTLP/HTTP 请求的收集器。 */
async function startCollector() {
  const bodies = { logs: [], traces: [], metrics: [] };
  const server = createServer((request_, response) => {
    const chunks = [];
    request_.on('data', (chunk) => chunks.push(chunk));
    request_.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const signal = request_.url?.includes('/v1/logs') ? 'logs' : request_.url?.includes('/v1/traces') ? 'traces' : 'metrics';
      bodies[signal].push(JSON.parse(text));
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

test('提供方目录：注册状态、凭据状态与端点掩码，未注册路由明确拒绝', async () => {
  const root = tempHome('wp09c-providers');
  const ctx = await openStack({
    root,
    providers: [
      {
        provider: 'gateway',
        displayName: '模型网关',
        baseUrl: GATEWAY_URL,
        models: ['xhs/dots3-note-prev'],
        apiKeyEnv: 'CHATDSH_WP09C_UNSET_KEY',
      },
      {
        provider: 'alt',
        displayName: '备用端点',
        baseUrl: 'https://user:secret@llm.example.com/v1?token=abc',
        models: ['alt-model'],
      },
    ],
  });
  try {
    const listed = ctx.chatdshModelProviders.list();
    assert.equal(listed.length, 2, '两个已配置的提供方都在目录里');
    const gateway = listed.find((entry) => entry.provider === 'gateway');
    assert.equal(gateway.displayName, '模型网关');
    assert.equal(gateway.registered, true, '路由插件已把网关路由注册进模型运行时');
    assert.equal(gateway.available, false, '凭据变量没有设置时不报告可用');
    assert.deepEqual(gateway.credential, { env: 'CHATDSH_WP09C_UNSET_KEY', configured: false });
    assert.equal(gateway.baseUrl, GATEWAY_URL, '没有凭据与查询串的端点原样显示');

    const alt = listed.find((entry) => entry.provider === 'alt');
    assert.equal(alt.registered, false, '没有路由的提供方不报告已注册');
    assert.equal(alt.available, false);
    assert.equal(alt.baseUrl, 'https://***@llm.example.com/v1?***', '端点里的凭据与查询串被掩掉');
    assert.equal(JSON.stringify(listed).includes('secret'), false, '凭据值不出现在的返回值里');

    const catalog = await ctx.chatdshModelProviders.models('gateway');
    assert.equal(catalog.source, 'config', '适配器不发布目录时用部署配置声明的模型');
    assert.equal(catalog.reason, 'adapter-publishes-no-catalog');
    assert.deepEqual(catalog.models.map((model) => model.id), ['xhs/dots3-note-prev']);
    assert.equal(catalog.models[0].contextSource, 'unavailable', '适配器没有披露上下文窗口');
    assert.equal(catalog.models[0].contextWindow, undefined, '不补猜测的上下文窗口');

    await assert.rejects(
      () => ctx.chatdshModelProviders.models('alt'),
      (error) => error.code === CHATDSH_ERROR_CODES.requestInvalid && error.details.reason === 'route-unregistered',
      '路由没有注册的提供方读不到清单，按输入不合法拒绝',
    );
    await assert.rejects(
      () => ctx.chatdshModelProviders.models('missing'),
      (error) => error.code === CHATDSH_ERROR_CODES.objectNotFound,
      '没有配置的提供方按目标不存在拒绝',
    );

    const status = await ctx.chatdshModelProviders.status();
    assert.equal(status.providers, 2);
    assert.equal(status.available, false);
    assert.equal(status.state, 'degraded');
    assert.equal(status.reason, 'credential-missing');
    assert.equal(status.catalog.length, 2);
    assert.equal(status.catalog.find((summary) => summary.provider === 'alt').reason, 'route-unregistered');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('未启用与不支持分开报告：没有提供方是 disabled，不发布目录是 catalog-unsupported', async () => {
  const disabledRoot = tempHome('wp09c-disabled');
  const disabled = await openStack({ root: disabledRoot, routes: [], providers: [] });
  try {
    const status = await disabled.chatdshModelProviders.status();
    assert.equal(status.state, 'disabled', '没有配置提供方属于未启用');
    assert.equal(status.reason, 'no-providers');
    assert.equal(status.available, false);
    assert.equal(status.providers, 0);
    assert.deepEqual(disabled.chatdshModelProviders.list(), []);
  } finally {
    await disabled.fiber.dispose();
  }

  const unsupportedRoot = tempHome('wp09c-unsupported');
  const unsupported = await openStack({
    root: unsupportedRoot,
    providers: [{ provider: 'gateway', displayName: '模型网关', baseUrl: GATEWAY_URL }],
  });
  try {
    const catalog = await unsupported.chatdshModelProviders.models('gateway');
    assert.equal(catalog.source, 'unsupported', '适配器不发布目录且配置没有声明模型时报告不支持');
    assert.equal(catalog.reason, 'adapter-publishes-no-catalog');
    assert.deepEqual(catalog.models, [], '不支持时不编造任何模型标识');

    const status = await unsupported.chatdshModelProviders.status();
    assert.equal(status.state, 'degraded');
    assert.equal(status.reason, 'catalog-unsupported');
    assert.equal(status.available, true, '路由与凭据齐备，提供方本身可用');
  } finally {
    await unsupported.fiber.dispose();
  }
});

test('额度与用量：读取真实账本，重启后仍以持久化用量作为启动读数', async () => {
  const root = tempHome('wp09c-quota');
  await seedUsage(root, 'gateway', { inputTokens: 40, outputTokens: 60 });

  const first = await openStack({
    root,
    routes: [{ provider: 'gateway', limit: 200 }],
    providers: [{ provider: 'gateway', displayName: '模型网关', baseUrl: GATEWAY_URL, models: ['xhs/dots3-note-prev'] }],
  });
  try {
    const quota = await first.chatdshLlmRouter.quota('gateway');
    assert.equal(quota.limit, 200);
    assert.equal(quota.used, 100, '启动读数由部署基线与持久化用量共同给出');
    assert.equal(quota.remaining, 100);
    assert.equal(quota.allowed, true);
    assert.equal(typeof quota.measuredAt, 'number');

    const usage = await first.chatdshLlmRouter.usage('gateway');
    assert.equal(usage.persisted, true);
    assert.equal(usage.records.length, 1);
    assert.equal(usage.records[0].inputTokens, 40);
    assert.equal(usage.records[0].outputTokens, 60);
    assert.equal(usage.records[0].requests, 1);

    await assert.rejects(
      () => first.chatdshLlmRouter.quota('missing'),
      (error) => error.code === CHATDSH_ERROR_CODES.objectNotFound,
      '没有这条路由的额度按目标不存在拒绝',
    );

    const summary = first.chatdshLlmRouter.routes();
    assert.equal(summary.length, 1);
    assert.equal(summary[0].quota.used, 100);
    assert.equal(summary[0].registered, true);

    const providerQuota = await first.chatdshModelProviders.quota('gateway');
    assert.equal(providerQuota.state, 'available');
    assert.equal(providerQuota.used, 100);
    assert.equal(providerQuota.remaining, 100);

    const providerUsage = await first.chatdshModelProviders.usage('gateway');
    assert.equal(providerUsage.length, 1);
    assert.equal(providerUsage[0].state, 'available');
    assert.equal(providerUsage[0].inputTokens, 40);
    assert.equal(providerUsage[0].requests, 1);
    assert.equal(providerUsage[0].persisted, true);
  } finally {
    await first.fiber.dispose();
    await settle(300);
  }

  const second = await openStack({
    root,
    routes: [{ provider: 'gateway', limit: 200 }],
    providers: [{ provider: 'gateway', displayName: '模型网关', baseUrl: GATEWAY_URL }],
  });
  try {
    const quota = await second.chatdshLlmRouter.quota('gateway');
    assert.equal(quota.used, 100, '重启后用量与已用额度一起恢复');
    const usage = await second.chatdshLlmRouter.usage('gateway');
    assert.equal(usage.records[0].requests, 1);
  } finally {
    await second.fiber.dispose();
  }
});

test('路由选择：默认模型、额度回退与失败原因', async () => {
  const root = tempHome('wp09c-select');
  const ctx = await openStack({
    root,
    routes: [{ provider: 'gateway', limit: 0 }, { provider: 'alt' }],
    defaultModel: { provider: 'alt', model: 'alt-model' },
    catalog: false,
  });
  try {
    const fallback = await ctx.chatdshLlmRouter.select({ provider: 'gateway', model: 'xhs/dots3-note-prev' });
    assert.equal(fallback.source, 'fallback');
    assert.equal(fallback.fallbackReason, 'quota-exhausted');
    assert.equal(fallback.provider, 'alt');
    assert.equal(fallback.model, 'alt-model');
    assert.equal(fallback.catalogVerified, false, '适配器不发布目录时不声称校验过模型成员');

    const byDefault = await ctx.chatdshLlmRouter.select({});
    assert.equal(byDefault.source, 'default');
    assert.equal(byDefault.provider, 'alt');
    assert.equal(byDefault.model, 'alt-model');

    await assert.rejects(
      () => ctx.chatdshLlmRouter.select({ provider: 'missing', model: 'any' }),
      (error) => error.code === CHATDSH_ERROR_CODES.objectNotFound,
      '未注册的提供方按目标不存在拒绝',
    );
    await assert.rejects(
      () => ctx.chatdshLlmRouter.select({ provider: 'gateway' }),
      (error) => error.code === CHATDSH_ERROR_CODES.requestInvalid,
      '只给 provider 不给模型必须拒绝',
    );

    const routes = ctx.chatdshLlmRouter.routes();
    assert.deepEqual(routes.map((route) => route.provider), ['alt', 'gateway']);
    assert.equal(routes.find((route) => route.provider === 'alt').default, true);
    assert.equal(routes.find((route) => route.provider === 'gateway').default, false);
    assert.equal(routes.find((route) => route.provider === 'gateway').quota.allowed, false);
  } finally {
    await ctx.fiber.dispose();
  }

  const lonelyRoot = tempHome('wp09c-select-lonely');
  const lonely = await openStack({ root: lonelyRoot, routes: [{ provider: 'gateway', limit: 0 }], catalog: false, insights: false });
  try {
    await assert.rejects(
      () => lonely.chatdshLlmRouter.select({}),
      (error) => error.code === CHATDSH_ERROR_CODES.requestInvalid && error.details.reason === 'default-model-missing',
      '没有默认模型时不给隐式选择',
    );
    await assert.rejects(
      () => lonely.chatdshLlmRouter.select({ provider: 'gateway', model: 'xhs/dots3-note-prev' }),
      (error) => error.code === CHATDSH_ERROR_CODES.quotaExceeded,
      '额度用尽且没有可回退的默认模型时按额度拒绝',
    );
  } finally {
    await lonely.fiber.dispose();
  }
});

test('会话模型：首轮写入后固定，改写按版本冲突拒绝，重启后仍固定', async () => {
  const root = tempHome('wp09c-fixed');
  const first = await openStack({
    root,
    routes: [{ provider: 'gateway' }],
    defaultModel: { provider: 'gateway', model: 'xhs/dots3-note-prev' },
    catalog: false,
    insights: false,
  });
  let sessionId;
  let boundAt;
  try {
    const session = first.sessions.create('wp09c-session-fixed', { meta: {} });
    sessionId = session.id;
    assert.equal(await first.chatdshLlmRouter.sessionModel(sessionId), undefined, '新建会话还没有固定模型');

    const finish = await lastChunk(first, request('gateway', 'xhs/dots3-note-prev', sessionId));
    assert.equal(finish.type, 'finish');
    assert.equal(finish.reason.kind, 'error', '上游不可达，请求在网络层失败');
    assert.equal(finish.reason.failure.message, 'fetch failed');

    const binding = await first.chatdshLlmRouter.sessionModel(sessionId);
    assert.equal(binding.provider, 'gateway');
    assert.equal(binding.model, 'xhs/dots3-note-prev');
    assert.equal(binding.revision, 1);
    boundAt = binding.boundAt;

    const locked = await lastChunk(first, request('gateway', 'another-model', sessionId));
    assert.equal(locked.reason.kind, 'error');
    assert.equal(locked.reason.failure.message, '会话模型已固定，不能再改');
    assert.equal((await first.chatdshLlmRouter.sessionModel(sessionId)).model, 'xhs/dots3-note-prev');

    const same = await first.chatdshLlmRouter.bindSession({
      sessionId,
      provider: 'gateway',
      model: 'xhs/dots3-note-prev',
      revision: 1,
    });
    assert.equal(same.revision, 1, '重复绑定同一个模型按原样返回');
    assert.equal(same.boundAt, boundAt, '固定时刻不变');

    await assert.rejects(
      () => first.chatdshLlmRouter.bindSession({ sessionId, provider: 'gateway', model: 'another-model', revision: 1 }),
      (error) => error.code === CHATDSH_ERROR_CODES.revisionConflict,
      '换成别的模型按版本冲突拒绝',
    );
    await assert.rejects(
      () => first.chatdshLlmRouter.bindSession({ sessionId, provider: 'gateway', model: 'xhs/dots3-note-prev', revision: 99 }),
      (error) => error.code === CHATDSH_ERROR_CODES.revisionConflict,
      '过期的 revision 必须拒绝',
    );
    await assert.rejects(
      () => first.chatdshLlmRouter.bindSession({ sessionId: 'wp09c-missing-session', provider: 'gateway', model: 'm' }),
      (error) => error.code === CHATDSH_ERROR_CODES.sessionNotFound,
      '未知会话不能绑定模型',
    );

    const fresh = first.sessions.create('wp09c-session-fresh', { meta: {} });
    await assert.rejects(
      () => first.chatdshLlmRouter.bindSession({ sessionId: fresh.id, provider: 'gateway', model: 'm', revision: 5 }),
      (error) => error.code === CHATDSH_ERROR_CODES.revisionConflict,
      '还没有绑定时只接受版本 0',
    );
  } finally {
    await first.fiber.dispose();
    await settle(300);
  }

  const second = await openStack({ root, routes: [{ provider: 'gateway' }], catalog: false, insights: false });
  try {
    const binding = await second.chatdshLlmRouter.sessionModel(sessionId);
    assert.equal(binding.provider, 'gateway');
    assert.equal(binding.model, 'xhs/dots3-note-prev');
    assert.equal(binding.revision, 1);
    assert.equal(binding.boundAt, boundAt, '固定时刻随记录一起持久化');

    const locked = await lastChunk(second, request('gateway', 'another-model', sessionId));
    assert.equal(locked.reason.failure.message, '会话模型已固定，不能再改', '重启后固定仍然生效');
  } finally {
    await second.fiber.dispose();
  }
});

test('上下文占用：比例、剩余、窗口来源、全会话查询与降级原因', async () => {
  const root = tempHome('wp09c-insights');
  const ctx = await openStack({
    root,
    routes: [{ provider: 'gateway' }],
    defaultModel: { provider: 'gateway', model: 'xhs/dots3-note-prev' },
  });
  try {
    const bound = ctx.sessions.create('wp09c-context-bound', { meta: {} });
    const unbound = ctx.sessions.create('wp09c-context-unbound', { meta: {} });
    await ctx.chatdshLlmRouter.bindSession({ sessionId: bound.id, provider: 'gateway', model: 'xhs/dots3-note-prev' });

    const insight = await ctx.chatdshContextInsights.insight(bound.id);
    assert.equal(insight.windowTokens, 131072, '目录没有披露窗口时用配置窗口');
    assert.equal(insight.window.source, 'config');
    assert.equal(insight.window.degraded, true);
    assert.equal(insight.window.reason, 'catalog-unsupported', '写明降级原因');
    assert.equal(insight.window.provider, 'gateway');
    assert.equal(insight.window.model, 'xhs/dots3-note-prev');
    assert.equal(insight.tokensSource, 'usage-projection', '用量投影已装载，token 计数来自它');
    assert.equal(insight.usedTokens, 0);
    assert.equal(insight.usedRatio, 0);
    assert.equal(insight.remainingTokens, 131072);
    assert.equal(insight.level, 'ok');
    assert.equal(insight.events, 0);

    const unboundInsight = await ctx.chatdshContextInsights.insight(unbound.id);
    assert.equal(unboundInsight.window.reason, 'no-session-model');
    assert.equal(unboundInsight.window.source, 'config');

    const all = await ctx.chatdshContextInsights.all();
    assert.deepEqual(Object.keys(all).sort(), [bound.id, unbound.id].sort());
    assert.equal(all[bound.id].window.reason, 'catalog-unsupported');

    await assert.rejects(
      () => ctx.chatdshContextInsights.insight('wp09c-missing-session'),
      (error) => error.code === CHATDSH_ERROR_CODES.sessionNotFound,
      '未知会话按会话不存在拒绝',
    );

    const catalogWindow = contextInsights.summarizeContext({
      events: 12,
      inputTokens: 300,
      outputTokens: 200,
      window: { tokens: 1000, source: 'model-catalog', degraded: false, provider: 'gateway', model: 'xhs/dots3-note-prev' },
      tokensSource: 'usage-projection',
    });
    assert.equal(catalogWindow.usedRatio, 0.5);
    assert.equal(catalogWindow.level, 'ok');
    assert.equal(catalogWindow.remainingTokens, 500);
    assert.equal(catalogWindow.window.source, 'model-catalog');
    assert.equal(catalogWindow.window.degraded, false);
    assert.equal(catalogWindow.events, 12);

    const warn = contextInsights.summarizeContext({
      events: 1,
      inputTokens: 500,
      outputTokens: 200,
      window: { tokens: 1000, source: 'model-catalog', degraded: false },
      tokensSource: 'usage-projection',
    });
    assert.equal(warn.level, 'warn');
    const critical = contextInsights.summarizeContext({
      events: 1,
      inputTokens: 700,
      outputTokens: 200,
      window: { tokens: 1000, source: 'model-catalog', degraded: false },
      tokensSource: 'usage-projection',
    });
    assert.equal(critical.level, 'critical');
    assert.equal(critical.remainingTokens, 100);
    assert.throws(
      () => contextInsights.summarizeContext({
        events: 0,
        inputTokens: 0,
        outputTokens: 0,
        window: { tokens: 0, source: 'config', degraded: true, reason: 'catalog-unsupported' },
        tokensSource: 'unavailable',
      }),
      /上下文窗口必须大于零/,
      '窗口不大于零必须拒绝，不能当成占用为零',
    );
  } finally {
    await ctx.fiber.dispose();
  }

  const lonelyRoot = tempHome('wp09c-insights-lonely');
  const lonely = await openStack({ root: lonelyRoot, router: false, catalog: false, usage: false });
  try {
    const session = lonely.sessions.create('wp09c-context-lonely', { meta: {} });
    const insight = await lonely.chatdshContextInsights.insight(session.id);
    assert.equal(insight.window.reason, 'router-unavailable', '没有装载路由服务时明确报告');
    assert.equal(insight.window.source, 'config');
    assert.equal(insight.windowTokens, 131072);
    assert.equal(insight.tokensSource, 'unavailable', '没有用量投影时明确报告 token 来源缺失');
  } finally {
    await lonely.fiber.dispose();
  }
});

test('真实流式请求带回用量后账本与额度一起前进，重启后仍保留', async () => {
  const server = createServer((incoming, response) => {
    incoming.on('data', () => {});
    incoming.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      response.write('data: {"type":"text-delta","index":0,"text":"收到"}\n\n');
      response.write('data: {"type":"usage","usage":{"inputTokens":3,"outputTokens":2,"totalTokens":5}}\n\n');
      response.write('data: {"type":"finish","reason":{"kind":"stop"}}\n\n');
      response.end();
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}/llm`;
  const root = tempHome('wp09c-stream-usage');
  let sessionId;
  try {
    const first = await openStack({
      root,
      baseUrl,
      routes: [{ provider: 'gateway', limit: 1000 }],
      insights: false,
      catalog: false,
    });
    try {
      const session = first.sessions.create('wp09c-stream-session', { meta: {} });
      sessionId = session.id;
      const chunks = [];
      for await (const chunk of first.llm.stream(request('gateway', 'xhs/dots3-note-prev', sessionId))) {
        chunks.push(chunk);
      }
      const finish = chunks.at(-1);
      assert.equal(finish.type, 'finish');
      assert.equal(finish.reason.kind, 'stop', '真实流式响应正常结束');

      const quota = await first.chatdshLlmRouter.quota('gateway');
      assert.equal(quota.used, 5, '用量按上游报告的 token 计入额度读数');
      assert.equal(quota.remaining, 995);

      const usage = await first.chatdshLlmRouter.usage('gateway');
      assert.equal(usage.persisted, true);
      assert.equal(usage.records[0].inputTokens, 3);
      assert.equal(usage.records[0].outputTokens, 2);
      assert.equal(usage.records[0].requests, 1);

      const binding = await first.chatdshLlmRouter.sessionModel(sessionId);
      assert.equal(binding.model, 'xhs/dots3-note-prev', '成功请求同样固定会话模型');
    } finally {
      await first.fiber.dispose();
      await settle(300);
    }

    const second = await openStack({ root, baseUrl, routes: [{ provider: 'gateway', limit: 1000 }], insights: false, catalog: false });
    try {
      const quota = await second.chatdshLlmRouter.quota('gateway');
      assert.equal(quota.used, 5, '重启后已用额度从持久化用量恢复');
      const usage = await second.chatdshLlmRouter.usage('gateway');
      assert.equal(usage.records[0].requests, 1);
      assert.equal((await second.chatdshLlmRouter.sessionModel(sessionId)).revision, 1);
    } finally {
      await second.fiber.dispose();
    }
  } finally {
    server.close();
  }
});

test('失败分支写出事件、动作 span 与计数指标', async () => {
  const root = tempHome('wp09c-telemetry');
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
      component: '@chatdsh/host-llm-router',
    });
    assert.equal(telemetry.enabled, true, '遥测客户端应当在开启状态');
    ctx = await openStack({
      root,
      routes: [{ provider: 'gateway' }, { provider: 'blocked', limit: 0 }],
      providers: [
        { provider: 'gateway', displayName: '模型网关', baseUrl: GATEWAY_URL },
        { provider: 'alt', displayName: '备用端点', baseUrl: GATEWAY_URL },
      ],
      defaultModel: { provider: 'gateway', model: 'xhs/dots3-note-prev' },
      telemetry,
    });

    const session = ctx.sessions.create('wp09c-telemetry-session', { meta: {} });
    await ctx.chatdshLlmRouter.bindSession({ sessionId: session.id, provider: 'gateway', model: 'xhs/dots3-note-prev' });
    const locked = await lastChunk(ctx, request('gateway', 'another-model', session.id));
    assert.equal(locked.reason.failure.message, '会话模型已固定，不能再改');

    const rejected = await lastChunk(ctx, request('blocked', 'any-model'));
    assert.equal(rejected.reason.kind, 'error', '额度拒绝在发出请求之前发生');

    await assert.rejects(
      () => ctx.chatdshLlmRouter.quota('missing'),
      (error) => error.code === CHATDSH_ERROR_CODES.objectNotFound,
    );
    await assert.rejects(
      () => ctx.chatdshModelProviders.models('alt'),
      (error) => error.code === CHATDSH_ERROR_CODES.requestInvalid,
    );
    const insight = await ctx.chatdshContextInsights.insight(session.id);
    assert.equal(insight.window.reason, 'catalog-unsupported');
    await telemetry.flush(3000);

    const logs = flattenLogs(collector.records().logs);
    const lockedEvent = logs.find((entry) => entry.name === 'chatdsh.runtime.model.provider.failed'
      && entry.attributes['error.code'] === CHATDSH_ERROR_CODES.revisionConflict);
    assert.ok(lockedEvent !== undefined, '会话模型锁定应当写出一条失败事件');
    assert.equal(lockedEvent.attributes.provider, 'gateway');
    assert.ok(lockedEvent.attributes['error.type'] !== undefined);

    const quotaEvent = logs.find((entry) => entry.name === 'chatdsh.llm.quota.rejected');
    assert.ok(quotaEvent !== undefined, '额度拒绝应当写出一条事件');
    assert.equal(quotaEvent.attributes['error.code'], CHATDSH_ERROR_CODES.quotaExceeded);

    const routeEvent = logs.find((entry) => entry.name === 'chatdsh.runtime.model.provider.failed'
      && entry.attributes['error.code'] === CHATDSH_ERROR_CODES.requestInvalid);
    assert.ok(routeEvent !== undefined, '路由未注册的拒绝应当写出一条事件');
    assert.equal(routeEvent.attributes.provider, 'alt');

    const spans = flattenTraces(collector.records().traces);
    const lockedSpan = spans.find((entry) => entry.name === 'chatdsh.llm.stream'
      && entry.attributes.outcome === 'session-model-locked');
    assert.ok(lockedSpan !== undefined, '会话模型锁定应当有一个动作 span');
    assert.equal(lockedSpan.attributes.provider, 'gateway');
    assert.equal(lockedSpan.attributes.model, 'another-model');
    assert.equal(lockedSpan.attributes['error.code'], CHATDSH_ERROR_CODES.revisionConflict);

    const quotaSpan = spans.find((entry) => entry.name === 'chatdsh.llm.stream'
      && entry.attributes.outcome === 'quota-rejected');
    assert.ok(quotaSpan !== undefined, '额度拒绝应当有一个动作 span');
    assert.equal(quotaSpan.attributes.provider, 'blocked');

    const callSpan = spans.find((entry) => entry.name === 'chatdsh.runtime.remote.call'
      && entry.attributes['rpc.method'] === 'chatdshLlmRouter/quota' && entry.attributes.outcome === 'failed');
    assert.ok(callSpan !== undefined, '失败的 Remote 调用应当有一个动作 span');

    const insightSpan = spans.find((entry) => entry.name === 'chatdsh.runtime.context.insight');
    assert.ok(insightSpan !== undefined, '上下文占用应当有一个动作 span');
    assert.equal(insightSpan.attributes['session.id'], session.id);
    assert.equal(insightSpan.attributes.outcome, 'ok');

    const metrics = flattenMetrics(collector.records().metrics);
    const names = new Set(metrics.map((entry) => entry.name));
    for (const name of [
      'chatdsh_llm_requests_total',
      'chatdsh_remote_calls_total',
      'chatdsh_model_provider_resolutions_total',
      'chatdsh_context_usage_ratio',
    ]) {
      assert.ok(names.has(name), `${name} 应当被导出`);
    }
  } finally {
    if (telemetry !== undefined) await telemetry.shutdown();
    await collector.close();
    if (ctx !== undefined) await ctx.fiber.dispose();
  }
});
