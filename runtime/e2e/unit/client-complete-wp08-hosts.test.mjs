// WP08 宿主侧的验收测试：审批、提问与计划接管都在真实装配上跑通。
//
// 装配是真实运行时：真实会话注册表、真实会话投影、真实代理循环、真实工具运行时、真实审批
// 服务与真实用户提问服务，测试只登记一条真实工具与一个真实的 `tools/pre-execute` 权限门。
// 因此「决定到达工具等待者」这一条由工具本体是否执行来证明，而不是由前端状态证明。
//
// 覆盖：单次决定与拒绝、超时、两个客户端竞争、失效卡片的三类原因、会话策略与作用范围说明、
// 全局分组与跳转地址、统计、提问的选择题与自由输入、跳过与校验失败、计划接管的单一编辑区与
// 草稿恢复、共享契约的形状、真实遥测客户端的信号导出。
//
// 运行：node --test e2e/unit/client-complete-wp08-hosts.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureDeps } from '../lib/ensure-deps.mjs';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';

const RUNTIME = resolve(import.meta.dirname, '../..');
ensureDeps(RUNTIME);
ensureDeps(resolve(RUNTIME, '..', 'dsh-adapter'));

const { Context } = await import('@deepseek-ai/cordis');
const { default: SessionPlugin } = await import('@deepseek-ai/dsh-session');
const { default: SessionProjectionRegistry } = await import('@deepseek-ai/dsh-session-projection');
const { default: LlmRuntime } = await import('@deepseek-ai/dsh-llm');
const { default: AgentRegistry } = await import('@deepseek-ai/dsh-agent');
const { default: AgentLoop } = await import('@deepseek-ai/dsh-agent-loop');
const { default: UserQuestions } = await import('@deepseek-ai/dsh-user-questions');
const { SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt');
const { ToolRuntime, defineTool } = await import('@deepseek-ai/dsh-tools');
const { default: ApprovalService } = await import('@deepseek-ai/dsh-user-approval');
const { TypertRemoteService } = await import('../../../dsh-adapter/lib/index.js');
const contracts = await import('../../packages/core/contracts/lib/index.js');
const diagnostics = await import('../../packages/core/diagnostics/lib/index.js');
const { defaultTelemetryConfig } = await import('../../packages/core/diagnostics/lib/config.js');
const approvalHost = await import('../../packages/host/approval/lib/index.js');

/** 操作标识的生成器，保证每次都不相同且满足契约写法。 */
let operationSeq = 0;

/**
 * 生成一个操作标识。
 * @returns 32 位十六进制写法。
 */
function nextOperationId() {
  operationSeq += 1;
  return operationSeq.toString(16).padStart(32, '0');
}

/**
 * 生成一个请求摘要。
 * @param seed - 区分不同请求的种子。
 * @returns 64 位十六进制写法。
 */
function digestOf(seed) {
  return seed.repeat(64).slice(0, 64);
}

/**
 * 起一个接收 OTLP/HTTP 请求的收集器。
 * @returns {Promise<{ url: string, records: () => object, close: () => Promise<void> }>} 收集器。
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

/**
 * 把 OTLP 载荷摊平成 { name, attributes } 列表。
 * @param payloads - 某一种信号的载荷。
 * @param signal - 信号种类。
 * @returns 记录列表。
 */
function flatten(payloads, signal) {
  const out = [];
  for (const payload of payloads) {
    if (signal === 'traces') {
      for (const resource of payload.resourceSpans ?? []) {
        for (const scope of resource.scopeSpans ?? []) {
          for (const span of scope.spans ?? []) {
            out.push({ name: span.name, attributes: attributesOf(span.attributes) });
          }
        }
      }
      continue;
    }
    if (signal === 'metrics') {
      for (const resource of payload.resourceMetrics ?? []) {
        for (const scope of resource.scopeMetrics ?? []) {
          for (const metric of scope.metrics ?? []) {
            for (const point of metric.sum?.dataPoints ?? []) {
              out.push({ name: metric.name, attributes: attributesOf(point.attributes) });
            }
          }
        }
      }
      continue;
    }
    for (const resource of payload.resourceLogs ?? []) {
      for (const scope of resource.scopeLogs ?? []) {
        for (const record of scope.logRecords ?? []) {
          out.push({ name: record.body?.stringValue ?? '', attributes: attributesOf(record.attributes) });
        }
      }
    }
  }
  return out;
}

/**
 * 把一组 OTLP 属性摊平成对象。
 * @param attributes - 属性列表。
 * @returns 键值对象。
 */
function attributesOf(attributes) {
  const out = {};
  for (const entry of attributes ?? []) {
    const value = entry.value ?? {};
    out[entry.key] = value.stringValue ?? value.intValue ?? value.boolValue ?? value.doubleValue;
  }
  return out;
}

/**
 * 装配一套真实的宿主环境。
 * @param {string} prefix - 独立数据根前缀。
 * @param {{ telemetry?: object, answerTimeoutMs?: number }} options - 可选的遥测客户端与等待上限。
 * @returns {Promise<object>} 上下文、服务、代理与清理函数。
 */
async function openHost(prefix, options = {}) {
  const home = allocateIndependentHome(prefix);
  const ctx = new Context();
  ctx.plugin(SessionPlugin);
  ctx.plugin(SessionProjectionRegistry);
  new SystemPrompt(ctx, {});
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(AgentLoop);
  await ctx.plugin(UserQuestions);
  new ApprovalService(ctx, { policy: 'ask' });
  if (options.telemetry !== undefined) ctx.provide('chatdshTelemetry', options.telemetry);

  const executed = [];
  ctx.tools.register(defineTool({
    name: 'wp08-write',
    description: '写入一个文件',
    parameters: { path: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
      render: () => [{ type: 'text', text: '已写入' }],
    },
    execute: async (args) => {
      executed.push(args.path);
      return { ok: true };
    },
  }));
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'wp08-write') return next();
    return { kind: 'ask', reason: '工作区之外写入' };
  });

  const service = new approvalHost.ChatdshApprovalService(ctx, {
    takeOver: true,
    answerTimeoutMs: options.answerTimeoutMs ?? 30_000,
    questionTimeoutMs: 30_000,
    deviceId: 'device-alpha',
  });
  await service[TypertRemoteService.init]();
  const handle = await ctx.agents.create({ sessionId: `${prefix}-session` });
  const agent = handle.agent;
  return {
    home,
    ctx,
    service,
    agent,
    handle,
    executed,
    async dispose() {
      await ctx.fiber.dispose();
      releaseIndependentHome(home);
    },
  };
}

/**
 * 发起一次真实工具调用。
 * @param host - 装配结果。
 * @param callId - 工具调用标识。
 * @returns 执行承诺。
 */
function callTool(host, callId) {
  host.agent.session.append('turn/start', { turn: host.agent.session.seq });
  return host.ctx.tools.execute({
    callId,
    name: 'wp08-write',
    arguments: { path: `/workspace/${callId}.txt` },
    agent: host.agent,
    signal: new AbortController().signal,
  });
}

/**
 * 等到卡片出现在待处理列表里。
 * @param service - 审批服务。
 * @param callId - 工具调用标识。
 * @returns 卡片。
 */
async function waitCard(service, callId) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const card = service.pending({ filter: 'waiting' }).cards.find((item) => item.callId === callId);
    if (card !== undefined) return card;
    await delay(20);
  }
  throw new Error(`等待卡片超时：${callId}`);
}

/**
 * 提交一次决定。
 * @param service - 审批服务。
 * @param card - 卡片。
 * @param choice - 选项。
 * @param decidedBy - 客户端标识。
 * @param confirmed - 是否确认扩大范围。
 * @returns 决定结果。
 */
function decide(service, card, choice, decidedBy, confirmed = false) {
  return service.decide({
    callId: card.callId,
    stateVersion: card.stateVersion,
    choice,
    operationId: nextOperationId(),
    requestDigest: digestOf('a'),
    escalationConfirmed: confirmed,
    decidedBy,
  });
}

test('批准之后真实工具继续执行，拒绝之后工具按拒绝结束', async () => {
  const host = await openHost('wp08-approve-deny');
  try {
    const approved = callTool(host, 'call-approved');
    const card = await waitCard(host.service, 'call-approved');
    assert.deepEqual(card.choices, ['once', 'session', 'always', 'deny']);
    assert.equal(card.capabilityScope, '工具 wp08-write 的本次调用');
    assert.equal(card.summary, '工作区之外写入');
    const result = decide(host.service, card, 'once', 'client-a');
    assert.equal(result.outcome, 'decided');
    contracts.approvalDecisionResultSchema.parse(result);
    const executed = await approved;
    assert.equal(executed.isError, false);
    assert.equal(host.executed.includes('/workspace/call-approved.txt'), true, '工具本体真的执行了');

    const denied = callTool(host, 'call-denied');
    const denyCard = await waitCard(host.service, 'call-denied');
    decide(host.service, denyCard, 'deny', 'client-a');
    const deniedResult = await denied;
    assert.equal(deniedResult.isError, true);
    assert.match(JSON.stringify(deniedResult.content), /rejected/);
    assert.equal(host.executed.includes('/workspace/call-denied.txt'), false, '被拒绝的调用没有执行工具本体');
  } finally {
    await host.dispose();
  }
});

test('两个客户端竞争同一卡片只成功一次，另一侧得到明确冲突', async () => {
  const host = await openHost('wp08-race');
  try {
    const pending = callTool(host, 'call-race');
    const card = await waitCard(host.service, 'call-race');
    const first = decide(host.service, card, 'once', 'client-a');
    const second = decide(host.service, card, 'deny', 'client-b');
    assert.equal(first.outcome, 'decided');
    assert.equal(second.outcome, 'already-decided');
    assert.equal(second.choice, 'once');
    contracts.approvalDecisionResultSchema.parse(second);
    assert.equal((await pending).isError, false);

    // 迟到的第三个客户端拿到的是失效说明，而不是又一次决定。
    const third = decide(host.service, card, 'deny', 'client-c');
    assert.equal(third.outcome, 'already-decided');
    const invalid = host.service.pending({ filter: 'handled' }).cards.find((item) => item.callId === 'call-race');
    assert.equal(invalid?.invalidReason, 'already-decided');
    assert.equal(invalid?.invalidText, '另一客户端已经处理了这张卡片');
  } finally {
    await host.dispose();
  }
});

test('超时之后等待者拿到不可用，卡片按失效收尾并计入统计', async () => {
  const host = await openHost('wp08-timeout', { answerTimeoutMs: 1_000 });
  try {
    const service = host.service;
    const pending = callTool(host, 'call-timeout');
    const deadline = Date.now() + 5_000;
    let card;
    while (Date.now() < deadline && card === undefined) {
      card = service.pending({ filter: 'waiting' }).cards.find((item) => item.callId === 'call-timeout');
      if (card === undefined) await delay(20);
    }
    assert.ok(card !== undefined, '卡片应当进入等待');
    const result = await Promise.race([pending, delay(5_000).then(() => undefined)]);
    assert.ok(result !== undefined, '工具在超时之后结束');
    assert.equal(result.isError, true, '超时按不可用处理，工具被拒绝');
    assert.equal(host.executed.includes('/workspace/call-timeout.txt'), false);
    const expired = service.pending({ filter: 'handled' }).cards.find((item) => item.callId === 'call-timeout');
    assert.equal(expired?.invalidReason, 'expired');
    const stats = service.stats(String(host.agent.id));
    assert.equal(stats.timeout, 1);
    assert.equal(service.decide({
      callId: 'call-timeout',
      stateVersion: card.stateVersion,
      choice: 'once',
      operationId: nextOperationId(),
      requestDigest: digestOf('b'),
      escalationConfirmed: false,
      decidedBy: 'client-late',
    }).code, 'approval-expired');
  } finally {
    await host.dispose();
  }
});

test('失效卡片说明三类原因：决定前已被处理、会话结束、缺少关联键', async () => {
  const host = await openHost('wp08-invalid');
  try {
    const pending = callTool(host, 'call-invalid');
    const card = await waitCard(host.service, 'call-invalid');
    decide(host.service, card, 'once', 'client-a');
    await pending;
    const handled = host.service.pending({ filter: 'handled' }).cards.find((item) => item.callId === 'call-invalid');
    assert.equal(handled?.invalidReason, 'already-decided');
    assert.equal(handled?.decidedBy, 'client-a');

    // 会话结束：另一条会话里的等待项在会话被释放之后按失效收尾。收尾发生在读取待处理列表时，
    // 因此触发一次读取，再断言等待者已经结束、卡片带着失效原因。
    const other = await host.ctx.agents.create({ sessionId: 'wp08-invalid-other' });
    const otherPending = callTool({ ...host, agent: other.agent }, 'call-orphan');
    await waitCard(host.service, 'call-orphan');
    await other.dispose();
    host.service.pending({ filter: 'waiting' });
    const settled = await Promise.race([otherPending, delay(2_000).then(() => 'timeout')]);
    assert.notEqual(settled, 'timeout', '会话结束后等待者不再挂着');
    const orphan = host.service.pending({ filter: 'handled' }).cards.find((item) => item.callId === 'call-orphan');
    assert.equal(orphan?.invalidReason, 'session-ended');
    assert.equal(orphan?.invalidText, '会话已经结束，等待者不再存在');

    // 缺少关联键：没有这张卡片时给出明确错误码。
    assert.deepEqual(host.service.decide({
      callId: 'call-unknown',
      stateVersion: 1,
      choice: 'once',
      operationId: nextOperationId(),
      requestDigest: digestOf('c'),
      escalationConfirmed: false,
    }), { outcome: 'rejected', code: 'approval-missing-correlation' });
  } finally {
    await host.dispose();
  }
});

test('本会话允许之后同类审批不再询问，作用范围说明可查且可撤销', async () => {
  const host = await openHost('wp08-policy');
  try {
    const first = callTool(host, 'call-policy-1');
    const card = await waitCard(host.service, 'call-policy-1');
    const result = decide(host.service, card, 'session', 'client-a', true);
    assert.equal(result.outcome, 'decided');
    await first;
    const policies = host.service.policies();
    assert.equal(policies.length, 1);
    assert.equal(policies[0].scope, 'session');
    assert.equal(policies[0].toolName, 'wp08-write');
    assert.match(policies[0].description, /只对本次会话里/);
    assert.match(policies[0].description, /会话结束后失效/);

    // 同类审批不再产生卡片，工具直接执行。
    const second = callTool(host, 'call-policy-2');
    const secondResult = await second;
    assert.equal(secondResult.isError, false);
    assert.equal(host.service.pending({ filter: 'waiting' }).cards.length, 0);
    assert.equal(host.service.stats(String(host.agent.id)).autoApproved, 1);

    assert.equal(host.service.clearPolicy('session:wp08-policy-session:wp08-write'), true);
    assert.equal(host.service.policies().length, 0);
    const third = callTool(host, 'call-policy-3');
    const thirdCard = await waitCard(host.service, 'call-policy-3');
    assert.equal(thirdCard.state, 'pending');
    decide(host.service, thirdCard, 'deny', 'client-a');
    await third;

    // 扩大范围不带确认时被契约拒绝。
    assert.equal(host.service.decide({
      callId: 'call-policy-4',
      stateVersion: 1,
      choice: 'always',
      operationId: nextOperationId(),
      requestDigest: digestOf('d'),
      escalationConfirmed: false,
    }).code, 'request-invalid');

    // 始终允许是本设备范围：说明写明跨会话，工具随之直接执行。
    const fourth = callTool(host, 'call-policy-4');
    const fourthCard = await waitCard(host.service, 'call-policy-4');
    assert.equal(decide(host.service, fourthCard, 'always', 'client-a', true).outcome, 'decided');
    await fourth;
    const always = host.service.policies().find((policy) => policy.scope === 'device');
    assert.ok(always !== undefined, '始终允许建立一条设备范围策略');
    assert.match(always.description, /对本设备所有会话里/);
    assert.match(always.description, /直到撤销/);
    const fifth = await callTool(host, 'call-policy-5');
    assert.equal(fifth.isError, false, '设备范围策略命中之后工具直接执行');
  } finally {
    await host.dispose();
  }
});

test('全局待处理按设备、会话与工具分组，并给出会话跳转地址', async () => {
  const host = await openHost('wp08-groups');
  try {
    const another = await host.ctx.agents.create({ sessionId: 'wp08-groups-second' });
    const first = callTool(host, 'call-group-1');
    const second = callTool({ ...host, agent: another.agent }, 'call-group-2');
    await waitCard(host.service, 'call-group-1');
    await waitCard(host.service, 'call-group-2');

    const overview = host.service.pending({ filter: 'waiting' });
    assert.equal(overview.cards.length, 2);
    assert.equal(overview.actionable, 2);
    assert.equal(overview.groups.length, 1);
    const device = overview.groups[0];
    assert.equal(device.deviceId, 'device-alpha');
    assert.equal(device.count, 2);
    assert.equal(device.sessions.length, 2);
    for (const session of device.sessions) {
      assert.match(session.sessionHref, /^#\/session\//);
      assert.deepEqual(session.tools.map((tool) => tool.toolName), ['wp08-write']);
      assert.equal(session.tools[0].count, 1);
    }

    // 会话过滤只留下这一条会话。
    const scoped = host.service.pending({ filter: 'waiting', sessionId: String(host.agent.id) });
    assert.deepEqual(scoped.cards.map((card) => card.callId), ['call-group-1']);
    assert.deepEqual(host.service.grouped({ filter: 'waiting' }).map((group) => group.count), [2]);

    decide(host.service, overview.cards[0], 'deny', 'client-a');
    decide(host.service, overview.cards[1], 'deny', 'client-b');
    await first;
    await second;
    await another.dispose();
  } finally {
    await host.dispose();
  }
});

test('统计包含批准、拒绝与超时计数，最近决定按时间倒序', async () => {
  const host = await openHost('wp08-stats');
  try {
    const approved = callTool(host, 'call-stats-1');
    decide(host.service, await waitCard(host.service, 'call-stats-1'), 'once', 'client-a');
    await approved;
    const denied = callTool(host, 'call-stats-2');
    decide(host.service, await waitCard(host.service, 'call-stats-2'), 'deny', 'client-b');
    await denied;
    const stats = host.service.stats(String(host.agent.id));
    assert.equal(stats.approved, 1);
    assert.equal(stats.denied, 1);
    assert.equal(stats.timeout, 0);
    assert.equal(stats.total, 2);
    assert.equal(stats.pending, 0);
    assert.equal(stats.recent.length, 2);
    assert.equal(stats.recent[0].callId, 'call-stats-2', '最近的决定排在最前');
    assert.equal(stats.recent[0].decidedBy, 'client-b');
    assert.equal(host.service.stats('no-such-session').total, 0);
  } finally {
    await host.dispose();
  }
});

test('提问的选择题与自由输入回填真实等待者', async () => {
  const host = await openHost('wp08-question');
  try {
    const ask = host.ctx.userQuestions.ask({
      questions: [
        { id: 'q-color', header: '样式', question: '用哪种颜色？', options: [{ label: '蓝色' }, { label: '绿色' }] },
        { id: 'q-note', question: '还有什么要求？', options: [{ label: '没有' }] },
      ],
      agent: host.agent,
      wait: { callId: 'call-question' },
    });
    const deadline = Date.now() + 5_000;
    let card;
    while (Date.now() < deadline && card === undefined) {
      card = host.service.questionCards().find((item) => item.callId === 'call-question');
      if (card === undefined) await delay(20);
    }
    assert.ok(card !== undefined, '提问卡片应当出现');
    assert.equal(card.kind, 'question');
    assert.equal(card.questions.length, 2);
    assert.deepEqual(card.questions[0].options.map((option) => option.label), ['蓝色', '绿色']);

    // 校验不通过时卡片保留，仍然可以继续作答。
    const invalid = host.service.answerQuestion({
      callId: 'call-question',
      stateVersion: card.stateVersion,
      operationId: nextOperationId(),
      requestDigest: digestOf('e'),
      answers: [{ id: 'q-color', selected: ['紫色'] }],
    });
    assert.equal(invalid.outcome, 'rejected');
    assert.equal(invalid.code, 'question-invalid');
    assert.equal(invalid.problems.includes('选项不属于该问题：紫色'), true);
    assert.equal(invalid.problems.includes('缺少问题的应答：q-note'), true);
    assert.equal(host.service.questionCards().length, 1, '校验失败之后卡片还在');

    const submitted = host.service.answerQuestion({
      callId: 'call-question',
      stateVersion: card.stateVersion,
      operationId: nextOperationId(),
      requestDigest: digestOf('f'),
      answers: [
        { id: 'q-color', selected: ['绿色'] },
        { id: 'q-note', selected: [], custom: '不要渐变' },
      ],
    });
    assert.equal(submitted.outcome, 'submitted');
    contracts.questionAnswerResultSchema.parse(submitted);
    const answer = await ask;
    assert.deepEqual(answer.answers, [
      { id: 'q-color', selected: ['绿色'] },
      { id: 'q-note', selected: [], custom: '不要渐变' },
    ]);
    assert.equal(host.service.questionCards().length, 0);
  } finally {
    await host.dispose();
  }
});

test('跳过是显式结果，提问卡片随之结束', async () => {
  const host = await openHost('wp08-skip');
  try {
    const ask = host.ctx.userQuestions.ask({
      questions: [{ id: 'q-continue', question: '还要继续吗？', options: [{ label: '继续' }, { label: '停止' }] }],
      agent: host.agent,
      wait: { callId: 'call-skip' },
    });
    const deadline = Date.now() + 5_000;
    let card;
    while (Date.now() < deadline && card === undefined) {
      card = host.service.questionCards().find((item) => item.callId === 'call-skip');
      if (card === undefined) await delay(20);
    }
    const result = host.service.skipQuestion({
      callId: 'call-skip',
      stateVersion: card.stateVersion,
      operationId: nextOperationId(),
      requestDigest: digestOf('a'),
    });
    assert.equal(result.outcome, 'submitted');
    const answer = await ask;
    assert.deepEqual(answer.answers, [{ id: 'q-continue', selected: [] }]);
  } finally {
    await host.dispose();
  }
});

test('计划接管只有一处编辑区，草稿可以恢复并交回等待中的工具', async () => {
  const host = await openHost('wp08-plan');
  try {
    const ask = host.ctx.userQuestions.ask({
      questions: [{
        id: 'plan-review',
        header: '计划审阅',
        question: '批准这份计划并退出计划模式吗？',
        detail: '# 计划\n\n1. 收集事实\n2. 写入改动',
        options: [{ label: '批准执行' }, { label: '继续规划' }],
        intent: { kind: 'plan-review', approve: '批准执行', callId: 'call-plan' },
      }],
      agent: host.agent,
    });
    const deadline = Date.now() + 5_000;
    let card;
    while (Date.now() < deadline && card === undefined) {
      card = host.service.questionCards().find((item) => item.callId === 'call-plan');
      if (card === undefined) await delay(20);
    }
    assert.ok(card !== undefined, '计划卡片应当出现');
    assert.equal(card.kind, 'plan-review');
    assert.equal(card.planMarkdown, '# 计划\n\n1. 收集事实\n2. 写入改动');
    assert.equal(card.takeover.draft, card.planMarkdown, '草稿初值是计划正文');

    const granted = host.service.takeover({ action: 'acquire', callId: 'call-plan', holderId: 'client-a', holderLabel: '本机', stateVersion: card.stateVersion });
    assert.equal(granted.outcome, 'granted');
    const held = host.service.takeover({ action: 'acquire', callId: 'call-plan', holderId: 'client-b', holderLabel: '手机', stateVersion: card.stateVersion });
    assert.equal(held.outcome, 'held');
    assert.equal(held.holderId, 'client-a');
    assert.match(held.reason, /本机正在编辑/);
    assert.equal(host.service.takeover({ action: 'release', callId: 'call-plan', holderId: 'client-b', holderLabel: '手机', stateVersion: card.stateVersion }).code, 'revision-conflict');

    const firstSave = host.service.savePlanDraft({ callId: 'call-plan', holderId: 'client-a', text: '# 计划（改）', revision: 0, stateVersion: card.stateVersion });
    assert.equal(firstSave.outcome, 'saved');
    assert.equal(firstSave.revision, 1);
    const stale = host.service.savePlanDraft({ callId: 'call-plan', holderId: 'client-a', text: '# 旧版本', revision: 0, stateVersion: card.stateVersion });
    assert.equal(stale.outcome, 'conflict');
    assert.equal(stale.revision, 1);

    // 另一位客户端接手时读到的是同一份草稿。
    host.service.takeover({ action: 'release', callId: 'call-plan', holderId: 'client-a', holderLabel: '本机', stateVersion: card.stateVersion });
    const second = host.service.takeover({ action: 'acquire', callId: 'call-plan', holderId: 'client-b', holderLabel: '手机', stateVersion: card.stateVersion });
    assert.equal(second.outcome, 'granted');
    assert.equal(second.draft, '# 计划（改）', '草稿在释放之后仍然可以恢复');
    assert.equal(second.draftRevision, 1);

    const submitted = host.service.submitPlan({
      callId: 'call-plan',
      stateVersion: card.stateVersion,
      operationId: nextOperationId(),
      requestDigest: digestOf('b'),
      holderId: 'client-b',
      decision: 'approve',
      feedback: '',
    });
    assert.equal(submitted.outcome, 'submitted');
    const answer = await ask;
    assert.deepEqual(answer.answers, [{ id: 'plan-review', selected: ['批准执行'] }]);
    assert.equal(host.service.questionCards().length, 0);

    // 卡片结束之后接管入口明确失效。
    assert.equal(host.service.takeover({ action: 'acquire', callId: 'call-plan', holderId: 'client-a', holderLabel: '本机', stateVersion: card.stateVersion }).code, 'question-expired');
  } finally {
    await host.dispose();
  }
});

test('真实遥测客户端导出等待 span、决定事件与计数指标', async () => {
  const collector = await startCollector();
  const telemetry = diagnostics.createTelemetryClient({
    config: defaultTelemetryConfig({
      endpoint: collector.url,
      exportIntervalMs: 100,
      exportIntervalMsMetrics: 100,
      exportTimeoutMs: 50,
    }),
    component: '@chatdsh/host-approval',
  });
  const host = await openHost('wp08-telemetry', { telemetry });
  try {
    assert.equal(telemetry.enabled, true);
    const pending = callTool(host, 'call-trace');
    decide(host.service, await waitCard(host.service, 'call-trace'), 'once', 'client-a');
    await pending;
    await telemetry.flush(3000);

    const spans = flatten(collector.records().traces, 'traces');
    const wait = spans.find((entry) => entry.name === 'chatdsh.runtime.approval.wait');
    assert.ok(wait !== undefined, '等待应当有一个 span');
    assert.equal(wait.attributes['approval.kind'], 'approval');
    assert.equal(wait.attributes.decision, 'allowed-once');

    const logs = flatten(collector.records().logs, 'logs');
    const decided = logs.find((entry) => entry.name === 'chatdsh.runtime.approval.decided');
    assert.ok(decided !== undefined, '决定应当写出一条事件');
    assert.equal(decided.attributes.decision, 'once');
    assert.equal(decided.attributes.decided_by, 'client-a');

    const metrics = flatten(collector.records().metrics, 'metrics');
    const counter = metrics.find((entry) => entry.name === 'chatdsh_approvals_total');
    assert.ok(counter !== undefined, '结果应当有一个计数指标');
    assert.equal(counter.attributes.kind, 'approval');
    assert.equal(counter.attributes.decision, 'once');

    // 登记过的信号名与属性键都在通知清单里，属性只有枚举值。
    for (const entry of [...spans, ...logs, ...metrics]) {
      const text = JSON.stringify(entry.attributes);
      assert.equal(text.includes('/workspace/'), false, '工具参数不进入遥测');
    }
  } finally {
    await host.dispose();
    await telemetry.shutdown();
    await collector.close();
  }
});
