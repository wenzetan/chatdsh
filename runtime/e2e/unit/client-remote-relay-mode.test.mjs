// 远程面板取数通道的选择与请求生成。
//
// 纯函数覆盖同源、直达与代理三种模式；identity 与遥测状态用一个真实本机 HTTP 服务
// 验证始终走宿主同源端点，和已配置的中继地址无关。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { relayMode } from '../../packages/client/remote/lib/client/control-url.js';
import { RemoteGateway, relayRequestOf } from '../../packages/client/remote/lib/client/api.js';
import { RemoteController } from '../../packages/client/remote/lib/client/controller.js';
import { createRemoteTelemetry } from '../../packages/client/remote/lib/client/telemetry.js';

const TRACE = '00-11111111111111111111111111111111-2222222222222222-01';

test('取数通道按页面来源分为同源、直达与代理', () => {
  assert.equal(relayMode('', 'http://127.0.0.1:3080'), 'same-origin');
  assert.equal(relayMode('   ', 'http://127.0.0.1:3080'), 'same-origin');
  assert.equal(relayMode('https://relay.example', 'https://relay.example'), 'direct');
  assert.equal(relayMode('https://relay.example/base', 'https://relay.example'), 'direct');
  assert.equal(relayMode('https://relay.example', 'http://127.0.0.1:3080'), 'proxy');
  assert.equal(relayMode('http://127.0.0.1:3170', 'http://127.0.0.1:3080'), 'proxy');
});

test('同源模式请求当前文档的网关路径', () => {
  const base = { controlUrl: '', hostBase: '', origin: 'https://relay.example' };
  const devices = relayRequestOf({ ...base, endpoint: 'devices', traceparent: TRACE });
  assert.equal(devices.url, '/chatdsh/gateway/devices');
  assert.equal(devices.method, 'GET');
  assert.equal(devices.headers.accept, 'application/json');
  assert.equal(devices.headers.traceparent, TRACE);
  assert.equal(devices.headers['x-chatdsh-control-url'], undefined);

  const sessions = relayRequestOf({ ...base, endpoint: 'sessions' });
  assert.equal(sessions.url, '/chatdsh/gateway/sessions');

  const replica = relayRequestOf({ ...base, endpoint: 'replica', sessionId: 'session a/b' });
  assert.equal(replica.url, '/chatdsh/gateway/replica?sessionId=session%20a%2Fb');

  const pair = relayRequestOf({ ...base, endpoint: 'pair', body: '{"code":"pair"}' });
  assert.equal(pair.url, '/chatdsh/gateway/devices/pair');
  assert.equal(pair.method, 'POST');
  assert.equal(pair.headers['content-type'], 'application/json');
  assert.equal(pair.headers['x-chatdsh-csrf'], undefined);
  assert.equal(pair.body, '{"code":"pair"}');
});

test('直达模式保留中继地址上的反向代理前缀', () => {
  const base = {
    controlUrl: 'https://relay.example/base',
    hostBase: '/d/device-a',
    origin: 'https://relay.example',
  };
  const devices = relayRequestOf({ ...base, endpoint: 'devices' });
  assert.equal(devices.url, 'https://relay.example/base/chatdsh/gateway/devices');
  assert.equal(devices.headers['x-chatdsh-control-url'], undefined);

  const replica = relayRequestOf({ ...base, endpoint: 'replica', sessionId: 's-1' });
  assert.equal(replica.url, 'https://relay.example/base/chatdsh/gateway/replica?sessionId=s-1');
});

test('代理模式请求宿主中继端点并附带目标地址', () => {
  const base = {
    controlUrl: 'https://relay.example/base',
    hostBase: '',
    origin: 'http://127.0.0.1:3080',
  };
  const devices = relayRequestOf({ ...base, endpoint: 'devices' });
  assert.equal(devices.url, '/chatdsh/device/relay/devices');
  assert.equal(devices.headers['x-chatdsh-control-url'], 'https://relay.example/base');

  const sessions = relayRequestOf({ ...base, endpoint: 'sessions', hostBase: '/d/device-a' });
  assert.equal(sessions.url, '/d/device-a/chatdsh/device/relay/sessions');

  const replica = relayRequestOf({ ...base, endpoint: 'replica', sessionId: 'session a/b&c' });
  assert.equal(replica.url, '/chatdsh/device/relay/replica?sessionId=session%20a%2Fb%26c');

  const pair = relayRequestOf({ ...base, endpoint: 'pair', body: '{"code":"pair"}' });
  assert.equal(pair.url, '/chatdsh/device/relay/pair');
  assert.equal(pair.method, 'POST');
  assert.equal(pair.headers['x-chatdsh-control-url'], 'https://relay.example/base');
  assert.equal(pair.headers['x-chatdsh-csrf'], '1');
  assert.equal(pair.headers['content-type'], 'application/json');
  assert.equal(pair.body, '{"code":"pair"}');
});

test('identity 与遥测状态始终走宿主同源端点', async () => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url ?? '', headers: request.headers });
    if (request.url === '/chatdsh/telemetry/browser') {
      request.resume();
      response.writeHead(204);
      response.end();
      return;
    }
    const body = request.url === '/chatdsh/device/identity'
      ? JSON.stringify({ deviceId: 'device-local' })
      : request.url === '/chatdsh/device/relay/devices'
        ? JSON.stringify({ devices: [] })
        : JSON.stringify({ enabled: true });
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    });
    response.end(body);
  });
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const hostBase = `http://127.0.0.1:${port}`;
  const telemetry = createRemoteTelemetry({
    relayPath: () => `${hostBase}/chatdsh/telemetry/browser`,
  });
  const gateway = new RemoteGateway(
    () => 'https://relay.example',
    () => hostBase,
    () => 'http://127.0.0.1:3080',
    telemetry,
  );
  try {
    const devices = await gateway.devices();
    assert.deepEqual(devices, { devices: [] });
    assert.deepEqual(await gateway.identity(), { deviceId: 'device-local' });
    assert.deepEqual(await gateway.telemetryStatus(), { enabled: true });
    assert.ok(requests.some((entry) => entry.url === '/chatdsh/device/relay/devices'));
    const relayed = requests.find((entry) => entry.url === '/chatdsh/device/relay/devices');
    assert.equal(relayed.headers['x-chatdsh-control-url'], 'https://relay.example');
    assert.ok(requests.some((entry) => entry.url === '/chatdsh/device/identity'));
    assert.ok(requests.some((entry) => entry.url === '/chatdsh/telemetry/status'));
    assert.equal(requests.some((entry) => entry.url === '/chatdsh/gateway/devices'), false);
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});

test('本机 DSH Web 首次打开未手动填写中继地址时自动从宿主 identity 发现中继并经本机代理连通', async () => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url ?? '', headers: request.headers });
    if (request.url === '/chatdsh/telemetry/browser') {
      request.resume();
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.url === '/chatdsh/device/identity') {
      const body = JSON.stringify({ deviceId: 'device-node-a', controlUrl: 'https://relay.example' });
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      response.end(body);
      return;
    }
    if (request.url === '/chatdsh/device/relay/devices') {
      const body = JSON.stringify({
        devices: [{ id: 'device-node-a', name: 'node-a', platform: 'linux', online: true, lastSeenAt: 1000 }],
      });
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      response.end(body);
      return;
    }
    if (request.url === '/chatdsh/device/relay/sessions') {
      const body = JSON.stringify({
        devices: [{
          deviceId: 'device-node-a',
          name: 'node-a',
          platform: 'linux',
          online: true,
          lastSeenAt: 1000,
          sessions: [{ sessionId: 's-1', title: '远程会话', updatedAt: 1000, cwd: '', workspaceName: 's-1', kind: 'work' }],
        }],
      });
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      response.end(body);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const origin = `http://127.0.0.1:${port}`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const target = typeof input === 'string' && input.startsWith('/') ? `${origin}${input}` : input;
    return originalFetch(target, init);
  };
  const telemetry = createRemoteTelemetry({
    relayPath: () => `${origin}/chatdsh/telemetry/browser`,
  });
  const controller = new RemoteController(
    { remote: { $host: {} } },
    telemetry,
    { pathname: () => '/', origin: () => origin },
  );
  try {
    await controller.refresh();
    const snap = controller.getSnapshot();
    assert.equal(snap.relay.state, 'connected');
    assert.equal(snap.devices.length, 1);
    assert.equal(snap.devices[0].id, 'device-node-a');
    assert.equal(snap.sessions.length, 1);
    assert.equal(snap.settings.controlUrl, 'https://relay.example');
    assert.equal(snap.settings.identity, 'device-node-a');
    assert.equal(requests.some((entry) => entry.url === '/chatdsh/gateway/devices'), false);
    const relayed = requests.find((entry) => entry.url === '/chatdsh/device/relay/devices');
    assert.equal(relayed?.headers['x-chatdsh-control-url'], 'https://relay.example');
  } finally {
    controller.dispose();
    globalThis.fetch = originalFetch;
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});
