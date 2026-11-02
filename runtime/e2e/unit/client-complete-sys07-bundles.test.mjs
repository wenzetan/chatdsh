// SYS07 的能力拆包与装卸验收。
//
// 记忆后端与推送端点都是真实 HTTP 服务，记录收到的请求与连接。默认组合一个包都不装：不建立
// 后端连接、不启动扫描、不登记订阅、不构造推送通道，端点也全部不可达。装载记忆包后连接与
// 扫描真实出现，卸载后连接关闭且不再扫描；装载 PWA 包后清单、Service Worker 与离线页可达，
// 订阅登记与推送投递走真实 HTTP，卸载后全部消失。平台能力按真实加载结果声明。
//
// 运行：node --test e2e/unit/client-complete-sys07-bundles.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { tempHome } from '../../scripts/lib/cleanup.mjs';
import { createTelemetryClient } from '../../packages/core/diagnostics/lib/client.js';
import { defaultTelemetryConfig } from '../../packages/core/diagnostics/lib/config.js';
import {
  CapabilityDeployment,
  createMemoryBundle,
  createPwaBundle,
  fileProbe,
  globalProbe,
  moduleProbe,
  probeCapabilities,
} from '../../packages/core/deployment/lib/index.js';
import { createDeployListener, createDeploymentHandler } from '../../gateway/lib/deploy/index.js';
import { pwaStaticContent } from '../../packages/client/pwa/lib/index.js';

/** runtime 根。 */
const RUNTIME = resolve(import.meta.dirname, '../..');

/** 关闭遥测导出的真实客户端。 */
function disabledTelemetry() {
  return createTelemetryClient({
    config: defaultTelemetryConfig({ surface: 'gateway' }),
    component: '@chatdsh/gateway',
    env: { CHATDSH_TELEMETRY: 'off' },
  });
}

/** 向操作系统申请一个回环端口，随后立刻释放。 */
async function freePort() {
  const server = createHttpServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise((done) => server.close(done));
  return port;
}

/** 一次明文 JSON 请求。 */
function requestJson({ port, path, method = 'GET', headers = {}, body }) {
  return new Promise((settle, fail) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const contentType = String(response.headers['content-type'] ?? '');
        settle({
          status: response.statusCode,
          headers: response.headers,
          body: text,
          json: text !== '' && contentType.includes('json') ? JSON.parse(text) : undefined,
        });
      });
    });
    request.on('error', fail);
    request.end(body);
  });
}

/** 记录请求与连接的后端服务。 */
async function startRecordingServer({ status = 200, payload = '{"api_version":"0.9.2"}' } = {}) {
  const state = { requests: 0, paths: [], connections: 0, open: 0, bodies: [] };
  const server = createHttpServer((request, response) => {
    state.requests += 1;
    state.paths.push(request.url ?? '');
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      state.bodies.push(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(payload);
    });
  });
  server.on('connection', (socket) => {
    state.connections += 1;
    state.open += 1;
    socket.on('close', () => {
      state.open -= 1;
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
    port,
    state,
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}

/** 建立明文开发计划。 */
function plaintextPlan(port) {
  return {
    host: '127.0.0.1',
    port,
    scope: 'gateway',
    development: true,
    allowedOrigins: [`http://127.0.0.1:${port}`],
    allowedHosts: [`127.0.0.1:${port}`],
    trustedProxies: [],
  };
}

/** 建立监听与部署处理器。 */
async function startDeploymentListener({ deployment, telemetry }) {
  const routes = createDeploymentHandler({ deployment, telemetry });
  const port = await freePort();
  const listener = createDeployListener({ plan: plaintextPlan(port), telemetry, handler: routes.handle, kindOf: routes.kindOf });
  await listener.start();
  return { port, listener, routes, origin: `http://127.0.0.1:${port}` };
}

/** 从检查快照里取一个组合包的状态。 */
function bundleStateOf(snapshot, id) {
  const state = snapshot.bundles.find((bundle) => bundle.id === id);
  assert.ok(state !== undefined, `检查快照里没有组合包 ${id}`);
  return state;
}

test('默认最轻组合可独立运行：不构造后端连接、扫描、订阅与推送资源', async () => {
  const home = tempHome('sys07-lightest');
  const telemetry = disabledTelemetry();
  const backend = await startRecordingServer();
  const push = await startRecordingServer({ status: 201, payload: '{"ok":true}' });
  const content = pwaStaticContent({ name: 'ChatDSH', version: '1' });
  const deployment = new CapabilityDeployment({
    bundles: [
      createMemoryBundle({ backendUrl: backend.url, scanIntervalMs: 150, requestTimeoutMs: 1_000 }),
      createPwaBundle({
        content,
        subscriptionStorePath: join(home, 'pwa', 'subscriptions.json'),
        pushTimeoutMs: 1_000,
      }),
    ],
    telemetry,
  });
  const { port, listener, origin } = await startDeploymentListener({ deployment, telemetry });
  try {
    const snapshot = await requestJson({ port, path: '/chatdsh/gateway/deployment' });
    assert.equal(snapshot.status, 200);
    assert.deepEqual(snapshot.json.lightest, []);
    assert.deepEqual(snapshot.json.resources, {});
    for (const bundle of snapshot.json.bundles) {
      assert.equal(bundle.mounted, false, `${bundle.id} 默认不得装载`);
      assert.deepEqual(bundle.menus, []);
      assert.deepEqual(bundle.endpoints, []);
      assert.deepEqual(bundle.services, []);
    }

    const manifest = await requestJson({ port, path: '/manifest.webmanifest' });
    assert.equal(manifest.status, 404, '未装载时清单端点不可达');
    const memoryStatus = await requestJson({ port, path: '/chatdsh/deployment/memory/status' });
    assert.equal(memoryStatus.status, 404, '未装载时记忆状态端点不可达');

    await delay(400);
    assert.equal(backend.state.connections, 0, '默认组合不得建立后端连接');
    assert.equal(backend.state.requests, 0, '默认组合不得发起后端请求');
    assert.equal(push.state.requests, 0, '默认组合不得构造推送通道');
    assert.equal(deployment.inspect().capabilities.length, 0);

    // 记忆包的装载接口本身需要精确来源。
    const withoutOrigin = await requestJson({
      port,
      path: '/chatdsh/gateway/deployment/bundles/memory-hindsight/mount',
      method: 'POST',
    });
    assert.equal(withoutOrigin.status, 403);
    assert.equal(withoutOrigin.json.error, 'origin-missing');
  } finally {
    await listener.stop();
    await deployment.close();
    await backend.close();
    await push.close();
    await telemetry.shutdown();
  }
});

test('记忆组合包装卸：连接与扫描真实建立，卸载后资源释放', async () => {
  const home = tempHome('sys07-memory');
  const telemetry = disabledTelemetry();
  const backend = await startRecordingServer();
  const deployment = new CapabilityDeployment({
    bundles: [createMemoryBundle({ backendUrl: backend.url, scanIntervalMs: 150, requestTimeoutMs: 1_000 })],
    telemetry,
  });
  const { port, listener, origin } = await startDeploymentListener({ deployment, telemetry });
  try {
    const mounted = await requestJson({
      port,
      path: '/chatdsh/gateway/deployment/bundles/memory-hindsight/mount',
      method: 'POST',
      headers: { origin },
    });
    assert.equal(mounted.status, 200);
    const memory = bundleStateOf(mounted.json.deployment, 'memory-hindsight');
    assert.equal(memory.mounted, true);
    assert.deepEqual(memory.resources, { 'backend-connection': 1, scan: 1 });
    assert.deepEqual(memory.menus, [{ id: 'memory', label: '记忆' }]);
    assert.deepEqual(memory.services, ['memory.recall', 'memory.write']);
    assert.deepEqual(memory.endpoints, [{ method: 'GET', path: '/chatdsh/deployment/memory/status', transport: 'http' }]);
    assert.deepEqual(mounted.json.deployment.resources, { 'backend-connection': 1, scan: 1 });

    await delay(120);
    assert.ok(backend.state.requests >= 1, '装载必须向真实后端发起探活');
    assert.ok(backend.state.paths.every((path) => path === '/version'), '探活路径必须指向后端版本端点');
    assert.ok(backend.state.open >= 1, '装载必须保持一条真实连接');

    const status = await requestJson({ port, path: '/chatdsh/deployment/memory/status' });
    assert.equal(status.status, 200);
    assert.equal(status.json.backend.reachable, true);
    assert.ok(status.json.backend.probes >= 1);

    // 扫描按间隔持续发生。
    const beforeScan = backend.state.requests;
    await delay(400);
    assert.ok(backend.state.requests > beforeScan, '扫描必须按间隔执行');

    const unmounted = await requestJson({
      port,
      path: '/chatdsh/gateway/deployment/bundles/memory-hindsight/unmount',
      method: 'POST',
      headers: { origin },
    });
    assert.equal(unmounted.status, 200);
    const memoryAfter = bundleStateOf(unmounted.json.deployment, 'memory-hindsight');
    assert.equal(memoryAfter.mounted, false);
    assert.deepEqual(memoryAfter.resources, {});
    assert.deepEqual(unmounted.json.deployment.resources, {});

    const afterUnmount = backend.state.requests;
    await delay(400);
    assert.equal(backend.state.requests, afterUnmount, '卸载之后不得继续扫描');
    assert.equal(backend.state.open, 0, '卸载之后后端连接必须释放');

    const statusAfter = await requestJson({ port, path: '/chatdsh/deployment/memory/status' });
    assert.equal(statusAfter.status, 404);

    // 后端不可达时装载失败，资源不残留。
    await backend.close();
    const failed = await requestJson({
      port,
      path: '/chatdsh/gateway/deployment/bundles/memory-hindsight/mount',
      method: 'POST',
      headers: { origin },
    });
    assert.equal(failed.status, 502);
    assert.match(String(failed.json.error), /^memory-backend-un/);
    assert.deepEqual(deployment.inspect().resources, {});
    assert.equal(bundleStateOf(deployment.inspect(), 'memory-hindsight').mounted, false);
  } finally {
    await listener.stop();
    await deployment.close();
    await telemetry.shutdown();
  }
});

test('PWA 组合包装卸：静态端点、订阅与推送通道随装卸出现与消失', async () => {
  const home = tempHome('sys07-pwa');
  const telemetry = disabledTelemetry();
  const push = await startRecordingServer({ status: 201, payload: '{"delivered":true}' });
  const content = pwaStaticContent({ name: 'ChatDSH', version: '1' });
  const storePath = join(home, 'pwa', 'subscriptions.json');
  const deployment = new CapabilityDeployment({
    bundles: [createPwaBundle({ content, subscriptionStorePath: storePath, pushTimeoutMs: 1_000 })],
    telemetry,
  });
  const { port, listener, origin } = await startDeploymentListener({ deployment, telemetry });
  try {
    const mounted = await requestJson({
      port,
      path: '/chatdsh/gateway/deployment/bundles/pwa/mount',
      method: 'POST',
      headers: { origin },
    });
    assert.equal(mounted.status, 200);
    const pwa = bundleStateOf(mounted.json.deployment, 'pwa');
    assert.equal(pwa.mounted, true);
    assert.deepEqual(pwa.resources, { 'static-routes': 1, subscription: 1, push: 1 });
    assert.deepEqual(pwa.menus, [{ id: 'pwa-install', label: '安装到主屏幕' }]);
    assert.equal(pwa.endpoints.length, 5);

    const manifest = await requestJson({ port, path: '/manifest.webmanifest' });
    assert.equal(manifest.status, 200);
    assert.equal(manifest.headers['content-type'], 'application/manifest+json');
    assert.equal(manifest.body, content.manifestJson);

    const serviceWorker = await requestJson({ port, path: '/sw.js' });
    assert.equal(serviceWorker.status, 200);
    assert.match(String(serviceWorker.headers['content-type']), /text\/javascript/);
    assert.equal(serviceWorker.headers['service-worker-allowed'], '/');
    assert.equal(serviceWorker.body, content.serviceWorkerSource);

    const offline = await requestJson({ port, path: '/offline.html' });
    assert.equal(offline.status, 200);
    assert.equal(offline.body, content.offlineHtml);

    const registered = await requestJson({
      port,
      path: '/chatdsh/deployment/pwa/subscriptions',
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: `${push.url}/push` }),
    });
    assert.equal(registered.status, 201);
    const subscriptionId = registered.json.subscription.id;
    assert.ok(typeof subscriptionId === 'string' && subscriptionId !== '');

    const delivered = await deployment.push({ subscriptionId, payload: { kind: 'approval' } });
    assert.equal(delivered.status, 201);
    assert.equal(push.state.requests, 1);
    assert.match(push.state.bodies[0], /approval/);

    const removed = await requestJson({
      port,
      path: `/chatdsh/deployment/pwa/subscriptions?id=${encodeURIComponent(subscriptionId)}`,
      method: 'DELETE',
      headers: { origin },
    });
    assert.equal(removed.status, 200);
    await assert.rejects(deployment.push({ subscriptionId, payload: { kind: 'approval' } }), (error) => error.code === 'push-subscription-missing');

    const unmounted = await requestJson({
      port,
      path: '/chatdsh/gateway/deployment/bundles/pwa/unmount',
      method: 'POST',
      headers: { origin },
    });
    assert.equal(unmounted.status, 200);
    const pwaAfter = bundleStateOf(unmounted.json.deployment, 'pwa');
    assert.equal(pwaAfter.mounted, false);
    assert.deepEqual(pwaAfter.resources, {});
    assert.deepEqual(unmounted.json.deployment.resources, {});

    const manifestAfter = await requestJson({ port, path: '/manifest.webmanifest' });
    assert.equal(manifestAfter.status, 404, '卸载之后静态端点必须消失');
    await assert.rejects(deployment.push({ subscriptionId, payload: {} }), (error) => error.code === 'bundle-push-unavailable');
  } finally {
    await listener.stop();
    await deployment.close();
    await push.close();
    await telemetry.shutdown();
  }
});

test('平台能力按真实加载结果声明', async () => {
  const telemetry = disabledTelemetry();
  try {
    const probes = [
      moduleProbe('pwa-manifest', join(RUNTIME, 'packages/client/pwa/lib/index.js')),
      fileProbe('pwa-icon', join(RUNTIME, 'packages/client/pwa/assets/icons/icon-192.png')),
      moduleProbe('web-push', 'web-push'),
      globalProbe('push-manager', 'PushManager'),
      fileProbe('missing-asset', join(RUNTIME, 'packages/client/pwa/assets/icons/missing.png')),
    ];
    const capabilities = await probeCapabilities(probes, telemetry);
    const byId = new Map(capabilities.map((capability) => [capability.id, capability]));
    assert.deepEqual(byId.get('pwa-manifest'), { id: 'pwa-manifest', status: 'available' });
    assert.deepEqual(byId.get('pwa-icon'), { id: 'pwa-icon', status: 'available' });
    assert.deepEqual(byId.get('web-push'), { id: 'web-push', status: 'missing', code: 'module-not-found' });
    assert.deepEqual(byId.get('push-manager'), { id: 'push-manager', status: 'missing', code: 'global-absent' });
    assert.deepEqual(byId.get('missing-asset'), { id: 'missing-asset', status: 'missing', code: 'file-not-found' });

    const deployment = new CapabilityDeployment({ bundles: [], telemetry, capabilities });
    assert.deepEqual(deployment.inspect().capabilities, capabilities);
  } finally {
    await telemetry.shutdown();
  }
});
