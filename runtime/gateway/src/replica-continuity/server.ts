/**
 * 连续副本服务的进程入口。
 *
 * 独立数据根、独立端口。启动顺序：读配置、建遥测客户端、开 SQLite、登记设备令牌、
 * 监听。退出时先停监听，再有界刷新遥测并关库。令牌只从环境变量读入，不打印。
 * @module @chatdsh/gateway/replica-continuity/server
 */

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createTelemetryClient } from '@chatdsh/core-diagnostics/client';
import { defaultTelemetryConfig } from '@chatdsh/core-diagnostics/config';
import { SqliteDatabase } from './sqlite.ts';
import { startReplicaServer } from './http.ts';
import { ReplicaContinuityStore } from './store.ts';

/** 进程配置。 */
export interface ReplicaProcessConfig {
  /** SQLite 文件路径。 */
  readonly databasePath: string;
  /** 监听地址。 */
  readonly host: string;
  /** 监听端口。 */
  readonly port: number;
  /** 需要登记的设备与令牌。 */
  readonly devices: readonly { readonly deviceId: string; readonly token: string }[];
}

/** 从环境变量读配置。 */
export function readReplicaConfig(env: NodeJS.ProcessEnv = process.env): ReplicaProcessConfig {
  const home = env.DSH_HOME ?? join(homedir(), '.dsh');
  const databasePath = env.CHATDSH_REPLICA_DB ?? join(home, 'replica', 'replica.sqlite');
  const port = Number.parseInt(env.CHATDSH_REPLICA_PORT ?? '3189', 10);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error(`CHATDSH_REPLICA_PORT 不合法：${env.CHATDSH_REPLICA_PORT ?? ''}`);
  }
  const devices: { deviceId: string; token: string }[] = [];
  for (const entry of (env.CHATDSH_REPLICA_DEVICES ?? '').split(',')) {
    if (entry === '') continue;
    const separator = entry.indexOf(':');
    if (separator <= 0) throw new Error('CHATDSH_REPLICA_DEVICES 的格式应为 deviceId:token');
    devices.push({ deviceId: entry.slice(0, separator), token: entry.slice(separator + 1) });
  }
  return {
    databasePath,
    host: env.CHATDSH_REPLICA_HOST ?? '127.0.0.1',
    port,
    devices,
  };
}

const config = readReplicaConfig();
mkdirSync(dirname(config.databasePath), { recursive: true });

const telemetry = createTelemetryClient({
  config: defaultTelemetryConfig({ surface: 'gateway' }),
  component: '@chatdsh/gateway',
});

const database = new SqliteDatabase(config.databasePath);
const store = new ReplicaContinuityStore(database);
for (const device of config.devices) store.registerToken(device.deviceId, device.token);

const server = await startReplicaServer({
  store,
  telemetry,
  host: config.host,
  port: config.port,
});
console.log(`chatdsh-replica ${server.url} ${config.databasePath}`);

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await server.close();
  await telemetry.flush(2000);
  await telemetry.shutdown();
  database.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
