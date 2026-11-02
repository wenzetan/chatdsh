// WP07 的真实浏览器验收：真实 SSE 跟随流、逐段追加、工具卡片截断、队列暂停与显式恢复、
// 准确停止、消息反馈与实时播报。
//
// 页面用 esbuild 打包包内已编译的真实模块与真实 React 渲染入口，由本机真实 HTTP 服务提供；
// 跟随流是真实的 text/event-stream 响应，发送、停止、状态查询与反馈都是真实 HTTP 接口，遥测
// 走真实的同源中继端点。浏览器是 agent-browser 独立会话里的真实 Chrome，使用独立 HOME、
// TMPDIR 与 profile，不截图；断言全部来自真实 DOM、控制器状态与本机收到的请求。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { build } from 'esbuild';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';

const execute = promisify(execFile);
const NODE_BIN = '/usr/local/nvm/versions/node/v24.19.0/bin';
const AGENT_BROWSER = `${NODE_BIN}/agent-browser`;
const RUNTIME_ROOT = new URL('../..', import.meta.url).pathname;

/** 页面入口：挂载真实席位，暴露控制器与错误收集。 */
const PAGE_ENTRY = `
import { createRoot } from 'react-dom/client';
import { createConversationTelemetry, createSeatRuntime, randomHex } from './packages/client/conversation/lib/index.js';

const host = document.querySelector('#seat');
const errors = [];
window.__errors = errors;
window.addEventListener('error', (event) => errors.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)));

const telemetry = createConversationTelemetry({ fetchImpl: fetch, randomHex, now: () => Date.now() });
const runtime = createSeatRuntime(host, {
  sessionId: 'session-wp07',
  deviceId: 'device-alpha',
  deviceName: '本机设备',
  cwd: '/workspace/chatdsh',
  model: 'deepseek-v4',
  source: 'local',
  title: '会话 WP07',
  storage: window.localStorage,
  clientId: 'client-wp07',
  windowId: 'window-wp07',
  telemetry,
  requestTimeoutMs: 4000,
  endpoints: {
    streamUrl: '/session-events',
    sendUrl: '/send',
    stopUrl: '/stop',
    queryUrl: '/query',
    feedbackUrl: '/feedback',
  },
  candidates: [
    { id: 'src/index.ts', kind: 'file', label: 'index.ts', group: '文件', origin: 'local', description: '入口文件' },
    { id: 'session-b', kind: 'session', label: '会话乙', group: '会话', origin: 'remote' },
    { id: 'memory-1', kind: 'memory', label: '偏好记忆', group: '记忆', origin: 'local' },
  ],
  runtimeCommands: [
    { id: 'compact', name: '压缩会话', group: '运行时', description: '压缩当前会话', scope: 'session', enabled: true },
  ],
});

const root = createRoot(host);
const render = () => root.render(runtime.element());
runtime.subscribe(render);
render();
window.__runtime = runtime;
window.__ready = true;
`;

/** 页面外壳。 */
const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>WP07 会话席位</title></head>
<body><main id="seat"></main><script type="module" src="/app.js"></script></body></html>`;

/** SSE 帧之间的空行。 */
const SSE_BREAK = String.fromCharCode(10, 10);

/** 一条会话事件。 */
function event(type, seq, time, data, extra = {}) {
  return { type, seq, time, data, ...extra };
}

/** 打开窗口里的一条记录。 */
function record(evt) {
  return { type: 'event', event: evt };
}

/** 一条用户消息。 */
function userMessage(seq, text) {
  return event('user/message', seq, 1_000 + seq, {
    id: `user-${seq}`,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  }, { surfaceOp: 'append' });
}

/** 一条助手消息。 */
function assistantMessage(seq, text) {
  return event('assistant/message', seq, 1_000 + seq, {
    turn: 1,
    step: 1,
    message: {
      id: `assistant-${seq}`,
      role: 'assistant',
      source: { kind: 'model', provider: 'deepseek', model: 'v4' },
      content: [{ type: 'text', text }],
    },
    stream: [],
  }, { surfaceOp: 'append' });
}

/** 建立真实 HTTP 服务的状态容器。 */
function createHarness() {
  return {
    events: [],
    streams: new Set(),
    sends: [],
    stops: [],
    queries: [],
    feedback: [],
    telemetry: [],
    attempt: 'attempt-1',
    attempts: 0,
    confirmed: new Set(),
    seq: 0,
  };
}

/** 起一个真实 HTTP 服务：页面、打包产物、跟随流与写入端点。 */
async function startServer(bundle) {
  const state = createHarness();
  const nextSeq = () => {
    state.seq += 1;
    return state.seq;
  };
  const append = (evt) => {
    state.events.push(evt);
    return evt;
  };
  const writeFrame = (response, payload) => {
    response.write(`data: ${JSON.stringify(payload)}${SSE_BREAK}`);
  };
  const broadcast = (payload) => {
    for (const response of state.streams) writeFrame(response, payload);
  };
  const snapshotFrame = () => ({
    type: 'snapshot',
    cursor: state.events.length === 0 ? 0 : state.events.at(-1).seq,
    hasMore: false,
    records: state.events.map(record),
  });
  const readJson = async (request) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://local.invalid');
    if (url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(PAGE);
      return;
    }
    if (url.pathname === '/app.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      response.end(bundle);
      return;
    }
    if (url.pathname === '/session-events') {
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      response.write(`retry: 200${SSE_BREAK}`);
      state.streams.add(response);
      writeFrame(response, snapshotFrame());
      request.on('close', () => state.streams.delete(response));
      return;
    }
    if (url.pathname === '/send' && request.method === 'POST') {
      const payload = await readJson(request);
      state.sends.push(payload);
      const duplicate = state.confirmed.has(payload.requestId);
      state.confirmed.add(payload.requestId);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ accepted: true, duplicate, seq: duplicate ? 0 : nextSeq() }));
      return;
    }
    if (url.pathname === '/stop' && request.method === 'POST') {
      state.stops.push(await readJson(request));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ outcome: 'stopped', runId: state.attempt }));
      return;
    }
    if (url.pathname === '/query') {
      const requestId = url.searchParams.get('requestId');
      state.queries.push(requestId);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(state.confirmed.has(requestId) ? { state: 'confirmed', seq: 1 } : { state: 'pending' }));
      return;
    }
    if (url.pathname === '/feedback' && request.method === 'POST') {
      state.feedback.push(await readJson(request));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"accepted":true}');
      return;
    }
    if (url.pathname === '/chatdsh/telemetry/browser' && request.method === 'POST') {
      state.telemetry.push({ signal: request.headers['x-chatdsh-signal'], body: await readJson(request) });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"accepted":true}');
      return;
    }
    if (url.pathname === '/state') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        sends: state.sends.length,
        stops: state.stops.length,
        queries: state.queries.length,
        feedback: state.feedback,
        telemetry: state.telemetry.length,
        events: state.events.map((item) => ({ type: item.type, seq: item.seq })),
      }));
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    state,
    append,
    nextSeq,
    broadcast,
    writeFrame,
    snapshotFrame,
    port: server.address().port,
    async close() {
      for (const stream of state.streams) stream.end();
      state.streams.clear();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** 把 OTLP 属性数组摊平成对象。 */
function attributesOf(attributes) {
  const out = {};
  for (const attribute of attributes ?? []) out[attribute.key] = attribute.value.stringValue ?? attribute.value.intValue;
  return out;
}

/** 取上报里的 span。 */
function spansOf(requests) {
  const out = [];
  for (const request of requests) {
    if (request.signal !== 'traces') continue;
    for (const resource of request.body.resourceSpans ?? []) {
      for (const scope of resource.scopeSpans ?? []) {
        for (const span of scope.spans ?? []) {
          out.push({ name: span.name, status: span.status, attributes: attributesOf(span.attributes) });
        }
      }
    }
  }
  return out;
}

/** 取上报里的日志记录。 */
function eventsOf(requests) {
  const out = [];
  for (const request of requests) {
    if (request.signal !== 'logs') continue;
    for (const resource of request.body.resourceLogs ?? []) {
      for (const scope of resource.scopeLogs ?? []) {
        for (const entry of scope.logRecords ?? []) {
          out.push({ body: entry.body?.stringValue, attributes: attributesOf(entry.attributes) });
        }
      }
    }
  }
  return out;
}

/** 取上报里的计数数据点。 */
function metricPointsOf(requests) {
  const out = [];
  for (const request of requests) {
    if (request.signal !== 'metrics') continue;
    for (const resource of request.body.resourceMetrics ?? []) {
      for (const scope of resource.scopeMetrics ?? []) {
        for (const metric of scope.metrics ?? []) {
          for (const point of metric.sum?.dataPoints ?? []) {
            out.push({ name: metric.name, attributes: attributesOf(point.attributes) });
          }
        }
      }
    }
  }
  return out;
}

test('真实 Chrome：流式追加、工具卡片、队列暂停与显式恢复、准确停止与反馈', { timeout: 300000 }, async () => {
  const home = allocateIndependentHome('wp07-stream');
  const session = `wp07-stream-${randomUUID().slice(0, 8)}`;
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
    const result = await execute(AGENT_BROWSER, ['--session', session, '--json', ...args], {
      env,
      timeout: 60000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const response = JSON.parse(result.stdout);
    assert.equal(response.success, true, `agent-browser ${args[0]}：${result.stdout}`);
    return response;
  };
  const bundle = await build({
    stdin: { contents: PAGE_ENTRY, resolveDir: RUNTIME_ROOT, loader: 'js' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2023',
    write: false,
    logLevel: 'silent',
  });
  const server = await startServer(bundle.outputFiles[0].text);
  const origin = `http://127.0.0.1:${server.port}`;
  const pushEvent = (evt) => {
    server.append(evt);
    server.broadcast({ type: 'event', event: evt });
  };
  const pushStream = (frame) => server.broadcast({ type: 'assistant-stream', frame });
  const pushChunk = (attemptId, index, text) => pushStream({
    type: 'chunk',
    attemptId,
    revision: 1,
    index,
    time: Date.now(),
    chunk: { type: 'text-delta', index, text },
  });
  const evalJs = async (expression) => {
    const response = await cli('eval', expression);
    return response.data.result;
  };
  const waitFor = (expression) => cli('wait', '--fn', expression);
  const textOf = (selector) => evalJs(`(document.querySelector(${JSON.stringify(selector)}) || {}).textContent || ''`);
  const click = (selector) => cli('click', selector);

  // 打开窗口之前先放好开场事件：回合开始与一条用户消息。
  server.append(event('turn/start', 0, 1_000, { turn: 1 }));
  server.append(userMessage(1, '你好，请开始'));
  server.state.seq = 1;

  let opened = false;
  try {
    await cli('open', `${origin}/`);
    opened = true;
    await waitFor('window.__ready === true');
    await waitFor('document.body.innerText.includes("你好，请开始")');
    assert.equal(await textOf('[data-source]'), '本机执行');
    assert.equal(await textOf('.chdsh-conv__title'), '会话 WP07');

    // 一：流式逐段追加。首字之前显示等待首字，片段到达之后逐段增长。
    pushStream({ type: 'start', attemptId: 'attempt-1', revision: 1, startedAfterSeq: 1, turn: 1, step: 1 });
    await waitFor('document.body.innerText.includes("等待首字")');
    pushChunk('attempt-1', 0, '逐');
    await waitFor('document.body.innerText.includes("逐")');
    assert.equal(await textOf('[data-announcer]'), '', '没有语义边界时不播报');
    pushChunk('attempt-1', 1, '段');
    await waitFor('document.body.innerText.includes("逐段")');
    assert.equal(await textOf('[data-announcer]'), '', '片段到达不逐 token 播报');
    pushChunk('attempt-1', 2, '追加。');
    await waitFor('document.body.innerText.includes("逐段追加。")');
    assert.equal(await textOf('[data-announcer]'), '逐段追加。', '到句末才播报一次');

    // 落盘事件到达之后，界面以落盘内容为准，状态变为已完成。
    pushStream({ type: 'end', attemptId: 'attempt-1', revision: 1, index: 2, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 2 } });
    pushEvent(assistantMessage(2, '逐段追加。'));
    pushEvent(event('turn/end', 3, 1_010, { turn: 1, reason: { kind: 'completed' } }));
    await waitFor('document.body.innerText.includes("已完成")');
    assert.equal(await textOf('[data-message-id="assistant-2"] [data-status-text]'), '已完成');
    assert.equal(
      await evalJs('document.querySelector("[data-message-id=\\"assistant-2\\"] .chdsh-conv__body").textContent'),
      '逐段追加。',
      '最终呈现与落盘内容一致'
    );

    // 二：工具卡片。参数摘要可见，结果超过上限时给出字节数与完整读取入口。
    const longResult = 'R'.repeat(6000);
    pushEvent(event('tool/call', 4, 1_020, { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"cat long.txt"}' }));
    pushEvent(event('tool/result', 5, 1_060, {
      turn: 1,
      step: 1,
      message: {
        id: 'tool-1',
        role: 'tool',
        source: { kind: 'tool', callId: 'call-1' },
        toolCallId: 'call-1',
        content: [{ type: 'text', text: longResult }],
      },
    }));
    pushEvent(event('turn/end', 6, 1_070, { turn: 1, reason: { kind: 'completed' } }));
    await waitFor('document.querySelector("[aria-label=\\"工具调用 bash\\"]") !== null');
    assert.match(await textOf('[aria-label="工具调用 bash"]'), /耗时 40 毫秒/);
    assert.match(await textOf('[aria-label="工具调用 bash"]'), /6000 字节，已截断显示/);
    assert.equal(await textOf('[aria-label="bash 结果"] pre').then((text) => text.length), 4096);
    await cli('find', 'text', '读取完整结果', 'click');
    await waitFor('document.querySelector("[data-full-result]") !== null');
    assert.equal(
      await evalJs('document.querySelector("[data-full-result] pre").textContent.length'),
      6000,
      '完整读取入口给出完整正文'
    );

    // 三：空闲时直接发送，服务端只收到一次提交。
    await cli('click', 'textarea.chdsh-conv__input');
    await cli('fill', 'textarea.chdsh-conv__input', '直接发送的内容');
    await cli('press', 'Enter');
    await waitFor('document.body.innerText.includes("已发送")');
    assert.equal(server.state.sends.length, 1);
    assert.equal(server.state.sends[0].sessionId, 'session-wp07');
    assert.equal(server.state.sends[0].content[0].text, '直接发送的内容');
    assert.equal(server.state.sends[0].mode, 'queue');

    // 四：运行中的消息进入队列，断线后队列暂停，恢复只重新读取状态。
    pushStream({ type: 'start', attemptId: 'attempt-2', revision: 1, startedAfterSeq: 6, turn: 2, step: 1 });
    pushChunk('attempt-2', 0, '正在输出');
    await waitFor('document.body.innerText.includes("正在输出")');
    await cli('click', 'textarea.chdsh-conv__input');
    await cli('fill', 'textarea.chdsh-conv__input', '排队的内容');
    await cli('press', 'Enter');
    await waitFor('document.body.innerText.includes("待发送队列")');
    assert.match(await textOf('[data-queue-state]'), /待发送/);
    assert.equal(server.state.sends.length, 1, '运行中的内容只入队，不直接提交');
    const queuedId = await evalJs('document.querySelector("[data-queue-item]").getAttribute("data-queue-item")');

    for (const stream of server.state.streams) stream.end();
    server.state.streams.clear();
    await waitFor('document.body.innerText.includes("队列已暂停")');
    assert.equal(await textOf('[data-connection]'), '连接中断');

    // 浏览器按服务端给的 retry 自动重连，重连后的打开窗口恢复读取。
    await waitFor('document.querySelector("[data-connection]").textContent !== "连接中断"');
    assert.match(await textOf('[data-queue-state]'), /已暂停/, '恢复连接不自动恢复队列');
    assert.equal(server.state.sends.length, 1, '恢复连接不自动发送');

    await click('[data-action="queue-resume"]');
    await waitFor('document.body.innerText.includes("等你显式发送")');
    assert.equal(server.state.sends.length, 1, '恢复队列不自动发送');
    assert.equal(
      await evalJs('document.querySelector("[data-queue-item]").getAttribute("data-queue-state")'),
      'pending'
    );

    await click('[data-action="queue-send"]');
    await waitFor('document.body.innerText.includes("队列里的下一条已发送")');
    assert.equal(server.state.sends.length, 2);
    assert.equal(server.state.sends[1].requestId, queuedId, '队列条目按原幂等键提交');
    assert.equal(
      await evalJs('document.querySelector("[data-queue-item]").getAttribute("data-queue-state")'),
      'confirmed'
    );
    await click('[data-action="queue-send"]');
    await waitFor('document.body.innerText.includes("队列里没有待发送内容")');
    assert.equal(server.state.sends.length, 2, '没有待发送内容时不再提交');

    // 五：准确停止。宿主确认之后才显示已停止，确认之后到达的片段被丢弃。
    server.state.attempt = 'attempt-3';
    pushStream({ type: 'start', attemptId: 'attempt-3', revision: 1, startedAfterSeq: 6, turn: 3, step: 1 });
    pushChunk('attempt-3', 0, '要停止的输出');
    await waitFor('document.body.innerText.includes("要停止的输出")');
    await waitFor('document.querySelector("[data-action=\\"stop\\"]").disabled === false');
    await click('[data-action="stop"]');
    await new Promise((resolve) => setTimeout(resolve, 800));
    const serverAfterStop = await fetch(`${origin}/state`).then((response) => response.json());
    const stopState = await evalJs('JSON.stringify({ run: window.__runtime.controller().state().run, notice: window.__runtime.controller().state().notice, failure: window.__runtime.controller().state().failure })');
    assert.equal(serverAfterStop.stops, 1, `${stopState} ${JSON.stringify(serverAfterStop)}`);
    assert.equal(stopState.includes('"run":"stopped"'), true, stopState);
    await waitFor('document.body.innerText.includes("已停止")');
    assert.equal(server.state.stops.length, 1);
    assert.equal(server.state.stops[0].sessionId, 'session-wp07');
    assert.equal(server.state.attempt, 'attempt-3');
    pushChunk('attempt-3', 1, '迟到的内容');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(
      await evalJs('document.body.innerText.includes("迟到的内容")'),
      false,
      '停止确认之后的迟到片段不进入消息区'
    );

    // 六：消息反馈与复制。
    await click('[data-message-id="assistant-2"] .chdsh-conv__row button:nth-child(1)');
    await waitFor('document.body.innerText.includes("反馈已提交")');
    assert.equal(server.state.feedback.length, 1);
    assert.equal(server.state.feedback[0].messageId, 'assistant-2');
    assert.equal(server.state.feedback[0].rating, 'like');
    await click('[data-message-id="assistant-2"] .chdsh-conv__row button:nth-child(3)');
    await waitFor('document.body.innerText.includes("已复制")');

    // 七：遥测。发送、队列、流式与引用各有一条信号，且不含消息正文。
    await new Promise((resolve) => setTimeout(resolve, 400));
    const telemetryState = await fetch(`${origin}/state`).then((response) => response.json());
    assert.ok(telemetryState.telemetry > 0, '遥测上报到达同源中继');
    const spans = spansOf(server.state.telemetry);
    const events = eventsOf(server.state.telemetry);
    const metrics = metricPointsOf(server.state.telemetry);
    const sendSpan = spans.find((span) => span.name === 'chatdsh.client.message.send');
    assert.ok(sendSpan !== undefined, JSON.stringify(spans.map((span) => span.name)));
    assert.equal(sendSpan.attributes['session.id'], 'session-wp07');
    assert.equal(sendSpan.attributes['deviceId'], 'device-alpha');
    assert.equal(sendSpan.attributes['outcome'], 'ok');
    assert.equal(sendSpan.attributes['chars'], '7');
    assert.ok(spans.some((span) => span.name === 'chatdsh.client.queue.consume'), '队列动作有 span');
    assert.ok(
      events.some((entry) => entry.body === 'chatdsh.client.stream.interrupted'),
      '连接中断有失败事件'
    );
    assert.ok(metrics.some((point) => point.name === 'chatdsh_client_message_sends_total'));
    assert.ok(metrics.some((point) => point.name === 'chatdsh_client_queue_actions_total'));
    assert.ok(metrics.some((point) => point.name === 'chatdsh_client_stream_events_total'));
    const telemetryText = JSON.stringify(server.state.telemetry);
    for (const secret of ['直接发送的内容', '排队的内容', '逐段追加', '要停止的输出']) {
      assert.equal(telemetryText.includes(secret), false, `遥测不含正文：${secret}`);
    }
    const errors = await evalJs('JSON.stringify(window.__errors)');
    assert.deepEqual(JSON.parse(errors), []);
  } finally {
    if (opened) await cli('close');
    await server.close();
    releaseIndependentHome(home);
  }
});

