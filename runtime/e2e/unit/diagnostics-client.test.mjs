// 诊断客户端的端到端单元测试。
//
// 覆盖关闭状态空操作、自建 W3C 上下文在真实 OpenTelemetry span 中的注入与还原，
// 以及自监控环形缓冲最多保留 32 条元数据。测试不依赖 OpenObserve 在线。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTelemetryClient,
  defaultTelemetryConfig,
} from '../../packages/core/diagnostics/lib/index.js';

test('关闭状态全部方法退化为空操作', async () => {
  const client = createTelemetryClient({
    config: defaultTelemetryConfig(),
    component: '@chatdsh/test',
    env: { CHATDSH_TELEMETRY: 'off' },
  });
  assert.equal(client.enabled, false);
  assert.equal(client.reason, 'env');
  const carrier = client.runSpanSync('chatdsh.test.disabled', {}, () => client.inject({ kept: 'yes' }));
  assert.deepEqual(carrier, { kept: 'yes' });
  assert.equal(client.currentTraceId(), undefined);
  assert.equal(typeof (await client.selfTest()).probeId, 'string');
  await client.shutdown();
});

test('自建 traceparent 可在活动 span 中注入并还原父上下文', async () => {
  const client = createTelemetryClient({
    config: defaultTelemetryConfig({ exportTimeoutMs: 50 }),
    component: '@chatdsh/test',
    env: {},
    instanceId: 'diagnostics-client-test',
  });
  try {
    assert.equal(client.enabled, true);
    const outbound = client.runSpanSync('chatdsh.test.parent', {}, () => {
      const carrier = client.inject({ custom: 'kept' });
      assert.equal(carrier.custom, 'kept');
      assert.match(carrier.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
      return carrier;
    });
    const parentTraceId = outbound.traceparent.split('-')[1];

    const childTraceId = client.withContext({ traceparent: outbound.traceparent }, () => {
      return client.runSpanSync('chatdsh.test.child', {}, () => client.currentTraceId());
    });
    assert.equal(childTraceId, parentTraceId);

    let asyncTraceId;
    const asyncCarrier = await client.runSpan('chatdsh.test.async', {}, async () => {
      asyncTraceId = client.currentTraceId();
      await Promise.resolve();
      assert.equal(client.currentTraceId(), asyncTraceId);
      return client.inject({});
    });
    assert.equal(asyncCarrier.traceparent.split('-')[1], asyncTraceId);

    const restoredTraceId = await client.withContext(
      { traceparent: outbound.traceparent },
      async () => {
        await Promise.resolve();
        return client.currentTraceId();
      },
    );
    assert.equal(restoredTraceId, parentTraceId);

    const source = { traceparent: outbound.traceparent, custom: 'kept' };
    const extracted = client.extract(source);
    assert.equal(extracted.traceparent, outbound.traceparent);
    assert.equal(extracted.custom, 'kept');
    assert.deepEqual(source, { traceparent: outbound.traceparent, custom: 'kept' });
    assert.deepEqual(client.extract({ traceparent: 'invalid' }), {});
  } finally {
    await client.shutdown();
  }
});

test('自监控环形缓冲只保留最近 32 条丢弃元数据', async () => {
  const client = createTelemetryClient({
    config: defaultTelemetryConfig({ exportTimeoutMs: 50 }),
    component: '@chatdsh/test',
    env: {},
    instanceId: 'diagnostics-ring-test',
  });
  try {
    for (let index = 0; index < 40; index += 1) {
      client.event('chatdsh.test.event', { 'not.registered': index });
    }
    const status = client.status();
    assert.equal(status.recentDiagnostics.length, 32);
    for (const record of status.recentDiagnostics) {
      assert.equal(record.signal, 'logs');
      assert.equal(record.reason, 'unregistered-attribute');
      assert.equal(typeof record.at, 'number');
      assert.deepEqual(Object.keys(record).sort(), ['at', 'reason', 'signal']);
    }
  } finally {
    await client.shutdown();
  }
});
