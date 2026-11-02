import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { listQuerySchema, type ChatdshTelemetry } from '@chatdsh/core-contracts';
import { ClientHttpError, clientRequestId, sendClientError, sendClientJson, setClientResponseHeaders } from './client-errors.ts';
import { assertClientDevice, authorizeClientRequest, validateClientOrigin, type ClientSecurityOptions } from './client-security.ts';
import { createClientSessionQuery, type AggregateSessionsOptions } from './sessions.ts';
import type { ReceiptStore } from './store.ts';

export interface ClientHttpOptions extends AggregateSessionsOptions, ClientSecurityOptions {
  readonly receipts: ReceiptStore;
  readonly telemetry: ChatdshTelemetry;
  /** 部署级稳定密钥；未提供时游标只在本次进程内有效。 */
  readonly cursorKey?: Buffer;
}

/** 私有会话读取入口。公共路由仅在认证服务配置完成后挂载。 */
export function createClientHttpHandler(options: ClientHttpOptions) {
  const origin = validateClientOrigin(options.origin);
  const key = Buffer.from(options.cursorKey ?? randomBytes(32));
  if (key.length < 32) throw new Error('分页游标签名密钥至少需要 32 字节');
  const querySessions = createClientSessionQuery(options.store.handle(), options.online);
  const counter = options.telemetry.counter('chatdsh_gateway_client_requests_total', { description: '私有客户端读取结果' });
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const raw = request.url ?? '/';
    if (!raw.startsWith('/chatdsh/client/')) return false;
    const requestId = clientRequestId(request);
    setClientResponseHeaders(response, requestId);
    const carrier = { traceparent: typeof request.headers.traceparent === 'string' ? request.headers.traceparent : undefined };
    await options.telemetry.withContext(carrier, () => options.telemetry.runSpan('chatdsh.gateway.client.request', {}, async (span) => {
      try {
        const principal = await authorizeClientRequest(request, options);
        if (request.method !== 'GET') throw new ClientHttpError(405, 'request-invalid');
        const url = new URL(raw, origin);
        if (url.pathname !== '/chatdsh/client/sessions') throw new ClientHttpError(404, 'object-not-found');
        const allowed = new Set(['limit', 'cursor', 'q', 'deviceId']);
        for (const name of url.searchParams.keys()) {
          if (!allowed.has(name) || url.searchParams.getAll(name).length !== 1) throw new ClientHttpError(400, 'request-invalid');
        }
        const parsed = listQuerySchema.safeParse({
          limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
          cursor: url.searchParams.get('cursor') ?? undefined,
        });
        if (!parsed.success) throw new ClientHttpError(400, 'request-invalid');
        const query = (url.searchParams.get('q') ?? '').trim();
        if (query.length > 200) throw new ClientHttpError(400, 'request-invalid');
        const deviceId = url.searchParams.get('deviceId');
        if (deviceId !== null) {
          assertClientDevice(principal, deviceId);
          if (options.store.nodeById(deviceId) === undefined) throw new ClientHttpError(404, 'device-unknown');
        }
        const binding = createHash('sha256').update(JSON.stringify([principal.clientId, principal.deviceIds, query, deviceId, parsed.data.limit])).digest('hex');
        let after: [number, string] | undefined;
        if (parsed.data.cursor !== undefined) {
          const bytes = Buffer.from(parsed.data.cursor, 'base64url');
          if (bytes.length < 33) throw new ClientHttpError(400, 'cursor-invalid');
          const payload = bytes.subarray(32);
          const expected = createHmac('sha256', key).update(payload).digest();
          if (!timingSafeEqual(bytes.subarray(0, 32), expected)) throw new ClientHttpError(400, 'cursor-invalid');
          const cursor: unknown = JSON.parse(payload.toString('utf8'));
          if (!Array.isArray(cursor) || cursor.length !== 4 || cursor[0] !== binding || typeof cursor[1] !== 'number' || cursor[1] <= Date.now() || typeof cursor[2] !== 'number' || typeof cursor[3] !== 'string') {
            throw new ClientHttpError(400, 'cursor-invalid');
          }
          const anchor = querySessions.resolveAnchor(cursor[3], principal.deviceIds, deviceId ?? undefined);
          if (anchor === undefined) throw new ClientHttpError(400, 'cursor-invalid');
          after = [cursor[2], anchor];
        }
        const { items, hasMore } = querySessions({
          clientId: principal.clientId, deviceIds: principal.deviceIds,
          deviceId: deviceId ?? undefined, query, limit: parsed.data.limit, after,
        });
        const last = items.at(-1);
        let nextCursor: string | undefined;
        if (hasMore && last !== undefined) {
          const payload = Buffer.from(JSON.stringify([binding, Date.now() + 900_000, last.updatedAt, createHash('sha256').update(last.sessionId).digest('hex')]));
          nextCursor = Buffer.concat([createHmac('sha256', key).update(payload).digest(), payload]).toString('base64url');
        }
        sendClientJson(response, 200, { items, page: { hasMore, nextCursor }, requestId });
        span.setAttribute('outcome', 'success');
        counter.add(1, { outcome: 'success' });
      } catch (error) {
        const failure = sendClientError(response, error, requestId);
        const outcome = failure.status >= 500 ? 'failed' : 'rejected';
        const errorType = error instanceof ClientHttpError ? 'ClientHttpError' : 'InternalError';
        const attributes = { outcome, 'error.type': errorType, 'error.code': failure.code };
        span.setAttributes(attributes);
        options.telemetry.event('chatdsh.gateway.client.rejected', attributes);
        counter.add(1, { outcome });
      }
    }));
    return true;
  };
}
