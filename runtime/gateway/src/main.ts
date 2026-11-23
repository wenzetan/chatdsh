#!/usr/bin/env node
/**
 * 轻量中继服务端进程入口。
 *
 * 启动顺序：读取配置、初始化遥测客户端、打开 SQLite、启动推送与监听。
 * 退出时先停止推送与监听，断开设备长连接，有界刷新遥测并关闭数据库。
 * @module @chatdsh/gateway/main
 */

import { createTelemetryClient } from '@chatdsh/core-diagnostics/client';
import { defaultTelemetryConfig } from '@chatdsh/core-diagnostics/config';
import { createGatewayServer } from './server.ts';
import { createPushHub } from './push.ts';
import { DeviceLinkHub } from './device-link.ts';
import { GatewayStore, PushQueue, ReceiptStore, ReplicaStore, SettingsStore, readConfig } from './store.ts';

const config = readConfig();

const telemetry = createTelemetryClient({
  config: defaultTelemetryConfig({
    surface: 'gateway',
    version: config.version,
    environment: config.environment,
  }),
  component: '@chatdsh/gateway',
});

const store = new GatewayStore(config.databasePath);
const replica = new ReplicaStore(store.handle());
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
  receipts,
  settings,
  push,
  telemetry,
  deviceLink,
  telemetryRelay: (signal, body) => telemetry.relay(signal, body),
});

push.start();
await server.start();
telemetry.log('info', 'gateway listening', { 'http.route': 'healthz' });
console.log(`chatdsh-gateway ${server.url()}`);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  telemetry.log('info', 'gateway stopping', { reason: signal });
  push.stop();
  deviceLink.stop();
  await server.stop();
  await telemetry.flush(3000);
  await telemetry.shutdown();
  store.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
