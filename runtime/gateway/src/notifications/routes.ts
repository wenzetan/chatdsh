/**
 * 通知中心的 HTTP 接口。
 *
 * 路径前缀固定为 `/chatdsh/gateway/notifications`。设备标识取 `x-chatdsh-node-id` 头或
 * `deviceId` 查询参数，访问客户端标识取 `x-chatdsh-client` 头或请求体字段。接口只读写
 * 通知记录、设置与订阅，不代替审批决定：标记已读不会通过任何审批。
 * @module @chatdsh/gateway/notifications/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { CHATDSH_ERROR_CODES, NODE_HEADERS } from '@chatdsh/core-contracts';
import type { NotificationProbe, NotificationFilter, NotificationSettings, PushSubscriptionView } from '@chatdsh/core-contracts';
import type { TelemetrySpan } from '@chatdsh/core-contracts';
import type { DeliveryTelemetry, NotificationDelivery } from './delivery.ts';
import {
  CursorError,
  NotificationStore,
  SettingsConflictError,
  type NotificationPage,
  type ReadResult,
  type StoredNotificationSettings,
} from './records.ts';
import { NOTIFICATION_PRIVACY_LEVELS, type NotificationPrivacyLevel } from './records.ts';

/** 路由前缀。 */
export const NOTIFICATION_ROUTE_PREFIX = '/chatdsh/gateway/notifications';

/** 访问客户端标识的头部名称。 */
export const CLIENT_HEADER = 'x-chatdsh-client';

/** 请求体上限。 */
const BODY_LIMIT = 64 * 1024;

/** 默认分页条数。 */
const DEFAULT_LIMIT = 20;

/** 分页条数上限。 */
const MAX_LIMIT = 100;

/** 验证通知的路由所需能力。 */
export interface ProbeCapability {
  /** 向设备的有效订阅发送一条验证通知。 */
  send(deviceId: string): Promise<{ id: string; probe: NotificationProbe }>;
  /** 记录客户端实际接收的时刻。 */
  receipt(probeId: string, receivedAt: number): NotificationProbe;
}

/** 路由上下文。 */
export interface NotificationRouteContext {
  /** 通知记录与订阅存储。 */
  readonly store: NotificationStore;
  /** 通知投递。 */
  readonly delivery: NotificationDelivery;
  /** 遥测面。 */
  readonly telemetry: DeliveryTelemetry;
  /** 验证通知。 */
  readonly probe: ProbeCapability;
  /** 当前时刻的毫秒时间戳。 */
  readonly now: () => number;
}

/** 一次路由处理的结果。 */
export interface RouteOutcome {
  /** 是否由本模块处理了这个请求。 */
  readonly handled: boolean;
}

/** 业务拒绝：转成响应并记一条事件。 */
class RouteRejection extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'RouteRejection';
  }
}

/** 写一个 JSON 响应。 */
function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

/** 读请求体，超过上限时拒绝。 */
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.byteLength;
    if (total > BODY_LIMIT) throw new RouteRejection(413, CHATDSH_ERROR_CODES.payloadTooLarge, '请求体超过上限');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 解析 JSON 对象请求体。 */
async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readBody(request);
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RouteRejection(400, CHATDSH_ERROR_CODES.requestInvalid, '请求体不是合法 JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new RouteRejection(400, CHATDSH_ERROR_CODES.requestInvalid, '请求体必须是 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

/** 取一个非空字符串字段。 */
function textField(payload: Record<string, unknown>, name: string): string | undefined {
  const value = payload[name];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** 取一个设备标识字段，缺失时直接拒绝。 */
function requireDevice(payload: Record<string, unknown>, request: IncomingMessage, url: URL): string {
  const header = request.headers[NODE_HEADERS.id];
  if (typeof header === 'string' && header !== '') return header;
  const query = url.searchParams.get('deviceId');
  if (query !== null && query !== '') return query;
  const body = textField(payload, 'deviceId');
  if (body !== undefined) return body;
  throw new RouteRejection(400, CHATDSH_ERROR_CODES.requestInvalid, '缺少设备标识');
}

/** 取访问客户端标识；缺失时拒绝。 */
function requireClient(payload: Record<string, unknown>, request: IncomingMessage, url: URL): string {
  const header = request.headers[CLIENT_HEADER];
  if (typeof header === 'string' && header !== '') return header;
  const query = url.searchParams.get('clientId');
  if (query !== null && query !== '') return query;
  const body = textField(payload, 'clientId');
  if (body !== undefined) return body;
  throw new RouteRejection(400, CHATDSH_ERROR_CODES.requestInvalid, '缺少访问客户端标识');
}

/** 取可选的设备标识。 */
function optionalDevice(request: IncomingMessage, url: URL): string | undefined {
  const header = request.headers[NODE_HEADERS.id];
  if (typeof header === 'string' && header !== '') return header;
  const query = url.searchParams.get('deviceId');
  return query === null || query === '' ? undefined : query;
}

/** 解析过滤条件。 */
function filterOf(url: URL): NotificationFilter {
  const raw = url.searchParams.get('filter') ?? 'all';
  if (raw === 'all' || raw === 'unread' || raw === 'approval' || raw === 'run-result') return raw;
  throw new RouteRejection(400, CHATDSH_ERROR_CODES.requestInvalid, `不支持的过滤条件：${raw}`);
}

/** 解析分页条数。 */
function limitOf(url: URL): number {
  const raw = url.searchParams.get('limit');
  if (raw === null) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_LIMIT) {
    throw new RouteRejection(400, CHATDSH_ERROR_CODES.requestInvalid, `分页条数取 1 到 ${MAX_LIMIT}`);
  }
  return parsed;
}

/** 解析时间参数。 */
function timeOf(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new RouteRejection(400, CHATDSH_ERROR_CODES.requestInvalid, `${name} 必须是非负整数毫秒时间戳`);
  }
  return parsed;
}

/** 校验通知标识数组。 */
function idsOf(payload: Record<string, unknown>): string[] {
  const value = payload.ids;
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) {
    throw new RouteRejection(400, CHATDSH_ERROR_CODES.requestInvalid, 'ids 取 1 到 500 个通知标识');
  }
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item === '' || item.length > 200) {
      throw new RouteRejection(400, CHATDSH_ERROR_CODES.requestInvalid, '通知标识必须是非空字符串');
    }
    ids.push(item);
  }
  return ids;
}

/** 校验通知设置，规则与契约里的通知设置一致。 */
function settingsOf(payload: Record<string, unknown>, current: StoredNotificationSettings): NotificationSettings & { privacy: NotificationPrivacyLevel; revision: number } {
  const deliveryMode = payload.deliveryMode ?? current.deliveryMode;
  if (deliveryMode !== 'all-at-once' && deliveryMode !== 'two-stage') {
    throw new RouteRejection(400, CHATDSH_ERROR_CODES.requestInvalid, 'deliveryMode 取 all-at-once 或 two-stage');
  }
  const firstStageSeconds = payload.firstStageSeconds ?? current.firstStageSeconds;
  if (typeof firstStageSeconds !== 'number' || !Number.isInteger(firstStageSeconds) || firstStageSeconds < 0 || firstStageSeconds > 300) {
    throw new RouteRejection(400, CHATDSH_ERROR_CODES.requestInvalid, 'firstStageSeconds 取 0 到 300 的整数');
  }
  const secondStageSeconds = payload.secondStageSeconds ?? current.secondStageSeconds;
  if (typeof secondStageSeconds !== 'number' || !Number.isInteger(secondStageSeconds) || secondStageSeconds < 1 || secondStageSeconds > 3600) {
    throw new RouteRejection(400, CHATDSH_ERROR_CODES.requestInvalid, 'secondStageSeconds 取 1 到 3600 的整数');
  }
  if (deliveryMode === 'two-stage' && secondStageSeconds <= firstStageSeconds) {
    throw new RouteRejection(400, CHATDSH_ERROR_CODES.requestInvalid, '第二阶段等待必须大于第一阶段等待');
  }
  const flags = {
    onTurnEnd: payload.onTurnEnd ?? current.onTurnEnd,
    onApproval: payload.onApproval ?? current.onApproval,
    messagePreview: payload.messagePreview ?? current.messagePreview,
    quietWhenFocused: payload.quietWhenFocused ?? current.quietWhenFocused,
  };
  for (const [name, value] of Object.entries(flags)) {
    if (typeof value !== 'boolean') throw new RouteRejection(400, CHATDSH_ERROR_CODES.requestInvalid, `${name} 必须是布尔值`);
  }
  const privacy = payload.privacy ?? current.privacy;
  if (typeof privacy !== 'string' || !(NOTIFICATION_PRIVACY_LEVELS as readonly string[]).includes(privacy)) {
    throw new RouteRejection(400, CHATDSH_ERROR_CODES.requestInvalid, `privacy 取 ${NOTIFICATION_PRIVACY_LEVELS.join('、')}`);
  }
  const revision = payload.revision ?? current.revision;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
    throw new RouteRejection(400, CHATDSH_ERROR_CODES.requestInvalid, 'revision 必须是非负整数');
  }
  return {
    deliveryMode,
    firstStageSeconds,
    secondStageSeconds,
    onTurnEnd: flags.onTurnEnd as boolean,
    onApproval: flags.onApproval as boolean,
    messagePreview: flags.messagePreview as boolean,
    quietWhenFocused: flags.quietWhenFocused as boolean,
    privacy: privacy as NotificationPrivacyLevel,
    revision,
  };
}

/** 校验订阅的密钥材料：公钥是 65 字节未压缩点，认证密钥是 16 字节。 */
function validateKeys(endpoint: string, p256dh: string, auth: string): void {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new RouteRejection(400, CHATDSH_ERROR_CODES.requestInvalid, '订阅端点不是合法地址');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new RouteRejection(400, CHATDSH_ERROR_CODES.requestInvalid, '订阅端点必须是 HTTP 或 HTTPS 地址');
  }
  const publicKey = Buffer.from(p256dh, 'base64url');
  if (publicKey.byteLength !== 65 || publicKey[0] !== 0x04) {
    throw new RouteRejection(400, CHATDSH_ERROR_CODES.requestInvalid, '订阅公钥必须是 65 字节的未压缩 P-256 公钥');
  }
  const secret = Buffer.from(auth, 'base64url');
  if (secret.byteLength !== 16) {
    throw new RouteRejection(400, CHATDSH_ERROR_CODES.requestInvalid, '订阅认证密钥必须是 16 字节');
  }
}

/** 把订阅记录转成对外视图，端点和密钥不出现。 */
function viewOfSubscription(record: { state: PushSubscriptionView['state']; permission: PushSubscriptionView['permission']; updatedAt: number; code?: string }): PushSubscriptionView {
  return {
    state: record.state,
    permission: record.permission,
    updatedAt: record.updatedAt,
    ...(record.code === undefined ? {} : { code: record.code as PushSubscriptionView['code'] }),
  };
}

/** 记录一次拒绝。 */
function reject(context: NotificationRouteContext, span: TelemetrySpan | undefined, error: RouteRejection): void {
  span?.setAttribute('outcome', 'rejected');
  span?.setAttribute('error.code', error.code);
  context.telemetry.event?.('chatdsh.gateway.notification.rejected', {
    outcome: 'rejected',
    'error.type': 'request',
    'error.code': error.code,
  });
}

/**
 * 处理一个通知中心请求。
 * @param context - 存储、投递、验证通知与遥测。
 * @param request - 入站请求。
 * @param response - 响应。
 * @returns 是否由本模块处理。
 */
export async function handleNotificationRequest(
  context: NotificationRouteContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'gateway'}`);
  if (url.pathname !== NOTIFICATION_ROUTE_PREFIX && !url.pathname.startsWith(`${NOTIFICATION_ROUTE_PREFIX}/`)) return false;
  const suffix = url.pathname.slice(NOTIFICATION_ROUTE_PREFIX.length);
  const method = request.method ?? 'GET';

  try {
    if (suffix === '' || suffix === '/') {
      if (method !== 'GET') {
        sendJson(response, 405, { error: 'method-not-allowed' });
        return true;
      }
      const filter = filterOf(url);
      const cursor = url.searchParams.get('cursor');
      const deviceId = optionalDevice(request, url);
      const sessionId = url.searchParams.get('sessionId');
      const since = timeOf(url, 'since');
      const until = timeOf(url, 'until');
      const span = context.telemetry.startSpan?.('chatdsh.gateway.notification.list', {
        count: 0,
        outcome: 'pending',
      });
      const page: NotificationPage = context.store.list({
        filter,
        limit: limitOf(url),
        ...(cursor === null ? {} : { cursor }),
        ...(deviceId === undefined ? {} : { deviceId }),
        ...(sessionId === null ? {} : { sessionId }),
        ...(since === undefined ? {} : { since }),
        ...(until === undefined ? {} : { until }),
      });
      span?.setAttribute('count', page.items.length);
      span?.setAttribute('outcome', 'ok');
      span?.end();
      sendJson(response, 200, page);
      return true;
    }

    if (suffix === '/read') {
      if (method !== 'POST') {
        sendJson(response, 405, { error: 'method-not-allowed' });
        return true;
      }
      const span = context.telemetry.startSpan?.('chatdsh.gateway.notification.read', { outcome: 'pending' });
      const payload = await readJson(request);
      const ids = idsOf(payload);
      const clientId = requireClient(payload, request, url);
      const result: ReadResult = context.delivery.read(ids, clientId, optionalDevice(request, url));
      span?.setAttribute('count', result.marked);
      span?.setAttribute('outcome', 'ok');
      span?.end();
      sendJson(response, 200, result);
      return true;
    }

    if (suffix === '/handled') {
      if (method !== 'POST') {
        sendJson(response, 405, { error: 'method-not-allowed' });
        return true;
      }
      const span = context.telemetry.startSpan?.('chatdsh.gateway.notification.handled', { outcome: 'pending' });
      const payload = await readJson(request);
      const ids = idsOf(payload);
      const marked = context.delivery.markHandled(ids);
      span?.setAttribute('count', marked);
      span?.setAttribute('outcome', 'ok');
      span?.end();
      sendJson(response, 200, { marked, unchanged: ids.length - marked });
      return true;
    }

    if (suffix === '/settings') {
      if (method === 'GET') {
        const span = context.telemetry.startSpan?.('chatdsh.gateway.notification.settings', { action: 'read', outcome: 'pending' });
        const settings = context.store.settings();
        span?.setAttribute('outcome', 'ok');
        span?.end();
        sendJson(response, 200, settings);
        return true;
      }
      if (method === 'PUT') {
        const span = context.telemetry.startSpan?.('chatdsh.gateway.notification.settings', { action: 'write', outcome: 'pending' });
        const payload = await readJson(request);
        const proposed = settingsOf(payload, context.store.settings());
        const { revision, ...settings } = proposed;
        const saved = context.store.saveSettings(settings, revision, context.now());
        context.telemetry.counter('chatdsh_gateway_notification_settings_total', { description: '通知设置写入结果' })
          .add(1, { outcome: 'ok' });
        span?.setAttribute('outcome', 'ok');
        span?.end();
        sendJson(response, 200, saved);
        return true;
      }
      sendJson(response, 405, { error: 'method-not-allowed' });
      return true;
    }

    if (suffix === '/subscription') {
      if (method === 'GET') {
        const span = context.telemetry.startSpan?.('chatdsh.gateway.notification.subscription', { action: 'read', outcome: 'pending' });
        const deviceId = optionalDevice(request, url);
        if (deviceId === undefined) throw new RouteRejection(400, CHATDSH_ERROR_CODES.requestInvalid, '缺少设备标识');
        const records = context.store.subscriptions(deviceId);
        const latest = records[0];
        span?.setAttribute('outcome', 'ok');
        span?.end();
        sendJson(response, 200, latest === undefined
          ? { state: 'unsubscribed', permission: 'default', updatedAt: context.now() }
          : viewOfSubscription(latest));
        return true;
      }
      if (method === 'POST') {
        const span = context.telemetry.startSpan?.('chatdsh.gateway.notification.subscription', { action: 'write', outcome: 'pending' });
        const payload = await readJson(request);
        const deviceId = requireDevice(payload, request, url);
        const clientId = requireClient(payload, request, url);
        const endpoint = textField(payload, 'endpoint');
        const keys = payload.keys;
        if (endpoint === undefined || typeof keys !== 'object' || keys === null) {
          throw new RouteRejection(400, CHATDSH_ERROR_CODES.requestInvalid, '订阅需要端点与密钥');
        }
        const p256dh = textField(keys as Record<string, unknown>, 'p256dh');
        const auth = textField(keys as Record<string, unknown>, 'auth');
        if (p256dh === undefined || auth === undefined) {
          throw new RouteRejection(400, CHATDSH_ERROR_CODES.requestInvalid, '订阅需要 p256dh 与 auth');
        }
        validateKeys(endpoint, p256dh, auth);
        const permission = payload.permission ?? 'granted';
        if (permission !== 'default' && permission !== 'granted' && permission !== 'denied' && permission !== 'unsupported') {
          throw new RouteRejection(400, CHATDSH_ERROR_CODES.requestInvalid, 'permission 取值不合法');
        }
        const record = context.store.upsertSubscription({ deviceId, clientId, endpoint, p256dh, auth, permission }, context.now());
        context.telemetry.counter('chatdsh_push_subscriptions_total', { description: '推送订阅状态变化' })
          .add(1, { action: 'subscribed', outcome: 'ok' });
        span?.setAttribute('outcome', 'ok');
        span?.end();
        sendJson(response, 200, viewOfSubscription(record));
        return true;
      }
      if (method === 'DELETE') {
        const span = context.telemetry.startSpan?.('chatdsh.gateway.notification.subscription', { action: 'delete', outcome: 'pending' });
        const deviceId = optionalDevice(request, url);
        if (deviceId === undefined) throw new RouteRejection(400, CHATDSH_ERROR_CODES.requestInvalid, '缺少设备标识');
        const removed = context.store.unsubscribe(deviceId, context.now());
        context.telemetry.counter('chatdsh_push_subscriptions_total', { description: '推送订阅状态变化' })
          .add(removed, { action: 'unsubscribed', outcome: 'ok' });
        span?.setAttribute('outcome', 'ok');
        span?.end();
        sendJson(response, 200, { removed });
        return true;
      }
      sendJson(response, 405, { error: 'method-not-allowed' });
      return true;
    }

    if (suffix === '/vapid') {
      if (method !== 'GET') {
        sendJson(response, 405, { error: 'method-not-allowed' });
        return true;
      }
      const span = context.telemetry.startSpan?.('chatdsh.gateway.notification.subscription', {
        action: 'vapid',
        outcome: 'pending',
      });
      const keys = context.store.vapidKeys();
      span?.setAttribute('outcome', 'ok');
      span?.end();
      sendJson(response, 200, { publicKey: keys.publicKey, subject: keys.subject });
      return true;
    }

    if (suffix === '/probe') {
      if (method !== 'POST') {
        sendJson(response, 405, { error: 'method-not-allowed' });
        return true;
      }
      const span = context.telemetry.startSpan?.('chatdsh.gateway.notification.probe', { outcome: 'pending' });
      const payload = await readJson(request);
      const deviceId = requireDevice(payload, request, url);
      const result = await context.probe.send(deviceId);
      span?.setAttribute('outcome', result.probe.result);
      if (result.probe.code !== undefined) span?.setAttribute('error.code', result.probe.code);
      span?.end();
      sendJson(response, result.probe.result === 'failed' ? 502 : 200, result);
      return true;
    }

    if (suffix === '/probe/receipt') {
      if (method !== 'POST') {
        sendJson(response, 405, { error: 'method-not-allowed' });
        return true;
      }
      const payload = await readJson(request);
      const probeId = textField(payload, 'probeId');
      const receivedAt = payload.receivedAt;
      if (probeId === undefined || typeof receivedAt !== 'number' || !Number.isInteger(receivedAt) || receivedAt < 0) {
        throw new RouteRejection(400, CHATDSH_ERROR_CODES.requestInvalid, '需要 probeId 与接收时刻');
      }
      const probe = context.probe.receipt(probeId, receivedAt);
      sendJson(response, 200, { id: probeId, probe });
      return true;
    }

    if (suffix === '/focus') {
      if (method !== 'POST') {
        sendJson(response, 405, { error: 'method-not-allowed' });
        return true;
      }
      const payload = await readJson(request);
      const deviceId = requireDevice(payload, request, url);
      const clientId = requireClient(payload, request, url);
      const sessionId = textField(payload, 'sessionId') ?? '';
      context.store.setFocus(clientId, deviceId, sessionId, context.now());
      sendJson(response, 200, { focused: sessionId !== '', sessionId });
      return true;
    }

    sendJson(response, 404, { error: CHATDSH_ERROR_CODES.objectNotFound });
    return true;
  } catch (error) {
    if (error instanceof CursorError) {
      const rejection = new RouteRejection(400, error.code, error.message);
      reject(context, undefined, rejection);
      sendJson(response, 400, { error: rejection.code });
      return true;
    }
    if (error instanceof SettingsConflictError) {
      reject(context, undefined, new RouteRejection(409, error.code, error.message));
      sendJson(response, 409, { error: error.code, settings: error.current });
      return true;
    }
    if (error instanceof RouteRejection) {
      reject(context, undefined, error);
      sendJson(response, error.status, { error: error.code });
      return true;
    }
    const rejection = new RouteRejection(500, CHATDSH_ERROR_CODES.internalError, error instanceof Error ? error.message : '内部错误');
    reject(context, undefined, rejection);
    sendJson(response, 500, { error: rejection.code });
    return true;
  }
}
