/**
 * 资源限制服务的冷启动、常驻与负载探针。
 *
 * 由容量报告与资源回收测试以真实子进程启动。三种模式都只输出一行 JSON：
 * `start` 打开真实 SQLite、启动服务、请求一次探活后输出总耗时并退出；
 * `load` 在服务上保持若干条事件流并持续上传，供父进程采样常驻内存与文件描述符，收到终止
 * 信号后关闭连接并退出；
 * `server` 持续提供真实服务（含真实导出与备份任务），供容量报告在独立进程里测量控制平面
 * 自身的资源占用，收到终止信号后关闭并退出。
 * @module @chatdsh/gateway/resource-limits/probe
 */

import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { createTelemetryClient } from '@chatdsh/core-diagnostics/client';
import { defaultTelemetryConfig } from '@chatdsh/core-diagnostics/config';
import { GatewayStore, ReplicaStore } from '../store.ts';
import { SqliteDatabase } from '../storage/sqlite.ts';
import { ReplicaContinuityStore } from '../replica-continuity/store.ts';
import { createResourceJobs, type ResourceJobs } from './jobs.ts';
import { startResourceLimitServer, type BackupJobOutcome, type ExportJobOutcome, type ResourceLimitServerHandle } from './server.ts';

/** 读一个命令行参数。 */
function argumentOf(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found === undefined ? fallback : found.slice(prefix.length);
}

/** 打开一条事件流并保持。 */
function keepStream(url: string): Promise<{ close: () => void }> {
  return new Promise((settle, fail) => {
    const request = httpRequest(url, (response) => {
      response.resume();
      settle({
        close: () => {
          request.destroy();
          response.destroy();
        },
      });
    });
    request.on('error', fail);
    request.end();
  });
}

/** 上传一段字节。 */
async function upload(url: string, bytes: number): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.alloc(bytes, 0x5a),
  });
  if (response.status !== 200) throw new Error(`探针上传返回 ${String(response.status)}`);
  await response.text();
}

const mode = argumentOf('mode', 'start');
const root = argumentOf('root', process.cwd());
const telemetry = createTelemetryClient({
  config: defaultTelemetryConfig({ surface: 'gateway' }),
  component: '@chatdsh/gateway',
  env: { CHATDSH_TELEMETRY: 'off' },
});
const startedAt = performance.now();
const store = new GatewayStore(join(root, 'gateway', 'gateway.sqlite'));
const replica = new ReplicaStore(store.handle());
const continuity = new ReplicaContinuityStore(new SqliteDatabase(join(root, 'gateway', 'replica-continuity.sqlite')));

/** 常驻与负载模式使用真实任务，冷启动模式不需要。 */
const jobs: ResourceJobs = mode === 'start'
  ? {
    export: async () => ({ jobId: 'probe-export', bytes: 0 }) satisfies ExportJobOutcome,
    backup: async () => ({ objects: 0, bytes: 0 }) satisfies BackupJobOutcome,
  }
  : createResourceJobs({
    dataRoot: root,
    database: store.handle(),
    telemetry,
    exportScope: {
      sessionId: argumentOf('export-session', 'sess-long'),
      turnFrom: 1,
      turnTo: Number.parseInt(argumentOf('export-turn-to', '25000'), 10),
    },
    keyPath: argumentOf('backup-key', join(root, 'backup-master.key')),
  });

const server: ResourceLimitServerHandle = await startResourceLimitServer({
  store,
  replica,
  continuity,
  telemetry,
  jobs,
});
const health = await fetch(`${server.url}/healthz`);
const coldStartMs = performance.now() - startedAt;
const healthOk = health.status === 200;
await health.text();

/** 关闭并退出。 */
async function shutdown(streams: { close: () => void }[]): Promise<void> {
  for (const stream of streams) stream.close();
  await server.close();
  await telemetry.shutdown();
}

if (mode === 'start') {
  console.log(JSON.stringify({ coldStartMs, status: health.status, port: server.port, healthOk }));
  await shutdown([]);
  process.exit(0);
}

if (mode === 'server') {
  console.log(JSON.stringify({ ready: true, mode, url: server.url, port: server.port, coldStartMs, pid: process.pid }));
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void shutdown([]).then(() => {
      process.exit(0);
    });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} else if (mode === 'load') {
  const streams: { close: () => void }[] = [];
  const streamCount = Number.parseInt(argumentOf('streams', '12'), 10);
  const uploadCount = Number.parseInt(argumentOf('uploads', '20'), 10);
  for (let index = 0; index < streamCount; index += 1) {
    streams.push(await keepStream(`${server.url}/chatdsh/gateway/resource/stream?session=load-${String(index % 5)}`));
  }
  for (let index = 0; index < uploadCount; index += 1) {
    await upload(`${server.url}/chatdsh/gateway/resource/upload?scope=attachment`, 4 * 1024 * 1024);
  }
  const memory = process.memoryUsage();
  console.log(JSON.stringify({ ready: true, mode, coldStartMs, port: server.port, rss: memory.rss, streams: streams.length, pid: process.pid }));
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void shutdown(streams).then(() => {
      process.exit(0);
    });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} else {
  throw new Error(`未知探针模式：${mode}`);
}
