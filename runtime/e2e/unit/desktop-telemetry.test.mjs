// 桌面壳遥测模块的测试。
//
// telemetry.mjs 负责把启动阶段、运行时编排与电源阻止编成 OTLP 交同源中继。这里起一个本地
// HTTP 服务当接收端，核对四件事：地址未就绪时先排队、设置地址后一次性发出、span 与事件的
// 载荷形状符合规范、地址不可达时不抛异常。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { noteEvent, setTelemetryOrigin, startSpan } from '../../desktop/electron/telemetry.mjs';

/** 起一个接收端，收集收到的请求。 */
async function startReceiver() {
  const received = [];
  const waiting = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      received.push({
        path: request.url,
        signal: request.headers['x-chatdsh-signal'],
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"accepted":true}');
      while (waiting.length > 0) waiting.shift()();
    });
  });
  await new Promise((settle) => server.listen(0, '127.0.0.1', settle));
  const port = server.address().port;
  return {
    origin: `http://127.0.0.1:${port}`,
    received,
    /** 等到累计收到 count 条请求。 */
    async waitFor(count, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (received.length < count) {
        if (Date.now() > deadline) return false;
        await new Promise((settle) => { waiting.push(settle); setTimeout(settle, 100); });
      }
      return true;
    },
    async close() {
      await new Promise((settle) => server.close(settle));
    },
  };
}

test('地址未就绪时排队，设置地址后一次性发出', async () => {
  const receiver = await startReceiver();
  try {
    const finish = startSpan('chatdsh.desktop.startup.instance');
    finish('ok', { stage: 'instance' });
    assert.equal(receiver.received.length, 0, '地址未设置时不应发出');

    setTelemetryOrigin(receiver.origin);
    assert.equal(await receiver.waitFor(1), true, '设置地址后应发出排队的记录');

    const first = receiver.received[0];
    assert.equal(first.path, '/chatdsh/telemetry/browser');
    assert.equal(first.signal, 'traces');
    const span = first.body.resourceSpans[0].scopeSpans[0].spans[0];
    assert.equal(span.name, 'chatdsh.desktop.startup.instance');
    assert.equal(span.status.code, 1);
    const attributes = Object.fromEntries(span.attributes.map((item) => [item.key, item.value.stringValue]));
    assert.equal(attributes.stage, 'instance');
    assert.equal(attributes.outcome, 'ok');
    assert.equal(typeof attributes.duration, 'string');

    const resourceAttributes = Object.fromEntries(
      first.body.resourceSpans[0].resource.attributes.map((item) => [item.key, item.value.stringValue]),
    );
    assert.equal(resourceAttributes['service.name'], 'chatdsh-desktop');
    assert.equal(resourceAttributes['chatdsh.surface'], 'desktop');
    assert.equal(resourceAttributes['chatdsh.component'], '@chatdsh/desktop');
    assert.equal(first.body.resourceSpans[0].scopeSpans[0].scope.name, '@chatdsh/desktop');
  } finally {
    await receiver.close();
  }
});

test('失败结果把 span 状态码标成二', async () => {
  const receiver = await startReceiver();
  try {
    setTelemetryOrigin(receiver.origin);
    const finish = startSpan('chatdsh.desktop.runtime.orchestrate');
    finish('failed', { 'runtime.id': 'http://127.0.0.1:3151' });
    assert.equal(await receiver.waitFor(1), true);
    const span = receiver.received[0].body.resourceSpans[0].scopeSpans[0].spans[0];
    assert.equal(span.status.code, 2);
  } finally {
    await receiver.close();
  }
});

test('电源阻止的 span 带上模式与动作', async () => {
  const receiver = await startReceiver();
  try {
    setTelemetryOrigin(receiver.origin);
    const finish = startSpan('chatdsh.desktop.power.block');
    finish('ok', { 'power.mode': 'prevent-display-sleep', action: 'acquire' });
    assert.equal(await receiver.waitFor(1), true);
    const span = receiver.received[0].body.resourceSpans[0].scopeSpans[0].spans[0];
    const attributes = Object.fromEntries(span.attributes.map((item) => [item.key, item.value.stringValue]));
    assert.equal(attributes['power.mode'], 'prevent-display-sleep');
    assert.equal(attributes.action, 'acquire');
  } finally {
    await receiver.close();
  }
});

test('事件走 logs 信号并带错误属性', async () => {
  const receiver = await startReceiver();
  try {
    setTelemetryOrigin(receiver.origin);
    noteEvent('chatdsh.desktop.runtime.failed', { 'error.type': 'runtime-start', 'error.code': 'spawn-failed' });
    assert.equal(await receiver.waitFor(1), true);
    const record = receiver.received[0];
    assert.equal(record.signal, 'logs');
    const logRecord = record.body.resourceLogs[0].scopeLogs[0].logRecords[0];
    assert.equal(logRecord.body.stringValue, 'chatdsh.desktop.runtime.failed');
    const attributes = Object.fromEntries(logRecord.attributes.map((item) => [item.key, item.value.stringValue]));
    assert.equal(attributes['error.type'], 'runtime-start');
    assert.equal(attributes['error.code'], 'spawn-failed');
  } finally {
    await receiver.close();
  }
});

test('地址不可达时不抛异常', async () => {
  setTelemetryOrigin('http://127.0.0.1:9');
  const finish = startSpan('chatdsh.desktop.startup.ui');
  finish('ok', { stage: 'ui' });
  noteEvent('chatdsh.desktop.noop', { 'error.type': 'none' });
  await new Promise((settle) => setTimeout(settle, 50));
  assert.equal(true, true);
});
