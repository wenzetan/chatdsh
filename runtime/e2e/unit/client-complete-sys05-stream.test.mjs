// SYS05 的运行事件流解析验收。
//
// 起一个真实的本机 HTTP 服务，按真实 Hermes 的 SSE 形状送出事件：`id:` 行、`data:` 单行
// JSON、注释帧与保活帧。测试按字节切片写入，覆盖分片落在多字节字符中间、CRLF 行尾与事件
// 边界；审批事件必须在终态之前产出；未知事件、缺终态、第二个终态与序号缺口必须明确失败。
//
// 运行：node --test e2e/unit/client-complete-sys05-stream.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { ensureDeps } from '../lib/ensure-deps.mjs';

const RUNTIME = resolve(import.meta.dirname, '../..');
ensureDeps(RUNTIME);

const { streamRunEvents, readRunFrames } = await import('../../../hermes-adapter/lib/index.js');

/**
 * 起一个真实 HTTP 服务，用写好的分片送出响应。
 * @param {(response: import('node:http').ServerResponse) => Promise<void>} write 写入主体。
 * @returns {Promise<{ baseUrl: string, close: () => Promise<void> }>} 服务地址与关闭函数。
 */
async function serve(write) {
  const server = createServer(async (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    await write(response);
    response.end();
  });
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((done) => server.close(done)),
  };
}

/** 一帧事件文本。 */
function frame(seq, payload) {
  return `id: ${seq}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** 按 N 字节切片写入，模拟 TCP 分片。 */
async function writeFragments(response, text, size, delayMs = 1) {
  const bytes = Buffer.from(text, 'utf8');
  for (let offset = 0; offset < bytes.length; offset += size) {
    response.write(bytes.subarray(offset, Math.min(offset + size, bytes.length)));
    await new Promise((done) => setTimeout(done, delayMs));
  }
}

/** 收齐事件或错误。 */
async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

test('分片与 CRLF 与注释帧不影响事件边界，审批先于终态', async () => {
  const frames = [
    frame(0, { event: 'message.delta', run_id: 'run-sse', seq: 0, delta: '第一段中文', timestamp: 1 }),
    frame(1, {
      event: 'approval.request', run_id: 'run-sse', seq: 1, request_id: 'req-1',
      description: '执行命令', command: 'rm -rf /', choices: ['once', 'deny'], timestamp: 1,
    }),
    frame(2, { event: 'approval.responded', run_id: 'run-sse', seq: 2, request_id: 'req-1', choice: 'once', resolved: 1 }),
    frame(3, { event: 'message.delta', run_id: 'run-sse', seq: 3, delta: '第二段', timestamp: 1 }),
    frame(4, { event: 'run.completed', run_id: 'run-sse', seq: 4, output: '第一段中文第二段', usage: { input_tokens: 3 }, timestamp: 1 }),
  ].join('').replaceAll('\n', '\r\n');
  const service = await serve(async (response) => {
    response.write(': open\r\n\r\n');
    await writeFragments(response, frames, 5);
    response.write(': stream closed\r\n\r\n');
  });
  try {
    const response = await fetch(`${service.baseUrl}/v1/runs/run-sse/events`);
    const events = await collect(streamRunEvents(response.body, { runId: 'run-sse' }));
    assert.deepEqual(events.map((event) => event.type), [
      'text.delta', 'approval.asked', 'approval.decided', 'text.delta', 'run.completed',
    ]);
    assert.equal(events[0].text, '第一段中文');
    const asked = events[1];
    assert.equal(asked.approval.requestId, 'req-1');
    assert.equal(asked.approval.title, '执行命令');
    assert.deepEqual(asked.approval.choices, ['once', 'deny']);
    assert.equal(asked.approval.command, 'rm -rf /');
    assert.equal(events[4].output, '第一段中文第二段');
    assert.deepEqual(events[4].usage, { input_tokens: 3 });
    assert.ok(events.indexOf(asked) < events.findIndex((event) => event.type === 'run.completed'), '审批在终态之前产出');
  } finally {
    await service.close();
  }
});

test('续读位置之前的事件被跳过', async () => {
  const frames = [0, 1, 2, 3].map((seq) => frame(seq, {
    event: seq === 3 ? 'run.completed' : 'message.delta',
    run_id: 'run-resume',
    seq,
    ...(seq === 3 ? { output: '完成' } : { delta: `第${seq}段` }),
  })).join('');
  const service = await serve((response) => writeFragments(response, frames, 8));
  try {
    const response = await fetch(`${service.baseUrl}/v1/runs/run-resume/events`);
    const events = await collect(streamRunEvents(response.body, { runId: 'run-resume', lastEventId: '1' }));
    assert.deepEqual(events.map((event) => event.seq), [2, 3]);
  } finally {
    await service.close();
  }
});

test('未知必需事件明确失败', async () => {
  const frames = frame(0, { event: 'future.unknown', run_id: 'run-unknown', seq: 0 })
    + frame(1, { event: 'run.completed', run_id: 'run-unknown', seq: 1, output: '完成' });
  const service = await serve((response) => writeFragments(response, frames, 16));
  try {
    const response = await fetch(`${service.baseUrl}/v1/runs/run-unknown/events`);
    await assert.rejects(
      () => collect(streamRunEvents(response.body, { runId: 'run-unknown' })),
      (error) => error.code === 'unknown-required-event',
    );
  } finally {
    await service.close();
  }
});

test('缺少终态明确失败', async () => {
  const frames = frame(0, { event: 'message.delta', run_id: 'run-open', seq: 0, delta: '半截' });
  const service = await serve((response) => writeFragments(response, frames, 16));
  try {
    const response = await fetch(`${service.baseUrl}/v1/runs/run-open/events`);
    await assert.rejects(
      () => collect(streamRunEvents(response.body, { runId: 'run-open' })),
      (error) => error.code === 'missing-terminal',
    );
  } finally {
    await service.close();
  }
});

test('第二个终态明确失败', async () => {
  const frames = frame(0, { event: 'run.completed', run_id: 'run-twice', seq: 0, output: '一次' })
    + frame(1, { event: 'run.cancelled', run_id: 'run-twice', seq: 1 });
  const service = await serve((response) => writeFragments(response, frames, 16));
  try {
    const response = await fetch(`${service.baseUrl}/v1/runs/run-twice/events`);
    await assert.rejects(
      () => collect(streamRunEvents(response.body, { runId: 'run-twice' })),
      (error) => error.code === 'multiple-terminal',
    );
  } finally {
    await service.close();
  }
});

test('序号缺口明确失败，事件流截断也失败', async () => {
  const gap = frame(0, { event: 'message.delta', run_id: 'run-gap', seq: 0, delta: '一' })
    + frame(2, { event: 'run.completed', run_id: 'run-gap', seq: 2, output: '完成' });
  const truncated = frame(0, { event: 'replay.truncated', run_id: 'run-truncated', seq: 0, oldest_retained_seq: 5 })
    + frame(1, { event: 'run.completed', run_id: 'run-truncated', seq: 1, output: '完成' });
  const service = await serve((response) => writeFragments(response, gap + truncated, 16));
  try {
    const first = await fetch(`${service.baseUrl}/v1/runs/run-gap/events`);
    await assert.rejects(
      () => collect(readRunFrames(first.body, { runId: 'run-gap' })),
      (error) => error.code === 'stream-gap',
    );
  } finally {
    await service.close();
  }
  const service2 = await serve((response) => writeFragments(response, truncated, 16));
  try {
    const second = await fetch(`${service2.baseUrl}/v1/runs/run-truncated/events`);
    await assert.rejects(
      () => collect(streamRunEvents(second.body, { runId: 'run-truncated' })),
      (error) => error.code === 'stream-truncated',
    );
  } finally {
    await service2.close();
  }
});

test('事件属于另一个运行时明确失败', async () => {
  const frames = frame(0, { event: 'run.completed', run_id: 'run-other', seq: 0, output: '完成' });
  const service = await serve((response) => writeFragments(response, frames, 16));
  try {
    const response = await fetch(`${service.baseUrl}/v1/runs/run-mine/events`);
    await assert.rejects(
      () => collect(streamRunEvents(response.body, { runId: 'run-mine' })),
      (error) => error.code === 'run-mismatch',
    );
  } finally {
    await service.close();
  }
});
