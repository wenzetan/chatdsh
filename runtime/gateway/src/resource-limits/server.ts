/**
 * 资源限制服务的真实监听入口。
 *
 * 公共路由接入由发行集成负责；本模块提供可直接监听的完整服务，用独立数据根与真实 SQLite，
 * 把每一类额度接在真实 HTTP 路径上：外壳页面与脚本、会话列表与历史分页、受额度约束的请求体
 * 上传、事件批次上报、事件流连接配额、跨设备公平分发、导出与备份的有界受理、连续副本追赶。
 *
 * 所有拒绝都返回带错误码、单位、上限、实测值与允许处理入口的响应；限流类拒绝同时带
 * `Retry-After`。服务不写业务正文到遥测，也不改变已受理内容的去向。
 * @module @chatdsh/gateway/resource-limits/server
 */

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChatdshTelemetry } from '@chatdsh/core-contracts';
import {
  RESOURCE_LIMITS,
  guardBytes,
  guardCount,
  guardMilliseconds,
  rejectionOf,
  type ResourceRejection,
  type ResourceScope,
} from '@chatdsh/core-limits';
import type { GatewayStore, ReplicaStore } from '../store.ts';
import { aggregateSessions } from '../sessions.ts';
import { renderShellPage, readShellScript, shellBuilt, SHELL_SCRIPT_PATH } from '../shell.ts';
import type { ReplicaContinuityStore } from '../replica-continuity/store.ts';
import { ResourceGovernor, type GovernorSnapshot } from './governor.ts';
import { FairFanout, type FanoutEvent } from './fanout.ts';
import { RESOURCE_SPANS, ResourceTelemetry } from './telemetry.ts';

/** 导出任务的返回形状。 */
export interface ExportJobOutcome {
  /** 导出任务标识。 */
  readonly jobId: string;
  /** 生成文件的字节数。 */
  readonly bytes: number;
}

/** 备份任务的返回形状。 */
export interface BackupJobOutcome {
  /** 备份对象数。 */
  readonly objects: number;
  /** 备份字节数。 */
  readonly bytes: number;
}

/** 服务选项。 */
export interface ResourceLimitServerOptions {
  /** 网关存储，使用真实 SQLite。 */
  readonly store: GatewayStore;
  /** 副本存储，使用同一个真实库。 */
  readonly replica: ReplicaStore;
  /** 连续副本接收端；提供时启用副本追赶路由。 */
  readonly continuity?: ReplicaContinuityStore;
  /** 遥测出口。 */
  readonly telemetry: ChatdshTelemetry;
  /** 真实的导出与备份执行函数，由调用方接入具体实现。 */
  readonly jobs: {
    readonly export: (signal: AbortSignal) => Promise<ExportJobOutcome>;
    readonly backup: (signal: AbortSignal) => Promise<BackupJobOutcome>;
  };
  /** 监听地址，默认回环。 */
  readonly host?: string;
  /** 监听端口，0 表示由系统分配。 */
  readonly port?: number;
  /** 外壳页面与脚本的来源，缺省读控制平面自己的构建产物。 */
  readonly shell?: {
    readonly page: () => string;
    readonly script: () => Buffer | undefined;
  };
}

/** 服务统计。 */
export interface ServerStats {
  /** 已提交事件总数。 */
  readonly committedEvents: number;
  /** 已提交事件的最大序号。 */
  readonly lastSeq: number;
  /** 导出完成数。 */
  readonly exportsCompleted: number;
  /** 备份完成数。 */
  readonly backupsCompleted: number;
  /** 副本追赶写入的事件数。 */
  readonly replicaEventsWritten: number;
}

/** 已启动的服务。 */
export interface ResourceLimitServerHandle {
  /** 监听地址。 */
  readonly url: string;
  /** 监听端口。 */
  readonly port: number;
  /** 资源治理器。 */
  readonly governor: ResourceGovernor;
  /** 跨设备公平分发。 */
  readonly fanout: FairFanout;
  /** 遥测出口。 */
  readonly resourceTelemetry: ResourceTelemetry;
  /** 治理器快照。 */
  readonly snapshot: () => GovernorSnapshot;
  /** 服务统计。 */
  readonly stats: () => ServerStats;
  /** 停止监听并释放连接。 */
  close(): Promise<void>;
}

/** 允许上传的资源种类。 */
const UPLOAD_SCOPES = new Set<ResourceScope>([
  'request-body',
  'message',
  'event',
  'webhook-body',
  'preview',
  'tool-display',
  'attachment',
  'turn-attachments',
  'recording-bytes',
  'replica-batch-bytes',
]);

/** 路由形状。 */
const SESSION_EVENTS_PATH = /^\/chatdsh\/gateway\/sessions\/([^/]+)\/events$/;
const FANOUT_PATH = /^\/chatdsh\/gateway\/fanout\/([^/]+)$/;

/** 写一段事件流文本；对端已经关闭时静默返回，订阅的清理由 close 事件负责。 */
function safeWrite(response: ServerResponse, text: string): void {
  if (response.writableEnded || response.destroyed) return;
  try {
    response.write(text);
  } catch {
    // 套接字在检查之后、写入之前被关闭属于正常断开。
  }
}

/** 写一个 JSON 响应。 */
function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  if (response.writableEnded || response.destroyed) return;
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

/** 读一个整数查询参数。 */
function integerParam(params: URLSearchParams, name: string, fallback: number): number {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** 事件正文的序列化字节数。 */
function payloadBytesOf(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload) ?? 'null');
}

/**
 * 建立并启动资源限制服务。
 * @param options - 监听地址、存储、遥测与任务执行函数。
 * @returns 服务句柄。
 */
export async function startResourceLimitServer(options: ResourceLimitServerOptions): Promise<ResourceLimitServerHandle> {
  const { store, replica, continuity, telemetry } = options;
  const governor = new ResourceGovernor({ telemetry });
  const resourceTelemetry = governor.telemetry;
  let committedEvents = 0;
  let lastSeq = 0;
  let exportsCompleted = 0;
  let backupsCompleted = 0;
  let replicaEventsWritten = 0;

  /** 一页事件的内容。 */
  interface EventsPage {
    readonly items: { readonly seq: number; readonly kind: string; readonly time: number; readonly bytes: number; readonly payload: unknown }[];
    readonly bytes: number;
    readonly hasMore: boolean;
  }

  /**
   * 按序号区间读取一页事件。
   *
   * 条数由 SQL 的 `limit` 限制，字节按额度二次截断，两者都不先把整个会话读进内存。
   */
  const readEventsPage = (sessionId: string, after: number, limit: number, byteBudget: number): EventsPage => {
    const rows = store.handle().prepare(
      'select seq, kind, time, bytes, payload from replica_events where session_id = ? and seq > ? order by seq asc limit ?',
    ).all(sessionId, after, limit) as { seq: number; kind: string; time: number; bytes: number; payload: string | null }[];
    const items: { seq: number; kind: string; time: number; bytes: number; payload: unknown }[] = [];
    let bytes = 0;
    let byteTruncated = false;
    for (const row of rows) {
      if (bytes + row.bytes > byteBudget) {
        byteTruncated = true;
        break;
      }
      bytes += row.bytes;
      items.push({
        seq: row.seq,
        kind: row.kind,
        time: row.time,
        bytes: row.bytes,
        payload: row.payload === null ? undefined : JSON.parse(row.payload) as unknown,
      });
    }
    return { items, bytes, hasMore: byteTruncated || rows.length === limit };
  };

  /** 从权威副本读取游标之后的事件，条数与字节都有界。 */
  const replayEvents = (sessionId: string, sinceSeq: number, limit: number): FanoutEvent[] => {
    const pageLimit = Math.min(limit, RESOURCE_LIMITS['list-page'].value);
    const stored = readEventsPage(sessionId, sinceSeq, pageLimit, RESOURCE_LIMITS['replica-batch-bytes'].value).items;
    const out: FanoutEvent[] = [];
    let bytes = 0;
    for (const event of stored) {
      if (out.length >= pageLimit) break;
      if (bytes + event.bytes > RESOURCE_LIMITS['replica-batch-bytes'].value) break;
      bytes += event.bytes;
      out.push({
        sessionId,
        seq: event.seq,
        kind: event.kind,
        bytes: event.bytes,
        frame: JSON.stringify({ seq: event.seq, kind: event.kind, payload: event.payload }),
      });
    }
    return out;
  };

  const fanout = new FairFanout({
    governor,
    telemetry: resourceTelemetry,
    replay: (sessionId, sinceSeq, limit) => replayEvents(sessionId, sinceSeq, limit),
  });

  /** 把一条事件推给全部在线设备。 */
  const broadcast = (event: FanoutEvent): void => {
    fanout.publish(event);
  };

  /** 处理一次上传。 */
  const handleUpload = async (request: IncomingMessage, response: ServerResponse, scope: ResourceScope): Promise<void> => {
    if (!UPLOAD_SCOPES.has(scope)) {
      sendJson(response, 400, { error: 'scope-unsupported', scope });
      return;
    }
    const span = resourceTelemetry.start(RESOURCE_SPANS.guard, { kind: scope, action: 'upload' });
    const read = await governor.readBody(request, scope);
    if (read.ok === false) {
      span?.setAttribute('outcome', 'rejected');
      span?.setAttribute('error.type', 'resource');
      span?.setAttribute('error.code', read.rejection.code);
      span?.end();
      governor.writeRejection(response, read.rejection);
      return;
    }
    span?.setAttribute('outcome', 'accepted');
    span?.setAttribute('bytes', read.bytes);
    span?.end();
    const digest = createHash('sha256').update(read.body).digest('hex');
    sendJson(response, 200, { accepted: true, kind: scope, bytes: read.bytes, digest });
  };

  /** 处理一次事件批次：条数、总字节与单条字节三次判定，通过后写真实 SQLite。 */
  const handleEventBatch = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const read = await governor.readBody(request, 'replica-batch-bytes');
    if (read.ok === false) {
      governor.writeRejection(response, read.rejection);
      return;
    }
    let parsed: { sessionId?: unknown; events?: unknown };
    try {
      parsed = JSON.parse(read.body.toString('utf8')) as { sessionId?: unknown; events?: unknown };
    } catch {
      sendJson(response, 400, { error: 'invalid-json' });
      return;
    }
    if (typeof parsed.sessionId !== 'string' || parsed.sessionId === '') {
      sendJson(response, 400, { error: 'session-id-required' });
      return;
    }
    if (!Array.isArray(parsed.events) || parsed.events.length === 0) {
      sendJson(response, 400, { error: 'events-required' });
      return;
    }
    const countVerdict = guardCount('replica-batch-items', parsed.events.length);
    if (countVerdict.ok === false) {
      governor.recordRejection('replica-batch-items', countVerdict.rejection);
      governor.writeRejection(response, countVerdict.rejection, { count: parsed.events.length });
      return;
    }
    const events: { seq: number; kind: string; time: number; bytes: number; payload: unknown }[] = [];
    for (const item of parsed.events) {
      if (typeof item !== 'object' || item === null) {
        sendJson(response, 400, { error: 'event-invalid' });
        return;
      }
      const record = item as { seq?: unknown; kind?: unknown; time?: unknown; payload?: unknown };
      if (typeof record.seq !== 'number' || typeof record.kind !== 'string') {
        sendJson(response, 400, { error: 'event-invalid' });
        return;
      }
      const bytes = payloadBytesOf(record.payload);
      const byteVerdict = guardBytes('event', bytes);
      if (byteVerdict.ok === false) {
        governor.recordRejection('event', byteVerdict.rejection);
        governor.writeRejection(response, byteVerdict.rejection, { seq: record.seq });
        return;
      }
      events.push({
        seq: record.seq,
        kind: record.kind,
        time: typeof record.time === 'number' ? record.time : Date.now(),
        bytes,
        payload: record.payload,
      });
    }
    const appended = replica.append(parsed.sessionId, events);
    committedEvents += appended.written;
    lastSeq = Math.max(lastSeq, appended.watermark);
    for (const event of events) {
      broadcast({
        sessionId: parsed.sessionId,
        seq: event.seq,
        kind: event.kind,
        bytes: event.bytes,
        frame: JSON.stringify({ seq: event.seq, kind: event.kind, payload: event.payload }),
      });
    }
    sendJson(response, 200, { accepted: true, written: appended.written, watermark: appended.watermark });
  };

  /** 处理一次连续副本批次，验证连续性与字节账本。 */
  const handleReplicaBatch = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (continuity === undefined) {
      sendJson(response, 404, { error: 'replica-continuity-unavailable' });
      return;
    }
    const read = await governor.readBody(request, 'replica-batch-bytes');
    if (read.ok === false) {
      governor.writeRejection(response, read.rejection);
      return;
    }
    let parsed: { sessionId?: unknown; deviceId?: unknown; retentionGeneration?: unknown; events?: unknown };
    try {
      parsed = JSON.parse(read.body.toString('utf8')) as typeof parsed;
    } catch {
      sendJson(response, 400, { error: 'invalid-json' });
      return;
    }
    if (typeof parsed.sessionId !== 'string' || typeof parsed.deviceId !== 'string') {
      sendJson(response, 400, { error: 'identity-required' });
      return;
    }
    if (!Array.isArray(parsed.events) || parsed.events.length === 0) {
      sendJson(response, 400, { error: 'events-required' });
      return;
    }
    const countVerdict = guardCount('replica-batch-items', parsed.events.length);
    if (countVerdict.ok === false) {
      governor.recordRejection('replica-batch-items', countVerdict.rejection);
      governor.writeRejection(response, countVerdict.rejection, { count: parsed.events.length });
      return;
    }
    let batchBytes = 0;
    const events: { seq: number; kind: string; time: number; payload: unknown }[] = [];
    for (const item of parsed.events) {
      if (typeof item !== 'object' || item === null) {
        sendJson(response, 400, { error: 'event-invalid' });
        return;
      }
      const record = item as { seq?: unknown; kind?: unknown; time?: unknown; payload?: unknown };
      if (typeof record.seq !== 'number' || typeof record.kind !== 'string') {
        sendJson(response, 400, { error: 'event-invalid' });
        return;
      }
      const bytes = payloadBytesOf(record.payload);
      batchBytes += bytes;
      const byteVerdict = guardBytes('event', bytes);
      if (byteVerdict.ok === false) {
        governor.recordRejection('event', byteVerdict.rejection);
        governor.writeRejection(response, byteVerdict.rejection, { seq: record.seq });
        return;
      }
      events.push({
        seq: record.seq,
        kind: record.kind,
        time: typeof record.time === 'number' ? record.time : Date.now(),
        payload: record.payload,
      });
    }
    const batchVerdict = guardBytes('replica-batch-bytes', batchBytes);
    if (batchVerdict.ok === false) {
      governor.recordRejection('replica-batch-bytes', batchVerdict.rejection);
      governor.writeRejection(response, batchVerdict.rejection, { count: events.length });
      return;
    }
    const result = continuity.append({
      sessionId: parsed.sessionId,
      deviceId: parsed.deviceId,
      retentionGeneration: typeof parsed.retentionGeneration === 'number' ? parsed.retentionGeneration : 0,
      events,
    });
    replicaEventsWritten += result.appended;
    sendJson(response, 200, {
      accepted: true,
      appended: result.appended,
      duplicates: result.duplicates,
      acknowledgedThrough: result.acknowledgedThrough,
      bytesCommitted: result.bytesCommitted,
    });
  };

  /** 处理事件流订阅，按访问会话计数并把期限写进连接。 */
  const handleStream = (response: ServerResponse, params: URLSearchParams): void => {
    const sessionKey = params.get('session') ?? 'default';
    const admission = governor.admitSse(sessionKey);
    if (admission.ok === false) {
      governor.writeRejection(response, admission.rejection, { open: admission.open });
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    safeWrite(response, `: connected ${admission.connectionId}\n\n`);
    response.on('error', () => undefined);
    governor.trackSse(admission.connectionId, response);
    const idle = setTimeout(() => {
      if (response.writableEnded || response.destroyed) return;
      const rejection = rejectionOf('stream-idle-timeout', RESOURCE_LIMITS['stream-idle-timeout'].value);
      governor.recordRejection('stream-idle-timeout', rejection);
      safeWrite(response, `event: idle\ndata: ${JSON.stringify({ error: rejection.code, entry: rejection.entry })}\n\n`);
      response.end();
    }, RESOURCE_LIMITS['stream-idle-timeout'].value);
    idle.unref();
    const heartbeat = setInterval(() => {
      if (response.writableEnded || response.destroyed) return;
      safeWrite(response, ': ping\n\n');
    }, 15_000);
    heartbeat.unref();
    response.on('close', () => {
      clearInterval(heartbeat);
      clearTimeout(idle);
      governor.untrackSse(admission.connectionId);
      admission.release();
    });
  };

  const server: Server = createServer((request, response) => {
    void handle(request, response);
  });

  /** 总入口。 */
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const { pathname, searchParams } = new URL(request.url ?? '/', 'http://resource-limits');
    const method = request.method ?? 'GET';
    if (pathname === '/healthz') {
      sendJson(response, 200, { ok: true });
      return;
    }
    if (pathname === '/' && method === 'GET') {
      const page = options.shell?.page() ?? renderShellPage();
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': String(Buffer.byteLength(page)) });
      response.end(page);
      return;
    }
    if (pathname === SHELL_SCRIPT_PATH && method === 'GET') {
      const script = options.shell?.script() ?? (shellBuilt() ? readShellScript() : undefined);
      if (script === undefined) {
        sendJson(response, 404, { error: 'shell-not-built' });
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Content-Length': String(script.byteLength),
        'Cache-Control': 'no-cache',
      });
      response.end(script);
      return;
    }
    if (pathname === '/chatdsh/gateway/sessions' && method === 'GET') {
      const limit = integerParam(searchParams, 'limit', RESOURCE_LIMITS['list-page-default'].value);
      const offset = integerParam(searchParams, 'offset', 0);
      const verdict = guardCount('list-page', limit);
      if (verdict.ok === false) {
        governor.recordRejection('list-page', verdict.rejection);
        governor.writeRejection(response, verdict.rejection, { limit });
        return;
      }
      const snapshot = aggregateSessions({ store, replica, online: () => true });
      const items = snapshot.devices.flatMap((device) => device.sessions);
      const page = items.slice(offset, offset + limit);
      sendJson(response, 200, {
        total: items.length,
        offset,
        limit,
        nextOffset: offset + page.length < items.length ? offset + page.length : null,
        items: page,
      });
      return;
    }
    const eventsMatch = SESSION_EVENTS_PATH.exec(pathname);
    if (eventsMatch !== null && method === 'GET') {
      const sessionId = decodeURIComponent(eventsMatch[1] ?? '');
      const after = integerParam(searchParams, 'after', -1);
      const limit = integerParam(searchParams, 'limit', RESOURCE_LIMITS['list-page-default'].value);
      const verdict = guardCount('list-page', limit);
      if (verdict.ok === false) {
        governor.recordRejection('list-page', verdict.rejection);
        governor.writeRejection(response, verdict.rejection, { limit });
        return;
      }
      const byteBudget = RESOURCE_LIMITS['replica-batch-bytes'].value;
      const page = readEventsPage(sessionId, after, limit, byteBudget);
      const last = page.items[page.items.length - 1];
      sendJson(response, 200, {
        sessionId,
        after,
        limit,
        bytes: page.bytes,
        count: page.items.length,
        nextAfter: last === undefined ? null : last.seq,
        truncated: page.hasMore,
        items: page.items,
      });
      return;
    }
    if (pathname === '/chatdsh/gateway/resource/upload') {
      if (method !== 'POST') {
        sendJson(response, 405, { error: 'method-not-allowed' });
        return;
      }
      const scope = searchParams.get('scope') ?? 'request-body';
      await handleUpload(request, response, scope as ResourceScope);
      return;
    }
    if (pathname === '/chatdsh/gateway/resource/recording') {
      if (method !== 'POST') {
        sendJson(response, 405, { error: 'method-not-allowed' });
        return;
      }
      const durationMs = integerParam(searchParams, 'durationMs', 0);
      const durationVerdict = guardMilliseconds('recording-duration', durationMs);
      if (durationVerdict.ok === false) {
        governor.recordRejection('recording-duration', durationVerdict.rejection);
        governor.writeRejection(response, durationVerdict.rejection, { durationMs });
        return;
      }
      await handleUpload(request, response, 'recording-bytes');
      return;
    }
    if (pathname === '/chatdsh/gateway/resource/events' && method === 'POST') {
      await handleEventBatch(request, response);
      return;
    }
    if (pathname === '/chatdsh/gateway/resource/replica/batch' && method === 'POST') {
      await handleReplicaBatch(request, response);
      return;
    }
    if (pathname === '/chatdsh/gateway/resource/stream' && method === 'GET') {
      handleStream(response, searchParams);
      return;
    }
    const fanoutMatch = FANOUT_PATH.exec(pathname);
    if (fanoutMatch !== null && method === 'GET') {
      const deviceId = decodeURIComponent(fanoutMatch[1] ?? '');
      const since = integerParam(searchParams, 'since', -1);
      const sessionId = searchParams.get('session') ?? '';
      if (sessionId === '') {
        sendJson(response, 400, { error: 'session-id-required' });
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      response.on('error', () => undefined);
      const subscription = fanout.subscribe(deviceId, sessionId, response, since);
      if (subscription.ok === false) {
        governor.writeRejection(response, subscription.rejection, { replayed: 0 });
        return;
      }
      request.on('close', () => {
        subscription.unsubscribe();
      });
      return;
    }
    if (pathname === '/chatdsh/gateway/resource/export' && method === 'POST') {
      const outcome = await governor.runExport(async (signal) => options.jobs.export(signal));
      if (outcome.ok === false) {
        governor.writeRejection(response, outcome.rejection);
        return;
      }
      exportsCompleted += 1;
      sendJson(response, 200, { accepted: true, waitedMs: outcome.waitedMs, ...outcome.value });
      return;
    }
    if (pathname === '/chatdsh/gateway/resource/backup' && method === 'POST') {
      const outcome = await governor.runBackup(async (signal) => options.jobs.backup(signal));
      if (outcome.ok === false) {
        governor.writeRejection(response, outcome.rejection);
        return;
      }
      backupsCompleted += 1;
      sendJson(response, 200, { accepted: true, waitedMs: outcome.waitedMs, ...outcome.value });
      return;
    }
    if (pathname === '/chatdsh/gateway/resource/state' && method === 'GET') {
      const samples = fanout.dispatchSamplesMs();
      sendJson(response, 200, {
        governor: governor.snapshot(),
        fanout: fanout.snapshot(),
        dispatch: {
          count: samples.length,
          samples: samples.slice(Math.max(0, samples.length - 2048)),
          queuedItems: fanout.totalQueuedItems(),
        },
        telemetryEnabled: telemetry.enabled,
        stats: { committedEvents, lastSeq, exportsCompleted, backupsCompleted, replicaEventsWritten },
      });
      return;
    }
    if (pathname === '/chatdsh/gateway/resource/dispatch/reset' && method === 'POST') {
      fanout.resetSamples();
      sendJson(response, 200, { cleared: true });
      return;
    }
    sendJson(response, 404, { error: 'not-found' });
  }

  await new Promise<void>((settle, fail) => {
    server.once('error', fail);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
      settle();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('资源限制服务没有取得监听端口');
  const port = (address as AddressInfo).port;

  return {
    url: `http://${options.host ?? '127.0.0.1'}:${String(port)}`,
    port,
    governor,
    fanout,
    resourceTelemetry,
    snapshot: () => governor.snapshot(),
    stats: () => ({ committedEvents, lastSeq, exportsCompleted, backupsCompleted, replicaEventsWritten }),
    close: async () => {
      fanout.close();
      await governor.close();
      await new Promise<void>((settle) => {
        server.close(() => settle());
        server.closeAllConnections();
      });
    },
  };
}

/** 一次拒绝的响应体形状，供测试与调用方复用。 */
export interface RejectionBody {
  readonly error: string;
  readonly kind: string;
  readonly unit: string;
  readonly limit: number;
  readonly observed: number;
  readonly entry: string;
  readonly guidance: string;
}

/** 构造一次拒绝响应体。 */
export function rejectionBodyOf(rejection: ResourceRejection): RejectionBody {
  return {
    error: rejection.code,
    kind: rejection.scope,
    unit: rejection.unit,
    limit: rejection.limit,
    observed: rejection.observed,
    entry: rejection.entry,
    guidance: rejection.guidance,
  };
}

/** 事件过小时的拒绝，供调用方在编码之前判定。 */
export function guardEventBytes(bytes: number): ResourceRejection | undefined {
  const verdict = guardBytes('event', bytes);
  return verdict.ok === false ? verdict.rejection : undefined;
}

/** 默认拒绝描述，供路由层在没有具体种类时使用。 */
export function defaultRejection(scope: ResourceScope, observed: number): ResourceRejection {
  return rejectionOf(scope, observed);
}


