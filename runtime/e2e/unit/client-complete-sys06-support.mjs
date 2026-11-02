// SYS06 验收共用的真实服务与遥测夹具。
//
// 这里只有真实实现：OTLP/HTTP 收集器接收遥测客户端导出的信号；Hermes 契约服务监听真实
// 端口并按 `api_server` 的接口应答能力、受理（幂等键）、状态查询与 SSE 事件流；托管子进程
// 由测试启动真实 Node 进程提供同样的能力接口。没有替身本仓库代码。

import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureDeps } from '../lib/ensure-deps.mjs';

const RUNTIME = resolve(import.meta.dirname, '../..');
ensureDeps(RUNTIME);

const { createTelemetryClient } = await import('../../packages/core/diagnostics/lib/index.js');
const { defaultTelemetryConfig } = await import('../../packages/core/diagnostics/lib/config.js');

export { delay };

/** 建立一个真实的 OTLP/HTTP 收集器。 */
export async function startCollector() {
  const bodies = { logs: [], traces: [], metrics: [] };
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const signal = request.url?.includes('/v1/logs')
        ? 'logs'
        : request.url?.includes('/v1/traces') ? 'traces' : 'metrics';
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

/** 建立接收集中的遥测客户端。 */
export function telemetryClientFor(collector, component) {
  return createTelemetryClient({
    config: defaultTelemetryConfig({
      endpoint: collector.url,
      exportIntervalMs: 100,
      exportIntervalMsMetrics: 100,
      exportTimeoutMs: 50,
      surface: 'gateway',
    }),
    component,
  });
}

/** 属性列表转对象。 */
export function attributesOf(entries) {
  const attributes = {};
  for (const entry of entries ?? []) {
    const value = entry.value ?? {};
    attributes[entry.key] = value.stringValue ?? value.intValue ?? value.boolValue ?? value.doubleValue;
  }
  return attributes;
}

/** 摊平日志。 */
export function flattenLogs(payloads) {
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
export function flattenTraces(payloads) {
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

/** 摊平指标。 */
export function flattenMetrics(payloads) {
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

/** 完整的 Hermes 能力。 */
const FEATURES = {
  run_submission: true,
  run_events_sse: true,
  approval_events: true,
  run_approval_response: true,
  run_stop: true,
  run_status: true,
};

/** 读完整请求体。 */
function readBody(request) {
  return new Promise((done) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
  });
}

/**
 * 起一个实现 Hermes `api_server` 运行契约的真实服务。
 *
 * 模式：`normal` 正常受理；`hang-first` 首次受理请求只登记运行、不回响应（客户端按超时
 * 判定受理结果不确定），同一幂等键的后续请求立即返回原运行。
 * @param {{ mode?: 'normal'|'hang-first', features?: Record<string, boolean> }} [options] 服务模式与能力覆盖。
 */
export async function startHermesServer(options = {}) {
  const state = {
    mode: options.mode ?? 'normal',
    features: { ...FEATURES, ...(options.features ?? {}) },
    runs: new Map(),
    byKey: new Map(),
    requests: [],
    hungKeys: new Set(),
    counter: 0,
  };
  const server = createServer(async (request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    await new Promise((done) => request.on('end', done));
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const key = request.headers['idempotency-key'];
    state.requests.push({
      method: request.method ?? '',
      url: request.url ?? '',
      key: typeof key === 'string' ? key : '',
      at: Date.now(),
    });
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/v1/capabilities') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ model: 'hermes-test', features: state.features }));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/runs') {
      const existing = typeof key === 'string' ? state.byKey.get(key) : undefined;
      if (existing !== undefined) {
        const run = state.runs.get(existing);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ run_id: existing, status: run.status, replayed: true }));
        return;
      }
      state.counter += 1;
      const runId = `run-${state.counter}`;
      const payload = JSON.parse(bodyText === '' ? '{}' : bodyText);
      state.runs.set(runId, {
        runId,
        status: 'queued',
        output: '',
        body: payload,
        key: typeof key === 'string' ? key : '',
      });
      if (typeof key === 'string') state.byKey.set(key, runId);
      if (state.mode === 'hang-first' && typeof key === 'string' && !state.hungKeys.has(key)) {
        state.hungKeys.add(key);
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ run_id: runId, status: 'queued', replayed: false }));
      return;
    }
    if (request.method === 'GET' && url.pathname.startsWith('/v1/runs/')) {
      const rest = url.pathname.slice('/v1/runs/'.length);
      if (rest.endsWith('/events')) {
        const runId = rest.slice(0, -'/events'.length);
        const run = state.runs.get(runId);
        if (run === undefined) {
          response.writeHead(404, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: 'run_not_found' }));
          return;
        }
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const frames = [
          { event: 'message.delta', payload: { delta: '你好' } },
          { event: 'run.completed', payload: { output: run.output || '完成了' } },
        ];
        let seq = 0;
        for (const frame of frames) {
          const data = JSON.stringify({ run_id: runId, event: frame.event, seq, ...frame.payload });
          response.write(`id: ${seq}\nevent: ${frame.event}\ndata: ${data}\n\n`);
          seq += 1;
        }
        run.status = 'completed';
        response.end();
        return;
      }
      const run = state.runs.get(rest);
      if (run === undefined) {
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'run_not_found' }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        run_id: run.runId,
        status: run.status,
        ...(run.output === '' ? {} : { output: run.output }),
      }));
      return;
    }
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(options.port ?? 0, '127.0.0.1', done);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    state,
    requests: state.requests,
    setStatus(runId, status, output = '') {
      const run = state.runs.get(runId);
      if (run === undefined) throw new Error(`未知运行：${runId}`);
      run.status = status;
      if (output !== '') run.output = output;
    },
    close: () => new Promise((done) => {
      server.closeAllConnections();
      server.close(done);
    }),
  };
}

/**
 * 托管子进程脚本：监听给定端口并提供能力接口。
 * @param {number} port 监听端口。
 * @returns {string} 交给 `node -e` 的脚本。
 */
export function childServerScript(port) {
  return `
const http = require('node:http');
const port = ${port};
const features = {
  run_submission: true,
  run_events_sse: true,
  approval_events: true,
  run_approval_response: true,
  run_stop: true,
  run_status: true,
};
const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/v1/capabilities') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ model: 'hermes-child', features }));
    return;
  }
  response.writeHead(404, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: 'not_found' }));
});
server.listen(port, '127.0.0.1', () => process.stdout.write('Hermes 能力接口已就绪 ' + port + '\\n'));
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
`;
}

/** 读一个地址的状态码；连接失败时返回 0。 */
export async function statusOf(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
    await response.text();
    return response.status;
  } catch {
    return 0;
  }
}

/** 进程是否还活着。 */
export function alive(pid) {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
