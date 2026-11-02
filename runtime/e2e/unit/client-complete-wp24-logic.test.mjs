// WP24 设备面板数据层验收：真实设备生命周期模块、真实 SQLite、真实 HTTP。
//
// 数据入口直接打真实控制平面的设备管理接口：列表、配对码签发、撤销与链路检查。失败分支
// 全部来自真实响应（未携带凭据、凭据无效、设备不存在、角色不符、重复撤销、控制平面不可达、
// 响应形状不符），断言的是界面会显示的中文说明与错误码。遥测经真实 HTTP 中继端点收取，
// 断言只出现登记过的信号名与属性。
//
// 运行：node --test e2e/unit/client-complete-wp24-logic.test.mjs

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { GatewayStore } from '../../gateway/lib/store.js';
import { DeviceLinkHub } from '../../gateway/lib/device-link.js';
import {
  DeviceLifecycle,
  DeviceTransportRegistry,
  PairingService,
  createDeviceHost,
} from '../../gateway/lib/devices/index.js';
import { createTelemetryClient } from '../../packages/core/diagnostics/lib/client.js';
import { defaultTelemetryConfig } from '../../packages/core/diagnostics/lib/config.js';
import {
  createDeviceGateway,
  DEVICES_PATH,
  LINK_CHECK_PATH,
  PAIRING_PATH,
  REVOKE_PATH,
} from '../../packages/client/account/lib/client/gateway.js';
import { createPanelTelemetry } from '../../packages/client/account/lib/client/telemetry.js';
import {
  describeFailure,
  formatMoment,
  formatRelative,
  formatRemaining,
  linkCheckText,
  platformLabel,
  ROLE_LABELS,
} from '../../packages/client/account/lib/client/describe.js';

const ROOT = new URL('../../', import.meta.url);

const hash = (value) => createHash('sha256').update(value).digest('hex');

/** 关闭遥测的客户端。 */
function silentTelemetry() {
  return createTelemetryClient({
    config: defaultTelemetryConfig({ surface: 'gateway' }),
    component: '@chatdsh/gateway',
    env: { CHATDSH_TELEMETRY: 'off' },
  });
}

/** 直接登记一台访问客户端，返回它的令牌。 */
function seedAccess(store, id, name = id) {
  const token = randomBytes(32).toString('base64url');
  store.registerMobileDevice({ id, name, platform: 'linux', tokenHash: hash(token) });
  return token;
}

/** 直接登记一台执行节点，返回它的令牌。 */
function seedNode(store, id, role = 'both') {
  const token = randomBytes(32).toString('base64url');
  store.registerNode({ id, name: id, platform: 'linux', role, capabilities: [], tokenHash: hash(token) });
  return token;
}

/**
 * 起一个真实装配的控制平面。
 * @param options - 覆盖项。
 */
async function startApp(options = {}) {
  const home = allocateIndependentHome('wp24-logic');
  const store = new GatewayStore(join(home, 'gateway.sqlite'));
  const telemetry = silentTelemetry();
  const transports = new DeviceTransportRegistry();
  const deviceLink = new DeviceLinkHub({ store, telemetry, heartbeatMs: 1000, deadAfterMs: 5000, requestTimeoutMs: 3000 });
  const pairing = new PairingService(options.pairing ?? {});
  let host;
  const server = createServer(async (request, response) => {
    if (host !== undefined && await host.handle(request, response)) return;
    response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'object-not-found' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const lifecycle = new DeviceLifecycle({
    store,
    telemetry,
    deviceLink,
    transports,
    pairing,
    controlUrl: origin,
    linkCheckTimeoutMs: 2000,
  });
  host = createDeviceHost({ lifecycle, telemetry, transports, controlUrl: origin });
  const controlToken = seedAccess(store, 'control', '验收访问客户端');
  const readerToken = seedAccess(store, 'reader', '第二访问客户端');
  const buildToken = seedNode(store, 'build-node', 'executor');
  return {
    home,
    origin,
    store,
    deviceLink,
    controlToken,
    readerToken,
    buildToken,
    async close() {
      host.stop();
      deviceLink.stop();
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await telemetry.shutdown();
      store.close();
      releaseIndependentHome(home);
    },
  };
}

/**
 * 把相对路径解析到控制平面地址上的真实请求实现。
 * @param origin - 控制平面地址。
 */
function fetchAt(origin) {
  return (path, init) => fetch(new URL(path, origin), init);
}

/** 把设备管理接口包一层，指向真实控制平面。 */
function gatewayAt(app, options = {}) {
  return createDeviceGateway({ fetchImpl: fetchAt(app.origin), ...options });
}

/** 一个不接收连接的地址，用于真实网络失败。 */
async function closedOrigin() {
  const server = createServer(() => undefined);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

test('设备入口按真实错误码给出说明，列表与配对码来自真实控制平面', async () => {
  const app = await startApp();
  try {
    const anonymous = gatewayAt(app);
    await assert.rejects(anonymous.list(), (error) => {
      assert.equal(error.code, 'device-token-required');
      assert.equal(error.status, 401);
      assert.match(describeFailure(error), /没有携带设备凭据/);
      return true;
    });

    const forged = gatewayAt(app, { credential: () => randomBytes(32).toString('base64url') });
    await assert.rejects(forged.list(), (error) => {
      assert.equal(error.code, 'device-token-invalid');
      assert.match(describeFailure(error), /设备凭据无效/);
      return true;
    });

    const gateway = gatewayAt(app, { credential: () => app.controlToken });
    const list = await gateway.list();
    assert.deepEqual(list.nodes.map((node) => node.id), ['build-node']);
    assert.equal(list.nodes[0].role, 'executor');
    assert.equal(list.nodes[0].online, false);
    assert.equal(list.nodes[0].currentExecutor, false);
    assert.equal(list.accessClients.length, 2);
    assert.equal(list.accessClients.find((client) => client.id === 'control').current, true);
    assert.equal(list.accessClients.find((client) => client.id === 'reader').current, false);
    assert.equal(JSON.stringify(list).includes(app.controlToken), false);
    assert.equal(JSON.stringify(list).includes(hash(app.controlToken)), false);

    const issued = await gateway.issuePairing('manual');
    assert.equal(issued.kind, 'manual');
    assert.equal(issued.controlUrl, app.origin);
    assert.match(issued.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.ok(issued.expiresAt > Date.now());
    const payload = JSON.parse(Buffer.from(issued.encoded, 'base64url').toString('utf8'));
    assert.equal(payload.controlUrl, app.origin);
    assert.equal(payload.pairingCode, issued.code);

    const offline = await gateway.checkLink('build-node');
    assert.equal(offline.reachable, false);
    assert.equal(offline.code, 'device-offline');
    assert.equal(offline.latencyMs, undefined);
    assert.equal(linkCheckText(offline), '不可达：执行节点离线（device-offline）');

    await assert.rejects(gateway.checkLink('control'), (error) => {
      assert.equal(error.code, 'device-role-mismatch');
      assert.match(describeFailure(error), /只针对执行节点/);
      return true;
    });

    await assert.rejects(gateway.checkLink('missing'), (error) => {
      assert.equal(error.code, 'device-unknown');
      assert.match(describeFailure(error), /没有这台设备/);
      return true;
    });

    const revoked = await gateway.revoke('reader', 'user');
    assert.equal(revoked.deviceId, 'reader');
    assert.equal(revoked.sessionsPreserved, true);
    assert.equal(revoked.closedLinks, 0);
    await assert.rejects(gateway.revoke('reader', 'user'), (error) => {
      assert.equal(error.code, 'already-handled');
      assert.match(describeFailure(error), /已经撤销过/);
      return true;
    });
    await assert.rejects(gateway.revoke('missing', 'lost'), (error) => {
      assert.equal(error.code, 'device-unknown');
      return true;
    });

    const afterRevoke = await gateway.list();
    assert.ok(afterRevoke.accessClients.find((client) => client.id === 'reader').revokedAt > 0);
  } finally {
    await app.close();
  }
});

test('控制平面不可达与响应形状不符都按失败返回，不显示成空列表', async () => {
  const origin = await closedOrigin();
  const offline = createDeviceGateway({ fetchImpl: fetchAt(origin), credential: () => 'token' });
  await assert.rejects(offline.list(), (error) => {
    assert.equal(error.code, 'gateway/offline');
    assert.match(describeFailure(error), /控制平面不可达/);
    return true;
  });

  const broken = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ nodes: 'not-an-array', accessClients: [] }));
  });
  broken.listen(0, '127.0.0.1');
  await once(broken, 'listening');
  try {
    const url = `http://127.0.0.1:${broken.address().port}`;
    const gateway = createDeviceGateway({ fetchImpl: fetchAt(url), credential: () => 'token' });
    await assert.rejects(gateway.list(), (error) => {
      assert.equal(error.code, 'gateway/invalid-response');
      assert.match(describeFailure(error), /形状不符合约定/);
      return true;
    });
  } finally {
    broken.closeAllConnections();
    await new Promise((resolve) => broken.close(resolve));
  }
});

test('设备管理调用与界面动作进入真实中继端点，信号只带登记过的属性', async () => {
  const app = await startApp();
  const batches = [];
  const relay = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      batches.push({
        path: request.url,
        signal: request.headers['x-chatdsh-signal'],
        csrf: request.headers['x-chatdsh-csrf'],
        body: Buffer.concat(chunks).toString('utf8'),
      });
      response.writeHead(204);
      response.end();
    });
  });
  relay.listen(0, '127.0.0.1');
  await once(relay, 'listening');
  const relayOrigin = `http://127.0.0.1:${relay.address().port}`;
  const telemetry = createPanelTelemetry({ fetchImpl: fetchAt(relayOrigin) });
  try {
    const gateway = createDeviceGateway({
      fetchImpl: fetchAt(app.origin),
      telemetry,
      credential: () => app.controlToken,
    });
    const list = await gateway.list();
    assert.equal(list.nodes.length, 1);
    await gateway.issuePairing('manual');
    gateway.noteAction('device-list', 'ok');
    gateway.noteAction('device-pairing-issue', 'ok');

    const anonymous = createDeviceGateway({ fetchImpl: fetchAt(app.origin), telemetry });
    await assert.rejects(anonymous.list());

    await new Promise((resolve) => setTimeout(resolve, 150));
    const signals = batches.map((batch) => batch.signal);
    assert.ok(signals.includes('traces'), '缺少 span 上报');
    assert.ok(signals.includes('logs'), '缺少事件上报');
    assert.ok(signals.includes('metrics'), '缺少计数上报');
    for (const batch of batches) {
      assert.equal(batch.path, '/chatdsh/telemetry/browser');
      assert.equal(batch.csrf, '1');
    }
    const text = batches.map((batch) => batch.body).join('\n');
    for (const name of [
      'chatdsh.client.remote.call',
      'chatdsh.client.ui.action',
      'chatdsh.client.error',
      'chatdsh_client_errors_total',
    ]) {
      assert.equal(text.includes(name), true, `缺少信号 ${name}`);
    }
    for (const method of ['devices/list', 'devices/pairing']) {
      assert.equal(text.includes(`"${method}"`), true, `缺少调用名 ${method}`);
    }
    for (const action of ['device-list', 'device-pairing-issue']) {
      assert.equal(text.includes(`"${action}"`), true, `缺少动作名 ${action}`);
    }
    assert.equal(text.includes('device-token-required'), true, '失败分支要带错误码');
    assert.equal(text.includes(app.controlToken), false, '遥测不携带设备凭据');
    assert.equal(text.includes('build-node'), false, '遥测不携带设备名称');
    assert.equal(text.includes(app.origin), false, '遥测不携带控制平面地址');
  } finally {
    relay.closeAllConnections();
    await new Promise((resolve) => relay.close(resolve));
    await app.close();
  }
});

test('时刻、有效期与链路结论的写法', () => {
  const now = Date.UTC(2026, 10, 1, 12, 0, 0);
  assert.equal(formatRemaining(now + 299_000, now), '04:59');
  assert.equal(formatRemaining(now + 1_000, now), '00:01');
  assert.equal(formatRemaining(now, now), '已过期');
  assert.equal(formatRemaining(now - 1, now), '已过期');
  assert.equal(formatRelative(now - 1_000, now), '刚刚');
  assert.equal(formatRelative(now - 180_000, now), '3 分钟前');
  assert.equal(formatRelative(now - 7_200_000, now), '2 小时前');
  assert.equal(formatRelative(now - 90_000_000, now), '昨天');
  assert.equal(formatRelative(now - 3 * 86_400_000, now), '3 天前');
  assert.match(formatMoment(now), /^2026年11月01日 \d{2}:00$/);
  assert.equal(platformLabel('darwin'), 'macOS');
  assert.equal(platformLabel('riscv'), 'riscv');
  assert.equal(ROLE_LABELS.both, '宿主与执行节点');
  assert.equal(linkCheckText({ deviceId: 'a', checkedAt: 1, reachable: true, latencyMs: 12 }), '可达，往返延迟 12 毫秒');
  assert.equal(linkCheckText({ deviceId: 'a', checkedAt: 1, reachable: true }), '可达');
  assert.equal(linkCheckText({ deviceId: 'a', checkedAt: 1, reachable: false, code: 'device-token-revoked' }), '不可达：设备令牌已撤销（device-token-revoked）');
  assert.equal(linkCheckText({ deviceId: 'a', checkedAt: 1, reachable: false }), '不可达：沿设备连接的请求没有完成（device-unreachable）');
});

test('区段初始帧用设计系统渲染加载骨架', async () => {
  const dir = join(ROOT.pathname, '.run', `wp24-ssr-${String(process.pid)}`);
  mkdirSync(dir, { recursive: true });
  try {
    const outfile = join(dir, 'account.mjs');
    await build({
      entryPoints: [join(ROOT.pathname, 'packages/client/account/src/client/index.tsx')],
      bundle: true,
      format: 'esm',
      platform: 'node',
      jsx: 'automatic',
      external: ['react', 'react-dom', 'react/jsx-runtime'],
      outfile,
    });
    const module = await import(outfile);
    assert.equal(typeof module.DeviceSection, 'function');
    const html = renderToStaticMarkup(createElement(module.DeviceSection));
    assert.match(html, /chdsh-panel/);
    assert.match(html, /chdsh-skeleton/);
    assert.doesNotMatch(html, /#[0-9a-fA-F]{6}\b/);
    assert.doesNotMatch(html, /rgba?\(/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('设备管理路径常量与控制平面一致', () => {
  assert.equal(DEVICES_PATH, '/chatdsh/gateway/devices');
  assert.equal(PAIRING_PATH, '/chatdsh/gateway/devices/pairing');
  assert.equal(REVOKE_PATH, '/chatdsh/gateway/devices/revoke');
  assert.equal(LINK_CHECK_PATH, '/chatdsh/gateway/devices/link-check');
});
