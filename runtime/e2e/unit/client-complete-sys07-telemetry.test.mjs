// SYS07 的遥测验收。
//
// 用真实 OTLP/HTTP 收集器接收控制平面遥测客户端导出的信号。先跑一遍真实动作：证书材料检查
// 与十天有效证书的告警、监听启动与启动失败、跨来源与伪造身份头的拒绝、升级拒绝、组合包装卸
// 与重复装载失败、平台能力加载失败；随后核对 span、失败事件、计数与当前量都存在，属性里没有
// 来源地址、证书路径与身份头取值。最后关闭遥测再跑同样的拒绝，确认拒绝语义不依赖遥测。
//
// 运行：node --test e2e/unit/client-complete-sys07-telemetry.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { tempHome } from '../../scripts/lib/cleanup.mjs';
import { createTelemetryClient } from '../../packages/core/diagnostics/lib/client.js';
import { defaultTelemetryConfig } from '../../packages/core/diagnostics/lib/config.js';
import {
  CapabilityDeployment,
  createPwaBundle,
  loadTlsMaterial,
  moduleProbe,
  probeCapabilities,
} from '../../packages/core/deployment/lib/index.js';
import { createDeployListener } from '../../gateway/lib/deploy/index.js';
import { pwaStaticContent } from '../../packages/client/pwa/lib/index.js';

/** runtime 根。 */
const RUNTIME = resolve(import.meta.dirname, '../..');

/** 真实接收 OTLP/HTTP 请求的收集器。 */
async function startCollector() {
  const bodies = { logs: [], traces: [], metrics: [] };
  const server = createHttpServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const signal = request.url?.includes('/v1/logs') ? 'logs' : request.url?.includes('/v1/traces') ? 'traces' : 'metrics';
      if (text !== '') bodies[signal].push(JSON.parse(text));
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

/** 属性列表转对象。 */
function attributesOf(entries) {
  const attributes = {};
  for (const entry of entries ?? []) {
    const value = entry.value ?? {};
    attributes[entry.key] = value.stringValue ?? value.intValue ?? value.boolValue ?? value.doubleValue;
  }
  return attributes;
}

/** 摊平日志。 */
function flattenLogs(payloads) {
  const out = [];
  for (const payload of payloads) {
    for (const resource of payload.resourceLogs ?? []) {
      for (const scope of resource.scopeLogs ?? []) {
        for (const record of scope.logRecords ?? []) {
          out.push({ name: record.body?.stringValue ?? '', attributes: attributesOf(record.attributes), raw: JSON.stringify(record) });
        }
      }
    }
  }
  return out;
}

/** 摊平追踪。 */
function flattenTraces(payloads) {
  const out = [];
  for (const payload of payloads) {
    for (const resource of payload.resourceSpans ?? []) {
      for (const scope of resource.scopeSpans ?? []) {
        for (const span of scope.spans ?? []) {
          out.push({ name: span.name, attributes: attributesOf(span.attributes), raw: JSON.stringify(span) });
        }
      }
    }
  }
  return out;
}

/** 摊平指标。 */
function flattenMetrics(payloads) {
  const out = [];
  for (const payload of payloads) {
    for (const resource of payload.resourceMetrics ?? []) {
      for (const scope of resource.scopeMetrics ?? []) {
        for (const metric of scope.metrics ?? []) {
          const points = metric.sum?.dataPoints ?? metric.gauge?.dataPoints ?? metric.histogram?.dataPoints ?? [];
          for (const point of points) {
            out.push({ name: metric.name, attributes: attributesOf(point.attributes), raw: JSON.stringify(point) });
          }
        }
      }
    }
  }
  return out;
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

/** 生成一张十天有效的自签证书。 */
function generateShortCertificate(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'short.key'), '-out', join(dir, 'short.pem'), '-days', '10', '-subj', '/CN=localhost'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  return { certPath: join(dir, 'short.pem'), keyPath: join(dir, 'short.key') };
}

/** 一次明文请求。 */
function plainRequest({ port, path = '/', method = 'GET', headers = {}, body }) {
  return new Promise((settle, fail) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => settle({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', fail);
    request.end(body);
  });
}

/** 一次原始 WebSocket 升级握手。 */
function upgradeRequest({ port, headers = {} }) {
  return new Promise((settle, fail) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/api/remote.mux',
      method: 'GET',
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        ...headers,
      },
    });
    request.on('upgrade', (response, socket) => {
      socket.destroy();
      settle({ status: response.statusCode });
    });
    request.on('response', (response) => {
      response.resume();
      settle({ status: response.statusCode });
    });
    request.on('error', fail);
    request.end();
  });
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

test('启动检查、传输拒绝、证书告警与组合包装卸都产生 span、失败事件与计数', async () => {
  const home = tempHome('sys07-telemetry');
  const collector = await startCollector();
  const telemetry = createTelemetryClient({
    config: defaultTelemetryConfig({
      endpoint: collector.url,
      exportIntervalMs: 100,
      exportIntervalMsMetrics: 100,
      exportTimeoutMs: 50,
    }),
    component: '@chatdsh/gateway',
    env: {},
  });
  const certificates = generateShortCertificate(join(home, 'certs'));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const deployment = new CapabilityDeployment({
    bundles: [
      createPwaBundle({
        content: pwaStaticContent({ name: 'ChatDSH', version: '1' }),
        subscriptionStorePath: join(home, 'pwa', 'subscriptions.json'),
      }),
    ],
    telemetry,
  });
  const listener = createDeployListener({
    plan: plaintextPlan(port),
    telemetry,
    handler: (request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"ok":true}');
    },
    kindOf: (request) => ((request.url ?? '').split('?')[0] === '/events' ? 'sse' : 'api'),
    onUpgrade: (request, socket) => {
      const key = String(request.headers['sec-websocket-key'] ?? '');
      const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.on('error', () => undefined);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    },
  });
  try {
    // 证书材料：十天有效进入告警窗口；权限过宽的副本被拒绝。
    const material = await loadTlsMaterial({ certPath: certificates.certPath, keyPath: certificates.keyPath, mutual: false }, telemetry);
    assert.equal(material.status, 'expiring');
    const looseKey = join(home, 'certs', 'loose.key');
    copyFileSync(certificates.keyPath, looseKey);
    chmodSync(looseKey, 0o644);
    await assert.rejects(loadTlsMaterial({ certPath: certificates.certPath, keyPath: looseKey, mutual: false }, telemetry), (error) => error.code === 'key-permission-forbidden');

    // 监听启动成功与启动失败。
    await listener.start();
    const wildcard = createDeployListener({ plan: { ...plaintextPlan(port), host: '0.0.0.0' }, telemetry, handler: () => undefined });
    await assert.rejects(wildcard.start(), (error) => error.code === 'bind-wildcard-forbidden');

    // 传输拒绝：跨来源写请求、伪造身份头、跨来源升级。
    const crossOrigin = await plainRequest({ port, path: '/chatdsh/gateway/settings', method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' });
    assert.equal(crossOrigin.status, 403);
    const forgedIdentity = await plainRequest({ port, path: '/healthz', headers: { 'tailscale-user-login': 'user@example.ts.net' } });
    assert.equal(forgedIdentity.status, 403);
    const upgrade = await upgradeRequest({ port, headers: { origin: 'https://evil.example' } });
    assert.equal(upgrade.status, 403);
    const allowed = await plainRequest({ port, path: '/healthz', headers: { origin } });
    assert.equal(allowed.status, 200);

    // 组合包装卸与重复装载失败。
    await deployment.mount('pwa');
    await assert.rejects(deployment.mount('pwa'), (error) => error.code === 'bundle-already-mounted');
    await deployment.unmount('pwa');

    // 平台能力加载失败。
    const capabilities = await probeCapabilities(
      [moduleProbe('pwa-manifest', join(RUNTIME, 'packages/client/pwa/lib/index.js')), moduleProbe('web-push', 'web-push')],
      telemetry
    );
    assert.equal(capabilities.find((capability) => capability.id === 'web-push')?.status, 'missing');

    await listener.stop();
    await telemetry.flush(4_000);
    await delay(400);
    await telemetry.flush(4_000);

    const logs = flattenLogs(collector.records().logs);
    const spans = flattenTraces(collector.records().traces);
    const metrics = flattenMetrics(collector.records().metrics);
    const spanNames = new Set(spans.map((span) => span.name));
    const eventNames = new Set(logs.map((log) => log.name));
    const metricNames = new Set(metrics.map((metric) => metric.name));
    const seen = `span=${[...spanNames].join('|')} 事件=${[...eventNames].join('|')} 指标=${[...metricNames].join('|')}`;

    for (const name of [
      'chatdsh.gateway.deploy.listener.start',
      'chatdsh.gateway.deploy.tls.material',
      'chatdsh.gateway.deploy.request',
      'chatdsh.gateway.deploy.upgrade',
      'chatdsh.gateway.deploy.bundle',
      'chatdsh.gateway.deploy.capability',
    ]) {
      assert.ok(spanNames.has(name), `缺少 span：${name}；实际 ${seen}`);
    }
    for (const name of [
      'chatdsh.gateway.deploy.rejected',
      'chatdsh.gateway.deploy.tls.expiring',
      'chatdsh.gateway.deploy.bundle.rejected',
      'chatdsh.gateway.deploy.capability.failed',
    ]) {
      assert.ok(eventNames.has(name), `缺少事件：${name}；实际 ${seen}`);
    }
    for (const name of [
      'chatdsh_gateway_deploy_listener_starts_total',
      'chatdsh_gateway_deploy_rejections_total',
      'chatdsh_gateway_deploy_bundle_mounts_total',
      'chatdsh_gateway_deploy_capabilities_total',
      'chatdsh_gateway_deploy_resources',
    ]) {
      assert.ok(metricNames.has(name), `缺少指标：${name}；实际 ${seen}`);
    }

    const rejected = logs.filter((log) => log.name === 'chatdsh.gateway.deploy.rejected');
    assert.ok(rejected.some((log) => log.attributes['error.code'] === 'origin-mismatch'), '跨来源拒绝必须带错误码');
    assert.ok(rejected.some((log) => log.attributes['error.code'] === 'identity-header-untrusted'), '伪造身份头必须带错误码');
    assert.ok(rejected.some((log) => log.attributes['error.code'] === 'bind-wildcard-forbidden'), '启动检查失败必须带错误码');

    const rejectionPoints = metrics.filter((metric) => metric.name === 'chatdsh_gateway_deploy_rejections_total');
    assert.ok(
      rejectionPoints.some((point) => point.attributes['error.code'] === 'origin-mismatch' && point.attributes.action === 'api'),
      '拒绝计数必须按动作与错误码分组'
    );
    const listenerPoints = metrics.filter((metric) => metric.name === 'chatdsh_gateway_deploy_listener_starts_total');
    assert.ok(listenerPoints.some((point) => point.attributes.outcome === 'ok'), '监听启动成功必须计数');
    assert.ok(listenerPoints.some((point) => point.attributes.outcome === 'rejected'), '监听启动失败必须计数');
    const resourcePoints = metrics.filter((metric) => metric.name === 'chatdsh_gateway_deploy_resources');
    assert.ok(resourcePoints.some((point) => point.attributes.kind === 'push'), '组合包资源必须按类别报告');
    const capabilityPoints = metrics.filter((metric) => metric.name === 'chatdsh_gateway_deploy_capabilities_total');
    assert.ok(capabilityPoints.some((point) => point.attributes.module === 'web-push' && point.attributes.status === 'missing'));

    // 内容边界：来源地址、证书路径与身份头取值不得出现在任何信号里。
    for (const record of [...logs, ...spans, ...metrics]) {
      assert.ok(!record.raw.includes('evil.example'), `${record.name} 携带了来源地址`);
      assert.ok(!record.raw.includes(home), `${record.name} 携带了文件路径`);
      assert.ok(!record.raw.includes('user@example.ts.net'), `${record.name} 携带了身份头取值`);
      assert.ok(!record.raw.includes('PRIVATE KEY'), `${record.name} 携带了私钥材料`);
    }
  } finally {
    await listener.stop();
    await deployment.close();
    await telemetry.shutdown();
    await collector.close();
  }
});

test('关闭遥测后拒绝语义不变', async () => {
  const home = tempHome('sys07-telemetry-off');
  const telemetry = createTelemetryClient({
    config: defaultTelemetryConfig({ surface: 'gateway' }),
    component: '@chatdsh/gateway',
    env: { CHATDSH_TELEMETRY: 'off' },
  });
  const port = await freePort();
  const listener = createDeployListener({ plan: plaintextPlan(port), telemetry, handler: () => undefined });
  try {
    assert.equal(telemetry.enabled, false);
    await listener.start();
    const rejected = await plainRequest({ port, path: '/healthz', headers: { origin: 'https://evil.example' } });
    assert.equal(rejected.status, 403);
    assert.equal(JSON.parse(rejected.body).error, 'origin-mismatch');
  } finally {
    await listener.stop();
    await telemetry.shutdown();
  }
  const deployment = new CapabilityDeployment({
    bundles: [
      createPwaBundle({
        content: pwaStaticContent({ name: 'ChatDSH', version: '1' }),
        subscriptionStorePath: join(home, 'pwa', 'subscriptions.json'),
      }),
    ],
    telemetry,
  });
  const mounted = await deployment.mount('pwa');
  assert.equal(mounted.mounted, true);
  await deployment.unmount('pwa');
  await deployment.close();
});
