// WP32 安全 IPC 与预加载暴露面。
//
// 直接驱动 ipc.mjs 的白名单分发器：未登记通道、来源不符、非主框架、参数缺失或类型错误
// 全部拒绝；拒绝与成功都写遥测。预加载脚本用真实源码在 V8 上下文里执行，Electron 平台
// 接口换成最小实现，核对暴露面恰好等于登记通道、页面看不到 Node 与 ipcRenderer。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { setTelemetryOrigin } from '../../desktop/electron/telemetry.mjs';
import {
  ALLOWED_CHANNELS, CALL_CHANNELS, CHANNEL_INDEX, EVENT_CHANNELS, IpcRejection, assertSenderUrl, createIpcRouter,
} from '../../desktop/electron/ipc.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PRELOAD = join(HERE, '..', '..', 'desktop', 'electron', 'preload.cjs');
const ORIGIN = 'http://127.0.0.1:3170';
const TRUSTED = { id: 1 };

/** 造一个 Electron IPC 事件对象。 */
function makeEvent(url, sender = TRUSTED) {
  const frame = { url };
  return { senderFrame: frame, senderMainFrame: frame, sender };
}

/** 创建分发器：所有通道的处理函数都记录调用。 */
function makeRouter(calls, options = {}) {
  const handlers = {};
  for (const entry of CALL_CHANNELS) {
    handlers[entry.channel] = (...args) => {
      calls.push({ channel: entry.channel, args });
      return { channel: entry.channel, args };
    };
  }
  const allowedOrigins = new Set([ORIGIN]);
  const allowedFiles = new Set(['file:///app/recovery.html']);
  return createIpcRouter({
    handlers,
    allowedOrigins,
    allowedFiles,
    isTrustedSender: (event) => (options.ignoreSender === true ? true : event.sender === TRUSTED),
  });
}

/** 起一个遥测接收端。 */
async function startReceiver() {
  const received = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      received.push({ signal: request.headers['x-chatdsh-signal'], body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"accepted":true}');
    });
  });
  await new Promise((settle) => server.listen(0, '127.0.0.1', settle));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    received,
    async until(testFn, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (testFn()) return true;
        await new Promise((settle) => setTimeout(settle, 50));
      }
      return false;
    },
    async close() {
      await new Promise((settle) => server.close(settle));
    },
  };
}

/** 在 V8 上下文里执行真实预加载源码。 */
function loadPreload() {
  const exposure = {};
  const invoked = [];
  const listeners = [];
  const electron = {
    contextBridge: {
      exposeInMainWorld(name, value) {
        exposure[name] = value;
      },
    },
    ipcRenderer: {
      async invoke(channel, ...args) {
        invoked.push({ channel, args, kind: 'invoke' });
        return { channel, args };
      },
      send(channel, ...args) {
        invoked.push({ channel, args, kind: 'send' });
      },
      on(channel, listener) {
        listeners.push({ channel, listener });
      },
      removeListener(channel) {
        listeners.push({ channel, listener: 'removed' });
      },
    },
  };
  const script = readFileSync(PRELOAD, 'utf8');
  const context = createContext({
    require: (id) => {
      if (id === 'electron') return electron;
      throw new Error(`预加载不允许加载 ${id}`);
    },
    module: { exports: {} },
    exports: {},
    process: { platform: 'win32' },
    console,
    TypeError,
  });
  runInContext(script, context, { filename: PRELOAD });
  return { exposure, invoked, listeners };
}

test('未登记的通道被拒绝', async () => {
  const router = makeRouter([]);
  await assert.rejects(
    () => router.invoke('chatdsh:shell:exec', makeEvent(`${ORIGIN}/chatdsh/boot/x`), 'rm'),
    (error) => error instanceof IpcRejection && error.code === 'channel-not-allowed',
  );
});

test('来源不符、非主框架、非受信窗口都被拒绝', async () => {
  const router = makeRouter([]);
  const foreign = `${'http://127.0.0.1:9'}/page`;
  await assert.rejects(
    () => router.invoke('chatdsh:status:get', makeEvent(foreign)),
    (error) => error.code === 'sender-not-allowed',
  );
  await assert.rejects(
    () => router.invoke('chatdsh:status:get', makeEvent('about:blank')),
    (error) => error.code === 'sender-scheme',
  );
  const otherSender = makeEvent(`${ORIGIN}/chatdsh/boot/x`, { id: 2 });
  await assert.rejects(
    () => router.invoke('chatdsh:status:get', otherSender),
    (error) => error.code === 'sender-not-trusted',
  );
  const frame = { url: `${ORIGIN}/chatdsh/boot/x` };
  await assert.rejects(
    () => router.invoke('chatdsh:status:get', { sender: TRUSTED, senderFrame: frame, senderMainFrame: { url: `${ORIGIN}/` } }),
    (error) => error.code === 'sender-frame-not-main',
  );
});

test('本地页面只能调用标记过的通道，且地址必须在集合里', async () => {
  const router = makeRouter([]);
  await assert.rejects(
    () => router.invoke('chatdsh:status:get', makeEvent('file:///app/recovery.html')),
    (error) => error.code === 'sender-not-allowed',
  );
  await assert.rejects(
    () => router.invoke('chatdsh:startup:failure', makeEvent('file:///other/evil.html')),
    (error) => error.code === 'sender-not-allowed',
  );
  const result = await router.invoke('chatdsh:startup:failure', makeEvent('file:///app/recovery.html'));
  assert.equal(result.channel, 'chatdsh:startup:failure');
});

test('参数按通道校验：数量、缺失、类型、越界与多余字段', async () => {
  const router = makeRouter([]);
  const event = makeEvent(`${ORIGIN}/chatdsh/boot/x`);
  await assert.rejects(() => router.invoke('chatdsh:keepalive:set', event), (error) => error.code === 'arguments-count');
  await assert.rejects(() => router.invoke('chatdsh:keepalive:set', event, 'yes'), (error) => error.code === 'argument-type');
  await assert.rejects(() => router.invoke('chatdsh:native:open-external', event, { url: 'https://example.com/', extra: 1 }), (error) => error.code === 'argument-key');
  await assert.rejects(() => router.invoke('chatdsh:native:open-external', event, {}), (error) => error.code === 'argument-missing');
  await assert.rejects(() => router.invoke('chatdsh:notification:show', event, { kind: 'unknown', title: 't', body: 'b', route: '/approvals' }), (error) => error.code === 'argument-choice');
  await assert.rejects(
    () => router.invoke('chatdsh:activity:report', makeEvent(`${ORIGIN}/chatdsh/boot/x`), { runningTurns: -1, pendingApprovals: 0, drafts: 0 }),
    (error) => error.code === 'argument-range',
  );
  const ok = await router.invoke('chatdsh:power:set', event, { enabled: true, mode: 'prevent-app-suspension' });
  assert.deepEqual(ok.args, [{ enabled: true, mode: 'prevent-app-suspension' }]);
});

test('发送类通道被拒绝时不抛异常，只记录结果', async () => {
  const router = makeRouter([]);
  const outcome = await router.send('chatdsh:window:minimize', makeEvent('file:///app/recovery.html'));
  assert.deepEqual(outcome, { ok: false, code: 'sender-not-allowed' });
  const accepted = await router.send('chatdsh:window:minimize', makeEvent(`${ORIGIN}/chatdsh/boot/x`));
  assert.equal(accepted.channel, 'chatdsh:window:minimize');
});

test('来源地址核对单独可用', () => {
  assert.equal(assertSenderUrl(`${ORIGIN}/chatdsh/boot/x`, new Set([ORIGIN])).origin, ORIGIN);
  assert.throws(() => assertSenderUrl('javascript:alert(1)', new Set([ORIGIN])), /不允许的来源协议/u);
  assert.throws(() => assertSenderUrl('not a url', new Set([ORIGIN])), /无法解析/u);
  assert.throws(
    () => assertSenderUrl('file:///app/other.html', new Set([ORIGIN]), new Set(['file:///app/recovery.html']), { fileSenders: true }),
    /不在允许集合/u,
  );
  assert.throws(
    () => assertSenderUrl('file:///app/recovery.html', new Set([ORIGIN]), new Set(['file:///app/recovery.html'])),
    /本地页面不能调用/u,
  );
});

test('通道表里没有重复名称，事件通道独立登记', () => {
  assert.equal(new Set(ALLOWED_CHANNELS).size, ALLOWED_CHANNELS.length);
  assert.equal(CHANNEL_INDEX.size, CALL_CHANNELS.length);
  for (const channel of EVENT_CHANNELS) assert.equal(ALLOWED_CHANNELS.includes(channel), false);
});

test('预加载只暴露白名单方法，页面看不到 Node 与 ipcRenderer', async () => {
  const { exposure, invoked, listeners } = loadPreload();
  assert.deepEqual(Object.keys(exposure), ['chatdshDesktop']);
  const api = exposure.chatdshDesktop;
  assert.deepEqual(Object.keys(api).sort(), ['activity', 'keepAlive', 'login', 'logs', 'native', 'notifications', 'onMenuAction', 'platform', 'power', 'startup', 'status', 'updates', 'window']);
  assert.equal(api.require, undefined);
  assert.equal(api.ipcRenderer, undefined);
  assert.equal(api.send, undefined);
  assert.equal(api.invoke, undefined);
  assert.equal(Object.isFrozen(api.status), true);

  await api.status.get();
  api.status.on(() => {});
  await api.keepAlive.get();
  await api.keepAlive.set(true);
  await api.window.state();
  api.window.minimize();
  api.window.toggleMaximize();
  api.window.close();
  await api.native.chooseDirectory('workspace');
  await api.native.openExternal('https://example.com/');
  await api.native.openPath('/data/logs/desktop.log');
  await api.native.writeClipboard('复制的文本');
  await api.notifications.show({ kind: 'approval', title: '有审批', body: '等待处理', route: '/approvals' });
  api.notifications.onClick(() => {});
  await api.updates.state();
  await api.updates.check('stable');
  await api.updates.download();
  await api.updates.install(true);
  await api.updates.cancel();
  api.updates.onState(() => {});
  await api.power.state();
  await api.power.set(true, 'prevent-display-sleep');
  await api.login.state();
  await api.login.set(true);
  await api.startup.failure();
  await api.startup.retry();
  await api.startup.safeMode('startup-recovery', ['client-kanban']);
  await api.startup.diagnostics();
  await api.logs.open();
  await api.logs.openDir();
  api.activity.report({ runningTurns: 2, pendingApprovals: 1, drafts: 0 });
  api.onMenuAction(() => {});

  const called = new Set(invoked.map((item) => item.channel));
  assert.deepEqual([...called].sort(), [...ALLOWED_CHANNELS].sort());
  const subscribed = new Set(listeners.filter((item) => item.listener !== 'removed').map((item) => item.channel));
  assert.deepEqual([...subscribed].sort(), [...EVENT_CHANNELS].sort());

  const notification = invoked.find((item) => item.channel === 'chatdsh:notification:show');
  assert.deepEqual(Object.keys(notification.args[0]).sort(), ['body', 'kind', 'route', 'title']);
  const power = invoked.find((item) => item.channel === 'chatdsh:power:set');
  assert.deepEqual({ ...power.args[0] }, { enabled: true, mode: 'prevent-display-sleep' });
  const activity = invoked.find((item) => item.channel === 'chatdsh:activity:report');
  assert.equal(activity.args[0].runningTurns, 2);
  const install = invoked.find((item) => item.channel === 'chatdsh:update:install');
  assert.deepEqual({ ...install.args[0] }, { confirmed: true });
});

test('成功与拒绝都写遥测：span、拒绝事件与计数', async () => {
  const receiver = await startReceiver();
  /** 取出本通道的拒绝事件属性。 */
  const rejectionOf = () => receiver.received
    .filter((item) => item.signal === 'logs')
    .map((item) => ({
      name: item.body.resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue,
      attributes: Object.fromEntries(
        item.body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.map((attribute) => [attribute.key, attribute.value.stringValue]),
      ),
    }))
    .find((item) => item.name === 'chatdsh.desktop.ipc.rejected' && item.attributes.channel === 'chatdsh:login:set');
  /** 取出本通道的计数。 */
  const rejectionMetric = () => receiver.received
    .filter((item) => item.signal === 'metrics')
    .map((item) => ({
      name: item.body.resourceMetrics[0].scopeMetrics[0].metrics[0].name,
      attributes: Object.fromEntries(
        item.body.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].attributes.map((attribute) => [attribute.key, attribute.value.stringValue]),
      ),
    }))
    .find((item) => item.name === 'chatdsh_desktop_ipc_rejections_total' && item.attributes.channel === 'chatdsh:login:set');
  try {
    setTelemetryOrigin(receiver.origin);
    const router = makeRouter([]);
    const event = makeEvent(`${ORIGIN}/chatdsh/boot/x`);
    await router.invoke('chatdsh:status:get', event);
    await assert.rejects(() => router.invoke('chatdsh:login:set', event, { enabled: 'yes' }), (error) => error.code === 'argument-type');

    assert.equal(await receiver.until(() => receiver.received
      .filter((item) => item.signal === 'traces')
      .some((item) => item.body.resourceSpans[0].scopeSpans[0].spans[0].name === 'chatdsh.desktop.ipc.invoke')), true, '成功调用应当写 span');
    assert.equal(await receiver.until(() => rejectionOf() !== undefined), true, '拒绝应当写事件');
    assert.equal(rejectionOf().attributes['error.code'], 'argument-type');
    assert.equal(await receiver.until(() => rejectionMetric() !== undefined), true, '拒绝应当写计数');
    assert.equal(rejectionMetric().attributes.reason, 'argument-type');
  } finally {
    await receiver.close();
  }
});
