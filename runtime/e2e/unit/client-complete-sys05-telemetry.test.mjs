// SYS05 的遥测验收。
//
// 用真实的 OTLP/HTTP 收集器接收宿主平面遥测客户端导出的信号，检查运行、审批与取消的
// span、失败事件与计数指标都存在，且属性里没有消息正文。所有信号名必须与包声明和
// docs/telemetry.md 的清单一致（由 scripts/check-telemetry.mjs 另行比对）。
//
// 运行：node --test e2e/unit/client-complete-sys05-telemetry.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { tempHome } from '../../scripts/lib/cleanup.mjs';
import { ensureDeps } from '../lib/ensure-deps.mjs';

const RUNTIME = resolve(import.meta.dirname, '../..');
ensureDeps(RUNTIME);

const { Context } = await import('@deepseek-ai/cordis');
const jsonl = await import('@deepseek-ai/dsh-session-persistence-jsonl');
const { default: SessionPlugin } = await import('@deepseek-ai/dsh-session');
const { ChatdshHermesChatService } = await import('../../packages/host/chat-hermes/lib/index.js');
const { createTelemetryClient } = await import('../../packages/core/diagnostics/lib/index.js');
const { defaultTelemetryConfig } = await import('../../packages/core/diagnostics/lib/config.js');

process.env.SYS05_HERMES_KEY = 'sys05-test-key';

/** 等插件激活。 */
function settle(ms = 800) {
  return new Promise((done) => setTimeout(done, ms));
}

/** 真实接收 OTLP/HTTP 请求的收集器。 */
async function startCollector() {
  const bodies = { logs: [], traces: [], metrics: [] };
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const signal = request.url?.includes('/v1/logs') ? 'logs' : request.url?.includes('/v1/traces') ? 'traces' : 'metrics';
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

/** 属性列表转对象。 */
function attributesOf(entries) {
  const attributes = {};
  for (const entry of entries ?? []) {
    const value = entry.value ?? {};
    attributes[entry.key] = value.stringValue ?? value.intValue ?? value.boolValue ?? value.doubleValue;
  }
  return attributes;
}

/** 摊平日志。 */
function flattenLogs(payloads) {
  const out = [];
  for (const payload of payloads) {
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

/** 摊平追踪。 */
function flattenTraces(payloads) {
  const out = [];
  for (const payload of payloads) {
    for (const resource of payload.resourceSpans ?? []) {
      for (const scope of resource.scopeSpans ?? []) {
        for (const span of scope.spans ?? []) {
          out.push({ name: span.name, attributes: attributesOf(span.attributes) });
        }
      }
    }
  }
  return out;
}

/** 摊平指标数据点。 */
function flattenMetrics(payloads) {
  const out = [];
  for (const payload of payloads) {
    for (const resource of payload.resourceMetrics ?? []) {
      for (const scope of resource.scopeMetrics ?? []) {
        for (const metric of scope.metrics ?? []) {
          const points = metric.sum?.dataPoints ?? metric.gauge?.dataPoints ?? [];
          for (const point of points) {
            out.push({ name: metric.name, attributes: attributesOf(point.attributes) });
          }
        }
      }
    }
  }
  return out;
}

/** 起一个实现 Hermes 运行契约的真实服务。 */
async function startHermes() {
  const state = {
    features: {
      run_submission: true, run_events_sse: true, approval_events: true,
      run_approval_response: true, run_stop: true, run_status: true,
    },
    runs: new Map(),
    behavior: 'complete',
  };
  const queues = new Map();
  const push = (run, event) => {
    const seq = run.events.length;
    const stored = { ...event, seq };
    run.events.push(stored);
    if (event.event === 'approval.request') run.status = 'waiting_for_approval';
    if (event.event === 'run.completed') { run.status = 'completed'; run.output = event.output; run.terminal = true; }
    if (event.event === 'run.cancelled') { run.status = 'cancelled'; run.terminal = true; }
    for (const queue of queues.get(run.id) ?? []) queue(stored);
  };
  const drive = (run) => {
    if (state.behavior === 'hang') return;
    push(run, { event: 'message.delta', run_id: run.id, delta: '回显' });
    if (state.behavior === 'approval') {
      run.approval = { requestId: `req-${run.id}` };
      push(run, {
        event: 'approval.request', run_id: run.id, request_id: run.approval.requestId,
        description: '执行命令', choices: ['once', 'deny'],
      });
      return;
    }
    push(run, { event: 'run.completed', run_id: run.id, output: '回显', usage: {} });
  };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const url = new URL(request.url, 'http://127.0.0.1');
    const json = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === '/v1/capabilities') {
      json(200, { features: state.features });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/runs') {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const run = {
        id: `run-${state.runs.size + 1}-${Date.now()}`, input: body.input, body,
        status: 'started', events: [], approval: undefined, terminal: undefined,
      };
      state.runs.set(run.id, run);
      json(202, { run_id: run.id, status: 'started', replayed: false });
      setTimeout(() => drive(run), 5);
      return;
    }
    const eventsMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/events$/);
    if (request.method === 'GET' && eventsMatch !== null) {
      const run = state.runs.get(decodeURIComponent(eventsMatch[1]));
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(': open\n\n');
      const queue = [];
      let ended = false;
      let wake;
      const notify = (event) => { queue.push(event); wake?.(); wake = undefined; };
      const listeners = queues.get(run.id) ?? new Set();
      queues.set(run.id, listeners);
      listeners.add(notify);
      for (const event of [...run.events]) queue.push(event);
      if (run.terminal === true) ended = true;
      try {
        for (;;) {
          const next = queue.shift();
          if (next !== undefined) {
            response.write(`id: ${next.seq}\ndata: ${JSON.stringify({ ...next, timestamp: 1 })}\n\n`);
            continue;
          }
          if (ended || run.terminal === true) break;
          await new Promise((done) => { wake = done; });
          if (run.terminal === true) ended = true;
        }
        response.write(': stream closed\n\n');
      } finally {
        listeners.delete(notify);
        response.end();
      }
      return;
    }
    const statusMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)$/);
    if (request.method === 'GET' && statusMatch !== null) {
      const run = state.runs.get(decodeURIComponent(statusMatch[1]));
      json(200, {
        object: 'hermes.run', run_id: run.id, status: run.status,
        ...(run.approval === undefined ? {} : { approval: { request_id: run.approval.requestId, description: '执行命令', choices: ['once', 'deny'] } }),
        ...(run.output === undefined ? {} : { output: run.output }),
      });
      return;
    }
    const approvalMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/approval$/);
    if (request.method === 'POST' && approvalMatch !== null) {
      const run = state.runs.get(decodeURIComponent(approvalMatch[1]));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      run.approval = undefined;
      push(run, { event: 'approval.responded', run_id: run.id, request_id: body.request_id, choice: body.choice, resolved: 1 });
      push(run, { event: 'run.completed', run_id: run.id, output: '已批准', usage: {} });
      json(200, { object: 'hermes.run.approval_response', run_id: run.id, choice: body.choice, resolved: 1 });
      return;
    }
    const stopMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/stop$/);
    if (request.method === 'POST' && stopMatch !== null) {
      const run = state.runs.get(decodeURIComponent(stopMatch[1]));
      push(run, { event: 'run.cancelled', run_id: run.id, interrupted: true });
      json(200, { run_id: run.id, status: 'stopping' });
      return;
    }
    json(404, { error: 'not_found' });
  });
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { state, baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(done)) };
}

/** 建一个带 DSH 回合的会话。 */
async function seedSession(ctx, id) {
  const created = await ctx.sessionPersistence.create({
    id, version: 4, cwd: RUNTIME, createdAt: Date.now(), isSeeded: false,
  });
  await created.append([
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
    {
      type: 'system/message', seq: 2, time: 1,
      data: {
        turn: 1, step: 1,
        message: { id: 's', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'SYS05 系统提示' }] },
      },
      surfaceOp: 'append',
    },
    {
      type: 'user/message', seq: 3, time: 1,
      data: { id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'SYS05 用户事实' }] },
      surfaceOp: 'append',
    },
    { type: 'step/end', seq: 4, time: 1, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 5, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
  ]);
  await created.flush();
  await created.close();
}

/** 等条件成立。 */
async function waitFor(predicate, timeoutMs = 5000, what = '条件') {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await delay(20);
  }
}

test('运行、审批、取消与能力拒绝都有 span、事件与计数', async () => {
  const collector = await startCollector();
  const telemetry = createTelemetryClient({
    config: defaultTelemetryConfig({
      endpoint: collector.url,
      exportIntervalMs: 100,
      exportIntervalMsMetrics: 100,
      exportTimeoutMs: 50,
    }),
    component: '@chatdsh/host-chat-hermes',
  });
  const hermes = await startHermes();
  const home = tempHome('sys05-telemetry');
  const ctx = new Context();
  ctx.plugin(SessionPlugin);
  ctx.plugin(jsonl, { root: join(home, 'sessions') });
  ctx.provide('chatdshTelemetry', telemetry);
  ctx.plugin(ChatdshHermesChatService, {
    baseUrl: hermes.baseUrl,
    apiKeyEnv: 'SYS05_HERMES_KEY',
    requestTimeoutMs: 5000,
    approvalTimeoutMs: 300_000,
    modelLabel: 'hermes-test-label',
    model: 'hermes-test',
    historyPageSize: 200,
    stopConfirmMs: 300,
  });
  await settle();
  const id = `sys05-telemetry-${Date.now()}`;
  await seedSession(ctx, id);
  try {
    const completed = await ctx.chatdshHermesChat.send(id, '第一问', 'op-telemetry-1');
    assert.equal(completed.terminal, 'completed');

    hermes.state.behavior = 'approval';
    const approving = ctx.chatdshHermesChat.send(id, '审批问题', 'op-telemetry-2');
    const runId = await waitFor(() => [...hermes.state.runs.values()].find((run) => run.input === '审批问题')?.id, 5000, '审批运行');
    await waitFor(async () => (await ctx.chatdshHermesChat.getRun(runId)).status === 'waiting_for_approval', 5000, '等待审批');
    const answer = await ctx.chatdshHermesChat.answerApproval(id, runId, `req-${runId}`, 'deny', 'sys05-test');
    assert.equal(answer.accepted, true);
    assert.equal((await approving).terminal, 'completed');

    hermes.state.behavior = 'hang';
    const hanging = ctx.chatdshHermesChat.send(id, '取消问题', 'op-telemetry-3');
    const cancelRun = await waitFor(() => [...hermes.state.runs.values()].find((run) => run.input === '取消问题')?.id, 5000, '取消运行');
    const cancelled = await ctx.chatdshHermesChat.cancelRun(id, cancelRun);
    assert.equal(cancelled.state, 'confirmed');
    assert.equal((await hanging).terminal, 'cancelled');

    hermes.state.features.run_approval_response = false;
    await assert.rejects(
      () => ctx.chatdshHermesChat.send(id, '拒绝问题', 'op-telemetry-4'),
      (error) => error.code === 'capability-missing',
    );

    await telemetry.flush(4000);
    const logs = flattenLogs(collector.records().logs);
    const spans = flattenTraces(collector.records().traces);
    const metrics = flattenMetrics(collector.records().metrics);

    const failed = logs.find((entry) => entry.name === 'chatdsh.chat.hermes.run.failed' && entry.attributes['error.code'] === 'capability-missing');
    assert.ok(failed !== undefined, '能力拒绝要写失败事件');
    assert.equal(failed.attributes['error.type'], 'HermesCapabilityError');

    const relayed = logs.find((entry) => entry.name === 'chatdsh.chat.hermes.approval.relayed' && entry.attributes.outcome === 'accepted');
    assert.ok(relayed !== undefined, '审批应答要写中转事件');

    const runSpan = spans.filter((entry) => entry.name === 'chatdsh.chat.hermes.run');
    assert.ok(runSpan.some((entry) => entry.attributes.outcome === 'completed'), '成功运行 span');
    assert.ok(runSpan.some((entry) => entry.attributes.outcome === 'rejected'), '拒绝运行 span');
    assert.ok(runSpan.some((entry) => entry.attributes.outcome === 'confirmed'), '取消 span');
    assert.ok(spans.some((entry) => entry.name === 'chatdsh.chat.hermes.approval' && entry.attributes['rpc.method'] === 'answerApproval'), '审批 span');

    const runs = metrics.filter((entry) => entry.name === 'chatdsh_chat_hermes_runs_total');
    assert.ok(runs.some((entry) => entry.attributes.outcome === 'completed'));
    assert.ok(runs.some((entry) => entry.attributes.outcome === 'cancelled'));
    assert.ok(runs.some((entry) => entry.attributes.outcome === 'rejected'));
    assert.ok(metrics.some((entry) => entry.name === 'chatdsh_chat_hermes_approvals_total' && entry.attributes.outcome === 'accepted'));

    for (const entry of [...logs, ...spans]) {
      for (const value of Object.values(entry.attributes)) {
        if (typeof value !== 'string') continue;
        assert.equal(value.includes('SYS05 用户事实'), false, '遥测不得带消息正文');
        assert.equal(value.includes('第一问'), false, '遥测不得带消息正文');
      }
    }
  } finally {
    await ctx.fiber.dispose();
    await telemetry.shutdown();
    await hermes.close();
    await collector.close();
  }
});
