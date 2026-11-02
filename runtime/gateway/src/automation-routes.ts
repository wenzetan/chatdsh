/**
 * 自动化接口的 HTTP 处理器。
 *
 * 覆盖列表、读取、建立、编辑、删除、启停与投递记录分页。来源、认证、CSRF 与设备范围
 * 校验在业务读写之前完成；字段校验、执行目标校验与修订号比较交换由自动化存储承担。
 * 响应形状与客户端数据入口一致，失败一律是 `{ error: 错误码 }`，不携带请求原文。
 *
 * 每个请求一个 `chatdsh.gateway.automation.<动作>` span，失败另写一条拒绝事件与计数。
 * 挂载到公共路由由集成步骤完成，本模块只返回处理函数：路径不属于本模块时返回 false，
 * 交给后续处理器。
 * @module @chatdsh/gateway/automation-routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ChatdshError,
  type AutomationEventSource,
  type ChatdshTelemetry,
  type TelemetrySpan,
} from '@chatdsh/core-contracts';
import { ClientHttpError, clientRequestId, sendClientJson, setClientResponseHeaders } from './client-errors.ts';
import { assertClientDevice, validateClientOrigin, type ClientPrincipal } from './client-security.ts';
import {
  AutomationStore,
  DELIVERY_PAGE_MAX,
  type AutomationDeliveryPage,
  type AutomationDeliveryQuery,
  type AutomationDeliveryRecord,
  type AutomationDeliveryState,
  type AutomationRecord,
} from './automation.ts';

/** 自动化记录的路径。 */
export const AUTOMATIONS_PATH = '/chatdsh/gateway/automations';

/** 投递记录分页的路径。 */
export const AUTOMATION_DELIVERIES_PATH = '/chatdsh/gateway/automation-deliveries';

/** 写操作要求的请求头，跨站表单无法携带。 */
export const AUTOMATION_CSRF_HEADER = 'x-chatdsh-csrf';

/** 建立与编辑的请求体上限。 */
const WRITE_BODY_MAX_BYTES = 64 * 1024;

/** 投递查询只接受的参数名。 */
const DELIVERY_QUERY_NAMES = new Set(['limit', 'automationId', 'state', 'source', 'cursor']);

/** 投递状态取值。 */
const DELIVERY_STATES: ReadonlySet<string> = new Set([
  'received',
  'validated',
  'dispatching',
  'accepted',
  'completed',
  'failed',
  'unconfirmed',
]);

/** 事件来源取值。 */
const EVENT_SOURCES: ReadonlySet<string> = new Set(['github', 'generic']);

/** 动作名。 */
type RouteAction = 'list' | 'read' | 'create' | 'update' | 'delete' | 'toggle' | 'deliveries' | 'other';

/** 动作与 span 名的对应。 */
const SPAN_OF_ACTION: Record<RouteAction, string> = {
  list: 'chatdsh.gateway.automation.list',
  read: 'chatdsh.gateway.automation.read',
  create: 'chatdsh.gateway.automation.create',
  update: 'chatdsh.gateway.automation.update',
  delete: 'chatdsh.gateway.automation.delete',
  toggle: 'chatdsh.gateway.automation.toggle',
  deliveries: 'chatdsh.gateway.automation.deliveries',
  other: 'chatdsh.gateway.automation.read',
};

/** 自动化接口的依赖。 */
export interface AutomationRouteOptions {
  /** 自动化存储。 */
  readonly automations: AutomationStore;
  /** 遥测面。 */
  readonly telemetry: ChatdshTelemetry;
  /** 同源地址；请求的主机与来源都按它比对。 */
  readonly origin: string;
  /** 认证回调，返回调用者的访问范围。 */
  readonly authenticate: (request: IncomingMessage) => ClientPrincipal | undefined | Promise<ClientPrincipal | undefined>;
}

/** 处理器内部的失败，携带状态码与错误码。 */
class RouteFailure extends Error {
  constructor(readonly status: number, readonly code: string, readonly reason: string) {
    super(code);
    this.name = 'RouteFailure';
  }
}

/** 错误码到 HTTP 状态码的映射。 */
function statusOf(code: string): number {
  switch (code) {
    case 'request-invalid':
    case 'cursor-invalid':
      return 400;
    case 'permission-denied':
    case 'workspace-forbidden':
    case 'origin-rejected':
    case 'csrf-required':
      return 403;
    case 'object-not-found':
    case 'device-unknown':
    case 'session-not-found':
      return 404;
    case 'payload-too-large':
      return 413;
    case 'device-offline':
    case 'device-role-mismatch':
    case 'revision-conflict':
    case 'object-in-use':
      return 409;
    default:
      return 500;
  }
}

/** 把一次失败翻译成响应体里的错误码。 */
function codeOf(error: unknown): string {
  if (error instanceof RouteFailure) return error.code;
  if (error instanceof ChatdshError) return error.code;
  if (error instanceof ClientHttpError) return error.code;
  return 'internal-error';
}

/** 把一次失败翻译成应答状态码。 */
function statusFor(error: unknown): number {
  if (error instanceof RouteFailure) return error.status;
  if (error instanceof ChatdshError) return statusOf(error.code);
  if (error instanceof ClientHttpError) return error.status;
  return 500;
}

/** 取路径末段；路径正好是基准路径时返回 undefined。 */
function subPathOf(pathname: string, base: string): string | undefined {
  if (!pathname.startsWith(`${base}/`)) return undefined;
  const rest = pathname.slice(base.length + 1);
  return rest === '' ? undefined : decodeURIComponent(rest);
}

/** 读取有界请求体。 */
async function readBody(request: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string, 'utf8');
    bytes += buffer.byteLength;
    if (bytes > limit) throw new ChatdshError('payload-too-large', '请求体超过上限', { reason: 'body' });
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 解析 JSON 请求体。 */
function jsonBodyOf(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ChatdshError('request-invalid', '请求体不是合法 JSON', { reason: 'json' });
  }
}

/** 去掉值为 undefined 的键。 */
function compact(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry;
  }
  return out;
}

/** 取路径的末段，用作工作区显示名。 */
function cwdTail(cwd: string): string | undefined {
  const segments = cwd.split(/[\\/]/).filter((segment) => segment !== '');
  const last = segments.at(-1);
  return last === undefined || last === '' ? undefined : last;
}

/** 读取执行目标里的设备标识，用于设备范围校验。 */
function targetDeviceOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;
  const target = (payload as Record<string, unknown>)['target'];
  if (typeof target !== 'object' || target === null || Array.isArray(target)) return undefined;
  const deviceId = (target as Record<string, unknown>)['deviceId'];
  return typeof deviceId === 'string' && deviceId !== '' ? deviceId : undefined;
}

/** 一条记录的响应形状。 */
function recordView(store: AutomationStore, record: AutomationRecord): Record<string, unknown> {
  const target = record.target;
  const node = target === undefined ? undefined : store.nodeOf(target.deviceId);
  const lastDelivery = store.lastDeliveryOf(record.id);
  return compact({
    id: record.id,
    name: record.name,
    trigger: record.trigger,
    action: record.action,
    enabled: record.enabled,
    createdAt: record.createdAt,
    revision: record.revision,
    updatedAt: record.updatedAt,
    spec: record.spec,
    target: target === undefined
      ? undefined
      : compact({
        deviceId: target.deviceId,
        deviceName: node?.name,
        workspaceId: target.workspaceId,
        workspaceName: target.cwd === undefined ? undefined : cwdTail(target.cwd),
        cwd: target.cwd,
        presetId: target.presetId,
        presetName: target.presetName ?? target.presetId,
        model: target.model,
      }),
    lastDelivery: lastDelivery === undefined
      ? undefined
      : compact({ state: lastDelivery.state, receivedAt: lastDelivery.receivedAt, code: lastDelivery.code }),
  });
}

/** 一条投递记录的响应形状。 */
function deliveryView(record: AutomationDeliveryRecord): Record<string, unknown> {
  return compact({
    deliveryId: record.deliveryId,
    automationId: record.automationId,
    eventId: record.eventId,
    source: record.source,
    receivedAt: record.receivedAt,
    dedupe: record.dedupe,
    state: record.state,
    sessionId: record.sessionId,
    completedAt: record.completedAt,
    code: record.code,
    reason: record.reason,
    attempts: record.attempts,
    httpStatus: record.httpStatus,
    lastAttemptAt: record.lastAttemptAt,
  });
}

/** 解析投递查询参数。 */
function deliveryQueryOf(url: URL): AutomationDeliveryQuery {
  for (const name of url.searchParams.keys()) {
    if (!DELIVERY_QUERY_NAMES.has(name) || url.searchParams.getAll(name).length !== 1) {
      throw new RouteFailure(400, 'request-invalid', 'query');
    }
  }
  const limitText = url.searchParams.get('limit');
  const limit = limitText === null ? 50 : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1 || limit > DELIVERY_PAGE_MAX) {
    throw new RouteFailure(400, 'request-invalid', 'limit');
  }
  const automationId = url.searchParams.get('automationId') ?? undefined;
  const state = url.searchParams.get('state') ?? undefined;
  if (state !== undefined && !DELIVERY_STATES.has(state)) throw new RouteFailure(400, 'request-invalid', 'state');
  const source = url.searchParams.get('source') ?? undefined;
  if (source !== undefined && !EVENT_SOURCES.has(source)) throw new RouteFailure(400, 'request-invalid', 'source');
  const cursor = url.searchParams.get('cursor') ?? undefined;
  return {
    ...(automationId === undefined ? {} : { automationId }),
    ...(state === undefined ? {} : { state: state as AutomationDeliveryState }),
    ...(source === undefined ? {} : { source: source as AutomationEventSource }),
    ...(cursor === undefined ? {} : { cursor }),
    limit,
  };
}

/** 动作判定结果。 */
interface RouteMatch {
  readonly automations: boolean;
  readonly deliveries: boolean;
  readonly subPath: string | undefined;
  readonly action: RouteAction;
}

/** 判定一次请求属于哪种动作。 */
function matchOf(pathname: string, method: string, hasId: boolean): RouteMatch | undefined {
  const automations = pathname === AUTOMATIONS_PATH || pathname.startsWith(`${AUTOMATIONS_PATH}/`);
  const deliveries = pathname === AUTOMATION_DELIVERIES_PATH;
  if (!automations && !deliveries) return undefined;
  const subPath = automations ? subPathOf(pathname, AUTOMATIONS_PATH) : undefined;
  let action: RouteAction = 'other';
  if (deliveries) action = method === 'GET' ? 'deliveries' : 'other';
  else if (subPath !== undefined) action = method === 'GET' ? 'read' : method === 'DELETE' ? 'delete' : 'other';
  else if (method === 'GET') action = hasId ? 'read' : 'list';
  else if (method === 'POST') action = 'create';
  else if (method === 'PUT') action = 'update';
  else if (method === 'DELETE') action = 'delete';
  else if (method === 'PATCH') action = 'toggle';
  return { automations, deliveries, subPath, action };
}

/**
 * 建立自动化接口的处理器。
 * @param options - 存储、遥测、同源地址与认证回调。
 * @returns HTTP 处理器；路径不属于本模块时返回 false。
 */
export function createAutomationRoutes(options: AutomationRouteOptions): (request: IncomingMessage, response: ServerResponse) => Promise<boolean> {
  const origin = validateClientOrigin(options.origin);
  const originHost = new URL(origin).host;
  const requests = options.telemetry.counter('chatdsh_gateway_automation_requests_total', { description: '自动化接口请求结果' });
  const writes = options.telemetry.counter('chatdsh_gateway_automation_writes_total', { description: '自动化记录写入结果' });
  const deliveryPages = options.telemetry.counter('chatdsh_gateway_automation_deliveries_total', { description: '投递记录分页结果' });

  /** 校验来源、认证与写入令牌。 */
  const authorize = async (request: IncomingMessage, write: boolean): Promise<ClientPrincipal> => {
    if (request.headers.host !== originHost) throw new RouteFailure(403, 'origin-rejected', 'host');
    const suppliedOrigin = request.headers.origin;
    const fetchSite = request.headers['sec-fetch-site'];
    if ((suppliedOrigin !== undefined && suppliedOrigin !== origin) || fetchSite === 'cross-site' || fetchSite === 'same-site') {
      throw new RouteFailure(403, 'origin-rejected', 'origin');
    }
    const principal = await options.authenticate(request);
    if (principal === undefined) throw new RouteFailure(401, 'auth-required', 'authentication');
    if (!Number.isFinite(principal.expiresAt) || principal.expiresAt <= Date.now()) {
      throw new RouteFailure(401, 'access-session-revoked', 'session');
    }
    if (write && request.headers[AUTOMATION_CSRF_HEADER] !== '1') {
      throw new RouteFailure(403, 'csrf-required', 'csrf');
    }
    return principal;
  };

  return async (request, response): Promise<boolean> => {
    const raw = request.url ?? '/';
    let url: URL;
    try {
      url = new URL(raw, origin);
    } catch {
      return false;
    }
    const method = (request.method ?? 'GET').toUpperCase();
    const match = matchOf(url.pathname, method, url.searchParams.has('id'));
    if (match === undefined) return false;

    const requestId = clientRequestId(request);
    setClientResponseHeaders(response, requestId);
    const carrier = {
      traceparent: typeof request.headers.traceparent === 'string' ? request.headers.traceparent : undefined,
      tracestate: typeof request.headers.tracestate === 'string' ? request.headers.tracestate : undefined,
    };
    const attributes = { action: match.action };

    try {
      await options.telemetry.withContext(carrier, () => options.telemetry.runSpan(SPAN_OF_ACTION[match.action], attributes, async (span) => {
        try {
          const principal = await authorize(request, method !== 'GET' && method !== 'HEAD');
          await handle({ request, response, url, match, method, principal, span });
          span.setAttribute('outcome', 'ok');
          requests.add(1, { action: match.action, outcome: 'ok' });
        } catch (error) {
          const code = codeOf(error);
          const type = error instanceof Error ? error.name : 'Unknown';
          span.setAttribute('outcome', 'failed');
          span.setAttribute('error.type', type);
          span.setAttribute('error.code', code);
          options.telemetry.event('chatdsh.gateway.automation.rejected', {
            action: match.action,
            outcome: 'failed',
            'error.type': type,
            'error.code': code,
            reason: error instanceof RouteFailure ? error.reason : error instanceof ChatdshError ? String(error.details['reason'] ?? 'rejected') : 'internal',
          });
          requests.add(1, { action: match.action, outcome: 'failed' });
          throw error;
        }
      }));
    } catch (error) {
      sendClientJson(response, statusFor(error), { error: codeOf(error), requestId });
    }
    return true;
  };

  /** 执行一次具体动作。 */
  async function handle(context: {
    readonly request: IncomingMessage;
    readonly response: ServerResponse;
    readonly url: URL;
    readonly match: RouteMatch;
    readonly method: string;
    readonly principal: ClientPrincipal;
    readonly span: TelemetrySpan;
  }): Promise<void> {
    const { request, response, url, match, method, principal, span } = context;
    if (match.deliveries) {
      if (method !== 'GET') throw new RouteFailure(405, 'method-not-allowed', 'method');
      const query = deliveryQueryOf(url);
      const page: AutomationDeliveryPage = options.automations.deliveries(query);
      span.setAttribute('count', page.deliveries.length);
      deliveryPages.add(1, { outcome: 'ok' });
      sendClientJson(response, 200, compact({
        deliveries: page.deliveries.map(deliveryView),
        nextCursor: page.nextCursor,
      }));
      return;
    }
    if (match.subPath !== undefined) {
      const id = match.subPath;
      if (method === 'GET') {
        const record = options.automations.get(id);
        if (record === undefined) throw new RouteFailure(404, 'automation-not-found', 'missing');
        sendClientJson(response, 200, recordView(options.automations, record));
        return;
      }
      if (method === 'DELETE') {
        if (!options.automations.remove(id)) throw new RouteFailure(404, 'automation-not-found', 'missing');
        writes.add(1, { action: 'delete', outcome: 'ok' });
        response.writeHead(204);
        response.end();
        return;
      }
      throw new RouteFailure(405, 'method-not-allowed', 'method');
    }
    if (method === 'GET') {
      if (match.action === 'read') {
        const record = options.automations.get(recordIdOf(url));
        if (record === undefined) throw new RouteFailure(404, 'automation-not-found', 'missing');
        sendClientJson(response, 200, recordView(options.automations, record));
        return;
      }
      const records = options.automations.list();
      span.setAttribute('count', records.length);
      sendClientJson(response, 200, { automations: records.map((record) => recordView(options.automations, record)) });
      return;
    }
    if (method === 'POST' || method === 'PUT') {
      const payload = jsonBodyOf(await readBody(request, WRITE_BODY_MAX_BYTES));
      const deviceId = targetDeviceOf(payload);
      if (deviceId !== undefined) assertClientDevice(principal, deviceId);
      if (method === 'POST') {
        const record = options.automations.createDraft(payload);
        span.setAttribute('trigger.kind', record.trigger.kind);
        writes.add(1, { action: 'create', outcome: 'ok' });
        sendClientJson(response, 201, recordView(options.automations, record));
        return;
      }
      const record = options.automations.updateDraft(payload);
      if (record === undefined) throw new RouteFailure(404, 'automation-not-found', 'missing');
      span.setAttribute('trigger.kind', record.trigger.kind);
      writes.add(1, { action: 'update', outcome: 'ok' });
      sendClientJson(response, 200, recordView(options.automations, record));
      return;
    }
    if (method === 'DELETE') {
      const id = recordIdOf(url);
      if (!options.automations.remove(id)) throw new RouteFailure(404, 'automation-not-found', 'missing');
      writes.add(1, { action: 'delete', outcome: 'ok' });
      response.writeHead(204);
      response.end();
      return;
    }
    if (method === 'PATCH') {
      const payload = jsonBodyOf(await readBody(request, WRITE_BODY_MAX_BYTES));
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        throw new RouteFailure(400, 'request-invalid', 'payload');
      }
      const value = payload as Record<string, unknown>;
      const id = value['id'];
      const enabled = value['enabled'];
      if (typeof id !== 'string' || id === '' || typeof enabled !== 'boolean') {
        throw new RouteFailure(400, 'request-invalid', 'payload');
      }
      const revision = value['revision'];
      if (revision !== undefined && (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0)) {
        throw new RouteFailure(400, 'request-invalid', 'revision');
      }
      if (typeof revision === 'number') {
        const current = options.automations.get(id);
        if (current === undefined) throw new RouteFailure(404, 'automation-not-found', 'missing');
        if (current.revision !== revision) throw new RouteFailure(409, 'revision-conflict', 'revision');
      }
      const record = options.automations.setEnabled(id, enabled);
      if (record === undefined) throw new RouteFailure(404, 'automation-not-found', 'missing');
      span.setAttribute('enabled', enabled);
      writes.add(1, { action: 'toggle', outcome: 'ok' });
      sendClientJson(response, 200, recordView(options.automations, record));
      return;
    }
    throw new RouteFailure(405, 'method-not-allowed', 'method');
  }
}

/** 从查询串取记录标识。 */
function recordIdOf(url: URL): string {
  const id = url.searchParams.get('id');
  if (id === null || id === '') throw new RouteFailure(400, 'request-invalid', 'id');
  return id;
}
