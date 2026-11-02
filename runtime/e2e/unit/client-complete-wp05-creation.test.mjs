// WP05 创建、继续与 fork 预估的验收测试。
//
// 设备离线失败、重复点击只创建一条、远程目录列举、本机继续与 fork 预估都在真实 HTTP 上
// 执行：进程内起真实 `node:http` 服务扮演控制平面与设备转发，外壳侧使用真实的
// `createShellApi`、真实 `OperationGate`、真实 `estimateFork` 与真实遥测客户端。副本事件来自
// 真实 `ReplicaStore`，预估结果用真实契约 `forkEstimateSchema` 校验。
//
// 测试服务是"设备转发"的宿主替身：设备的运行时不在本进程内，这里按设备代理的协议回真实
// 信封（`PROTOCOL` 与 `client.browser.js` 的 `server-response` 一致），以便在没有真实设备的
// 条件下验证外壳的失败与幂等分支。真实双设备创建由 `scripts/verify-shell.mjs` 覆盖。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { forkEstimateSchema } from '../../packages/core/contracts/lib/fork.js';
import { GatewayStore, ReplicaStore } from '../../gateway/lib/store.js';
import { createShellApi, describeFailure, ShellApiError } from '../../packages/client/shell/lib/client/api.js';
import { OperationGate } from '../../packages/client/shell/lib/client/idempotency.js';
import { estimateFork, textOfEvent } from '../../packages/client/shell/lib/client/estimate.js';
import { createShellTelemetry, randomHex } from '../../packages/client/shell/lib/client/telemetry.js';

/** 一次会话真实存在的副本事件。 */
const REPLICA_EVENTS = [
  { seq: 0, kind: 'session/title', time: 1_000, bytes: 16, payload: { data: { title: '继续用的会话' } } },
  { seq: 1, kind: 'turn/start', time: 1_001, bytes: 4, payload: { data: {} } },
  {
    seq: 2,
    kind: 'user/message',
    time: 1_002,
    bytes: 64,
    payload: {
      data: {
        content: [
          { type: 'text', text: '看一下这张图' },
          { type: 'image', attachment: { attachmentId: 'att-1', name: '图.png', mediaType: 'image/png' } },
        ],
      },
    },
  },
  { seq: 3, kind: 'tool/result', time: 1_003, bytes: 32, payload: { data: { content: [{ text: '命令输出' }] } } },
  { seq: 4, kind: 'assistant/message', time: 1_004, bytes: 32, payload: { data: { text: '已经看过了' } } },
  { seq: 5, kind: 'turn/start', time: 1_005, bytes: 4, payload: { data: {} } },
];

/**
 * 起一个真实 HTTP 服务，按路由回真实信封。
 * @param options - 控制设备是否离线与目录是否可读。
 */
async function startHost(options) {
  const home = allocateIndependentHome('wp05-create');
  const store = new GatewayStore(join(home, 'gateway.sqlite'));
  const replica = new ReplicaStore(store.handle());
  store.registerNode({ id: 'device-a', name: '甲设备', platform: 'linux', role: 'both', capabilities: [], tokenHash: 'x' });
  store.registerNode({ id: 'device-offline', name: '离线设备', platform: 'linux', role: 'both', capabilities: [], tokenHash: 'y' });
  replica.append('session-source', REPLICA_EVENTS);
  const calls = { create: 0, ownership: 0, directory: 0, import: 0, replica: 0, telemetry: [] };
  const listing = {
    path: '/work/project',
    home: '/home/acceptance',
    crumbs: [
      { name: '/', path: '/', hidden: false },
      { name: 'work', path: '/work', hidden: false },
      { name: 'project', path: '/work/project', hidden: false },
    ],
    entries: [
      { name: 'src', path: '/work/project/src', hidden: false },
      { name: '.git', path: '/work/project/.git', hidden: true },
    ],
    truncated: false,
  };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const json = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/chatdsh/telemetry/browser') {
      calls.telemetry.push({ signal: request.headers['x-chatdsh-signal'], body });
      response.writeHead(204).end();
      return;
    }
    if (url.pathname === '/chatdsh/gateway/ownership' && request.method === 'POST') {
      calls.ownership += 1;
      if (options.ownershipFailsFirst === true && calls.ownership === 1) {
        json(500, { error: { code: 'internal-error', requestId: 'request-1' } });
        return;
      }
      json(200, { sessionId: body.sessionId, deviceId: body.deviceId, cwd: body.cwd, kind: body.kind });
      return;
    }
    if (url.pathname === '/chatdsh/gateway/import' && request.method === 'POST') {
      calls.import += 1;
      json(200, { sessionId: 'fork-1', parentSession: body.sourceSessionId, imported: REPLICA_EVENTS.length, watermark: 5 });
      return;
    }
    if (url.pathname === '/chatdsh/gateway/replica' && request.method === 'GET') {
      calls.replica += 1;
      const sessionId = url.searchParams.get('sessionId');
      json(200, { sessionId, watermark: replica.watermarkOf(sessionId) ?? null, events: replica.read(sessionId) });
      return;
    }
    const deviceMatch = /^\/d\/([^/]+)(\/.*)$/u.exec(url.pathname);
    const prefixDevice = deviceMatch?.[1];
    const endpoint = deviceMatch?.[2] ?? url.pathname;
    if (prefixDevice === 'device-offline') {
      json(409, { error: 'device-offline' });
      return;
    }
    if (endpoint === '/api/session/create' && request.method === 'POST') {
      calls.create += 1;
      assert.equal(body.type, 'client-request');
      assert.equal(body.method, 'session/create');
      assert.equal(body.payload.args.request.cwd, options.cwd);
      json(200, { type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { sessionId: 'created-1' } } });
      return;
    }
    if (endpoint === '/api/session/rename' && request.method === 'POST') {
      json(200, { type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { sessionId: body.payload.args.request.sessionId } } });
      return;
    }
    if (endpoint === '/api/directoryPicker/list' && request.method === 'POST') {
      calls.directory += 1;
      if (options.directoryDenied === true) {
        json(200, {
          type: 'server-response',
          rpcId: body.rpcId,
          result: { ok: false, error: { code: 'permission-denied', message: '没有读取该目录的权限', details: {} } },
        });
        return;
      }
      json(200, { type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: listing } });
      return;
    }
    json(404, { error: 'request-invalid' });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;

  // 浏览器里相对路径按页面来源解析；测试里把相对路径拼到真实服务地址上。
  const browserFetch = (input, init) => fetch(new URL(input, origin), init);
  const telemetry = createShellTelemetry({ fetchImpl: browserFetch, randomHex, now: () => Date.now() });
  const api = createShellApi({ fetchImpl: browserFetch, newRequestId: () => randomUUID(), telemetry });

  return {
    api,
    calls,
    origin,
    home,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      store.close();
      releaseIndependentHome(home);
    },
  };
}

test('创建前设备离线：明确失败，不写归属、不建会话', async () => {
  const host = await startHost({ cwd: '/work/project' });
  try {
    await assert.rejects(
      host.api.createSession({ deviceId: 'device-offline', cwd: '/work/project' }),
      (error) => error instanceof ShellApiError && error.code === 'device-offline' && error.status === 409
    );
    assert.equal(host.calls.create, 0, '离线时没有发出创建请求');
    assert.equal(host.calls.ownership, 0, '离线时没有登记归属');
    assert.equal(describeFailure(new ShellApiError('device-offline', 409), '创建会话'), '创建会话失败：目标设备离线');
  } finally {
    await host.close();
  }
});

test('重复点击只创建一条：同一意图共享一个进行中的操作', async () => {
  const host = await startHost({ cwd: '/work/project' });
  try {
    const gate = new OperationGate();
    const key = 'create\u0000device-a\u0000/work/project';
    const work = () => host.api.createSession({ deviceId: 'device-a', cwd: '/work/project', title: '新会话' });
    const results = await Promise.all([gate.run(key, work), gate.run(key, work), gate.run(key, work)]);
    assert.deepEqual(results, [
      { sessionId: 'created-1' },
      { sessionId: 'created-1' },
      { sessionId: 'created-1' },
    ]);
    assert.equal(host.calls.create, 1, '三次点击只发出一条创建请求');
    assert.equal(host.calls.ownership, 1, '归属只登记一次');
    assert.equal(gate.isRunning(key), false, '完成后释放键');
    assert.equal(gate.size, 0);

    // 失败后同样释放键，下一次点击会重新尝试。
    const failing = new OperationGate();
    let attempts = 0;
    await assert.rejects(
      failing.run('retry-key', async () => {
        attempts += 1;
        throw new Error('第一次失败');
      }),
      /第一次失败/
    );
    await assert.rejects(
      failing.run('retry-key', async () => {
        attempts += 1;
        throw new Error('第二次失败');
      }),
      /第二次失败/
    );
    assert.equal(attempts, 2, '失败不会把键留在进行中状态');
  } finally {
    await host.close();
  }
});

test('部分成功：会话已创建但归属失败时，重试只登记归属，不再建会话', async () => {
  const host = await startHost({ cwd: '/work/project', ownershipFailsFirst: true });
  try {
    const created = await host.api.createSession({ deviceId: 'device-a', cwd: '/work/project' });
    assert.equal(created.sessionId, 'created-1');
    assert.equal(typeof created.ownershipWarning, 'string', '会话编号必须交回界面');
    assert.equal(created.ownershipWarning.includes('会话已创建'), true);
    assert.equal(host.calls.create, 1);
    assert.equal(host.calls.ownership, 1);

    await host.api.registerOwnership({ sessionId: created.sessionId, deviceId: 'device-a', cwd: '/work/project' });
    assert.equal(host.calls.ownership, 2);
    assert.equal(host.calls.create, 1, '重试归属不再创建会话');
  } finally {
    await host.close();
  }
});

test('远程目录列举：真实信封解析出当前位置、面包屑与条目，拒绝时给出错误码', async () => {
  const host = await startHost({ cwd: '/work/project' });
  try {
    const listing = await host.api.listDirectory('device-a', '/work/project');
    assert.equal(listing.path, '/work/project');
    assert.equal(listing.home, '/home/acceptance');
    assert.deepEqual(listing.crumbs.map((crumb) => crumb.path), ['/', '/work', '/work/project']);
    assert.deepEqual(listing.entries.map((entry) => entry.name), ['src', '.git']);
    assert.equal(listing.entries[1].hidden, true);
    assert.equal(listing.truncated, false);
    assert.equal(host.calls.directory, 1);
  } finally {
    await host.close();
  }
  const denied = await startHost({ cwd: '/work/project', directoryDenied: true });
  try {
    await assert.rejects(
      denied.api.listDirectory('device-a', '/root'),
      (error) => error instanceof ShellApiError && error.code === 'permission-denied'
    );
    assert.equal(describeFailure(new ShellApiError('permission-denied', 200), '读取设备目录'), '读取设备目录失败：当前访问会话没有该权限');
  } finally {
    await denied.close();
  }
});

test('本机继续：新会话带 parentSession，导入条数与副本一致', async () => {
  const host = await startHost({ cwd: '/work/project' });
  try {
    const result = await host.api.importSession({ sourceSessionId: 'session-source', deviceId: 'local', cwd: '/work/project' });
    assert.deepEqual(result, { sessionId: 'fork-1', parentSession: 'session-source', imported: REPLICA_EVENTS.length });
    assert.equal(host.calls.import, 1);
    // 导入结果不把内部副本水位带到界面上。
    assert.equal('watermark' in result, false);
  } finally {
    await host.close();
  }
});

test('fork 预估：事件、字符、缺失附件与压缩损失来自真实副本事件', async () => {
  const host = await startHost({ cwd: '/work/project' });
  try {
    const events = await host.api.readReplica('session-source');
    assert.equal(events.length, REPLICA_EVENTS.length);
    assert.equal(host.calls.replica, 1);

    const full = estimateFork(events, { importMode: 'full-prefix', sourceOnline: true, readAt: 9_000 });
    assert.equal(full.ok, true);
    const parsed = forkEstimateSchema.safeParse(full.estimate);
    assert.equal(parsed.success, true, parsed.success ? '' : JSON.stringify(parsed.error.issues));
    assert.equal(full.estimate.eventCount, 6);
    assert.deepEqual(full.estimate.missingAttachmentIds, ['att-1'], '附件需要源设备');
    assert.equal(full.estimate.compressionLoss, false);
    assert.equal(full.estimate.source.state, 'complete');
    assert.equal(full.estimate.scope.turnTo, 2, '两个回合');
    assert.equal(full.estimate.scope.attachmentsComplete, false);
    assert.equal(full.estimate.charCount, 15, '只统计消息正文：6 + 4 + 5');

    const compressed = estimateFork(events, { importMode: 'compressed', sourceOnline: false, readAt: 9_001 });
    assert.equal(compressed.ok, true);
    assert.equal(compressed.estimate.compressionLoss, true, '压缩复制会丢失工具输出原文');
    assert.equal(compressed.estimate.scope.compressed, true);
    assert.equal(compressed.estimate.source.state, 'partial', '源设备离线时副本为部分内容');
    assert.equal(forkEstimateSchema.safeParse(compressed.estimate).success, true);

    const missing = estimateFork([], { importMode: 'full-prefix', sourceOnline: false, readAt: 9_002 });
    assert.deepEqual(missing, { ok: false, reason: 'replica-unavailable' });
    assert.equal(describeFailure(new ShellApiError('replica-unavailable', 404), '读取副本'), '读取副本失败：该会话没有可读副本');
    assert.equal(textOfEvent(events[4].payload), '已经看过了');
  } finally {
    await host.close();
  }
});

test('遥测：Remote 调用产生已登记 span，失败分支带 outcome', async () => {
  const host = await startHost({ cwd: '/work/project' });
  try {
    await host.api.listDirectory('device-a');
    await assert.rejects(host.api.listDirectory('device-offline'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const traces = host.calls.telemetry.filter((entry) => entry.signal === 'traces');
    assert.ok(traces.length >= 2, `至少两次上报：${String(traces.length)}`);
    const spans = traces.flatMap((entry) => entry.body.resourceSpans.flatMap((span) => span.scopeSpans.flatMap((scope) => scope.spans)));
    const methods = spans.map((span) => span.attributes.find((attribute) => attribute.key === 'rpc.method')?.value.stringValue);
    assert.ok(methods.includes('directoryPicker/list'));
    assert.ok(spans.some((span) => span.attributes.some((attribute) => attribute.key === 'outcome' && attribute.value.stringValue === 'failed')));
    for (const span of spans) {
      assert.equal(span.name, 'chatdsh.client.remote.call');
      assert.equal(span.traceId.length, 32);
      assert.equal(span.spanId.length, 16);
    }
  } finally {
    await host.close();
  }
});
