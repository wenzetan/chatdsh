// 推送中枢的升级扫描：两段式下第一段的通知到期后推给其余在线设备。
//
// 起真实的 HTTP 服务与真实的 SQLite 存储，两条 SSE 连接经真实 socket 建立。升级由推送
// 中枢自己的扫描循环触发，测试不手工调用 escalateDue。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, createServer } from 'node:http';
import { join } from 'node:path';
import { tempHome } from '../../scripts/lib/cleanup.mjs';
import { GatewayStore, PushQueue } from '../../gateway/lib/store.js';
import { createPushHub } from '../../gateway/lib/push.js';

/** 建立一条 SSE 订阅，返回收到的通知与关闭函数。 */
function openConnection(port, deviceId) {
  return new Promise((resolve, reject) => {
    const received = [];
    const request = get({ host: '127.0.0.1', port, path: `/chatdsh/gateway/events?device=${encodeURIComponent(deviceId)}` }, (response) => {
      response.setEncoding('utf8');
      let buffer = '';
      response.on('data', (chunk) => {
        buffer += chunk;
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const line = part.split('\n').find((item) => item.startsWith('data: '));
          if (line !== undefined) received.push(line.slice(6));
        }
      });
      resolve({ deviceId, received, close: () => request.destroy() });
    });
    request.on('error', reject);
  });
}

/** 等到条件成立，超时即失败。 */
async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待超时：${timeoutMs}ms 内条件未成立`);
}

test('升级时刻把第一段的通知推给其余在线设备，第一段的目标不重复收到', async () => {
  const home = tempHome('gateway-push-escalation');
  const store = new GatewayStore(join(home, 'gateway.sqlite'));
  const push = createPushHub({
    queue: new PushQueue(store.handle()),
    devices: store,
    mode: 'two-stage',
    escalationMs: 60,
    sweepIntervalMs: 15,
  });
  const server = createServer((request, response) => {
    const deviceId = new URL(request.url ?? '/', 'http://gateway').searchParams.get('device') ?? 'unknown';
    push.subscribe(deviceId, 'web', response);
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    response.flushHeaders();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const first = await openConnection(port, 'device-a');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await openConnection(port, 'device-b');

    push.start();
    const payload = JSON.stringify({ kind: 'replica', sessionId: 's1' });
    const delivered = push.deliver(payload);
    assert.equal(delivered.delivered, 1);

    // 第一段投给最近活跃的一台，也就是后建立的这条连接。
    await waitFor(() => second.received.length === 1, 2000);
    await waitFor(() => first.received.length === 1, 2000);
    assert.deepEqual(second.received, [payload]);
    assert.deepEqual(first.received, [payload]);

    // 再过几个扫描周期，第一段的目标不会收到第二次。
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(second.received, [payload]);
    assert.deepEqual(first.received, [payload]);

    push.stop();
    first.close();
    second.close();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
});
