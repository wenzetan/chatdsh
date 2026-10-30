#!/usr/bin/env node
/**
 * 控制平面进程入口。
 *
 * 启动顺序：读配置、建遥测客户端、开存储、拉起运行时、监听。退出时先停监听，
 * 再停运行时、有界刷新遥测并关库。遥测关闭时不构造任何管道，本进程不产生到
 * OpenObserve 的连接。
 * @module @chatdsh/gateway/main
 */

// 只取框架无关的子路径：主入口导出宿主平面插件类，那条路径会拉起 cordis 相关模块。
import { createTelemetryClient } from '@chatdsh/core-diagnostics/client';
import { defaultTelemetryConfig } from '@chatdsh/core-diagnostics/config';
import { createGatewayServer } from './server.ts';
import { createPushHub } from './push.ts';
import { DeviceLinkHub } from './device-link.ts';
import { createRuntimeSupervisor, parseRuntimeLaunchConfig } from './runtime.ts';
import { GatewayStore, PushQueue, ReceiptStore, ReplicaStore, SettingsStore, ShareStore, dataRoot, readConfig } from './store.ts';

const config = readConfig();

const telemetry = createTelemetryClient({
  config: defaultTelemetryConfig({
    surface: 'gateway',
    version: config.version,
    environment: config.environment,
  }),
  component: '@chatdsh/gateway',
});

const runtime = createRuntimeSupervisor({
  config: parseRuntimeLaunchConfig(process.env, dataRoot()),
  externalUrl: config.runtimeUrl,
  telemetry,
  onLog: (line) => console.log(`[runtime] ${line}`),
});
const bootstrapSecret = process.env.CHATDSH_BOOTSTRAP_SECRET;

const store = new GatewayStore(config.databasePath);
const replica = new ReplicaStore(store.handle());
const share = new ShareStore(store.handle());
const receipts = new ReceiptStore(store.handle());
const settings = new SettingsStore(store.handle());
const push = createPushHub({
  queue: new PushQueue(store.handle()),
  devices: store,
  mode: config.pushMode,
  escalationMs: config.pushEscalationMs,
  telemetry: { counter: (name, options) => telemetry.counter(name, options) },
});
const deviceLink = new DeviceLinkHub({ store, telemetry });
const server = createGatewayServer({
  config,
  store,
  replica,
  share,
  receipts,
  settings,
  push,
  telemetry,
  deviceLink,
  runtime,
  bootstrapSecret,
});

await runtime.start();
push.start();

await server.start();
telemetry.log('info', 'gateway listening', { 'http.route': 'healthz' });
console.log(`chatdsh-gateway ${server.url()} → ${runtime.url()}`);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  telemetry.log('info', 'gateway stopping', { reason: signal });
  push.stop();
  deviceLink.stop();
  await server.stop();
  await runtime.stop();
  await telemetry.flush(3000);
  await telemetry.shutdown();
  store.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
