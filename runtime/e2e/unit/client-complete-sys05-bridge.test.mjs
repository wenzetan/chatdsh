// SYS05 的完整历史运行、审批、取消与幂等写入验收。
//
// 起一个本机真实 HTTP 服务，按 Hermes `api_server` 的真实契约实现能力探测、运行受理
// （幂等键）、事件流、审批应答、状态查询与停止。宿主使用真实的 Cordis 上下文与真实
// JSONL 会话持久化，不替身任何本仓库代码；遥测用真实的 OTLP 收集器接收。
//
// 运行：node --test e2e/unit/client-complete-sys05-bridge.test.mjs

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
const { createHermesHistoryRunBridge, historyDigestOf } = await import('../../../hermes-adapter/lib/index.js');

/** 等插件树激活。 */
function settle(ms = 800) {
  return new Promise((done) => setTimeout(done, ms));
}

process.env.SYS05_HERMES_KEY = 'sys05-test-key';

/** 一条待发事件队列：支持回放后继续推送。 */
function eventQueue() {
  const items = [];
  let wake;
  let ended = false;
  return {
    push(item) {
      items.push(item);
      wake?.();
      wake = undefined;
    },
    end() {
      ended = true;
      wake?.();
      wake = undefined;
    },
    async *iterate() {
      for (;;) {
        const next = items.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (ended) return;
        await new Promise((done) => { wake = done; });
      }
    },
  };
}

/**
 * 起一个实现 Hermes 运行契约的真实 HTTP 服务。
 * @param {{ features?: Record<string, boolean> }} options 能力覆盖。
 * @returns {Promise<object>} 服务句柄。
 */
async function startHermes({ features = {} } = {}) {
  const state = {
    features: {
      run_submission: true,
      run_events_sse: true,
      approval_events: true,
      run_approval_response: true,
      run_stop: true,
      run_status: true,
      ...features,
    },
    runs: new Map(),
    requests: [],
    approvals: [],
    stops: [],
    idempotency: new Map(),
    behavior: 'complete',
  };

  /** 取一个运行。 */
  function runOf(id) {
    const run = state.runs.get(id);
    if (run === undefined) throw new Error(`未知运行：${id}`);
    return run;
  }

  /** 推一条事件并更新状态。 */
  function push(run, event) {
    const seq = run.events.length;
    run.events.push({ ...event, seq });
    for (const queue of run.subscribers) queue.push({ ...event, seq });
    if (event.event === 'approval.request') run.status = 'waiting_for_approval';
    if (event.event === 'run.completed') { run.status = 'completed'; run.output = event.output; }
    if (event.event === 'run.failed') { run.status = 'failed'; run.error = event.error; }
    if (event.event === 'run.cancelled' || event.event === 'run.interrupted') run.status = event.event.slice(4);
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled' || run.status === 'interrupted') {
      run.terminal = run.status;
      for (const queue of run.subscribers) queue.end();
    }
  }

  /** 按行为推进一次运行。 */
  async function drive(run) {
    const input = run.input;
    if (state.behavior === 'missing-terminal') {
      push(run, { event: 'message.delta', run_id: run.id, delta: '半截回答' });
      run.streamClosed = true;
      for (const queue of run.subscribers) queue.end();
      return;
    }
    if (state.behavior === 'unknown-event') {
      push(run, { event: 'future.unknown', run_id: run.id });
      run.streamClosed = true;
      for (const queue of run.subscribers) queue.end();
      return;
    }
    if (state.behavior === 'hang' || state.behavior === 'ignore-stop') return;
    push(run, { event: 'message.delta', run_id: run.id, delta: `回显：${input}` });
    if (state.behavior === 'approval') {
      const requestId = `req-${run.id}`;
      run.approval = { requestId, description: '执行命令', command: 'rm -rf 构建目录', choices: ['once', 'deny'] };
      push(run, {
        event: 'approval.request', run_id: run.id, request_id: requestId,
        description: run.approval.description, command: run.approval.command,
        choices: run.approval.choices,
      });
      return;
    }
    push(run, { event: 'run.completed', run_id: run.id, output: `回显：${input}`, usage: { input_tokens: 1 } });
  }

  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    const url = new URL(request.url, 'http://127.0.0.1');
    const json = (status, body, headers = {}) => {
      response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      response.end(JSON.stringify(body));
    };

    if (request.method === 'GET' && url.pathname === '/v1/capabilities') {
      json(200, {
        object: 'hermes.api_server.capabilities',
        model: 'hermes-test',
        auth: { type: 'bearer', required: true },
        features: state.features,
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      json(200, { status: 'ok' });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/runs') {
      const body = JSON.parse(text);
      state.requests.push({ headers: request.headers, body });
      const key = request.headers['idempotency-key'];
      const existing = typeof key === 'string' ? state.idempotency.get(key) : undefined;
      if (existing !== undefined) {
        json(202, { run_id: existing, status: 'started', replayed: true }, { 'Idempotency-Replayed': 'true' });
        return;
      }
      const runId = `run-${state.runs.size + 1}-${Date.now()}`;
      if (typeof key === 'string') state.idempotency.set(key, runId);
      const run = {
        id: runId,
        input: body.input,
        body,
        status: 'started',
        events: [],
        subscribers: new Set(),
        approval: undefined,
        terminal: undefined,
        output: undefined,
        error: undefined,
      };
      state.runs.set(runId, run);
      json(202, { run_id: runId, status: 'started', replayed: false });
      setTimeout(() => { void drive(run); }, 5);
      return;
    }
    const eventsMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/events$/);
    if (request.method === 'GET' && eventsMatch !== null) {
      const run = runOf(decodeURIComponent(eventsMatch[1]));
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      response.write(': open\n\n');
      const queue = eventQueue();
      const lastSeq = Number.parseInt(request.headers['last-event-id'] ?? '-1', 10);
      const replay = [...run.events];
      run.subscribers.add(queue);
      for (const event of replay) if (event.seq > lastSeq) queue.push(event);
      if (run.terminal !== undefined || run.streamClosed === true) queue.end();
      try {
        for await (const event of queue.iterate()) {
          response.write(`id: ${event.seq}\ndata: ${JSON.stringify({ ...event, timestamp: 1 })}\n\n`);
        }
        response.write(': stream closed\n\n');
      } finally {
        run.subscribers.delete(queue);
        response.end();
      }
      return;
    }
    const statusMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)$/);
    if (request.method === 'GET' && statusMatch !== null) {
      const run = runOf(decodeURIComponent(statusMatch[1]));
      json(200, {
        object: 'hermes.run',
        run_id: run.id,
        status: run.status,
        last_event: run.events.at(-1)?.event ?? 'run.started',
        ...(run.approval === undefined ? {} : {
          approval: {
            request_id: run.approval.requestId,
            description: run.approval.description,
            command: run.approval.command,
            choices: run.approval.choices,
          },
        }),
        ...(run.output === undefined ? {} : { output: run.output }),
        ...(run.error === undefined ? {} : { error: run.error }),
      });
      return;
    }
    const approvalMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/approval$/);
    if (request.method === 'POST' && approvalMatch !== null) {
      const run = runOf(decodeURIComponent(approvalMatch[1]));
      const body = JSON.parse(text);
      state.approvals.push({ runId: run.id, body });
      if (run.approval === undefined || run.approval.requestId !== body.request_id) {
        json(409, { error: 'approval_not_pending' });
        return;
      }
      run.approval = undefined;
      push(run, {
        event: 'approval.responded', run_id: run.id, request_id: body.request_id,
        choice: body.choice, resolved: 1,
      });
      push(run, { event: 'run.completed', run_id: run.id, output: `已批准：${body.choice}`, usage: {} });
      json(200, { object: 'hermes.run.approval_response', run_id: run.id, choice: body.choice, resolved: 1 });
      return;
    }
    const stopMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/stop$/);
    if (request.method === 'POST' && stopMatch !== null) {
      const run = runOf(decodeURIComponent(stopMatch[1]));
      state.stops.push(run.id);
      if (state.behavior === 'ignore-stop') {
        json(200, { run_id: run.id, status: 'stopping' });
        return;
      }
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
  return {
    state,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((done) => server.close(done)),
  };
}

/** 建一条事件的公共字段。 */
function row(seq, type, data, extra = {}) {
  return { seq, type, time: 1_700_000_000_000 + seq, data, ...extra };
}

/**
 * 建一个带 DSH 回合的会话。
 * @param {object} ctx 上下文。
 * @param {string} id 会话标识。
 * @returns {Promise<void>} 写入完成。
 */
async function seedDshSession(ctx, id) {
  const created = await ctx.sessionPersistence.create({
    id, version: 4, cwd: RUNTIME, createdAt: Date.now(), isSeeded: false,
  });
  await created.append([
    row(0, 'turn/start', { turn: 1 }),
    row(1, 'step/start', { turn: 1, step: 1 }),
    row(2, 'system/message', {
      turn: 1, step: 1,
      message: {
        id: 's1', role: 'system', source: { kind: 'system-prompt' },
        content: [{ type: 'text', text: 'DSH 系统提示' }],
      },
    }, { surfaceOp: 'append' }),
    row(3, 'user/message', {
      id: 'u1', role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: 'DSH 事实：项目代号蓝鲸' }],
    }, { surfaceOp: 'append' }),
    row(4, 'assistant/message', {
      turn: 1, step: 1,
      message: {
        id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'dsh', model: 'dsh-1' },
        content: [{ type: 'text', text: '记下了' }],
      },
      stream: [],
    }, { surfaceOp: 'append' }),
    row(5, 'step/end', { turn: 1, step: 1 }),
    row(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]);
  await created.flush();
  await created.close();
}

/** 打开宿主。 */
async function openHost({ root, baseUrl, telemetry, stopConfirmMs = 300 }) {
  const ctx = new Context();
  ctx.plugin(SessionPlugin);
  ctx.plugin(jsonl, { root: join(root, 'sessions') });
  if (telemetry !== undefined) ctx.provide('chatdshTelemetry', telemetry);
  ctx.plugin(ChatdshHermesChatService, {
    baseUrl,
    apiKeyEnv: 'SYS05_HERMES_KEY',
    requestTimeoutMs: 5000,
    approvalTimeoutMs: 300_000,
    modelLabel: 'hermes-test-label',
    model: 'hermes-test',
    historyPageSize: 2,
    stopConfirmMs,
  });
  await settle();
  return ctx;
}

/** 读一个会话的全部事件。 */
async function readEvents(ctx, id) {
  const handle = await ctx.sessionPersistence.open(id, 'read');
  try {
    return (await handle.read()).events;
  } finally {
    await handle.close();
  }
}

/** 等一个条件成立。 */
async function waitFor(predicate, timeoutMs = 5000, what = '条件') {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await delay(20);
  }
}

/** 会话里的运行记录。 */
function runRecordsOf(events) {
  return events
    .filter((event) => event.type === 'plugin:chatdsh-hermes-run')
    .map((event) => event.data);
}

test('连续两轮携带完整历史、稳定 system 与可校验指纹', async () => {
  const hermes = await startHermes();
  const home = tempHome('sys05-bridge-history');
  const ctx = await openHost({ root: home, baseUrl: hermes.baseUrl });
  const id = `sys05-bridge-${Date.now()}`;
  await seedDshSession(ctx, id);
  try {
    const first = await ctx.chatdshHermesChat.send(id, '第一问', 'op-round-1');
    assert.equal(first.terminal, 'completed');
    assert.equal(first.assistantText, '回显：第一问');
    assert.equal(first.firstUser, 'DSH 事实：项目代号蓝鲸');
    assert.match(first.historyDigest, /^[0-9a-f]{64}$/);
    assert.equal(hermes.state.requests.length, 1);

    const firstBody = hermes.state.requests[0].body;
    assert.deepEqual(firstBody.conversation_history, [
      { role: 'user', content: 'DSH 事实：项目代号蓝鲸' },
      { role: 'assistant', content: '记下了' },
    ]);
    assert.equal(firstBody.instructions, 'DSH 系统提示');
    assert.equal(firstBody.model, 'hermes-test');
    assert.equal(firstBody.input, '第一问');
    assert.equal(hermes.state.requests[0].headers.authorization, 'Bearer sys05-test-key');
    assert.equal(hermes.state.requests[0].headers['x-chatdsh-history-mode'], 'full');
    const firstMessages = [
      ...firstBody.conversation_history,
      { role: 'user', content: firstBody.input },
    ].map((message) => ({ role: message.role, text: message.content }));
    assert.equal(hermes.state.requests[0].headers['x-chatdsh-history-digest'], historyDigestOf(firstBody.instructions, firstMessages));

    const second = await ctx.chatdshHermesChat.send(id, '第二问', 'op-round-2');
    assert.equal(second.terminal, 'completed');
    assert.equal(hermes.state.requests.length, 2);
    const secondBody = hermes.state.requests[1].body;
    assert.deepEqual(secondBody.conversation_history, [
      { role: 'user', content: 'DSH 事实：项目代号蓝鲸' },
      { role: 'assistant', content: '记下了' },
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '回显：第一问' },
    ]);
    assert.equal(secondBody.instructions, 'DSH 系统提示');
    assert.equal(secondBody.session_id, id, '携带完整历史时同时给出会话标识');
    const secondMessages = [
      ...secondBody.conversation_history,
      { role: 'user', content: secondBody.input },
    ].map((message) => ({ role: message.role, text: message.content }));
    assert.equal(hermes.state.requests[1].headers['x-chatdsh-history-digest'], historyDigestOf(secondBody.instructions, secondMessages));
    assert.notEqual(
      hermes.state.requests[0].headers['x-chatdsh-history-digest'],
      hermes.state.requests[1].headers['x-chatdsh-history-digest'],
    );

    const events = await readEvents(ctx, id);
    const records = runRecordsOf(events).filter((record) => record.state !== 'accepted');
    assert.equal(records.length, 2);
    assert.deepEqual(records.map((record) => record.state), ['completed', 'completed']);
    assert.equal(records[1].firstUser, 'DSH 事实：项目代号蓝鲸');
    assert.equal(records[0].historyDigest, hermes.state.requests[0].headers['x-chatdsh-history-digest']);
  } finally {
    await ctx.fiber.dispose();
    await hermes.close();
  }
});

test('审批在运行结束前可见，决定按 run_id/request_id 关联合法落盘', async () => {
  const hermes = await startHermes();
  hermes.state.behavior = 'approval';
  const home = tempHome('sys05-bridge-approval');
  const ctx = await openHost({ root: home, baseUrl: hermes.baseUrl });
  const id = `sys05-bridge-approval-${Date.now()}`;
  await seedDshSession(ctx, id);
  try {
    const sending = ctx.chatdshHermesChat.send(id, '执行操作', 'op-approval');
    const runId = await waitFor(() => {
      const entry = [...hermes.state.runs.values()].find((run) => run.status === 'waiting_for_approval');
      return entry?.id;
    }, 5000, '运行进入等待审批');
    const request = await waitFor(async () => {
      const events = await readEvents(ctx, id);
      return events.find((event) => event.type === 'plugin:chatdsh-approval' && event.data.kind === 'request' && event.data.runId === runId);
    }, 5000, '审批请求写入会话');

    const during = await readEvents(ctx, id);
    assert.equal(hermes.state.runs.get(runId).terminal, undefined, '审批可见时运行尚未终结');
    assert.equal(request.data.runId, runId);
    assert.equal(request.data.requestId, `req-${runId}`);
    assert.deepEqual(request.data.choices, ['once', 'deny']);
    assert.equal(request.data.origin, 'hermes');
    assert.equal(during.filter((event) => event.type === 'assistant/message').length, 1, '审批可见时只有 DSH 回合的助手消息');

    const status = await ctx.chatdshHermesChat.getRun(runId);
    assert.equal(status.status, 'waiting_for_approval');
    assert.equal(status.approval.requestId, `req-${runId}`);

    const answer = await ctx.chatdshHermesChat.answerApproval(id, runId, `req-${runId}`, 'once', 'sys05-test');
    assert.deepEqual(answer, { accepted: true, outcome: 'accepted' });
    const result = await sending;
    assert.equal(result.terminal, 'completed');
    assert.equal(result.assistantText, '已批准：once');
    assert.deepEqual(result.approvals, [`req-${runId}`]);

    const after = await readEvents(ctx, id);
    const decision = after.find((event) => event.type === 'plugin:chatdsh-approval' && event.data.kind === 'decision');
    assert.ok(decision !== undefined, '审批决定要落盘');
    assert.equal(decision.data.runId, runId);
    assert.equal(decision.data.requestId, `req-${runId}`);
    assert.equal(decision.data.choice, 'once');
    assert.ok(decision.seq < after.filter((event) => event.type === 'assistant/message').at(-1).seq, '审批决定先于收尾');
    assert.deepEqual(hermes.state.approvals.map((entry) => entry.body), [{ request_id: `req-${runId}`, choice: 'once' }]);
  } finally {
    await ctx.fiber.dispose();
    await hermes.close();
  }
});

test('取消传播到同一运行并取得终态', async () => {
  const hermes = await startHermes();
  hermes.state.behavior = 'hang';
  const home = tempHome('sys05-bridge-cancel');
  const ctx = await openHost({ root: home, baseUrl: hermes.baseUrl });
  const id = `sys05-bridge-cancel-${Date.now()}`;
  await seedDshSession(ctx, id);
  try {
    const sending = ctx.chatdshHermesChat.send(id, '长任务', 'op-cancel');
    const runId = await waitFor(() => [...hermes.state.runs.keys()][0], 5000, '运行受理');
    const outcome = await ctx.chatdshHermesChat.cancelRun(id, runId);
    assert.equal(outcome.state, 'confirmed');
    assert.equal(outcome.status.status, 'cancelled');
    assert.deepEqual(hermes.state.stops, [runId]);
    const result = await sending;
    assert.equal(result.terminal, 'cancelled');
    const events = await readEvents(ctx, id);
    const end = events.filter((event) => event.type === 'turn/end').at(-1);
    assert.deepEqual(end.data.reason, { kind: 'aborted', reason: { kind: 'user' } });
    assert.equal(runRecordsOf(events).at(-1).state, 'cancelled');
  } finally {
    await ctx.fiber.dispose();
    await hermes.close();
  }
});

test('停止未被确认时报告未确认，不宣称已停止', async () => {
  const hermes = await startHermes();
  hermes.state.behavior = 'ignore-stop';
  const home = tempHome('sys05-bridge-unconfirmed');
  const ctx = await openHost({ root: home, baseUrl: hermes.baseUrl, stopConfirmMs: 200 });
  const id = `sys05-bridge-unconfirmed-${Date.now()}`;
  await seedDshSession(ctx, id);
  try {
    const sending = ctx.chatdshHermesChat.send(id, '停不下来', 'op-unconfirmed');
    const runId = await waitFor(() => [...hermes.state.runs.keys()][0], 5000, '运行受理');
    const outcome = await ctx.chatdshHermesChat.cancelRun(id, runId);
    assert.equal(outcome.state, 'unconfirmed');
    assert.equal(outcome.code, 'stop-unconfirmed');
    assert.equal(outcome.status.status, 'started');
    // 服务端稍后真正取消，宿主随事件流收尾；不能因为未确认就提前收尾。
    const run = hermes.state.runs.get(runId);
    assert.equal(run.terminal, undefined);
    const cancelled = { event: 'run.cancelled', run_id: runId, seq: run.events.length };
    run.events.push(cancelled);
    for (const queue of run.subscribers) queue.push(cancelled);
    run.status = 'cancelled';
    run.terminal = 'cancelled';
    for (const queue of run.subscribers) queue.end();
    const result = await sending;
    assert.equal(result.terminal, 'cancelled');
  } finally {
    await ctx.fiber.dispose();
    await hermes.close();
  }
});

test('能力缺失时在执行前拒绝，不创建运行', async () => {
  const hermes = await startHermes({ features: { run_approval_response: false } });
  const home = tempHome('sys05-bridge-capability');
  const ctx = await openHost({ root: home, baseUrl: hermes.baseUrl });
  const id = `sys05-bridge-capability-${Date.now()}`;
  await seedDshSession(ctx, id);
  const before = await readEvents(ctx, id);
  try {
    await assert.rejects(
      () => ctx.chatdshHermesChat.send(id, '不该运行', 'op-rejected'),
      (error) => error.code === 'capability-missing' && error.missing.includes('run_approval_response'),
    );
    assert.equal(hermes.state.requests.length, 0, '拒绝发生在执行之前');
    const after = await readEvents(ctx, id);
    assert.equal(after.length, before.length, '拒绝不写会话事件');
  } finally {
    await ctx.fiber.dispose();
    await hermes.close();
  }
});

test('缺少终态明确失败并写出错误收尾', async () => {
  const hermes = await startHermes();
  hermes.state.behavior = 'missing-terminal';
  const home = tempHome('sys05-bridge-missing');
  const ctx = await openHost({ root: home, baseUrl: hermes.baseUrl });
  const id = `sys05-bridge-missing-${Date.now()}`;
  await seedDshSession(ctx, id);
  try {
    await assert.rejects(
      () => ctx.chatdshHermesChat.send(id, '没有终态', 'op-missing'),
      (error) => error.code === 'missing-terminal',
    );
    const events = await readEvents(ctx, id);
    const ends = events.filter((event) => event.type === 'turn/end');
    assert.equal(ends.at(-1).data.reason.kind, 'error');
    assert.deepEqual(ends.slice(0, -1).map((event) => event.data.reason.kind), ['completed'], '只有 DSH 自己的回合是正常结束');
    assert.equal(runRecordsOf(events).at(-1).state, 'failed');
  } finally {
    await ctx.fiber.dispose();
    await hermes.close();
  }
});

test('空会话的第一轮不携带历史，直接按本次输入发起运行', async () => {
  const hermes = await startHermes();
  const home = tempHome('sys05-bridge-empty');
  const ctx = await openHost({ root: home, baseUrl: hermes.baseUrl });
  const id = `sys05-bridge-empty-${Date.now()}`;
  const created = await ctx.sessionPersistence.create({
    id, version: 4, cwd: RUNTIME, createdAt: Date.now(), isSeeded: false,
  });
  await created.flush();
  await created.close();
  try {
    const result = await ctx.chatdshHermesChat.send(id, '第一句话', 'op-empty');
    assert.equal(result.terminal, 'completed');
    assert.equal(result.firstUser, '');
    const body = hermes.state.requests[0].body;
    assert.equal(body.input, '第一句话');
    assert.equal('conversation_history' in body, false, '第一条历史为空时不伪造历史');
    assert.equal('instructions' in body, false, '没有 system 文本时不发 instructions');
    assert.equal('session_id' in body, false, '空历史不携带会话标识，避免 Hermes 加载自己的历史');
  } finally {
    await ctx.fiber.dispose();
    await hermes.close();
  }
});

test('同一操作标识重启后重放不产生第二条回复', async () => {
  const hermes = await startHermes();
  const home = tempHome('sys05-bridge-idempotent');
  const first = await openHost({ root: home, baseUrl: hermes.baseUrl });
  const id = `sys05-bridge-idempotent-${Date.now()}`;
  await seedDshSession(first, id);
  let events;
  try {
    const result = await first.chatdshHermesChat.send(id, '只执行一次', 'op-idempotent');
    assert.equal(result.replayed, false);
    assert.equal(result.appended > 0, true);
  } finally {
    await first.fiber.dispose();
  }

  const second = await openHost({ root: home, baseUrl: hermes.baseUrl });
  try {
    const replay = await second.chatdshHermesChat.send(id, '只执行一次', 'op-idempotent');
    assert.equal(replay.replayed, true);
    assert.equal(replay.appended, 0);
    assert.equal(hermes.state.requests.length, 1, '不创建第二次运行');
    events = await readEvents(second, id);
    const users = events.filter((event) => event.type === 'user/message');
    const assistants = events.filter((event) => event.type === 'assistant/message');
    assert.equal(users.length, 2, '一条是 DSH 回合，一条是 Hermes 回合');
    assert.equal(assistants.length, 2);
  } finally {
    await second.fiber.dispose();
    await hermes.close();
  }
});

test('重复应答已解决的审批按已失效落定', async () => {
  const hermes = await startHermes();
  hermes.state.behavior = 'approval';
  const home = tempHome('sys05-bridge-stale');
  const ctx = await openHost({ root: home, baseUrl: hermes.baseUrl });
  const id = `sys05-bridge-stale-${Date.now()}`;
  await seedDshSession(ctx, id);
  try {
    const sending = ctx.chatdshHermesChat.send(id, '重复审批', 'op-stale');
    const runId = await waitFor(() => [...hermes.state.runs.values()].find((run) => run.input === '重复审批')?.id, 5000, '审批运行');
    await waitFor(async () => (await ctx.chatdshHermesChat.getRun(runId)).status === 'waiting_for_approval', 5000, '等待审批');
    const first = await ctx.chatdshHermesChat.answerApproval(id, runId, `req-${runId}`, 'once', 'sys05-test');
    assert.equal(first.accepted, true);
    assert.equal((await sending).terminal, 'completed');

    const second = await ctx.chatdshHermesChat.answerApproval(id, runId, `req-${runId}`, 'deny', 'sys05-test');
    assert.deepEqual(second, { accepted: false, outcome: 'stale' });
    const events = await readEvents(ctx, id);
    const decisions = events.filter((event) => event.type === 'plugin:chatdsh-approval' && event.data.kind === 'decision');
    assert.equal(decisions.length, 2);
    assert.equal(decisions.at(-1).data.stale, true);
    assert.equal(decisions.at(-1).data.choice, 'deny');
  } finally {
    await ctx.fiber.dispose();
    await hermes.close();
  }
});

test('受理结果未知时拒绝转交其他执行体', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/v1/capabilities') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ features: {
        run_submission: true, run_events_sse: true, approval_events: true,
        run_approval_response: true, run_stop: true, run_status: true,
      } }));
      return;
    }
    // 受理请求不回应：模拟连接建立后超时，受理结果未知。
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const bridge = createHermesHistoryRunBridge({
    baseUrl: `http://127.0.0.1:${port}`,
    requestTimeoutMs: 300,
    approvalTimeoutMs: 1000,
  });
  const messages = [{ role: 'user', text: '可能已经受理' }];
  try {
    await assert.rejects(
      () => bridge.startHistoryRun({
        sessionId: 'session-unknown',
        operationId: 'op-unknown',
        messages,
        system: '',
        historyDigest: historyDigestOf('', messages),
      }),
      (error) => error.code === 'acceptance-unknown' && error.acceptanceUnknown === true,
    );
    const refused = createHermesHistoryRunBridge({
      baseUrl: 'http://127.0.0.1:65533',
      requestTimeoutMs: 300,
      approvalTimeoutMs: 1000,
    });
    await assert.rejects(
      () => refused.capabilities(),
      (error) => error.code === 'unreachable' && error.acceptanceUnknown === false,
    );
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test('同一会话的发送串行，回合并行时回合号与序号连续', async () => {
  const hermes = await startHermes();
  const home = tempHome('sys05-bridge-serial');
  const ctx = await openHost({ root: home, baseUrl: hermes.baseUrl });
  const id = `sys05-bridge-serial-${Date.now()}`;
  await seedDshSession(ctx, id);
  try {
    const [first, second] = await Promise.all([
      ctx.chatdshHermesChat.send(id, '并发一'),
      ctx.chatdshHermesChat.send(id, '并发二'),
    ]);
    assert.equal(first.terminal, 'completed');
    assert.equal(second.terminal, 'completed');
    assert.deepEqual(hermes.state.requests.map((entry) => entry.body.input), ['并发一', '并发二']);
    const events = await readEvents(ctx, id);
    const turns = events.filter((event) => event.type === 'turn/start').map((event) => event.data.turn);
    assert.deepEqual(turns, [1, 2, 3]);
    assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index));
    assert.equal(events.filter((event) => event.type === 'assistant/message').length, 3);
  } finally {
    await ctx.fiber.dispose();
    await hermes.close();
  }
});
