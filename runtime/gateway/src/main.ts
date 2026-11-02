#!/usr/bin/env node
/**
 * 控制平面进程入口。
 *
 * 启动顺序：读配置、建遥测客户端、开存储、拉起运行时与后端运行期分支、开监听、启动备份调度。
 * 退出时先停备份调度与监听，再停设备长连接、后端运行期分支与运行时，有界刷新遥测并关库。
 * 遥测关闭时不构造任何管道，本进程不产生到 OpenObserve 的连接。
 * @module @chatdsh/gateway/main
 */

// 只取框架无关的子路径：主入口导出宿主平面插件类，那条路径会拉起 cordis 相关模块。
import { join } from 'node:path';
import { createTelemetryClient } from '@chatdsh/core-diagnostics/client';
import { defaultTelemetryConfig } from '@chatdsh/core-diagnostics/config';
import { ChatdshError } from '@chatdsh/core-contracts';
import { createGatewayServer } from './server.ts';
import { createPushHub } from './push.ts';
import { DeviceLinkHub } from './device-link.ts';
import { createRuntimeSupervisor, parseRuntimeLaunchConfig } from './runtime.ts';
import { createBackendRuntime } from './backends/index.ts';
import { createBackup, pruneBackups } from './backup/index.ts';
import { GatewayStore, PushQueue, ReceiptStore, ReplicaStore, SettingsStore, dataRoot, readConfig } from './store.ts';

/** 备份调度的缺省间隔：每天一套。 */
const DEFAULT_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** 备份主密钥的缺省文件名；与资源限制里的约定一致，由部署提供。 */
const BACKUP_KEY_FILE = 'backup-master.key';

/**
 * 解析备份调度的间隔。`0` 表示不调度；负数与非整数直接失败。
 * @param raw - 环境变量的取值。
 * @returns 间隔毫秒数。
 */
function parseBackupInterval(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_BACKUP_INTERVAL_MS;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0) throw new Error(`CHATDSH_BACKUP_INTERVAL_MS 必须是非负整数：${raw}`);
  return value;
}

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

// 执行体选择与托管：控制平面持有配置与诊断，回合执行与承载体插件由运行时承载。
const backends = createBackendRuntime({
  dataRoot: dataRoot(),
  env: process.env,
  telemetry,
  dsh: {
    async dispatch(request) {
      throw new ChatdshError('chat-backend-unreachable', '控制平面不执行回合', {
        'session.id': request.sessionId,
      });
    },
  },
  host: {
    async mount(row) {
      throw new Error(`控制平面不装载承载体插件：${row.id}`);
    },
  },
  onLog: (line) => console.log(`[backends] ${line}`),
});

const server = createGatewayServer({
  config,
  store,
  replica,
  receipts,
  settings,
  push,
  telemetry,
  deviceLink,
  runtime,
  bootstrapSecret,
});

/**
 * 起一次备份调度：到点生成一套备份，再按保留策略清理旧套。
 *
 * 同一时刻只跑一次；失败只记录并计数，不打断控制平面。间隔为 0 时不建立定时器。
 * @param intervalMs - 间隔毫秒数。
 * @returns 停止函数。
 */
function startBackupSchedule(intervalMs: number): { stop(): void } {
  if (intervalMs === 0) return { stop(): void {} };
  let running = false;
  let sequence = 0;
  const runOnce = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      sequence += 1;
      const created = await createBackup({
        sourceRoot: dataRoot(),
        backupRoot: join(config.backupRoot, `set-${new Date().toISOString().replace(/[:.]/gu, '-')}-${String(sequence)}`),
        software: { version: config.version },
        keyPath: join(dataRoot(), BACKUP_KEY_FILE),
        external: [],
        telemetry,
      });
      telemetry.log('info', 'scheduled backup completed', {
        objects: created.manifest.totals.objects,
        bytes: created.manifest.totals.cipherBytes,
      });
      await pruneBackups({ setsRoot: config.backupRoot, telemetry });
    } catch (error) {
      telemetry.log('error', 'scheduled backup failed', {
        'error.type': error instanceof Error ? error.name : 'Unknown',
        'error.code': typeof (error as { code?: unknown }).code === 'string' ? String((error as { code: string }).code) : 'backup-unexpected',
      });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void runOnce(), intervalMs);
  timer.unref();
  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}

const backupSchedule = startBackupSchedule(parseBackupInterval(process.env.CHATDSH_BACKUP_INTERVAL_MS));

await runtime.start();
await backends.start();
push.start();

await server.start();
telemetry.log('info', 'gateway listening', { 'http.route': 'healthz' });
console.log(`chatdsh-gateway ${server.url()} → ${runtime.url()}`);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  telemetry.log('info', 'gateway stopping', { reason: signal });
  backupSchedule.stop();
  push.stop();
  deviceLink.stop();
  await server.stop();
  await backends.stop();
  await runtime.stop();
  await telemetry.flush(3000);
  await telemetry.shutdown();
  store.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
