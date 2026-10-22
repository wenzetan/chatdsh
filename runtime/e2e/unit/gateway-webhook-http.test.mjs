// 网关 webhook 路由的端到端测试。
//
// 起真实的 HTTP 服务与真实的 SQLite 存储，发真实请求，核对状态码、响应体与落库结果。
// 遥测用关闭状态的客户端，不产生任何导出管道。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tempHome } from '../../scripts/lib/cleanup.mjs';
import { createTelemetryClient } from '../../packages/core/diagnostics/lib/client.js';
import { defaultTelemetryConfig } from '../../packages/core/diagnostics/lib/config.js';
import { GatewayStore, PushQueue, ReceiptStore, ReplicaStore, ScheduleStore, ShareStore } from '../../gateway/lib/store.js';
import { createPushHub } from '../../gateway/lib/push.js';
import { createGatewayServer } from '../../gateway/lib/server.js';
import { AutomationStore } from '../../gateway/lib/automation.js';

/** 起一个完整装配的网关，返回地址与关闭函数。 */
async function startGateway() {
  const home = tempHome('gateway-webhook');
  const databasePath = join(home, 'gateway.sqlite');
  const telemetry = createTelemetryClient({
    config: defaultTelemetryConfig({ surface: 'gateway' }),
    component: '@chatdsh/gateway',
    env: { CHATDSH_TELEMETRY: 'off' },
  });
  const store = new GatewayStore(databasePath);
  const replica = new ReplicaStore(store.handle());
  const share = new ShareStore(store.handle());
  const schedule = new ScheduleStore(store.handle());
  const receipts = new ReceiptStore(store.handle());
  const push = createPushHub({
    queue: new PushQueue(store.handle()),
    devices: store,
    mode: 'all-at-once',
    escalationMs: 1000,
    telemetry: { counter: (name, options) => telemetry.counter(name, options) },
  });
  const server = createGatewayServer({
    config: {
      host: '127.0.0.1',
      port: 0,
      runtimeUrl: 'http://127.0.0.1:1',
      runtimeRoutes: {},
      accessProvider: 'manual',
      databasePath,
      environment: 'test',
      version: '0.0.0',
      pushMode: 'all-at-once',
      pushEscalationMs: 1000,
      llmGateway: { quota: {} },
    },
    store,
    replica,
    share,
    schedule,
    receipts,
    push,
    telemetry,
  });
  await server.start();
  return {
    url: server.url(),
    store,
    async close() {
      await server.stop();
      await telemetry.shutdown();
      store.close();
    },
  };
}

test('webhook 路由：合法投递 202，重复投递 202 duplicate，脏数据 401', async () => {
  process.env.HOOK_SECRET = 's3cret';
  const gateway = await startGateway();
  try {
    const automations = new AutomationStore(gateway.store.handle());
    automations.create({
      id: 'a1',
      accountId: 'acct',
      name: '构建通知',
      trigger: { kind: 'webhook', secretEnv: 'HOOK_SECRET' },
      action: { kind: 'start-session', prompt: '总结这次构建' },
      enabled: true,
      createdAt: 1,
    });

    const accepted = await fetch(`${gateway.url}/chatdsh/gateway/webhook/a1`, {
      method: 'POST',
      headers: { 'x-chatdsh-webhook-secret': 's3cret', 'x-github-delivery': 'delivery-1' },
      body: JSON.stringify({ ref: 'refs/heads/main' }),
    });
    assert.equal(accepted.status, 202);
    assert.deepEqual(await accepted.json(), { accepted: true });

    const duplicate = await fetch(`${gateway.url}/chatdsh/gateway/webhook/a1`, {
      method: 'POST',
      headers: { 'x-chatdsh-webhook-secret': 's3cret', 'x-github-delivery': 'delivery-1' },
      body: JSON.stringify({ ref: 'refs/heads/main' }),
    });
    assert.equal(duplicate.status, 202);
    assert.deepEqual(await duplicate.json(), { duplicate: true });

    assert.deepEqual(automations.eventsOf('a1').map((event) => event.eventId), ['delivery-1']);

    const unauthorized = await fetch(`${gateway.url}/chatdsh/gateway/webhook/a1`, {
      method: 'POST',
      headers: { 'x-chatdsh-webhook-secret': 'wrong' },
      body: 'not-json',
    });
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await unauthorized.json(), { error: 'webhook-unauthorized' });

    const missing = await fetch(`${gateway.url}/chatdsh/gateway/webhook/missing`, {
      method: 'POST',
      headers: { 'x-chatdsh-webhook-secret': 's3cret' },
      body: '{}',
    });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'automation-not-found' });
  } finally {
    await gateway.close();
  }
});
