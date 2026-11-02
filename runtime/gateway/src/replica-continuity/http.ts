/**
 * 连续副本的 HTTP 接口。
 *
 * 上报、游标查询、清理与显式重新获取都走同一套路由。接收端在一个事务里写入事件、
 * 连续前缀、字节账本与通知登记，事务提交之后才广播通知并返回确认。任何一条事件被拒绝
 * 时整批回滚，连续前缀不会跨过缺口。
 *
 * 公共路由的接入由发行集成负责；本模块提供可直接监听的完整服务，并用独立数据根。
 * @module @chatdsh/gateway/replica-continuity/http
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChatdshTelemetry, TelemetrySpan } from '@chatdsh/core-contracts';
import { NODE_HEADERS } from '@chatdsh/core-contracts';
import {
  REPLICA_ERROR_CODES,
  ReplicaContinuityError,
  type ReplicaErrorCode,
} from './errors.ts';
import {
  ReplicaContinuityStore,
  type CommittedReplicaEvent,
  type ReplicaEventInput,
} from './store.ts';

/** 上报路由。 */
export const REPLICA_PATH = '/chatdsh/gateway/replica';

/** 保留策略路由。 */
export const REPLICA_RETENTION_PATH = '/chatdsh/gateway/replica/retention';

/** 探活路由。 */
export const REPLICA_HEALTH_PATH = '/healthz';

/** 请求体上限；与现有控制平面路由一致。 */
export const REPLICA_BODY_LIMIT = 4 * 1024 * 1024;

/** 服务选项。 */
export interface ReplicaServerOptions {
  /** 连续副本存储。 */
  readonly store: ReplicaContinuityStore;
  /** 遥测出口；未安装时不产生信号。 */
  readonly telemetry?: ChatdshTelemetry;
  /** 提交之后的广播；只收到本次新提交的事件。 */
  readonly notify?: (event: CommittedReplicaEvent) => void;
  /** 监听地址，默认回环。 */
  readonly host?: string;
  /** 监听端口，0 表示由系统分配。 */
  readonly port?: number;
  /** 请求体上限，默认 {@link REPLICA_BODY_LIMIT}。 */
  readonly bodyLimitBytes?: number;
}

/** 已启动的服务。 */
export interface ReplicaServerHandle {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

/** 读取请求体；超过上限立即失败。 */
async function readBody(request: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.byteLength;
    if (total > limit) {
      throw new ReplicaContinuityError(
        REPLICA_ERROR_CODES.invalidPayload,
        413,
        '请求体超过上限',
        { limit },
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 写一个 JSON 响应。 */
function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  response.end(text);
}

/** 从请求头取单值。 */
function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0) return value[0];
  return undefined;
}

/** 节点令牌所在的请求头名。 */
const TOKEN_HEADER_NAME = 'authorization';

/** 取请求里的节点令牌；没有 Bearer 形态时返回空串。 */
function nodeTokenOf(request: IncomingMessage): string {
  for (const [name, value] of Object.entries(request.headers)) {
    if (name !== TOKEN_HEADER_NAME) continue;
    const text = typeof value === 'string' ? value : value?.[0] ?? '';
    return text.startsWith('Bearer ') ? text.slice('Bearer '.length) : '';
  }
  return '';
}

/** 解析上报事件。 */
function parseEvents(value: unknown): readonly ReplicaEventInput[] {
  if (!Array.isArray(value)) {
    throw new ReplicaContinuityError(REPLICA_ERROR_CODES.invalidPayload, 400, '事件列表缺失');
  }
  return value.map((item, index) => {
    if (item === null || typeof item !== 'object') {
      throw new ReplicaContinuityError(REPLICA_ERROR_CODES.invalidPayload, 400, '事件形状不合法', { index });
    }
    const record = item as Record<string, unknown>;
    const seq = record.seq;
    const kind = record.kind;
    const time = record.time;
    if (typeof seq !== 'number' || typeof kind !== 'string' || typeof time !== 'number') {
      throw new ReplicaContinuityError(REPLICA_ERROR_CODES.invalidPayload, 400, '事件字段不合法', { index });
    }
    if (!('payload' in record)) {
      throw new ReplicaContinuityError(REPLICA_ERROR_CODES.invalidPayload, 400, '事件正文缺失', { index });
    }
    return { seq, kind, time, payload: record.payload };
  });
}

/** 错误到响应的映射。 */
function errorStatusOf(error: ReplicaContinuityError): number {
  return error.status;
}

/** 记录一次失败信号的属性。 */
function markFailure(span: TelemetrySpan | undefined, code: ReplicaErrorCode): void {
  span?.setAttribute('outcome', code);
}

/** 启动连续副本服务。 */
export async function startReplicaServer(options: ReplicaServerOptions): Promise<ReplicaServerHandle> {
  const host = options.host ?? '127.0.0.1';
  const limit = options.bodyLimitBytes ?? REPLICA_BODY_LIMIT;
  const store = options.store;
  const telemetry = options.telemetry;

  const requestHandler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? host}`);
    if (url.pathname === REPLICA_HEALTH_PATH) {
      sendJson(response, 200, { status: 'ok' });
      return;
    }
    if (url.pathname !== REPLICA_PATH && url.pathname !== REPLICA_RETENTION_PATH) {
      sendJson(response, 404, { error: 'not-found' });
      return;
    }
    const deviceId = headerValue(request, NODE_HEADERS.id);
    const token = nodeTokenOf(request);
    if (deviceId === undefined || deviceId === '' || token === '' || !store.authorize(deviceId, token)) {
      const failure = new ReplicaContinuityError(REPLICA_ERROR_CODES.unauthorized, 401, '节点令牌无效或已撤销');
      sendJson(response, 401, { error: failure.code });
      return;
    }

    if (url.pathname === REPLICA_PATH && request.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId');
      if (sessionId === null || sessionId === '') {
        sendJson(response, 400, { error: REPLICA_ERROR_CODES.invalidPayload });
        return;
      }
      sendJson(response, 200, store.cursorView(sessionId));
      return;
    }

    if (url.pathname === REPLICA_RETENTION_PATH) {
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'method-not-allowed' });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readBody(request, limit)) as unknown;
      } catch (error) {
        if (error instanceof ReplicaContinuityError) throw error;
        sendJson(response, 400, { error: 'invalid-json' });
        return;
      }
      if (parsed === null || typeof parsed !== 'object') {
        sendJson(response, 400, { error: REPLICA_ERROR_CODES.invalidPayload });
        return;
      }
      const record = parsed as Record<string, unknown>;
      const sessionId = record.sessionId;
      const action = record.action;
      if (typeof sessionId !== 'string' || sessionId === '' || (action !== 'clear' && action !== 'reacquire')) {
        sendJson(response, 400, { error: REPLICA_ERROR_CODES.invalidPayload });
        return;
      }
      const state = action === 'clear' ? store.clear(sessionId) : store.reacquire(sessionId);
      sendJson(response, 200, state);
      return;
    }

    if (url.pathname !== REPLICA_PATH || request.method !== 'POST') {
      sendJson(response, 405, { error: 'method-not-allowed' });
      return;
    }

    let bodyText: string;
    try {
      bodyText = await readBody(request, limit);
    } catch (error) {
      if (error instanceof ReplicaContinuityError) {
        sendJson(response, errorStatusOf(error), { error: error.code });
        return;
      }
      throw error;
    }
    let sessionId = '';
    let retentionGeneration = 0;
    let events: readonly ReplicaEventInput[] = [];
    let wireBytes = 0;
    try {
      const parsed = JSON.parse(bodyText) as unknown;
      if (parsed === null || typeof parsed !== 'object') {
        throw new ReplicaContinuityError(REPLICA_ERROR_CODES.invalidPayload, 400, '请求体形状不合法');
      }
      const record = parsed as Record<string, unknown>;
      if (typeof record.sessionId !== 'string' || record.sessionId === '') {
        throw new ReplicaContinuityError(REPLICA_ERROR_CODES.invalidPayload, 400, '会话标识缺失');
      }
      if (typeof record.retentionGeneration !== 'number' || !Number.isSafeInteger(record.retentionGeneration)) {
        throw new ReplicaContinuityError(REPLICA_ERROR_CODES.invalidPayload, 400, '保留代次缺失');
      }
      sessionId = record.sessionId;
      retentionGeneration = record.retentionGeneration;
      events = parseEvents(record.events);
      wireBytes = Buffer.byteLength(bodyText);
    } catch (error) {
      if (error instanceof ReplicaContinuityError) {
        sendJson(response, errorStatusOf(error), { error: error.code, ...error.details });
        return;
      }
      sendJson(response, 400, { error: 'invalid-json' });
      return;
    }

    const run = async (span: TelemetrySpan | undefined): Promise<void> => {
      try {
        const result = store.append({ sessionId, deviceId, retentionGeneration, events });
        for (const event of result.committed) options.notify?.(event);
        span?.setAttributes({
          'session.id': sessionId,
          seq: result.acknowledgedThrough,
          bytes: wireBytes,
          outcome: result.appended > 0 ? 'appended' : 'duplicate',
        });
        sendJson(response, 200, {
          sessionId: result.sessionId,
          acknowledgedThrough: result.acknowledgedThrough,
          appended: result.appended,
          duplicates: result.duplicates,
          bytesCommitted: result.bytesCommitted,
          retentionGeneration: result.retentionGeneration,
        });
      } catch (error) {
        if (!(error instanceof ReplicaContinuityError)) throw error;
        if (error.code === REPLICA_ERROR_CODES.gap) {
          const expectedSeq = Number(error.details.expectedSeq ?? 0);
          store.recordGap(sessionId, expectedSeq);
          markFailure(span, error.code);
          span?.setAttribute('session.id', sessionId);
          sendJson(response, error.status, {
            error: error.code,
            expectedSeq,
            missing: {
              from: expectedSeq,
              to: Math.max(expectedSeq, Number(error.details.seq ?? expectedSeq) - 1),
            },
          });
          return;
        }
        markFailure(span, error.code);
        span?.setAttribute('session.id', sessionId);
        sendJson(response, error.status, { error: error.code, ...error.details });
      }
    };

    if (telemetry === undefined) {
      await run(undefined);
      return;
    }
    const carrier = {
      traceparent: headerValue(request, 'traceparent'),
      tracestate: headerValue(request, 'tracestate'),
    };
    const attributes = {
      'session.id': sessionId,
      seq: events.length === 0 ? 0 : events[events.length - 1]?.seq ?? 0,
      bytes: wireBytes,
    };
    await telemetry.withContext(telemetry.extract(carrier), async () => {
      await telemetry.runSpan('chatdsh.gateway.replica.append', attributes, async (span) => {
        telemetry.gauge('chatdsh_replica_lag_sessions', { description: '副本落后会话数' })
          .record(store.pendingGapCount());
        await run(span);
      });
    });
  };

  const server = createServer((request, response) => {
    requestHandler(request, response).catch((error: unknown) => {
      if (error instanceof ReplicaContinuityError) {
        sendJson(response, errorStatusOf(error), { error: error.code, ...error.details });
        return;
      }
      if (!response.headersSent) sendJson(response, 500, { error: 'replica-internal' });
      else response.destroy();
    });
  });
  await new Promise<void>((settle, fail) => {
    server.once('error', fail);
    server.listen(options.port ?? 0, host, () => {
      server.off('error', fail);
      settle();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    host,
    port: address.port,
    url: `http://${host}:${address.port}`,
    close: () => new Promise<void>((settle, fail) => {
      server.close((error) => (error === undefined ? settle() : fail(error)));
    }),
  };
}
