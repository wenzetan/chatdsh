// SYS06 的可选托管与能力装卸验收。
//
// 真实子进程：托管入口是 `node -e` 起的真实 HTTP 服务，检查单实例、就绪、退出检测、回收与
// 再次启动。外部地址模式用另一个真实服务验证：`stop` 之后它仍在应答，控制平面从未持有它的
// 进程。能力装卸用真实监听端口的插件宿主：关闭能力后对应端口不再可连，插件配置里的凭据
// 只有环境变量名。
//
// 运行：node --test e2e/unit/client-complete-sys06-hosting.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { tempHome } from '../../scripts/lib/cleanup.mjs';
import {
  alive,
  childServerScript,
  flattenLogs,
  flattenTraces,
  startCollector,
  startHermesServer,
  statusOf,
  telemetryClientFor,
} from './client-complete-sys06-support.mjs';

const { findFreePort } = await import('../../gateway/lib/runtime.js');
const { createHermesSupervisor, readHermesDependencyConfig, HERMES_ENV } = await import('../../gateway/lib/backends/supervisor.js');
const { BackendRuntime } = await import('../../gateway/lib/backends/index.js');
const { historyDigestOf } = await import('../../../hermes-adapter/lib/index.js');

/** 插件宿主：每条行占用一个真实监听端口，卸载时关闭。 */
function createSocketHost() {
  const rows = new Map();
  return {
    async mount(row) {
      const server = createServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ plugin: row.id }));
      });
      await new Promise((done, fail) => {
        server.once('error', fail);
        server.listen(0, '127.0.0.1', done);
      });
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      rows.set(row.id, { row, port, server });
      return {
        dispose: () => new Promise((done) => {
          rows.delete(row.id);
          server.closeAllConnections();
          server.close(done);
        }),
      };
    },
    rowOf: (id) => rows.get(id)?.row,
    portOf: (id) => rows.get(id)?.port,
    ids: () => [...rows.keys()].sort(),
  };
}

/** 托管配置。 */
function managedEnv(home, port) {
  return {
    [HERMES_ENV.bin]: process.execPath,
    [HERMES_ENV.args]: JSON.stringify(['-e', childServerScript(port)]),
    [HERMES_ENV.port]: String(port),
    [HERMES_ENV.home]: join(home, 'hermes'),
    [HERMES_ENV.readyTimeoutMs]: '15000',
    [HERMES_ENV.probeTimeoutMs]: '200',
  };
}

test('托管单实例、就绪、退出检测与回收', async () => {
  const collector = await startCollector();
  const telemetry = telemetryClientFor(collector, '@chatdsh/gateway');
  const home = tempHome('sys06-hosting');
  const port = await findFreePort(21000, 200);
  const config = readHermesDependencyConfig(managedEnv(home, port));
  assert.equal(config.mode, 'managed');
  const supervisor = createHermesSupervisor({ config, telemetry });
  try {
    // 并发启动只产生一个子进程。
    const readiness = await Promise.all([supervisor.ensureReady(), supervisor.ensureReady(), supervisor.ensureReady()]);
    assert.ok(readiness.every((item) => item.ready));
    const pid = supervisor.state().pid;
    assert.equal(typeof pid, 'number');
    assert.equal(alive(pid), true);
    assert.equal(await statusOf(`${config.url}/v1/capabilities`), 200);

    // 已经就绪时再次调用不会另起进程。
    await supervisor.ensureReady();
    assert.equal(supervisor.state().pid, pid);

    // 子进程退出：标记不可用、记录退出并回收句柄。
    process.kill(pid, 'SIGTERM');
    const deadline = Date.now() + 5000;
    while (supervisor.state().pid !== undefined && Date.now() < deadline) await delay(50);
    const exited = supervisor.state();
    assert.equal(exited.pid, undefined);
    assert.equal(exited.ready, false);
    assert.equal(alive(pid), false);
    assert.equal(typeof exited.lastExit.at, 'number');
    assert.ok(exited.lastExit.code === 0 || exited.lastExit.signal === 'SIGTERM');

    // 退出之后可以再次启动，仍然只有一个实例。
    const restarted = await supervisor.ensureReady();
    assert.equal(restarted.ready, true);
    const secondPid = supervisor.state().pid;
    assert.equal(typeof secondPid, 'number');
    assert.notEqual(secondPid, pid);
    assert.equal(alive(secondPid), true);

    // 回收：停止之后端口关闭、进程退出，重复调用不报错。
    await supervisor.stop();
    assert.equal(supervisor.state().pid, undefined);
    assert.equal(alive(secondPid), false);
    assert.equal(await statusOf(`${config.url}/v1/capabilities`), 0);
    await supervisor.stop();

    await telemetry.flush(2000);
    const traces = flattenTraces(collector.records().traces);
    const logs = flattenLogs(collector.records().logs);
    assert.ok(
      traces.some((span) => span.name === 'chatdsh.gateway.runtime.lifecycle' && span.attributes.action === 'start' && span.attributes.outcome === 'ready'),
      '托管启动 span',
    );
    assert.ok(
      traces.some((span) => span.name === 'chatdsh.gateway.runtime.lifecycle' && span.attributes.action === 'stop'),
      '托管停止 span',
    );
    assert.ok(logs.some((log) => log.name === 'chatdsh.gateway.runtime.ready'), '就绪事件');
    assert.ok(logs.some((log) => log.name === 'chatdsh.gateway.runtime.exited'), '意外退出事件');
  } finally {
    await telemetry.shutdown();
    await collector.close();
  }
});

test('外部地址模式不启停外部进程', async () => {
  const collector = await startCollector();
  const telemetry = telemetryClientFor(collector, '@chatdsh/gateway');
  const external = await startHermesServer();
  const config = readHermesDependencyConfig({ [HERMES_ENV.externalUrl]: external.url });
  assert.equal(config.mode, 'external');
  assert.equal(config.bin, undefined);
  const supervisor = createHermesSupervisor({ config, telemetry });
  try {
    const readiness = await supervisor.ensureReady();
    assert.equal(readiness.ready, true);
    assert.equal(readiness.reason, 'external');
    assert.equal(supervisor.state().pid, undefined);
    assert.equal(supervisor.state().mode, 'external');
    const before = external.requests.length;
    await supervisor.stop();
    assert.equal(supervisor.state().pid, undefined);
    assert.equal(await statusOf(`${external.url}/v1/capabilities`), 200, '外部进程没有被停止');
    assert.ok(external.requests.length > before, '外部服务仍然在应答');

    assert.throws(
      () => readHermesDependencyConfig({
        [HERMES_ENV.externalUrl]: external.url,
        [HERMES_ENV.bin]: process.execPath,
      }),
      /只能给一个/,
    );

    await telemetry.flush(2000);
    const traces = flattenTraces(collector.records().traces);
    assert.ok(
      traces.some((span) => span.name === 'chatdsh.gateway.runtime.lifecycle' && span.attributes.action === 'stop' && span.attributes.outcome === 'external-skipped'),
      '外部模式停止为跳过',
    );
  } finally {
    await telemetry.shutdown();
    await external.close();
    await collector.close();
  }
});

test('能力开关独立，关闭时卸载插件并释放资源', async () => {
  const collector = await startCollector();
  const telemetry = telemetryClientFor(collector, '@chatdsh/gateway');
  const home = tempHome('sys06-capabilities');
  const port = await findFreePort(22000, 200);
  const host = createSocketHost();
  process.env.SYS06_HERMES_KEY = 'sys06-secret-value';
  const env = {
    ...managedEnv(home, port),
    [HERMES_ENV.apiKeyEnv]: 'SYS06_HERMES_KEY',
    CHATDSH_HINDSIGHT_URL: 'http://127.0.0.1:18889',
  };
  const runtime = new BackendRuntime({
    dataRoot: home,
    env,
    telemetry,
    host,
    dsh: {
      async dispatch() {
        return { accepted: true };
      },
    },
  });
  const hermesUrl = `http://127.0.0.1:${port}`;
  try {
    // 默认形态：聊天由 DSH 承载、记忆不启用，没有插件也没有托管进程。
    await runtime.start();
    assert.deepEqual(host.ids(), []);
    assert.equal(runtime.diagnostics().hermes.pid, undefined);
    assert.equal(runtime.diagnostics().hermes.configured, true);
    assert.equal(runtime.diagnostics().hermes.ready, false);

    // 诊断显示最近一次发送的实际判断。
    const judged = await runtime.send({ sessionId: 'diag', turn: 1, text: '诊断用的一轮' });
    assert.equal(judged.outcome, 'dsh');
    assert.equal(runtime.diagnostics().lastSend.sessionId, 'diag');
    assert.equal(runtime.diagnostics().lastSend.executionSource, 'dsh');
    assert.equal(runtime.diagnostics().lastSend.revision, runtime.settings().revision);

    // 打开 Hermes 聊天与 Hindsight 记忆：两个插件各自占一个真实端口，托管进程就绪。
    await runtime.save({ revision: 0, chatBackend: 'hermes', memoryBackend: 'hindsight' });
    assert.deepEqual(host.ids(), ['chatdsh-chat-hermes', 'chatdsh-memory']);
    const chatRow = host.rowOf('chatdsh-chat-hermes');
    assert.equal(chatRow.module, '@chatdsh/host-chat-hermes');
    assert.equal(chatRow.config.baseUrl, hermesUrl);
    assert.equal(chatRow.config.apiKeyEnv, 'SYS06_HERMES_KEY');
    assert.equal(JSON.stringify(chatRow).includes('sys06-secret-value'), false, '配置里只有变量名');
    const memoryRow = host.rowOf('chatdsh-memory');
    assert.equal(memoryRow.config.hindsightUrl, 'http://127.0.0.1:18889');
    assert.equal(memoryRow.config.apiKeyEnv, 'HINDSIGHT_API_KEY');
    assert.equal(await statusOf(`http://127.0.0.1:${host.portOf('chatdsh-chat-hermes')}/`), 200);
    assert.equal(await statusOf(`http://127.0.0.1:${host.portOf('chatdsh-memory')}/`), 200);
    const managedPid = runtime.diagnostics().hermes.pid;
    assert.equal(typeof managedPid, 'number');
    assert.equal(alive(managedPid), true);
    assert.equal(await statusOf(`${hermesUrl}/v1/capabilities`), 200);
    const chatPort = host.portOf('chatdsh-chat-hermes');

    // 关闭聊天能力：卸载聊天插件并回收托管进程，记忆插件保持不动。
    await runtime.save({ revision: 1, chatBackend: 'dsh', memoryBackend: 'hindsight' });
    assert.deepEqual(host.ids(), ['chatdsh-memory']);
    assert.equal(await statusOf(`http://127.0.0.1:${chatPort}/`), 0, '聊天插件资源已释放');
    assert.equal(alive(managedPid), false, '托管进程被回收');
    assert.equal(await statusOf(`${hermesUrl}/v1/capabilities`), 0);
    assert.equal(runtime.diagnostics().hermes.pid, undefined);

    // 关闭记忆能力：卸载记忆插件，端口不可再连。
    const memoryPort = host.portOf('chatdsh-memory');
    await runtime.save({ revision: 2, chatBackend: 'dsh', memoryBackend: 'none' });
    assert.deepEqual(host.ids(), []);
    assert.equal(await statusOf(`http://127.0.0.1:${memoryPort}/`), 0, '记忆插件资源已释放');

    // 非法组合拒绝保存，装配保持不变。
    await assert.rejects(
      runtime.save({ revision: 3, chatBackend: 'dsh', memoryBackend: 'hermes' }),
      (error) => error.code === 'invalid-combination',
    );
    assert.deepEqual(host.ids(), []);
    assert.equal(runtime.settings().revision, 3);

    // Hermes 内置记忆依附 Hermes 聊天：只装聊天插件，不装记忆插件。
    await runtime.save({ revision: 3, chatBackend: 'hermes', memoryBackend: 'hermes' });
    assert.deepEqual(host.ids(), ['chatdsh-chat-hermes']);
    assert.equal(runtime.diagnostics().selection.memoryBackend, 'hermes');
    assert.equal(typeof runtime.diagnostics().hermes.pid, 'number');

    // 关闭全部能力。
    const lastPid = runtime.diagnostics().hermes.pid;
    await runtime.stop();
    assert.deepEqual(host.ids(), []);
    assert.equal(alive(lastPid), false);

    await telemetry.flush(2000);
    const traces = flattenTraces(collector.records().traces);
    const mounts = traces.filter((span) => span.name === 'chatdsh.runtime.plugin.activate');
    assert.ok(mounts.some((span) => span.attributes['plugin.name'] === 'chatdsh-chat-hermes' && span.attributes.outcome === 'mounted'));
    assert.ok(mounts.some((span) => span.attributes['plugin.name'] === 'chatdsh-chat-hermes' && span.attributes.outcome === 'unmounted'));
    assert.ok(mounts.some((span) => span.attributes['plugin.name'] === 'chatdsh-memory' && span.attributes.outcome === 'unmounted'));
    assert.ok(
      traces.some((span) => span.name === 'chatdsh.gateway.runtime.lifecycle' && span.attributes.action === 'start'),
      '托管启动 span',
    );
  } finally {
    delete process.env.SYS06_HERMES_KEY;
    await telemetry.shutdown();
    await collector.close();
  }
});

test('托管进程提前退出时标记不可用，发送按不可达降级', async () => {
  const collector = await startCollector();
  const telemetry = telemetryClientFor(collector, '@chatdsh/gateway');
  const home = tempHome('sys06-hosting-exit');
  const port = await findFreePort(23000, 200);
  const host = createSocketHost();
  const dshCalls = [];
  const env = {
    [HERMES_ENV.bin]: process.execPath,
    [HERMES_ENV.args]: JSON.stringify(['-e', 'process.exit(1)']),
    [HERMES_ENV.port]: String(port),
    [HERMES_ENV.readyTimeoutMs]: '5000',
    [HERMES_ENV.probeTimeoutMs]: '200',
  };
  const runtime = new BackendRuntime({
    dataRoot: home,
    env,
    telemetry,
    host,
    dsh: {
      async dispatch(request) {
        dshCalls.push(request);
        return { accepted: true };
      },
    },
  });
  try {
    await runtime.start();
    await runtime.save({ revision: 0, chatBackend: 'hermes', memoryBackend: 'none' });
    const state = runtime.diagnostics().hermes;
    assert.equal(state.ready, false);
    assert.equal(state.pid, undefined);
    assert.equal(state.lastExit.code, 1);
    assert.deepEqual(host.ids(), ['chatdsh-chat-hermes'], '插件按配置挂载，进程不可用不影响装配');

    const system = '你是 ChatDSH 的聊天助手。';
    const messages = [{ role: 'user', text: '托管进程不在一轮' }];
    const judgment = await runtime.send({
      sessionId: 'exit-1',
      turn: 1,
      text: '托管进程不在一轮',
      history: { operationId: 'op-exit-1', messages, system, historyDigest: historyDigestOf(system, messages) },
    });
    assert.equal(judgment.outcome, 'degraded-dsh');
    assert.equal(judgment.executionSource, 'dsh-fallback');
    assert.equal(judgment.reason, 'exited');
    assert.equal(judgment.memoryEnabled, false);
    assert.equal(judgment.historyBridgeRequired, true);
    assert.equal(dshCalls.at(-1).historyBridgeRequired, true);
    assert.equal(runtime.historyModeOf('exit-1'), 'full');
    assert.equal(runtime.diagnostics().lastSend.outcome, 'degraded-dsh');
  } finally {
    await runtime.stop();
    await telemetry.shutdown();
    await collector.close();
  }
});
