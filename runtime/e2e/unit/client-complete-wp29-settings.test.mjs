// WP29 验收：设置版本、作用范围与同步。
//
// 控制平面是真实网关进程（真实 SQLite 与真实 HTTP），两台设备与一个新设备是真实的
// Cordis 运行时实例（真实本机 HTTP 服务、真实 home 层文件、各自独立的数据根），两个
// 客户端各自用真实会话请求自己那台设备的设置接口。断言覆盖表单版本与过期拒绝、来源与
// 作用范围、白名单字段过滤、按控制平面接收时刻合并、两台设备两个客户端竞争写入、新设备
// 继承白名单设置，以及写入 span、拒绝与失败事件和计数指标。
//
// 运行：node --test e2e/unit/client-complete-wp29-settings.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import net from 'node:net';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { ensureDeps } from '../lib/ensure-deps.mjs';

const RUNTIME = resolve(import.meta.dirname, '../..');
const REPO = resolve(RUNTIME, '..');
ensureDeps(RUNTIME);
ensureDeps(resolve(REPO, 'dsh-adapter'));
ensureBuild(join(RUNTIME, 'packages/host/settings-sync'), join(RUNTIME, 'packages/host/settings-sync/lib/index.js'), 'wp29-settings-build');
ensureBuild(join(RUNTIME, 'gateway'), join(RUNTIME, 'gateway/lib/main.js'), 'wp29-gateway-build');

/**
 * 编译一个工程，多个测试文件同时运行时用目录锁串行。
 * @param {string} projectDir - 工程目录。
 * @param {string} artifact - 就绪判定用的产物路径。
 * @param {string} lockName - 锁目录名。
 */
function ensureBuild(projectDir, artifact, lockName) {
  if (existsSync(artifact)) return;
  const lock = join(RUNTIME, '.verify', `${lockName}.lock`);
  mkdirSync(join(RUNTIME, '.verify'), { recursive: true });
  const deadline = Date.now() + 240_000;
  for (;;) {
    if (existsSync(artifact)) return;
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > 300_000) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error('等待构建锁超时');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
    }
  }
  try {
    execFileSync(join(RUNTIME, 'node_modules/.bin/tsc'), ['-b', projectDir], { cwd: RUNTIME, stdio: 'inherit' });
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

const { Context } = await import('@deepseek-ai/cordis');
const { default: WebServer } = await import('@deepseek-ai/dsh-host-webserver');
const {
  ChatdshSettingsSyncService,
  SETTINGS_FORM_PATH,
  SETTINGS_LATEST_PATH,
  SETTINGS_PUSH_PATH,
  SETTINGS_SCOPES_PATH,
  SETTINGS_SYNC_PATH,
} = await import('../../packages/host/settings-sync/lib/index.js');
const { createTelemetryClient } = await import('../../packages/core/diagnostics/lib/client.js');
const { defaultTelemetryConfig } = await import('../../packages/core/diagnostics/lib/config.js');

/** 等一段时间。 */
function settle(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * 找一个空闲端口。
 * @param {number} start - 起始端口。
 */
async function findFreePort(start) {
  for (let port = start; port <= start + 200; port += 1) {
    const server = net.createServer();
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
    } catch {
      continue;
    }
    await new Promise((resolve) => server.close(resolve));
    return port;
  }
  throw new Error('没有可用端口');
}

/**
 * 反复执行一个检查直到成立。
 * @param {() => Promise<{ ok: boolean, value?: unknown, detail?: unknown }>} check - 检查函数。
 * @param {number} timeoutMs - 超时毫秒数。
 * @param {string} label - 失败时报告的等待对象。
 */
async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last.ok) return last.value;
    await settle(80);
  }
  throw new Error(`等待超时：${label}；最后状态 ${JSON.stringify(last?.detail ?? last)}`);
}

/**
 * 起一个真实中继进程。
 * @param {string} home - 中继的数据根。
 * @param {string} pairingCode - 配对码。
 */
async function startGateway(home, pairingCode) {
  const port = await findFreePort(20310);
  const child = spawn(process.execPath, [join(RUNTIME, 'gateway/lib/main.js')], {
    cwd: RUNTIME,
    env: {
      ...process.env,
      CHATDSH_TELEMETRY: 'off',
      DSH_HOME: join(home, 'gateway-home'),
      CHATDSH_GATEWAY_HOST: '127.0.0.1',
      CHATDSH_GATEWAY_PORT: String(port),
      CHATDSH_GATEWAY_DB: join(home, 'gateway.sqlite'),
      CHATDSH_PAIRING_CODE: pairingCode,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { text: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output.text += chunk; });
  child.stderr.on('data', (chunk) => { output.text += chunk; });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitFor(async () => {
      if (child.exitCode !== null) return { ok: false, detail: `中继已退出：${output.text.slice(-800)}` };
      const response = await fetch(`${base}/healthz`).catch(() => undefined);
      return { ok: response?.ok === true, detail: response?.status ?? '不可达' };
    }, 30_000, '中继监听');
  } catch (error) {
    child.kill('SIGTERM');
    throw error;
  }
  return {
    base,
    output: () => output.text,
    async stop() {
      child.kill('SIGTERM');
      await waitFor(async () => ({ ok: child.exitCode !== null }), 15_000, '中继退出').catch(() => undefined);
    },
  };
}

/**
 * 配对一台设备，取回节点令牌。
 * @param {string} base - 控制平面地址。
 * @param {string} name - 设备名称。
 * @param {string} code - 配对码。
 */
async function pairDevice(base, name, code) {
  const response = await fetch(`${base}/chatdsh/gateway/devices/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, name, platform: 'linux', role: 'both', capabilities: ['shell'] }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, `配对 ${name} 失败：${JSON.stringify(body)}`);
  return { deviceId: body.deviceId, token: body.token };
}

/**
 * 装配一台真实的设备运行时：真实本机 HTTP 服务与真实设置同步插件。
 * @param {{ home: string, deviceId: string, token: string, controlUrl: string, scanIntervalMs?: number, telemetry?: object }} options 设备参数。
 */
async function openDevice({ home, deviceId, token, controlUrl, scanIntervalMs = 200, telemetry }) {
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const ctx = new Context();
  try {
    ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
    await waitFor(async () => ({ ok: ctx.webServer !== undefined }), 10_000, '本机 HTTP 服务');
    if (telemetry !== undefined) {
      ctx.provide('chatdshTelemetry');
      ctx.set('chatdshTelemetry', telemetry);
    }
    ctx.plugin(ChatdshSettingsSyncService, { controlUrl, nodeToken: token, deviceId, scanIntervalMs });
    const origin = await waitFor(async () => {
      const address = ctx.webServer?.getOrigin?.();
      if (address === undefined) return { ok: false, detail: '服务尚未监听' };
      const response = await fetch(`${address}${SETTINGS_SCOPES_PATH}`).catch(() => undefined);
      return { ok: response?.status === 200, detail: response?.status ?? '不可达', value: address };
    }, 30_000, `${deviceId} 设置接口就绪`);
    return { ctx, deviceId, home, origin };
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
}

/** 一台设备的真实客户端。 */
function clientOf(origin) {
  const call = async (path, init) => {
    const response = await fetch(`${origin}${path}`, init);
    const text = await response.text();
    return { status: response.status, body: text === '' ? undefined : JSON.parse(text) };
  };
  return {
    readForm: (namespace) => call(`${SETTINGS_FORM_PATH}?ns=${encodeURIComponent(namespace)}`),
    latest: (namespace) => call(`${SETTINGS_LATEST_PATH}?ns=${encodeURIComponent(namespace)}`),
    scopes: () => call(SETTINGS_SCOPES_PATH),
    sync: () => call(SETTINGS_SYNC_PATH),
    write: (namespace, revision, fields) => call(SETTINGS_FORM_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ namespace, revision, fields }),
    }),
  };
}

/** 读控制平面的白名单设置快照。 */
async function snapshot(base) {
  const response = await fetch(`${base}/chatdsh/gateway/settings`);
  assert.equal(response.status, 200);
  return (await response.json()).namespaces;
}

/** 读 home 层补丁文件。 */
function homeText(home) {
  const path = join(home, 'cordis.patch.yml');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** 起一个真实接收 OTLP/HTTP 请求的收集器。 */
async function startOtlpReceiver() {
  const records = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      records.push({ path: request.url ?? '', body: Buffer.concat(chunks).toString('utf8') });
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
    endpoint: `http://127.0.0.1:${port}`,
    records,
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}

test('设置版本、作用范围、白名单过滤、两台设备竞争写入与新设备继承', { timeout: 240_000 }, async () => {
  const home = allocateIndependentHome('wp29-settings');
  const pairingCode = randomBytes(9).toString('base64url');
  const devices = [];
  let gateway;
  try {
    gateway = await startGateway(join(home, 'control-plane'), pairingCode);
    const deviceA = await pairDevice(gateway.base, 'device-a', pairingCode);
    const deviceB = await pairDevice(gateway.base, 'device-b', pairingCode);

    const homeA = join(home, 'device-a');
    const homeB = join(home, 'device-b');
    mkdirSync(homeA, { recursive: true });
    mkdirSync(homeB, { recursive: true });
    // 设备 A 的 home 层预置一个白名单之外的字段与一个设备范围命名空间：两者都不得上报。
    writeFileSync(join(homeA, 'cordis.patch.yml'), [
      '- id: agent-default-model',
      "  name: '@deepseek-ai/dsh-agent-default-model'",
      '  config:',
      '    model: seeded',
      '    apiKeyEnv: CHATDSH_KEY',
      '- id: bash-local',
      "  name: '@deepseek-ai/dsh-bash-local'",
      '  config:',
      '    cwd: /srv/work',
      '    timeoutMs: 5000',
      '',
    ].join('\n'));

    const stackA = await openDevice({ home: homeA, deviceId: deviceA.deviceId, token: deviceA.token, controlUrl: gateway.base });
    devices.push(stackA);
    const clientA = clientOf(stackA.origin);

    // 表单读数：版本从零开始，来源分设备、控制平面与默认三种。
    const initialForm = await clientA.readForm('agent-default-model');
    assert.equal(initialForm.status, 200, JSON.stringify(initialForm.body));
    assert.equal(initialForm.body.namespace, 'agent-default-model');
    assert.equal(initialForm.body.section, 'models');
    assert.equal(initialForm.body.scope, 'client');
    assert.equal(initialForm.body.revision, 0);
    const initialFields = Object.fromEntries(initialForm.body.fields.map((entry) => [entry.field, entry]));
    assert.deepEqual(Object.keys(initialFields).sort(), ['model', 'provider', 'reasoningEffort']);
    assert.equal(initialFields.model.value, 'seeded', 'home 层已有的值就是有效值');
    assert.equal(initialFields.model.source, 'control-plane');
    assert.equal(initialFields.provider.source, 'default');
    assert.equal(initialFields.reasoningEffort.source, 'default');
    assert.equal(initialForm.body.filteredCount, 1, '同一命名空间里白名单之外的字段被过滤');
    const unknownForm = await clientA.readForm('不存在的设置');
    assert.equal(unknownForm.status, 404, JSON.stringify(unknownForm.body));
    assert.equal(unknownForm.body.error, 'object-not-found');

    // 被过滤字段的数量可以查询：一个字段越界，一个命名空间的全部字段越界。
    const syncA = await clientA.sync();
    assert.equal(syncA.status, 200);
    assert.equal(syncA.body.filtered.total, 3);
    assert.deepEqual(syncA.body.filtered.byNamespace, { 'agent-default-model': 1, 'bash-local': 2 });
    assert.deepEqual(syncA.body.whitelist.namespaces, ['agent-default-model', 'client-locale', 'client-ui-chat', 'client-product-analytics', 'agent-preset-registry']);

    // 作用范围：路径与超时字段属于设备范围，写入被拒绝，控制平面不收。
    const scopes = await clientA.scopes();
    assert.equal(scopes.status, 200);
    assert.deepEqual(scopes.body.deviceFieldKeywords.sort(), ['cwd', 'path', 'platform', 'power', 'sandbox', 'timeout', 'tray']);
    const bashScope = scopes.body.namespaces.find((entry) => entry.namespace === 'bash-local');
    assert.equal(bashScope.scope, 'device');
    for (const field of bashScope.fields) {
      assert.equal(field.scope, 'device', `${field.field} 属于设备范围`);
      assert.equal(field.synced, false, `${field.field} 不参与同步`);
    }
    const modelScope = scopes.body.namespaces.find((entry) => entry.namespace === 'agent-default-model');
    assert.equal(modelScope.scope, 'client');
    for (const field of modelScope.fields) {
      assert.equal(field.scope, 'client');
      assert.equal(field.synced, true);
    }
    const deviceScopeWrite = await clientA.write('bash-local', 0, { cwd: '/etc' });
    assert.equal(deviceScopeWrite.status, 400, JSON.stringify(deviceScopeWrite.body));
    assert.equal(deviceScopeWrite.body.outcome, 'rejected');
    assert.equal(deviceScopeWrite.body.code, 'permission-denied');
    assert.equal(deviceScopeWrite.body.reason, 'namespace-device-scope');
    assert.equal((await snapshot(gateway.base))['bash-local'], undefined, '设备范围设置没有进入控制平面');

    // 非白名单字段同样被拒绝上报，白名单命名空间里的路径字段按设备范围处理。
    const filteredWrite = await clientA.write('agent-default-model', 0, { apiKeyEnv: 'CHATDSH_KEY' });
    assert.equal(filteredWrite.status, 400, JSON.stringify(filteredWrite.body));
    assert.equal(filteredWrite.body.outcome, 'rejected');
    assert.deepEqual(filteredWrite.body.fields, ['apiKeyEnv']);
    const pathWrite = await clientA.write('agent-default-model', 0, { workspacePath: '/srv/work' });
    assert.equal(pathWrite.status, 400, JSON.stringify(pathWrite.body));
    assert.deepEqual(pathWrite.body.fields, ['workspacePath']);

    // 客户端一提交：版本推进，控制平面记录接收时刻。
    const written = await clientA.write('agent-default-model', 0, { model: 'model-from-a' });
    assert.equal(written.status, 200, JSON.stringify(written.body));
    assert.equal(written.body.outcome, 'applied');
    assert.equal(written.body.revision, 1);
    assert.deepEqual(written.body.fields, ['model']);
    assert.equal(written.body.values.model, 'model-from-a');
    const latestA = await clientA.latest('agent-default-model');
    assert.equal(latestA.status, 200);
    assert.equal(latestA.body.revision, 1);
    assert.equal(latestA.body.values.model, 'model-from-a');
    const syncAfterWrite = await clientA.sync();
    assert.equal(syncAfterWrite.status, 200);
    assert.equal(syncAfterWrite.body.namespaces['agent-default-model'].revision, 1);
    assert.deepEqual(syncAfterWrite.body.namespaces['agent-default-model'].fields.map((entry) => entry.field), ['model']);
    assert.equal(syncAfterWrite.body.namespaces['agent-default-model'].fields[0].source, 'device', '本设备的写入来源是本设备');
    assert.equal(syncAfterWrite.body.filtered.total, 3, '被过滤字段数量不随写入变化');

    const stackB = await openDevice({ home: homeB, deviceId: deviceB.deviceId, token: deviceB.token, controlUrl: gateway.base });
    devices.push(stackB);
    const clientB = clientOf(stackB.origin);

    // 设备 B 按控制平面接收时刻合并，版本随之推进。
    await waitFor(async () => {
      const form = await clientB.readForm('agent-default-model');
      return form.status === 200 && form.body.revision === 1 ? { ok: true } : { ok: false, detail: form.body?.revision };
    }, 20_000, '设备 B 收到控制平面的设置');
    const formB = await clientB.readForm('agent-default-model');
    const fieldsB = Object.fromEntries(formB.body.fields.map((entry) => [entry.field, entry]));
    assert.equal(fieldsB.model.value, 'model-from-a');
    assert.equal(fieldsB.model.source, 'control-plane', '跨设备得到的值来源是控制平面');
    const deviceIds = formB.body.devices.map((entry) => entry.deviceId).sort();
    assert.deepEqual(deviceIds, [deviceA.deviceId, deviceB.deviceId].sort(), '作用设备列表来自控制平面的设备登记');

    // 客户端二用旧版本提交：拒绝并返回最新版本与当前值，服务端值不变。
    const stale = await clientB.write('agent-default-model', 0, { model: 'model-from-b' });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal(stale.body.outcome, 'conflict');
    assert.equal(stale.body.conflict.currentRevision, 1);
    assert.equal(stale.body.revision, 1);
    assert.deepEqual(stale.body.conflict.fields, [
      { field: 'model', sensitive: false, userValue: 'model-from-b', serverValue: 'model-from-a' },
    ]);
    assert.equal(stale.body.values.model, 'model-from-a');
    const afterStale = await snapshot(gateway.base);
    assert.equal(JSON.parse(afterStale['agent-default-model'][0].value), 'model-from-a', '服务端值没有被过期写入覆盖');
    assert.equal(JSON.stringify(afterStale).includes('model-from-b'), false);
    const formBAfter = await clientB.readForm('agent-default-model');
    assert.equal(formBAfter.body.revision, 1, '冲突不改变版本');
    assert.equal(Object.fromEntries(formBAfter.body.fields.map((entry) => [entry.field, entry])).model.value, 'model-from-a');

    // 只上报白名单字段：控制平面里这个命名空间只有 model 一行。
    assert.deepEqual(afterStale['agent-default-model'].map((row) => row.key), ['model']);
    assert.equal(JSON.stringify(afterStale).includes('apiKeyEnv'), false);

    // 较早接收时刻的推送不覆盖本地更新的记录。
    const olderPush = await fetch(`${stackB.origin}${SETTINGS_PUSH_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ namespace: 'agent-default-model', key: 'model', value: JSON.stringify('model-stale'), updatedAt: 1 }),
    });
    assert.equal(olderPush.status, 200);
    const olderBody = await olderPush.json();
    assert.equal(olderBody.revision, 1, '过期推送不推进版本');
    assert.equal((await clientB.latest('agent-default-model')).body.values.model, 'model-from-a');

    // 推送端点同样拒绝白名单之外的内容。
    const badPush = await fetch(`${stackB.origin}${SETTINGS_PUSH_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ namespace: 'bash-local', key: 'cwd', value: JSON.stringify('/etc'), updatedAt: Date.now() }),
    });
    assert.equal(badPush.status, 400);
    assert.equal((await badPush.json()).error, 'namespace-not-whitelisted');

    // 新设备继承白名单设置：读到控制平面上的值，写进自己的 home 层。
    const deviceC = await pairDevice(gateway.base, 'device-c', pairingCode);
    const homeC = join(home, 'device-c');
    mkdirSync(homeC, { recursive: true });
    const stackC = await openDevice({ home: homeC, deviceId: deviceC.deviceId, token: deviceC.token, controlUrl: gateway.base });
    devices.push(stackC);
    const clientC = clientOf(stackC.origin);
    const inherited = await clientC.latest('agent-default-model');
    assert.equal(inherited.status, 200);
    assert.equal(inherited.body.revision, 1);
    assert.equal(inherited.body.values.model, 'model-from-a');
    const fieldsC = Object.fromEntries((await clientC.readForm('agent-default-model')).body.fields.map((entry) => [entry.field, entry]));
    assert.equal(fieldsC.model.source, 'control-plane');
    const homeFileC = homeText(homeC);
    assert.ok(homeFileC.includes('model-from-a'), `新设备的 home 层收到继承值：${homeFileC}`);
    assert.ok(homeFileC.includes('@deepseek-ai/dsh-agent-default-model'), '补丁行带上游模块名');
    assert.equal(homeFileC.includes('apiKeyEnv'), false, '非白名单字段没有随继承写入');
    const syncC = await clientC.sync();
    assert.equal(syncC.status, 200);
    assert.equal(syncC.body.filtered.total, 0, '新设备的 home 层只有白名单字段');

    // 设备 A 的 home 层仍然保留自己的设备范围字段。
    const homeFileA = homeText(homeA);
    assert.ok(homeFileA.includes('/srv/work'), `设备范围字段保留：${homeFileA}`);
    assert.ok(homeFileA.includes('model: model-from-a'));

    // 重新读取最新版本后再次提交：使用最新版本成功写入，另一台设备收敛到新值。
    const refreshed = await clientB.latest('agent-default-model');
    assert.equal(refreshed.body.revision, 1);
    const resubmitted = await clientB.write('agent-default-model', refreshed.body.revision, { model: 'model-from-b' });
    assert.equal(resubmitted.status, 200, JSON.stringify(resubmitted.body));
    assert.equal(resubmitted.body.revision, 2);
    const afterResubmit = await snapshot(gateway.base);
    assert.equal(JSON.parse(afterResubmit['agent-default-model'][0].value), 'model-from-b');
    await waitFor(async () => {
      const form = await clientA.readForm('agent-default-model');
      const model = form.body?.fields?.find((entry) => entry.field === 'model');
      return form.body?.revision === 2 && model?.value === 'model-from-b'
        ? { ok: true }
        : { ok: false, detail: { revision: form.body?.revision, model: model?.value } };
    }, 20_000, '设备 A 收敛到最新值');
    const homeAfterResubmit = homeText(homeA);
    assert.ok(homeAfterResubmit.includes('model: model-from-b'));
    assert.ok(homeAfterResubmit.includes('/srv/work'), '设备范围字段不随同步变化');
  } finally {
    for (const device of devices) await device.ctx.fiber.dispose();
    if (gateway !== undefined) await gateway.stop();
    releaseIndependentHome(home);
  }
});

test('遥测：写入 span、拒绝与失败事件、计数指标', { timeout: 240_000 }, async () => {
  const home = allocateIndependentHome('wp29-settings-telemetry');
  const pairingCode = randomBytes(9).toString('base64url');
  const receiver = await startOtlpReceiver();
  const devices = [];
  const telemetryClients = [];
  let gateway;
  try {
    gateway = await startGateway(join(home, 'control-plane'), pairingCode);
    const deviceT = await pairDevice(gateway.base, 'device-telemetry', pairingCode);

    const telemetryOfDevice = createTelemetryClient({
      config: defaultTelemetryConfig({
        endpoint: receiver.endpoint,
        surface: 'runtime',
        exportIntervalMs: 1500,
        exportIntervalMsMetrics: 1500,
        exportTimeoutMs: 500,
      }),
      component: '@chatdsh/host-settings-sync',
      env: { CHATDSH_TELEMETRY: 'on' },
    });
    telemetryClients.push(telemetryOfDevice);
    const homeT = join(home, 'device-telemetry');
    mkdirSync(homeT, { recursive: true });
    const stackT = await openDevice({
      home: homeT,
      deviceId: deviceT.deviceId,
      token: deviceT.token,
      controlUrl: gateway.base,
      telemetry: telemetryOfDevice,
    });
    devices.push(stackT);
    const clientT = clientOf(stackT.origin);

    const written = await clientT.write('agent-default-model', 0, { model: 'telemetry-model' });
    assert.equal(written.status, 200, JSON.stringify(written.body));
    const conflicted = await clientT.write('agent-default-model', 0, { model: 'second-model' });
    assert.equal(conflicted.status, 409, JSON.stringify(conflicted.body));
    const rejectedField = await clientT.write('agent-default-model', 1, { apiKeyEnv: 'CHATDSH_KEY' });
    assert.equal(rejectedField.status, 400, JSON.stringify(rejectedField.body));
    const rejectedScope = await clientT.write('bash-local', 0, { cwd: '/etc' });
    assert.equal(rejectedScope.status, 400, JSON.stringify(rejectedScope.body));

    // 控制平面不可达的设备：上报失败产生失败事件与不可达计数。
    const telemetryOfHerem = createTelemetryClient({
      config: defaultTelemetryConfig({
        endpoint: receiver.endpoint,
        surface: 'runtime',
        exportIntervalMs: 1500,
        exportIntervalMsMetrics: 1500,
        exportTimeoutMs: 500,
      }),
      component: '@chatdsh/host-settings-sync',
      env: { CHATDSH_TELEMETRY: 'on' },
    });
    telemetryClients.push(telemetryOfHerem);
    const homeDead = join(home, 'device-dead');
    mkdirSync(homeDead, { recursive: true });
    const stackDead = await openDevice({
      home: homeDead,
      deviceId: 'device-dead',
      token: 'dead-token',
      controlUrl: 'http://127.0.0.1:1',
      telemetry: telemetryOfHerem,
    });
    devices.push(stackDead);
    const deadClient = clientOf(stackDead.origin);
    const unreachable = await deadClient.write('agent-default-model', 0, { model: 'unreachable-model' });
    assert.equal(unreachable.status, 502, JSON.stringify(unreachable.body));

    for (const client of telemetryClients) await client.flush(5000);
    const traces = receiver.records.filter((item) => item.path.includes('/v1/traces')).map((item) => item.body);
    const events = receiver.records.filter((item) => item.path.includes('/v1/logs')).map((item) => item.body);
    const metrics = receiver.records.filter((item) => item.path.includes('/v1/metrics')).map((item) => item.body);
    const traceText = traces.join('\n');
    const eventText = events.join('\n');
    const metricText = metrics.join('\n');
    const everything = receiver.records.map((item) => item.body).join('\n');

    assert.ok(traceText.includes('chatdsh.sync.settings.push') && traceText.includes('pushed'), '写入 span 记录成功上报');
    assert.ok(traceText.includes('chatdsh.sync.settings.push') && traceText.includes('pushed'), '写入 span 记录成功上报');
    assert.ok(traceText.includes('"namespace"') && traceText.includes('"agent-default-model"'), '写入 span 带命名空间');
    assert.ok(traceText.includes('"outcome"') && traceText.includes('"applied"'), '下发 span 带结局');
    assert.ok(traceText.includes('chatdsh.sync.settings.apply'), '下发 span 覆盖写 home 层');
    assert.ok(traceText.includes('chatdsh.sync.settings.push') && traceText.includes('unreachable'), '不可达的上报记入 span');
    assert.ok(eventText.includes('chatdsh.sync.settings.rejected') && eventText.includes('revision-conflict'), '版本冲突写出拒绝事件');
    assert.ok(eventText.includes('"error.code"'), '拒绝事件带 error.code 属性');
    assert.ok(eventText.includes('request-invalid'), '字段校验失败写出拒绝事件');
    assert.ok(eventText.includes('namespace-device-scope'), '作用范围拒绝写出拒绝事件');
    assert.ok(eventText.includes('chatdsh.sync.settings.failed') && eventText.includes('TypeError'), '不可达写出失败事件');
    assert.ok(eventText.includes('"error.type"'), '失败事件带 error.type 属性');
    assert.ok(metricText.includes('chatdsh_sync_settings_pushes_total'), '上报计数已导出');
    assert.ok(metricText.includes('chatdsh_sync_settings_applies_total'), '下发计数已导出');
    assert.ok(metricText.includes('conflict') && metricText.includes('unreachable'), '计数按结局分开');
    assert.equal(everything.includes('telemetry-model'), false, '遥测里没有设置取值');
    assert.equal(everything.includes('/etc'), false, '遥测里没有设备路径');
  } finally {
    for (const device of devices) await device.ctx.fiber.dispose();
    for (const client of telemetryClients) await client.shutdown();
    await receiver.close();
    if (gateway !== undefined) await gateway.stop();
    releaseIndependentHome(home);
  }
});
