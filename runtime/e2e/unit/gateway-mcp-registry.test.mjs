// MCP 全局注册与按设备端点记录的验收测试。
//
// 注册表是全局的：任一设备上报的服务器，其他设备都能读到。端点按设备分开存，同一台
// 服务器在内网机器与外部设备上可以有不同的连接方式。启用状态不进控制平面。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { ensureDeps } from '../lib/ensure-deps.mjs';

const REPO = resolve(import.meta.dirname, '../../..');
ensureDeps(resolve(import.meta.dirname, '../..'));
ensureDeps(resolve(REPO, 'dsh-adapter'));

const { GatewayStore, readConfig } = await import('../../gateway/lib/store.js');
const { McpRegistry } = await import('../../gateway/lib/mcp-registry.js');

/** 建一个内存注册表。 */
function registry() {
  const store = new GatewayStore(':memory:');
  return { store, registry: new McpRegistry(store.handle()) };
}

test('设备上报的服务器成为全局注册，其他设备可读', () => {
  const { store, registry: mcp } = registry();
  try {
    mcp.upsertServers('acct-1', 'device-a', {
      context7: { type: 'http', url: 'https://mcp.context7.com/mcp' },
    });
    const snapshot = mcp.snapshot('acct-1');
    assert.deepEqual(snapshot.servers.map((server) => server.name), ['context7']);
    const endpoints = snapshot.endpoints.filter((endpoint) => endpoint.server === 'context7');
    assert.equal(endpoints.length, 1);
    assert.equal(endpoints[0].deviceId, 'device-a');
    assert.equal(endpoints[0].transport, 'http');
    assert.equal(endpoints[0].row.url, 'https://mcp.context7.com/mcp');
  } finally {
    store.close();
  }
});

test('同一服务器在不同设备上保留各自的连接方式', () => {
  const { store, registry: mcp } = registry();
  try {
    mcp.upsertServers('acct-1', 'device-internal', {
      context7: { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
    });
    mcp.upsertServers('acct-1', 'device-external', {
      context7: { type: 'http', url: 'https://mcp.context7.com/mcp' },
    });
    const endpoints = mcp.snapshot('acct-1').endpoints.filter((endpoint) => endpoint.server === 'context7');
    assert.equal(endpoints.length, 2);
    const internal = endpoints.find((endpoint) => endpoint.deviceId === 'device-internal');
    const external = endpoints.find((endpoint) => endpoint.deviceId === 'device-external');
    assert.equal(internal.transport, 'stdio');
    assert.equal(internal.row.command, 'npx');
    assert.equal(external.transport, 'http');
  } finally {
    store.close();
  }
});

test('上报是覆盖式的：同一设备的旧端点被替换', () => {
  const { store, registry: mcp } = registry();
  try {
    mcp.upsertServers('acct-1', 'device-a', {
      context7: { type: 'http', url: 'https://old.example/mcp' },
    });
    mcp.upsertServers('acct-1', 'device-a', {
      context7: { type: 'http', url: 'https://new.example/mcp' },
    });
    const endpoints = mcp.snapshot('acct-1').endpoints;
    assert.equal(endpoints.length, 1);
    assert.equal(endpoints[0].row.url, 'https://new.example/mcp');
  } finally {
    store.close();
  }
});

test('设备可以移除自己的一段端点，其他设备不受影响', () => {
  const { store, registry: mcp } = registry();
  try {
    mcp.upsertServers('acct-1', 'device-a', { context7: { type: 'http', url: 'https://a.example/mcp' } });
    mcp.upsertServers('acct-1', 'device-b', { context7: { type: 'http', url: 'https://b.example/mcp' } });
    mcp.removeServer('acct-1', 'device-a', 'context7');
    const endpoints = mcp.snapshot('acct-1').endpoints;
    assert.equal(endpoints.length, 1);
    assert.equal(endpoints[0].deviceId, 'device-b');
    // 全局注册仍在：还有别的设备在用这台服务器。
    assert.deepEqual(mcp.snapshot('acct-1').servers.map((server) => server.name), ['context7']);
  } finally {
    store.close();
  }
});

test('最后一段端点移除后全局注册也随之消失', () => {
  const { store, registry: mcp } = registry();
  try {
    mcp.upsertServers('acct-1', 'device-a', { context7: { type: 'http', url: 'https://a.example/mcp' } });
    mcp.removeServer('acct-1', 'device-a', 'context7');
    assert.deepEqual(mcp.snapshot('acct-1').servers, []);
  } finally {
    store.close();
  }
});

test('不同账号的注册互相隔离', () => {
  const { store, registry: mcp } = registry();
  try {
    mcp.upsertServers('acct-1', 'device-a', { context7: { type: 'http', url: 'https://a.example/mcp' } });
    mcp.upsertServers('acct-2', 'device-b', { other: { type: 'http', url: 'https://b.example/mcp' } });
    assert.deepEqual(mcp.snapshot('acct-1').servers.map((server) => server.name), ['context7']);
    assert.deepEqual(mcp.snapshot('acct-2').servers.map((server) => server.name), ['other']);
  } finally {
    store.close();
  }
});

test('端点里不保存凭据值，只保存环境变量名', () => {
  const { store, registry: mcp } = registry();
  try {
    mcp.upsertServers('acct-1', 'device-a', {
      context7: { type: 'http', url: 'https://mcp.context7.com/mcp', credentialEnv: 'CONTEXT7_API_KEY' },
    });
    const endpoint = mcp.snapshot('acct-1').endpoints[0];
    assert.equal(endpoint.credentialEnv, 'CONTEXT7_API_KEY');
    assert.equal(JSON.stringify(endpoint).includes('secret'), false);
  } finally {
    store.close();
  }
});

/** 起一个只装配 MCP 注册表所需的网关。 */
async function startGateway() {
  const { createGatewayServer } = await import('../../gateway/lib/server.js');
  const { ReplicaStore, ShareStore, ScheduleStore, ReceiptStore, PushQueue } = await import('../../gateway/lib/store.js');
  const { createPushHub } = await import('../../gateway/lib/push.js');
  const store = new GatewayStore(':memory:');
  const telemetry = {
    event() {}, log() {},
    counter: () => ({ add() {} }), histogram: () => ({ record() {} }), gauge: () => ({ record() {} }),
    startSpan: () => ({ setAttribute() {}, setAttributes() {}, recordException() {}, end() {} }),
    runSpan: (_n, _a, fn) => fn({ setAttribute() {}, setAttributes() {}, recordException() {}, end() {} }),
    runSpanSync: (_n, _a, fn) => fn({ setAttribute() {}, setAttributes() {}, recordException() {}, end() {} }),
    currentTraceId: () => undefined,
  };
  const server = createGatewayServer({
    config: { ...readConfig(), port: 0, accessProvider: 'manual', llmGateway: { quota: {} } },
    store,
    replica: new ReplicaStore(store.handle()),
    share: new ShareStore(store.handle()),
    schedule: new ScheduleStore(store.handle()),
    receipts: new ReceiptStore(store.handle()),
    push: createPushHub({ queue: new PushQueue(store.handle()), devices: store, mode: 'all-once', escalationMs: 1000, telemetry }),
    telemetry,
  });
  await server.start();
  return { server, store };
}

test('路由：PUT 上报端点，GET 读到全局注册，DELETE 移除本段', async () => {
  const { server, store } = await startGateway();
  try {
    const base = server.url();
    const put = await fetch(`${base}/chatdsh/gateway/mcp`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'tailscale-user-login': 'alice', 'x-chatdsh-device-id': 'device-a' },
      body: JSON.stringify({ servers: { context7: { type: 'http', url: 'https://mcp.context7.com/mcp' } } }),
    });
    assert.equal(put.status, 200);
    assert.equal((await put.json()).written, 1);

    const get = await fetch(`${base}/chatdsh/gateway/mcp`, { headers: { 'tailscale-user-login': 'alice' } });
    const snapshot = await get.json();
    assert.deepEqual(snapshot.servers.map((item) => item.name), ['context7']);
    assert.equal(snapshot.endpoints[0].deviceId, 'device-a');

    const del = await fetch(`${base}/chatdsh/gateway/mcp?server=context7`, {
      method: 'DELETE',
      headers: { 'tailscale-user-login': 'alice', 'x-chatdsh-device-id': 'device-a' },
    });
    assert.equal(del.status, 200);
    assert.deepEqual((await del.json()).servers, []);
  } finally {
    await server.stop();
    store.close();
  }
});

test('路由：缺设备标识的上报被拒绝', async () => {
  const { server, store } = await startGateway();
  try {
    const response = await fetch(`${server.url()}/chatdsh/gateway/mcp`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'tailscale-user-login': 'alice' },
      body: JSON.stringify({ servers: {} }),
    });
    assert.equal(response.status, 400);
  } finally {
    await server.stop();
    store.close();
  }
});
