/**
 * 控制平面的 HTTP 服务：内置路由加反向代理。
 *
 * 客户端只与控制平面通信，运行时不对外。单账号形态下没有身份头部：请求的去向由设备的
 * 归属决定，反代只改写 Host 与 Origin 一类的传输头部。
 *
 * 每个入站请求一个 `chatdsh.gateway.http` span，反代另有一个 `chatdsh.gateway.proxy`。
 * @module @chatdsh/gateway/server
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';
import type { ChatdshTelemetry } from '@chatdsh/core-contracts';
import { NODE_HEADERS, CHATDSH_ERROR_CODES } from '@chatdsh/core-contracts';
import type { GatewayConfig, GatewayStore, NodeRole, ReceiptStore, ReplicaStore, SettingsStore, ShareStore } from './store.ts';
import { SETTINGS_NAMESPACES } from './store.ts';
import type { PushHub } from './push.ts';
import type { RuntimeTarget } from './runtime.ts';
import { renderSharePage } from './render.ts';
import { AutomationStore, handleWebhook } from './automation.ts';
import { handleLlmRequest, LlmQuotaLedger } from './llm.ts';
import { McpRegistry } from './mcp-registry.ts';
import {
  authenticateMobileDevice,
  deviceTokenHash,
  handleMobileTelemetryRequest,
  MOBILE_TELEMETRY_PATH,
  readLimitedBody,
} from './mobile-http.ts';
import { MobileTelemetryRelay } from './mobile-telemetry.ts';
import {
  bridgeSockets,
  handleMobileChannel,
  isMobileChannelPath,
  openUpstreamUpgrade,
  pairingPayload,
} from './mobile-channel.ts';
import { DEVICE_LINK_PATH, DeviceLinkError, nodeTokenOf, type DeviceLinkHub } from './device-link.ts';
import { aggregateSessions } from './sessions.ts';
import { DevicePluginsError, fetchDevicePlugins } from './device-plugins.ts';
import { SHELL_SCRIPT_PATH, readShellScript, renderShellPage, shellBuilt } from './shell.ts';
import { encodeServerTextFrame } from './websocket.ts';

/** 服务实例。 */
export interface GatewayServer {
  /** 开始监听。 */
  start(): Promise<void>;
  /** 停止监听并等待连接关闭。 */
  stop(): Promise<void>;
  /** 实际监听的地址。 */
  url(): string;
}

/** 请求处理的共享上下文。 */
interface HandlerContext {
  readonly config: GatewayConfig;
  readonly store: GatewayStore;
  readonly replica: ReplicaStore;
  readonly share: ShareStore;
  /** 已读水位。 */
  readonly receipts: ReceiptStore;
  /** 白名单设置的存储。 */
  readonly settings: SettingsStore;
  readonly push: PushHub;
  readonly telemetry: ChatdshTelemetry;
  /** 设备长连接的在线表与转发面。 */
  readonly deviceLink: DeviceLinkHub;
  /** 托管的运行时目标；缺省时按配置的固定地址反代。 */
  readonly runtime?: RuntimeTarget;
  /** 启动路径下发端点要求的口令；缺省时端点关闭。 */
  readonly bootstrapSecret?: string;
}

/** 设备链路自检端点的路径形状。 */
const DEVICE_PROBE_PATH = /^\/chatdsh\/gateway\/devices\/([^/]+)\/probe$/;

/** 按设备路由的路径形状：`/d/<deviceId>` 与它下面的全部路径。 */
const DEVICE_PREFIX_PATH = /^\/d\/([^/]+)(\/.*)?$/;

/** 按设备取插件清单的路径形状。 */
const DEVICE_PLUGINS_PATH = /^\/chatdsh\/gateway\/devices\/([^/]+)\/plugins$/;

/** 外壳静态资源的路径前缀。 */
const SHELL_ASSET_PREFIX = '/shell/';

/** 逐跳头部：前缀反代时不转发请求方向，也不回填响应方向。 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * 浏览器安全头：前缀反代是控制平面到设备的服务端转发，这一段不带浏览器语境。
 *
 * 设备运行时按 `Host`、`Origin` 与 `Sec-Fetch-Site` 判定请求可信：外壳与 iframe 同源，
 * 浏览器发出的 `Origin`、`Referer` 是控制平面的地址，直接透传会被设备当成跨源请求而回
 * 403。控制平面已在这一层做完入站校验，交给设备的是一份不带这些头部的服务端请求。
 */
const BROWSER_SECURITY_HEADERS = new Set([
  'origin',
  'referer',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-fetch-user',
]);

/** 前缀反代的请求体上限，与长连接单帧载荷上限一致。 */
const DEVICE_PROXY_BODY_LIMIT = 8 * 1024 * 1024;

/** 前缀反代的转发超时。 */
const DEVICE_PROXY_TIMEOUT_MS = 60_000;

/** 路由分类，用于指标的 `route` 属性与 span 命名。方法目前不参与分类，保留参数以便后续区分读写。 */
function routeOf(_method: string, path: string): string {
  if (path === '/healthz') return 'healthz';
  if (path === '/' || path === '/index.html') return 'shell';
  if (path.startsWith(SHELL_ASSET_PREFIX)) return 'shell-asset';
  if (path === '/chatdsh/gateway/bootstrap') return 'bootstrap';
  if (path === '/chatdsh/gateway/mobile/pair') return 'mobile-pair';
  if (path === '/chatdsh/gateway/mobile/session') return 'mobile-session';
  if (path === MOBILE_TELEMETRY_PATH) return 'mobile-telemetry';
  if (path === '/chatdsh/gateway/mobile/devices') return 'mobile-devices';
  if (path === '/chatdsh/gateway/mobile/pairing') return 'mobile-pairing';
  if (path === '/chatdsh/gateway/ownership') return 'ownership';
  if (path === '/chatdsh/gateway/local') return 'local';
  if (path === '/chatdsh/gateway/settings') return 'settings';
  if (path === '/chatdsh/gateway/sessions') return 'sessions';
  if (path === '/chatdsh/gateway/devices/pair') return 'device-pair';
  if (DEVICE_PROBE_PATH.test(path)) return 'device-probe';
  if (DEVICE_PLUGINS_PATH.test(path)) return 'device-plugins';
  if (path === '/chatdsh/gateway/devices') return 'devices';
  if (path === '/chatdsh/gateway/replica') return 'replica';
  if (path === '/chatdsh/gateway/share') return 'share';
  if (path === '/chatdsh/gateway/shares') return 'share-list';
  if (path === '/chatdsh/gateway/receipt') return 'receipt';
  if (path === '/chatdsh/gateway/import') return 'import';
  if (path === '/chatdsh/gateway/events') return 'events';
  if (path.startsWith('/chatdsh/gateway/webhook/')) return 'webhook';
  if (path === '/chatdsh/gateway/automations') return 'automations';
  if (path === '/chatdsh/gateway/mcp') return 'mcp';
  if (path === '/chatdsh/gateway/llm') return 'llm';
  if (path.startsWith('/s/')) return 'snapshot';
  if (DEVICE_PREFIX_PATH.test(path)) return 'device-proxy';
  if (path.startsWith('/api/')) return 'api';
  if (path.startsWith('/plugins/')) return 'plugins';
  return 'static';
}

/** HTTP 状态码的分类，用于指标的 `status_class` 属性。 */
function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
}

/** 浏览器设备标识的 cookie 名。 */
const DEVICE_COOKIE = 'chatdsh-device';

/** 从 Cookie 头取一个值。 */
function cookieOf(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    if (value !== '') return decodeURIComponent(value);
  }
  return undefined;
}

/**
 * 根路径是否仍然交给运行时。
 *
 * 运行时的启动路径带 `token` 查询参数，登录之后的运行时页面带 `dsh-auth-*` cookie：
 * 这两种请求照旧反代给运行时（桌面壳与手机都用这条路径取界面凭据），其余请求由控制
 * 平面返回外壳页面。
 * @param request - 入站请求。
 * @returns 仍然要反代的请求为真。
 */
function isRuntimeRootRequest(request: IncomingMessage): boolean {
  const raw = request.url ?? '/';
  const queryAt = raw.indexOf('?');
  if (queryAt !== -1 && new URLSearchParams(raw.slice(queryAt)).has('token')) return true;
  const cookie = request.headers.cookie;
  if (typeof cookie !== 'string') return false;
  return cookie.split(';').some((part) => part.trim().startsWith('dsh-auth-'));
}

/** 取请求的设备标识；没有节点标识头与 cookie 时发一个新标识。 */
function deviceIdOf(request: IncomingMessage): { id: string; issued: boolean } {
  const header = request.headers[NODE_HEADERS.id];
  if (typeof header === 'string' && header !== '') return { id: header, issued: false };
  const cookie = cookieOf(request.headers.cookie, DEVICE_COOKIE);
  if (cookie !== undefined) return { id: cookie, issued: false };
  return { id: `web-${randomUUID()}`, issued: true };
}

/** 请求来源：优先取反代写入的转发头，保持协议、主机与端口逐字一致。 */
function originOf(request: IncomingMessage): string {
  const forwardedProto = request.headers['x-forwarded-proto'];
  const proto = (typeof forwardedProto === 'string' ? forwardedProto.split(',')[0]?.trim() : undefined) ?? 'http';
  const forwardedHost = request.headers['x-forwarded-host'];
  const host = (typeof forwardedHost === 'string' ? forwardedHost.split(',')[0]?.trim() : undefined)
    ?? request.headers.host
    ?? '127.0.0.1';
  return `${proto}://${host}`;
}

/** 平台分类；只记录有界枚举，不保存原始 User-Agent。 */
function platformOf(request: IncomingMessage): string {
  const explicit = request.headers['x-chatdsh-platform'];
  if (typeof explicit === 'string' && explicit !== '') return explicit.slice(0, 32);
  const agent = String(request.headers['user-agent'] ?? '');
  if (/Electron/i.test(agent)) return 'desktop';
  if (/Android|iPhone|iPad|Mobile/i.test(agent)) return 'mobile';
  if (agent !== '') return 'web';
  return 'unknown';
}

function sameSecret(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

/**
 * 建立控制平面服务。
 * @param context - 配置、存储与遥测。
 */
export function createGatewayServer(context: HandlerContext): GatewayServer {
  const { config, store, replica, share, receipts, settings, push, telemetry } = context;
  const mobileRelay = new MobileTelemetryRelay(telemetry);
  const automations = new AutomationStore(store.handle());
  const llmLedger = new LlmQuotaLedger(store, config.llmGateway.quota);
  const mcpRegistry = new McpRegistry(store.handle());
  const upgradedSockets = new Set<Duplex>();

  /**
   * 解析请求代表的设备。
   *
   * 执行节点用节点令牌证明身份，令牌无效时拒绝；没有令牌时接受普通节点标识头与浏览器
   * cookie。这个结果只决定记录归属的设备，不再用于账号维度的归属判定。
   * @param request - 入站请求。
   * @param browserDeviceId - 浏览器设备标识。
   * @returns 设备标识；令牌无效时返回错误码。
   */
  function deviceOfRequest(request: IncomingMessage, browserDeviceId: string): { id: string; source: 'token' | 'header' | 'browser' } | { error: string } {
    const token = nodeTokenOf(request);
    if (token !== '') {
      const node = store.nodeByTokenHash(deviceTokenHash(token));
      return node === undefined ? { error: 'node-token-invalid' } : { id: node.id, source: 'token' };
    }
    const header = request.headers[NODE_HEADERS.id];
    if (typeof header === 'string' && header !== '') return { id: header, source: 'header' };
    return { id: browserDeviceId, source: 'browser' };
  }

  /**
   * 写一条会话归属。
   *
   * `deviceId` 在这里确定，之后不再修改：已经有归属的会话再写一次同设备属于幂等，写另一台
   * 设备按冲突拒绝。目标设备不在线时明确失败，不排队、不改路由。
   */
  async function writeOwnership(request: IncomingMessage, response: ServerResponse): Promise<void> {
    await telemetry.runSpan('chatdsh.gateway.ownership.write', {}, async (span) => {
      const reject = (status: number, errorType: string, errorCode: string): void => {
        span.setAttribute('outcome', 'rejected');
        span.setAttribute('error.type', errorType);
        span.setAttribute('error.code', errorCode);
        telemetry.event('chatdsh.gateway.ownership.rejected', {
          action: 'write',
          outcome: 'rejected',
          'error.type': errorType,
          'error.code': errorCode,
        });
        telemetry.counter('chatdsh_gateway_ownership_writes_total', { description: '会话归属写入次数' })
          .add(1, { outcome: 'rejected' });
        sendJson(response, status, { error: errorCode });
      };
      const body = await readLimitedBody(request, 64 * 1024);
      if (body === undefined) {
        reject(413, 'request', 'payload-too-large');
        return;
      }
      let payload: { sessionId?: unknown; deviceId?: unknown; cwd?: unknown; kind?: unknown; workspaceId?: unknown };
      try {
        payload = JSON.parse(body) as typeof payload;
      } catch {
        reject(400, 'payload', 'invalid-json');
        return;
      }
      if (typeof payload.sessionId !== 'string' || payload.sessionId === '') {
        reject(400, 'payload', 'session-id-required');
        return;
      }
      if (typeof payload.deviceId !== 'string' || payload.deviceId === '') {
        reject(400, 'payload', 'device-id-required');
        return;
      }
      if (typeof payload.cwd !== 'string' || payload.cwd === '') {
        reject(400, 'payload', 'cwd-required');
        return;
      }
      const kind = payload.kind === undefined ? 'work' : payload.kind;
      if (kind !== 'work' && kind !== 'chat') {
        reject(400, 'payload', 'kind-invalid');
        return;
      }
      if (payload.workspaceId !== undefined && typeof payload.workspaceId !== 'string') {
        reject(400, 'payload', 'workspace-id-invalid');
        return;
      }
      const node = store.nodeById(payload.deviceId);
      if (node === undefined) {
        reject(404, 'request', 'device-not-found');
        return;
      }
      const existing = store.getSession(payload.sessionId);
      if (existing !== undefined && existing.deviceId !== node.id) {
        reject(409, 'request', 'ownership-device-locked');
        return;
      }
      if (existing === undefined && !context.deviceLink.online(node.id)) {
        reject(409, 'link', 'device-offline');
        return;
      }
      store.upsertSession({
        sessionId: payload.sessionId,
        workspaceId: payload.workspaceId as string | undefined,
        deviceId: node.id,
        cwd: payload.cwd,
        kind,
        createdAt: Date.now(),
      });
      const record = store.getSession(payload.sessionId);
      span.setAttribute('outcome', 'written');
      telemetry.counter('chatdsh_gateway_ownership_writes_total', { description: '会话归属写入次数' })
        .add(1, { outcome: existing === undefined ? 'created' : 'unchanged' });
      sendJson(response, 200, {
        created: existing === undefined,
        sessionId: record?.sessionId ?? payload.sessionId,
        deviceId: record?.deviceId ?? node.id,
        cwd: record?.cwd ?? payload.cwd,
        kind: record?.kind ?? kind,
        ...(record?.workspaceId === undefined ? {} : { workspaceId: record.workspaceId }),
        createdAt: record?.createdAt ?? Date.now(),
      });
    });
  }

  /**
   * 把一次 `/d/<deviceId>/<rest>` 请求经该设备的长连接转发出去。
   *
   * 保留方法、查询串与请求体；回填状态码、响应头与响应体。设备不存在返回 404，
   * 设备离线返回 409。这两种情况都不回退到宿主机运行时，也不排队。
   */
  async function proxyToDevice(
    request: IncomingMessage,
    response: ServerResponse,
    path: string
  ): Promise<void> {
    const matched = DEVICE_PREFIX_PATH.exec(path);
    const method = request.method ?? 'GET';
    const deviceId = matched?.[1] === undefined ? '' : decodeURIComponent(matched[1]);
    await telemetry.runSpan('chatdsh.gateway.device.proxy', { deviceId, 'http.method': method }, async (span) => {
      const reject = (status: number, errorType: string, errorCode: string): void => {
        span.setAttribute('outcome', 'rejected');
        span.setAttribute('error.type', errorType);
        span.setAttribute('error.code', errorCode);
        telemetry.event('chatdsh.gateway.device.rejected', {
          action: 'proxy',
          outcome: 'rejected',
          'error.type': errorType,
          'error.code': errorCode,
        });
        telemetry.counter('chatdsh_gateway_device_proxies_total', { description: '按设备路由的转发次数' })
          .add(1, { outcome: errorCode });
        sendJson(response, status, { error: errorCode });
      };
      const node = deviceId === '' ? undefined : store.nodeById(deviceId);
      if (node === undefined) {
        reject(404, 'request', 'device-not-found');
        return;
      }
      if (!context.deviceLink.online(node.id)) {
        reject(409, 'link', 'device-offline');
        return;
      }
      const rest = matched?.[2] === undefined || matched[2] === '' ? '/' : matched[2];
      const raw = request.url ?? path;
      const queryAt = raw.indexOf('?');
      const targetPath = queryAt === -1 ? rest : `${rest}${raw.slice(queryAt)}`;
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        if (value === undefined) continue;
        const lowered = key.toLowerCase();
        if (HOP_BY_HOP_HEADERS.has(lowered)) continue;
        if (BROWSER_SECURITY_HEADERS.has(lowered)) continue;
        if (lowered === 'host' || lowered === 'content-length') continue;
        headers[lowered] = Array.isArray(value) ? value.join(', ') : value;
      }
      const carrier = telemetry.inject({});
      if (headers.traceparent === undefined && carrier.traceparent !== undefined) headers.traceparent = carrier.traceparent;
      if (headers.tracestate === undefined && carrier.tracestate !== undefined) headers.tracestate = carrier.tracestate;
      const body = await readRawBody(request, DEVICE_PROXY_BODY_LIMIT);
      if (body === undefined) {
        reject(413, 'request', 'payload-too-large');
        return;
      }
      try {
        const reply = await context.deviceLink.sendRequest(
          node.id,
          { method, path: targetPath, headers, body: body.length === 0 ? undefined : body },
          DEVICE_PROXY_TIMEOUT_MS
        );
        span.setAttribute('outcome', 'forwarded');
        span.setAttribute('http.status_code', reply.status);
        telemetry.counter('chatdsh_gateway_device_proxies_total', { description: '按设备路由的转发次数' })
          .add(1, { outcome: 'forwarded' });
        const replyHeaders: Record<string, string | string[]> = {};
        const isHead = method === 'HEAD';
        for (const [key, value] of Object.entries(reply.headers)) {
          const lowered = key.toLowerCase();
          if (HOP_BY_HOP_HEADERS.has(lowered)) continue;
          // 设备侧的 fetch 已经解开了内容编码，长度按实际字节重算；HEAD 没有响应体，保留原值。
          if (lowered === 'content-encoding') continue;
          if (lowered === 'content-length' && !isHead) continue;
          replyHeaders[lowered] = typeof value === 'string' ? value : [...value];
        }
        if (!isHead) replyHeaders['content-length'] = String(reply.body.length);
        response.writeHead(reply.status, replyHeaders);
        response.end(reply.body);
      } catch (error) {
        if (error instanceof DeviceLinkError && error.code === 'device-timeout') {
          reject(504, 'link', 'device-timeout');
          return;
        }
        reject(502, 'link', error instanceof DeviceLinkError ? error.code : 'device-link-failed');
      }
    });
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    const matchedRoute = routeOf(request.method ?? 'GET', path);
    // 根路径默认由控制平面返回外壳；运行时的启动路径与登录后的运行时页面仍走默认反代。
    const route = matchedRoute === 'shell' && isRuntimeRootRequest(request) ? 'static' : matchedRoute;
    const started = Date.now();
    const device = deviceIdOf(request);
    if (device.issued) {
      response.setHeader('Set-Cookie', `${DEVICE_COOKIE}=${encodeURIComponent(device.id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
    }

    const traceCarrier: Record<string, string> = {};
    if (typeof request.headers.traceparent === 'string') traceCarrier.traceparent = request.headers.traceparent;
    if (typeof request.headers.tracestate === 'string') traceCarrier.tracestate = request.headers.tracestate;

    return telemetry.withContext(traceCarrier, () => telemetry.runSpan('chatdsh.gateway.http', {
      'http.route': route,
      'http.method': request.method ?? 'GET',
    }, async (span) => {
      response.on('finish', () => {
        span.setAttribute('http.status_code', response.statusCode);
        telemetry.counter('chatdsh_http_requests_total', { description: '控制平面入站请求数' })
          .add(1, { route, method: request.method ?? 'GET', status_class: statusClass(response.statusCode) });
        telemetry.histogram('chatdsh_http_request_duration_seconds', { unit: 's', description: '控制平面请求耗时' })
          .record((Date.now() - started) / 1000, { route, method: request.method ?? 'GET' });
      });

      if (route === 'healthz') {
        sendJson(response, 200, {
          ok: true,
          service: 'chatdsh-gateway',
          version: config.version,
          runtime: { ready: context.runtime?.ready() ?? true },
        });
        return;
      }

      // 外壳页面与它的脚本：控制平面自己托管，与运行时的前端产物无关。
      if (route === 'shell') {
        const html = renderShellPage();
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(html),
          'Cache-Control': 'no-store',
        });
        response.end(html);
        return;
      }

      if (route === 'shell-asset') {
        if (path !== SHELL_SCRIPT_PATH) {
          sendJson(response, 404, { error: 'not-found' });
          return;
        }
        if (!shellBuilt()) {
          sendJson(response, 503, { error: 'shell-not-built' });
          return;
        }
        const script = readShellScript();
        response.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Content-Length': String(script.length),
          'Cache-Control': 'no-store',
        });
        response.end(script);
        return;
      }

      // 左栏的聚合会话列表：只读归属表与副本，不查询设备。
      if (route === 'sessions') {
        if (request.method !== 'GET') {
          sendJson(response, 405, { error: 'method-not-allowed' });
          return;
        }
        await telemetry.runSpan('chatdsh.gateway.sessions.list', {}, async (span) => {
          const snapshot = aggregateSessions({
            store,
            replica,
            online: (deviceId) => context.deviceLink.online(deviceId),
          });
          const sessionCount = snapshot.devices.reduce((total, device) => total + device.sessions.length, 0);
          span.setAttribute('device.count', snapshot.devices.length);
          span.setAttribute('session.count', sessionCount);
          span.setAttribute('outcome', 'ok');
          sendJson(response, 200, snapshot);
        });
        return;
      }

      // 本机运行时：外壳的「在本机继续」需要一个本机设备。控制平面的默认运行时地址就是
      // 本机；它在设备表里没有登记时，该动作不可用并给出原因。
      if (route === 'local') {
        if (request.method !== 'GET') {
          sendJson(response, 405, { error: 'method-not-allowed' });
          return;
        }
        const localNode = store.listNodes().find((node) => node.role === 'host' || node.role === 'both');
        const available = context.runtime?.ready() === true || localNode !== undefined;
        sendJson(response, 200, {
          available,
          deviceId: localNode?.id ?? 'local',
          ...(available ? {} : { reason: '本机运行时未登记为设备' }),
        });
        return;
      }

      // 白名单设置的同步：GET 读全部白名单命名空间的设置，POST 写一条并记接收时刻。
      if (route === 'settings') {
        const namespaces = new Set<string>(SETTINGS_NAMESPACES);
        if (request.method === 'GET') {
          await telemetry.runSpan('chatdsh.gateway.settings.read', {}, async (span) => {
            const snapshot = settings.snapshot();
            span.setAttribute('namespace.count', Object.keys(snapshot).length);
            span.setAttribute('outcome', 'ok');
            sendJson(response, 200, { namespaces: snapshot });
          });
          return;
        }
        if (request.method === 'POST') {
          await telemetry.runSpan('chatdsh.gateway.settings.write', {}, async (span) => {
            const reject = (status: number, errorType: string, errorCode: string): void => {
              span.setAttribute('outcome', 'rejected');
              span.setAttribute('error.type', errorType);
              span.setAttribute('error.code', errorCode);
              telemetry.event('chatdsh.gateway.settings.rejected', { outcome: 'rejected', 'error.type': errorType, 'error.code': errorCode });
              telemetry.counter('chatdsh_gateway_settings_writes_total', { description: '设置同步写入次数' })
                .add(1, { outcome: errorCode });
              sendJson(response, status, { error: errorCode });
            };
            const body = await readBody(request, 128 * 1024);
            let payload: { namespace?: unknown; key?: unknown; value?: unknown };
            try {
              payload = JSON.parse(body) as { namespace?: unknown; key?: unknown; value?: unknown };
            } catch {
              reject(400, 'payload', 'invalid-json');
              return;
            }
            if (typeof payload.namespace !== 'string' || typeof payload.key !== 'string' || payload.key === '') {
              reject(400, 'payload', 'invalid-payload');
              return;
            }
            if (!namespaces.has(payload.namespace)) {
              reject(400, 'policy', 'namespace-not-whitelisted');
              return;
            }
            const value = typeof payload.value === 'string' ? payload.value : JSON.stringify(payload.value);
            const updatedAt = settings.put({ namespace: payload.namespace, key: payload.key, value });
            span.setAttribute('outcome', 'written');
            telemetry.counter('chatdsh_gateway_settings_writes_total', { description: '设置同步写入次数' })
              .add(1, { outcome: 'written' });
            // 推给其余在线设备：设置同步走设备长连接的推送通道。
            const event = JSON.stringify({ kind: 'settings', namespace: payload.namespace, key: payload.key, value, updatedAt });
            for (const deviceId of context.deviceLink.onlineIds()) {
              void context.deviceLink.sendRequest(deviceId, { method: 'POST', path: '/chatdsh/device/settings', headers: { 'content-type': 'application/json' }, body: Buffer.from(event, 'utf8') }, 10_000).catch(() => undefined);
            }
            sendJson(response, 200, { namespace: payload.namespace, key: payload.key, updatedAt });
          });
          return;
        }
        sendJson(response, 405, { error: 'method-not-allowed' });
        return;
      }

      // 按设备取插件清单：沿该设备的长连接调它运行时的插件管理端点。
      if (route === 'device-plugins') {
        if (request.method !== 'GET') {
          sendJson(response, 405, { error: 'method-not-allowed' });
          return;
        }
        const matched = DEVICE_PLUGINS_PATH.exec(path);
        const deviceId = matched?.[1] === undefined ? '' : decodeURIComponent(matched[1]);
        await telemetry.runSpan('chatdsh.gateway.device.plugins', { deviceId }, async (span) => {
          const reject = (status: number, errorType: string, errorCode: string): void => {
            span.setAttribute('outcome', 'rejected');
            span.setAttribute('error.type', errorType);
            span.setAttribute('error.code', errorCode);
            telemetry.event('chatdsh.gateway.device.rejected', {
              action: 'plugins',
              outcome: 'rejected',
              'error.type': errorType,
              'error.code': errorCode,
            });
            telemetry.counter('chatdsh_gateway_device_plugins_total', { description: '按设备取插件清单的次数' })
              .add(1, { outcome: errorCode });
            sendJson(response, status, { error: errorCode });
          };
          const node = deviceId === '' ? undefined : store.nodeById(deviceId);
          if (node === undefined) {
            reject(404, 'request', 'device-not-found');
            return;
          }
          if (!context.deviceLink.online(node.id)) {
            reject(409, 'link', 'device-offline');
            return;
          }
          try {
            const snapshot = await fetchDevicePlugins({
              deviceLink: context.deviceLink,
              deviceId: node.id,
              traceHeaders: telemetry.inject({}),
            });
            span.setAttribute('bundle.count', snapshot.bundles.length);
            span.setAttribute('plugin.count', snapshot.plugins.length);
            span.setAttribute('outcome', 'ok');
            telemetry.counter('chatdsh_gateway_device_plugins_total', { description: '按设备取插件清单的次数' })
              .add(1, { outcome: 'ok' });
            sendJson(response, 200, snapshot);
          } catch (error) {
            if (error instanceof DeviceLinkError) {
              reject(error.code === 'device-timeout' ? 504 : 502, 'link', error.code);
              return;
            }
            if (error instanceof DevicePluginsError) {
              if (error.upstreamStatus !== undefined) span.setAttribute('device.status_code', error.upstreamStatus);
              reject(502, 'device', error.code);
              return;
            }
            reject(502, 'device', 'device-plugins-failed');
          }
        });
        return;
      }

      // 启动路径下发：桌面壳持有口令，用它换取运行时的带令牌路径，再把窗口指过来。
      if (route === 'bootstrap') {
        const expected = context.bootstrapSecret;
        const provided = request.headers['x-chatdsh-bootstrap'];
        if (expected === undefined || typeof provided !== 'string' || !sameSecret(provided, expected)) {
          sendJson(response, 404, { error: 'not-found' });
          return;
        }
        const bootPath = context.runtime?.bootPath();
        if (context.runtime === undefined || !context.runtime.ready() || bootPath === undefined) {
          sendJson(response, 503, { error: 'runtime-not-ready' });
          return;
        }
        sendJson(response, 200, { ready: true, path: bootPath });
        return;
      }

      // webhook 投递：鉴权走记录里的密钥环境变量，不依赖控制平面的身份头，因此放在身份解析之前。
      if (route === 'webhook') {
        if (request.method !== 'POST') {
          sendJson(response, 405, { error: 'method-not-allowed' });
          return;
        }
        const automationId = path.slice('/chatdsh/gateway/webhook/'.length);
        const body = await readBody(request, 256 * 1024);
        const result = await telemetry.runSpan('chatdsh.gateway.webhook', { 'automation.id': automationId }, async (span) => {
          const headers: Record<string, string | undefined> = {};
          for (const [key, value] of Object.entries(request.headers)) {
            headers[key] = Array.isArray(value) ? value[0] : value;
          }
          const outcome = handleWebhook(automations, automationId, headers, body);
          span.setAttribute('outcome', String(outcome.status));
          telemetry.counter('chatdsh_webhook_receipts_total', { description: 'webhook 投递结果' })
            .add(1, { outcome: String(outcome.status) });
          if (outcome.status >= 400) {
            telemetry.event('chatdsh.gateway.webhook.rejected', {
              reason: typeof outcome.body.error === 'string' ? outcome.body.error : 'unknown',
              'error.code': typeof outcome.body.error === 'string' ? outcome.body.error : 'unknown',
            });
          }
          return outcome;
        });
        sendJson(response, result.status, result.body);
        return;
      }

      // 分享快照匿名可读：令牌本身就是访问凭据，因此这一步在身份解析之前。
      if (route === 'snapshot') {
        const token = path.slice('/s/'.length);
        const record = share.get(token);
        if (record === undefined) {
          sendJson(response, 404, { error: CHATDSH_ERROR_CODES.shareUnavailable });
          return;
        }
        if (record.revokedAt !== undefined || (record.expiresAt !== undefined && record.expiresAt <= Date.now())) {
          sendJson(response, 410, { error: CHATDSH_ERROR_CODES.shareUnavailable });
          return;
        }
        share.touch(token);
        const events = replica.read(record.sessionId, record.upToSeq);
        const html = telemetry.runSpanSync('chatdsh.gateway.share.render', {
          'share.id': token,
          up_to_seq: record.upToSeq,
        }, () => renderSharePage(record, events));
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(html),
          'X-Robots-Tag': 'noindex',
        });
        response.end(html);
        return;
      }

      // 移动端遥测中转：凭设备令牌鉴权，先于网页侧处理，避免匿名请求写设备表。
      if (route === 'mobile-telemetry') {
        await handleMobileTelemetryRequest({ request, response, store, telemetry, relay: mobileRelay });
        return;
      }

      // 每次 API 请求顺手登记设备：设备面板与推送分级都要有设备记录，不能只靠 SSE 连接。
      if (route !== 'static' && route !== 'plugins') {
        store.touchDevice({
          id: device.id,
          origin: originOf(request),
          platform: platformOf(request),
          lastSeenAt: Date.now(),
        });
      }
      // 手机配对：一次性口令换长期设备令牌。口令只从环境变量读取，未配置时端点关闭。
      if (route === 'mobile-pair') {
        await telemetry.runSpan('chatdsh.gateway.mobile.pair', {}, async (span) => {
          const reject = (status: number, errorType: string, errorCode: string): void => {
            span.setAttribute('outcome', 'rejected');
            span.setAttribute('error.type', errorType);
            span.setAttribute('error.code', errorCode);
            telemetry.event('chatdsh.gateway.mobile.rejected', {
              action: 'pair',
              outcome: 'rejected',
              'error.type': errorType,
              'error.code': errorCode,
            });
            telemetry.counter('chatdsh_mobile_pairings_total', { description: '手机配对次数' })
              .add(1, { outcome: 'rejected' });
            sendJson(response, status, { error: errorCode });
          };
          if (request.method !== 'POST') {
            reject(405, 'request', 'method-not-allowed');
            return;
          }
          const expected = config.pairingCode;
          if (expected === undefined) {
            reject(404, 'config', 'pairing-disabled');
            return;
          }
          const body = await readLimitedBody(request, 64 * 1024);
          if (body === undefined) {
            reject(413, 'request', 'payload-too-large');
            return;
          }
          let payload: { code?: unknown; deviceName?: unknown; platform?: unknown };
          try {
            payload = JSON.parse(body) as { code?: unknown; deviceName?: unknown; platform?: unknown };
          } catch {
            reject(400, 'payload', 'invalid-json');
            return;
          }
          if (typeof payload.code !== 'string' || !sameSecret(payload.code, expected)) {
            reject(401, 'auth', 'pairing-code-invalid');
            return;
          }
          const deviceName = typeof payload.deviceName === 'string' && payload.deviceName.trim() !== ''
            ? payload.deviceName.trim().slice(0, 80)
            : 'Android';
          const platform = typeof payload.platform === 'string' && payload.platform.trim() !== ''
            ? payload.platform.trim().slice(0, 32)
            : 'android';
          span.setAttribute('platform', platform);
          const bootPath = context.runtime?.bootPath();
          if (context.runtime === undefined || !context.runtime.ready() || bootPath === undefined) {
            reject(503, 'runtime', 'runtime-not-ready');
            return;
          }
          const token = randomBytes(32).toString('base64url');
          const record = store.registerMobileDevice({
            id: randomUUID(),
            name: deviceName,
            platform,
            tokenHash: deviceTokenHash(token),
          });
          store.touchDevice({
            id: record.id,
            origin: originOf(request),
            platform: record.platform,
            lastSeenAt: record.lastSeenAt,
          });
          span.setAttribute('outcome', 'paired');
          telemetry.counter('chatdsh_mobile_pairings_total', { description: '手机配对次数' })
            .add(1, { outcome: 'ok' });
          response.setHeader('Cache-Control', 'no-store');
          sendJson(response, 200, {
            token,
            deviceId: record.id,
            name: record.name,
            platform: record.platform,
            bootPath,
          });
        });
        return;
      }

      // 手机每次启动取一次运行时的带令牌路径；设备令牌只用于这一步。
      if (route === 'mobile-session') {
        await telemetry.runSpan('chatdsh.gateway.mobile.session', {}, async (span) => {
          const reject = (status: number, errorType: string, errorCode: string): void => {
            span.setAttribute('outcome', 'rejected');
            span.setAttribute('error.type', errorType);
            span.setAttribute('error.code', errorCode);
            telemetry.event('chatdsh.gateway.mobile.rejected', {
              action: 'session',
              outcome: 'rejected',
              'error.type': errorType,
              'error.code': errorCode,
            });
            telemetry.counter('chatdsh_mobile_sessions_total', { description: '手机取启动路径次数' })
              .add(1, { outcome: 'rejected' });
            sendJson(response, status, { error: errorCode });
          };
          if (request.method !== 'GET') {
            reject(405, 'request', 'method-not-allowed');
            return;
          }
          const auth = authenticateMobileDevice(request, store);
          if (auth.record === undefined) {
            reject(401, 'auth', auth.error ?? 'device-token-invalid');
            return;
          }
          const record = auth.record;
          store.touchMobileDevice(record.id);
          store.touchDevice({
            id: record.id,
            origin: originOf(request),
            platform: record.platform,
            lastSeenAt: Date.now(),
          });
          const bootPath = context.runtime?.bootPath();
          if (context.runtime === undefined || !context.runtime.ready() || bootPath === undefined) {
            reject(503, 'runtime', 'runtime-not-ready');
            return;
          }
          span.setAttribute('outcome', 'ok');
          telemetry.counter('chatdsh_mobile_sessions_total', { description: '手机取启动路径次数' })
            .add(1, { outcome: 'ok' });
          response.setHeader('Cache-Control', 'no-store');
          sendJson(response, 200, {
            deviceId: record.id,
            name: record.name,
            platform: record.platform,
            bootPath,
          });
        });
        return;
      }

      // 已配对手机设备的列举与吊销；吊销立即生效，下一次取启动路径即被拒绝。
      // 配对载荷：把控制平面地址与配对码打包成客户端能直接解析的 Base64URL，
      // 与运行时的配对载荷同形，客户端因此不需要区分「连控制平面」与「连运行时」。
      if (route === 'mobile-pairing') {
        await telemetry.runSpan('chatdsh.gateway.mobile.pairing', {}, async (span) => {
          if (request.method !== 'GET') {
            span.setAttribute('outcome', 'rejected');
            span.setAttribute('error.type', 'request');
            span.setAttribute('error.code', 'method-not-allowed');
            sendJson(response, 405, { error: 'method-not-allowed' });
            return;
          }
          const code = config.pairingCode;
          if (code === undefined) {
            span.setAttribute('outcome', 'rejected');
            span.setAttribute('error.type', 'config');
            span.setAttribute('error.code', 'pairing-disabled');
            sendJson(response, 404, { error: 'pairing-disabled' });
            return;
          }
          const ttlMs = 5 * 60 * 1000;
          const expiresAt = Date.now() + ttlMs;
          const payload = pairingPayload({
            publicUrl: `${originOf(request).replace(/^http/, 'ws')}/ws/mobile`,
            pairingCode: code,
            expiresAt,
          });
          span.setAttribute('outcome', 'issued');
          response.setHeader('Cache-Control', 'no-store');
          sendJson(response, 200, {
            encoded: payload.encoded,
            payload: payload.payload,
            expiresAt,
          });
        });
        return;
      }

      if (route === 'mobile-devices') {
        await telemetry.runSpan('chatdsh.gateway.mobile.devices', {}, async (span) => {
          if (request.method === 'GET') {
            span.setAttribute('action', 'list');
            span.setAttribute('outcome', 'ok');
            telemetry.counter('chatdsh_mobile_devices_total', { description: '手机设备管理操作' })
              .add(1, { action: 'list', outcome: 'ok' });
            sendJson(response, 200, { devices: store.listMobileDevices() });
            return;
          }
          if (request.method === 'DELETE') {
            span.setAttribute('action', 'revoke');
            const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'gateway'}`);
            const id = url.searchParams.get('id');
            if (id === null || !store.revokeMobileDevice(id)) {
              span.setAttribute('outcome', 'rejected');
              span.setAttribute('error.type', 'request');
              span.setAttribute('error.code', 'device-not-found');
              telemetry.event('chatdsh.gateway.mobile.rejected', {
                action: 'revoke',
                outcome: 'rejected',
                'error.type': 'request',
                'error.code': 'device-not-found',
              });
              telemetry.counter('chatdsh_mobile_devices_total', { description: '手机设备管理操作' })
                .add(1, { action: 'revoke', outcome: 'rejected' });
              sendJson(response, 404, { error: 'device-not-found' });
              return;
            }
            span.setAttribute('outcome', 'revoked');
            telemetry.counter('chatdsh_mobile_devices_total', { description: '手机设备管理操作' })
              .add(1, { action: 'revoke', outcome: 'revoked' });
            sendJson(response, 200, { revoked: true, id });
            return;
          }
          span.setAttribute('outcome', 'rejected');
          span.setAttribute('error.type', 'request');
          span.setAttribute('error.code', 'method-not-allowed');
          telemetry.event('chatdsh.gateway.mobile.rejected', {
            action: 'devices',
            outcome: 'rejected',
            'error.type': 'request',
            'error.code': 'method-not-allowed',
          });
          telemetry.counter('chatdsh_mobile_devices_total', { description: '手机设备管理操作' })
            .add(1, { action: 'devices', outcome: 'rejected' });
          sendJson(response, 405, { error: 'method-not-allowed' });
        });
        return;
      }
      // 节点配对：一次性配对码换长期节点令牌。令牌只在响应里出现一次，库里只存摘要。
      if (route === 'device-pair') {
        await telemetry.runSpan('chatdsh.gateway.device.pair', {}, async (span) => {
          const reject = (status: number, errorType: string, errorCode: string): void => {
            span.setAttribute('outcome', 'rejected');
            span.setAttribute('error.type', errorType);
            span.setAttribute('error.code', errorCode);
            telemetry.event('chatdsh.gateway.device.rejected', {
              action: 'pair',
              outcome: 'rejected',
              'error.type': errorType,
              'error.code': errorCode,
            });
            telemetry.counter('chatdsh_gateway_device_pairs_total', { description: '节点配对次数' })
              .add(1, { outcome: 'rejected' });
            sendJson(response, status, { error: errorCode });
          };
          if (request.method !== 'POST') {
            reject(405, 'request', 'method-not-allowed');
            return;
          }
          const expected = config.pairingCode;
          if (expected === undefined) {
            reject(404, 'config', 'pairing-disabled');
            return;
          }
          const body = await readLimitedBody(request, 64 * 1024);
          if (body === undefined) {
            reject(413, 'request', 'payload-too-large');
            return;
          }
          let payload: { code?: unknown; name?: unknown; platform?: unknown; role?: unknown; capabilities?: unknown };
          try {
            payload = JSON.parse(body) as typeof payload;
          } catch {
            reject(400, 'payload', 'invalid-json');
            return;
          }
          if (typeof payload.code !== 'string' || !sameSecret(payload.code, expected)) {
            reject(401, 'auth', 'pairing-code-invalid');
            return;
          }
          const role = payload.role === undefined ? 'both' : payload.role;
          if (role !== 'host' && role !== 'executor' && role !== 'both') {
            reject(400, 'payload', 'role-invalid');
            return;
          }
          const rawCapabilities = payload.capabilities === undefined ? [] : payload.capabilities;
          if (!Array.isArray(rawCapabilities) || rawCapabilities.some((item) => typeof item !== 'string')) {
            reject(400, 'payload', 'capabilities-invalid');
            return;
          }
          const capabilities = rawCapabilities.map((item: string) => item.slice(0, 64)).slice(0, 32);
          const platform = typeof payload.platform === 'string' && payload.platform.trim() !== ''
            ? payload.platform.trim().slice(0, 32)
            : 'linux';
          const deviceName = typeof payload.name === 'string' && payload.name.trim() !== ''
            ? payload.name.trim().slice(0, 80)
            : platform;
          const token = randomBytes(32).toString('base64url');
          const record = store.registerNode({
            id: randomUUID(),
            name: deviceName,
            platform,
            role: role as NodeRole,
            capabilities,
            tokenHash: deviceTokenHash(token),
          });
          span.setAttribute('platform', platform);
          span.setAttribute('outcome', 'paired');
          telemetry.counter('chatdsh_gateway_device_pairs_total', { description: '节点配对次数' })
            .add(1, { outcome: 'ok' });
          response.setHeader('Cache-Control', 'no-store');
          sendJson(response, 200, { deviceId: record.id, token });
        });
        return;
      }

      // 链路自检：沿设备的长连接转发一次 `GET /healthz`，这是连接能承载请求的最小证据。
      if (route === 'device-probe') {
        if (request.method !== 'GET') {
          sendJson(response, 405, { error: 'method-not-allowed' });
          return;
        }
        const match = DEVICE_PROBE_PATH.exec(path);
        const deviceId = match?.[1] === undefined ? '' : decodeURIComponent(match[1]);
        const node = store.nodeById(deviceId);
        if (node === undefined) {
          sendJson(response, 404, { error: 'device-not-found' });
          return;
        }
        const startedAt = Date.now();
        if (!context.deviceLink.online(node.id)) {
          telemetry.event('chatdsh.gateway.device.rejected', {
            action: 'probe',
            outcome: 'rejected',
            'error.type': 'link',
            'error.code': 'device-offline',
          });
          telemetry.counter('chatdsh_gateway_device_requests_total', { description: '控制平面沿设备连接转发的请求数' })
            .add(1, { outcome: 'offline' });
          sendJson(response, 409, { error: 'device-offline' });
          return;
        }
        try {
          const reply = await context.deviceLink.sendRequest(node.id, { method: 'GET', path: '/healthz', headers: {} }, 10_000);
          sendJson(response, 200, {
            deviceId: node.id,
            online: true,
            status: reply.status,
            durationMs: Date.now() - startedAt,
          });
        } catch (error) {
          const code = error instanceof DeviceLinkError ? error.code : 'device-unreachable';
          telemetry.event('chatdsh.gateway.device.rejected', {
            action: 'probe',
            outcome: 'rejected',
            'error.type': 'link',
            'error.code': code,
          });
          sendJson(response, code === 'device-timeout' ? 504 : 502, { error: code });
        }
        return;
      }

      if (route === 'ownership' || route === 'devices') {
        if (route === 'ownership') {
          if (request.method === 'POST') {
            await writeOwnership(request, response);
            return;
          }
          if (request.method !== 'GET') {
            sendJson(response, 405, { error: 'method-not-allowed' });
            return;
          }
          sendJson(response, 200, { sessions: store.listSessions() });
          return;
        }
        // 设备列表是执行节点的列表；在线状态由长连接表判定，`lastSeenAt` 取最近一次握手或心跳。
        sendJson(response, 200, {
          devices: store.listNodes().map((node) => ({
            id: node.id,
            name: node.name,
            platform: node.platform,
            role: node.role,
            capabilities: node.capabilities,
            online: context.deviceLink.online(node.id),
            lastSeenAt: node.lastSeenAt,
          })),
        });
        return;
      }

      // 按设备路由：`/d/<deviceId>/<rest>` 经该设备的长连接转发。前缀之外的请求仍走下面的
      // 默认反代，行为不变。
      if (route === 'device-proxy') {
        await proxyToDevice(request, response, path);
        return;
      }

      // 模型入口：额度前置检查与流式转发。
      if (route === 'llm') {
        await telemetry.runSpan('chatdsh.gateway.llm', { provider: 'gateway' }, async (span) => {
          span.setAttribute('outcome', 'forwarded');
          await handleLlmRequest(request, response, {
            config: config.llmGateway,
            ledger: llmLedger,
            telemetry,
          });
        });
        return;
      }

      // MCP 全局注册：GET 读快照，PUT 覆盖本设备的端点。设备来自节点令牌或节点标识头。
      if (route === 'mcp') {
        if (request.method === 'GET') {
          await telemetry.runSpan('chatdsh.gateway.mcp.registry', { action: 'read' }, async (span) => {
            const snapshot = mcpRegistry.snapshot();
            span.setAttribute('outcome', 'ok');
            sendJson(response, 200, snapshot);
          });
          return;
        }
        const caller = deviceOfRequest(request, device.id);
        if ('error' in caller) {
          sendJson(response, 401, { error: caller.error });
          return;
        }
        if (caller.source === 'browser') {
          sendJson(response, 400, { error: 'missing-device-id' });
          return;
        }
        const callerDeviceId = caller.id;
        if (request.method === 'PUT') {
          const body = await readBody(request, 256 * 1024);
          const parsed = JSON.parse(body) as { servers?: unknown };
          if (typeof parsed.servers !== 'object' || parsed.servers === null || Array.isArray(parsed.servers)) {
            sendJson(response, 400, { error: 'missing-servers' });
            return;
          }
          await telemetry.runSpan('chatdsh.gateway.mcp.registry', { action: 'write' }, async (span) => {
            try {
              const written = mcpRegistry.upsertServers(callerDeviceId, parsed.servers as never);
              span.setAttribute('outcome', 'ok');
              telemetry.counter('chatdsh_mcp_registry_writes_total', { description: 'MCP 端点上报次数' })
                .add(1, { outcome: 'ok' });
              sendJson(response, 200, { written, ...mcpRegistry.snapshot() });
            } catch (error) {
              span.setAttribute('outcome', 'failed');
              span.setAttribute('error.code', 'mcp-registry/invalid');
              telemetry.counter('chatdsh_mcp_registry_writes_total', { description: 'MCP 端点上报次数' })
                .add(1, { outcome: 'failed' });
              sendJson(response, 400, { error: error instanceof Error ? error.message : 'invalid' });
            }
          });
          return;
        }
        if (request.method === 'DELETE') {
          const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'gateway'}`);
          const server = url.searchParams.get('server');
          if (server === null) {
            sendJson(response, 400, { error: 'missing-device-id-or-server' });
            return;
          }
          await telemetry.runSpan('chatdsh.gateway.mcp.registry', { action: 'delete' }, async (span) => {
            mcpRegistry.removeServer(callerDeviceId, server);
            span.setAttribute('outcome', 'ok');
            telemetry.counter('chatdsh_mcp_registry_writes_total', { description: 'MCP 端点上报次数' })
              .add(1, { outcome: 'ok' });
            sendJson(response, 200, mcpRegistry.snapshot());
          });
          return;
        }
        sendJson(response, 405, { error: 'method-not-allowed' });
        return;
      }

      if (route === 'automations') {
        if (request.method === 'GET') {
          sendJson(response, 200, { automations: automations.list() });
          return;
        }
        if (request.method === 'PATCH') {
          if (request.headers['x-chatdsh-csrf'] !== '1') {
            sendJson(response, 403, { error: 'csrf-required' });
            return;
          }
          const body = await readBody(request, 64 * 1024);
          let payload: { id?: unknown; enabled?: unknown };
          try {
            payload = JSON.parse(body) as { id?: unknown; enabled?: unknown };
          } catch {
            sendJson(response, 400, { error: 'invalid-json' });
            return;
          }
          if (typeof payload.id !== 'string' || typeof payload.enabled !== 'boolean') {
            sendJson(response, 400, { error: 'invalid-payload' });
            return;
          }
          const record = automations.setEnabled(payload.id, payload.enabled);
          if (record === undefined) {
            sendJson(response, 404, { error: 'automation-not-found' });
            return;
          }
          sendJson(response, 200, record);
          return;
        }
        sendJson(response, 405, { error: 'method-not-allowed' });
        return;
      }

      if (route === 'replica') {
        const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'gateway'}`);
        if (request.method === 'POST') {
          const body = await readBody(request, 4 * 1024 * 1024);
          let payload: { sessionId?: unknown; events?: unknown };
          try {
            payload = JSON.parse(body) as { sessionId?: unknown; events?: unknown };
          } catch {
            sendJson(response, 400, { error: 'invalid-json' });
            return;
          }
          const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : undefined;
          const events = normalizeEvents(payload.events);
          if (sessionId === undefined || events === undefined) {
            sendJson(response, 400, { error: 'invalid-payload' });
            return;
          }
          if (store.getSession(sessionId) === undefined) {
            // 首次上报时补一条归属：设备来自节点令牌、节点标识头或浏览器 cookie。
            const caller = deviceOfRequest(request, device.id);
            if ('error' in caller) {
              sendJson(response, 401, { error: caller.error });
              return;
            }
            store.upsertSession({
              sessionId,
              deviceId: caller.id,
              cwd: '',
              kind: 'work',
              createdAt: Date.now(),
            });
          }
          const result = telemetry.runSpanSync('chatdsh.gateway.replica.append', {
            'session.id': sessionId,
            seq: events.length,
            bytes: Buffer.byteLength(body),
          }, (span) => {
            const appended = replica.append(sessionId, events);
            span.setAttribute('outcome', 'appended');
            return appended;
          });
          // 副本有新事件就通知在线设备：跨端一致性的来源在这里。
          push.deliver(JSON.stringify({
            kind: 'replica',
            sessionId,
            watermark: result.watermark,
            appended: events.length,
          }));
          // 审批提醒：一批新事件里出现 approval/asked 时推一条提醒，让没打开该会话的设备也能
          // 知道有人在等回答。approval/decided 出现时撤回对应提醒。
          for (const event of events) {
            if (event.kind === 'approval/asked') {
              const asked = approvalInfoOf(event.payload);
              push.deliver(JSON.stringify({ kind: 'approval', sessionId, toolName: asked.toolName, callId: asked.callId }));
            }
            if (event.kind === 'approval/decided') {
              const decided = approvalInfoOf(event.payload);
              push.withdraw(sessionId, decided.callId);
            }
          }
          sendJson(response, 200, result);
          return;
        }
        const sessionId = url.searchParams.get('sessionId');
        if (sessionId === null) {
          sendJson(response, 200, { watermarks: replica.listWatermarks() });
          return;
        }
        const upToSeq = url.searchParams.get('upToSeq');
        sendJson(response, 200, {
          sessionId,
          // 副本不存在时给 null：0 是合法序号，用 0 表示「没有副本」会让补齐漏掉第一条事件。
          watermark: replica.watermarkOf(sessionId) ?? null,
          events: replica.read(sessionId, upToSeq === null ? undefined : Number.parseInt(upToSeq, 10)),
        });
        return;
      }

      if (route === 'share' || route === 'share-list') {
        const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'gateway'}`);
        if (route === 'share-list') {
          sendJson(response, 200, { shares: share.list() });
          return;
        }
        if (request.method === 'POST') {
          const body = await readBody(request, 1024 * 1024);
          let payload: { sessionId?: unknown; upToSeq?: unknown; ttlMs?: unknown };
          try {
            payload = JSON.parse(body) as { sessionId?: unknown; upToSeq?: unknown; ttlMs?: unknown };
          } catch {
            sendJson(response, 400, { error: 'invalid-json' });
            return;
          }
          if (typeof payload.sessionId !== 'string') {
            sendJson(response, 400, { error: 'invalid-payload' });
            return;
          }
          const record = share.create({
            sessionId: payload.sessionId,
            upToSeq: typeof payload.upToSeq === 'number' ? payload.upToSeq : undefined,
            ttlMs: typeof payload.ttlMs === 'number' ? payload.ttlMs : undefined,
          }, replica.watermarkOf(payload.sessionId) ?? 0);
          sendJson(response, 200, {
            token: record.token,
            path: `/s/${record.token}`,
            sessionId: record.sessionId,
            upToSeq: record.upToSeq,
            expiresAt: record.expiresAt ?? null,
          });
          return;
        }
        if (request.method === 'DELETE') {
          const token = url.searchParams.get('token');
          if (token === null) {
            sendJson(response, 400, { error: 'invalid-payload' });
            return;
          }
          const revoked = share.revoke(token);
          sendJson(response, revoked ? 200 : 404, { revoked });
          return;
        }
        sendJson(response, 405, { error: 'method-not-allowed' });
        return;
      }

      // 设备用 SSE 长连接订阅通知；连接期间在线，断开即摘除。
      if (route === 'events') {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        response.write(': connected\n\n');
        for (const payload of push.drain()) response.write(`data: ${payload}\n\n`);
        const platform = typeof request.headers['x-chatdsh-platform'] === 'string'
          ? request.headers['x-chatdsh-platform']
          : 'web';
        const unsubscribe = push.subscribe(device.id, platform, response, originOf(request));
        const heartbeat = setInterval(() => {
          try {
            response.write(': ping\n\n');
          } catch {
            // 断开的连接由 close 事件清理。
          }
        }, 15_000);
        heartbeat.unref();
        request.on('close', () => {
          clearInterval(heartbeat);
          unsubscribe();
        });
        return;
      }

      // 已读水位：写入后向其他在线设备投递一条变化，供未读计数同步。
      if (route === 'receipt') {
        const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'gateway'}`);
        if (request.method === 'POST') {
          const body = await readBody(request, 64 * 1024);
          let payload: { sessionId?: unknown; readUpToSeq?: unknown };
          try {
            payload = JSON.parse(body) as { sessionId?: unknown; readUpToSeq?: unknown };
          } catch {
            sendJson(response, 400, { error: 'invalid-json' });
            return;
          }
          if (typeof payload.sessionId !== 'string' || typeof payload.readUpToSeq !== 'number') {
            sendJson(response, 400, { error: 'invalid-payload' });
            return;
          }
          const record = receipts.mark({
            sessionId: payload.sessionId,
            deviceId: device.id,
            readUpToSeq: payload.readUpToSeq,
          });
          push.deliver(JSON.stringify({
            kind: 'receipt',
            sessionId: record.sessionId,
            deviceId: record.deviceId,
            readUpToSeq: record.readUpToSeq,
            at: record.updatedAt,
          }));
          sendJson(response, 200, record);
          return;
        }
        const sessionId = url.searchParams.get('sessionId');
        if (sessionId === null) {
          sendJson(response, 400, { error: 'invalid-payload' });
          return;
        }
        sendJson(response, 200, { receipts: receipts.list(sessionId) });
        return;
      }

      // 会话导入：从副本读源会话的事件，建一条带 parentSession 的新会话并把事件复制过去。
      // 源设备离线时这条路径仍然可用，读的是控制平面保存的副本。
      if (route === 'import') {
        if (request.method !== 'POST') {
          sendJson(response, 405, { error: 'method-not-allowed' });
          return;
        }
        const body = await readBody(request, 256 * 1024);
        let payload: { sourceSessionId?: unknown; cwd?: unknown; deviceId?: unknown };
        try {
          payload = JSON.parse(body) as { sourceSessionId?: unknown; cwd?: unknown; deviceId?: unknown };
        } catch {
          sendJson(response, 400, { error: 'invalid-json' });
          return;
        }
        if (typeof payload.sourceSessionId !== 'string') {
          sendJson(response, 400, { error: 'invalid-payload' });
          return;
        }
        const owned = store.getSession(payload.sourceSessionId);
        const events = replica.read(payload.sourceSessionId);
        if (events.length === 0) {
          sendJson(response, 404, { error: 'replica-unavailable' });
          return;
        }
        const sessionId = randomUUID();
        // 「在本机继续」指定目标设备时按其 deviceId 归属；没有指定时按请求方设备归属。
        const targetDeviceId = typeof payload.deviceId === 'string' && payload.deviceId !== '' ? payload.deviceId : device.id;
        store.upsertSession({
          sessionId,
          deviceId: targetDeviceId,
          cwd: typeof payload.cwd === 'string' ? payload.cwd : owned?.cwd ?? '',
          kind: owned?.kind ?? 'work',
          createdAt: Date.now(),
          parentSession: payload.sourceSessionId,
        });
        replica.append(sessionId, events.map((event) => ({
          seq: event.seq,
          kind: event.kind,
          time: event.time,
          bytes: event.bytes,
          payload: event.payload,
        })));
        sendJson(response, 200, {
          sessionId,
          parentSession: payload.sourceSessionId,
          watermark: replica.watermarkOf(sessionId) ?? null,
          imported: events.length,
        });
        return;
      }

      // 默认反代：指到配置的运行时地址（配置托管时用托管进程的地址）。
      const routedUrl = context.runtime?.url() ?? config.runtimeUrl;
      const routedTarget = new URL(routedUrl);
      await proxy(request, response, {
        target: routedTarget,
        forward: routedTarget.protocol === 'https:' ? httpsRequest : httpRequest,
        requestId: telemetry.currentTraceId() ?? '',
        telemetry,
      });
    }));
  }

  const server: Server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      telemetry.log('error', 'gateway request failed', { 'error.type': error instanceof Error ? error.name : 'Unknown' });
      if (!response.headersSent) sendJson(response, 500, { error: 'internal' });
      else response.end();
    });
  });

  // WebSocket 升级：运行时的 Remote 流走 `/api/remote.mux`，HTTP 反代接不住这条连接。
  // 这里按同一套身份与路由规则建立上游升级，再把两侧套接字对接。
  server.on('upgrade', (request, socket, head) => {
    upgradedSockets.add(socket);
    socket.once('close', () => upgradedSockets.delete(socket));
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    // 设备长连接的升级由中枢自己完成握手、验令牌与拒绝，不经过反代与身份解析。
    if (path === DEVICE_LINK_PATH) {
      context.deviceLink.handleUpgrade(request, socket);
      return;
    }
    // 前缀路由只承载普通 HTTP 请求：长连接的帧要能多路复用，这一段留到后续能力，
    // 这里直接拒绝，升级请求不会落到宿主机运行时。
    if (DEVICE_PREFIX_PATH.test(path)) {
      const body = JSON.stringify({ error: 'device-websocket-unsupported' });
      socket.write(
        'HTTP/1.1 501 Not Implemented\r\n' +
        'Content-Type: application/json; charset=utf-8\r\n' +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        'Connection: close\r\n\r\n' +
        body
      );
      socket.destroy();
      telemetry.event('chatdsh.gateway.device.rejected', {
        action: 'proxy',
        outcome: 'rejected',
        'error.type': 'unsupported',
        'error.code': 'device-websocket-unsupported',
      });
      telemetry.counter('chatdsh_gateway_device_proxies_total', { description: '按设备路由的转发次数' })
        .add(1, { outcome: 'websocket-unsupported' });
      return;
    }
    const route = routeOf(request.method ?? 'GET', path);
    const span = telemetry.startSpan('chatdsh.gateway.proxy', {
      'http.route': route,
      'http.method': 'UPGRADE',
    });
    const fail = (error: Error): void => {
      span.recordException(error);
      span.setAttribute('outcome', 'failed');
      socket.destroy();
      span.end();
    };
    /** 在升级握手阶段拒绝一条连接，回一个最小的 HTTP 响应后关闭套接字。 */
    const rejectUpgrade = (status: number, errorType: string, errorCode: string): void => {
      span.setAttribute('error.type', errorType);
      span.setAttribute('error.code', errorCode);
      const body = JSON.stringify({ error: errorCode });
      socket.write(
        `HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Forbidden'}\r\n` +
        'Content-Type: application/json; charset=utf-8\r\n' +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        'Connection: close\r\n\r\n' +
        body
      );
      socket.destroy();
      span.setAttribute('outcome', 'rejected');
      span.end();
    };

    // 手机业务通道由专门的处理函数负责：配对码换令牌、设备令牌校验、拒绝分支都写在
    // mobile-channel.ts 里。配对与校验都在这里完成，之后把连接桥接到运行时插件；配对
    // 连接上先写 paired 帧，插件的 hello 随后在同一连接上到达客户端。
    if (isMobileChannelPath(path)) {
      const routedUrl = context.runtime?.url() ?? config.runtimeUrl;
      const decision = handleMobileChannel(request, socket, {
        pairingCode: config.pairingCode,
        runtimeUrl: routedUrl,
        store,
        telemetry,
      });
      if (decision.bridgePath === undefined) {
        span.setAttribute('outcome', 'rejected');
        span.end();
        return;
      }
      const target = new URL(routedUrl);
      const headers: Record<string, string | string[] | undefined> = { ...request.headers };
      headers.host = target.host;
      if (typeof headers.origin === 'string') headers.origin = target.origin;
      // 手机带来的凭据由控制平面消费，发往运行时的请求头按通道需要改写。
      for (const [name, value] of Object.entries(decision.headers ?? {})) {
        if (value === null) delete headers[name];
        else headers[name] = value;
      }
      openUpstreamUpgrade(
        routedUrl,
        decision.bridgePath,
        headers,
        (response, upstreamSocket, upstreamHead) => {
          const lines = [`HTTP/1.1 ${response.statusCode ?? 101} ${response.statusMessage ?? 'Switching Protocols'}`];
          for (let index = 0; index < response.rawHeaders.length; index += 2) {
            lines.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`);
          }
          socket.write(`${lines.join('\r\n')}\r\n\r\n`);
          if (decision.preamble !== undefined) socket.write(encodeServerTextFrame(decision.preamble));
          bridgeSockets(socket, upstreamSocket, head, upstreamHead);
          span.setAttribute('http.status_code', response.statusCode ?? 101);
          span.setAttribute('outcome', 'upgraded');
          span.end();
        },
        (response) => {
          decision.rollback?.();
          span.setAttribute('http.status_code', response.statusCode ?? 502);
          span.setAttribute('outcome', 'rejected');
          response.resume();
          span.end();
          rejectUpgrade(502, 'runtime', 'runtime-upgrade-rejected');
        },
        (error) => {
          decision.rollback?.();
          fail(error);
        }
      );
      return;
    }

    try {
      const routedUrl = context.runtime?.url() ?? config.runtimeUrl;
      const target = new URL(routedUrl);
      span.setAttribute('runtime.id', target.host);
      const headers: Record<string, string | string[] | undefined> = { ...request.headers };
      headers.host = target.host;
      if (typeof headers.origin === 'string') headers.origin = target.origin;
      if (typeof headers.referer === 'string') {
        try {
          const referer = new URL(headers.referer);
          headers.referer = `${target.origin}${referer.pathname}${referer.search}`;
        } catch {
          delete headers.referer;
        }
      }
      if (headers['x-forwarded-host'] === undefined && typeof request.headers.host === 'string') {
        headers['x-forwarded-host'] = request.headers.host;
      }
      if (headers['x-forwarded-proto'] === undefined) headers['x-forwarded-proto'] = 'http';
      const carrier = telemetry.inject({});
      if (headers.traceparent === undefined && carrier.traceparent !== undefined) headers.traceparent = carrier.traceparent;
      if (headers.tracestate === undefined && carrier.tracestate !== undefined) headers.tracestate = carrier.tracestate;

      const forward = target.protocol === 'https:' ? httpsRequest : httpRequest;
      const upstream = forward({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port === '' ? undefined : target.port,
        path: request.url ?? '/',
        method: request.method ?? 'GET',
        headers,
      });
      upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
        span.setAttribute('http.status_code', response.statusCode ?? 101);
        const lines = [`HTTP/1.1 ${response.statusCode ?? 101} ${response.statusMessage ?? 'Switching Protocols'}`];
        for (let index = 0; index < response.rawHeaders.length; index += 2) {
          lines.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`);
        }
        socket.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (upstreamHead.length > 0) socket.write(upstreamHead);
        if (head.length > 0) upstreamSocket.write(head);
        upstreamSocket.pipe(socket);
        upstreamSocket.on('close', () => socket.destroy());
        socket.on('close', () => upstreamSocket.destroy());
        socket.pipe(upstreamSocket);
        upstreamSocket.on('error', () => socket.destroy());
        socket.on('error', () => upstreamSocket.destroy());
        span.setAttribute('outcome', 'upgraded');
        span.end();
      });
      upstream.on('response', (response) => {
        span.setAttribute('http.status_code', response.statusCode ?? 502);
        const lines = [`HTTP/1.1 ${response.statusCode ?? 502} ${response.statusMessage ?? ''}`];
        for (let index = 0; index < response.rawHeaders.length; index += 2) {
          lines.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`);
        }
        socket.write(`${lines.join('\r\n')}\r\n\r\n`);
        response.pipe(socket);
        response.on('end', () => socket.end());
        span.setAttribute('outcome', 'rejected');
        span.end();
      });
      upstream.on('error', fail);
      upstream.end();
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });

  return {
    start(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => resolve());
      });
    },
    stop(): Promise<void> {
      for (const socket of upgradedSockets) socket.destroy();
      return new Promise((resolve) => {
        const timer = setTimeout(resolve, 2000);
        timer.unref();
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
        server.closeAllConnections();
      });
    },
    url(): string {
      const address = server.address();
      if (address === null || typeof address === 'string') return `http://${config.host}:${config.port}`;
      return `http://${config.host}:${address.port}`;
    },
  };
}

/** 读取请求体；超过上限时抛出，由调用方按协议错误处理。 */
async function readBody(request: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) throw new Error('payload too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 读取原始请求体；超过上限时返回 `undefined`，供按字节转发的路径使用。 */
async function readRawBody(request: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * 校验上报的事件形状。
 *
 * 副本带上事件本体：跨设备浏览、会话导入与分享渲染都从副本读内容。遥测不记录本体，
 * 那是遥测的内容边界，与副本的职责不同。
 */
/** 从审批事件体里取提醒与撤回需要的稳定字段；取不到时给空串。 */
function approvalInfoOf(payload: unknown): { toolName: string; callId: string } {
  if (typeof payload !== 'object' || payload === null) return { toolName: '', callId: '' };
  const record = payload as { toolName?: unknown; callId?: unknown; request?: { callId?: unknown; toolName?: unknown } };
  const toolName = typeof record.toolName === 'string' ? record.toolName : (typeof record.request?.toolName === 'string' ? record.request.toolName : '');
  const callId = typeof record.callId === 'string' ? record.callId : (typeof record.request?.callId === 'string' ? record.request.callId : '');
  return { toolName, callId };
}

function normalizeEvents(value: unknown): { seq: number; kind: string; time: number; bytes: number; payload?: unknown }[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const events: { seq: number; kind: string; time: number; bytes: number; payload?: unknown }[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return undefined;
    const record = item as { seq?: unknown; kind?: unknown; time?: unknown; bytes?: unknown; payload?: unknown };
    if (typeof record.seq !== 'number' || typeof record.kind !== 'string') return undefined;
    events.push({
      seq: record.seq,
      kind: record.kind,
      time: typeof record.time === 'number' ? record.time : Date.now(),
      bytes: typeof record.bytes === 'number' ? record.bytes : 0,
      payload: record.payload,
    });
  }
  return events;
}

/** 反代一次请求，注入身份头部。 */
async function proxy(
  request: IncomingMessage,
  response: ServerResponse,
  options: {
    target: URL;
    forward: typeof httpRequest;
    requestId: string;
    telemetry: ChatdshTelemetry;
  },
): Promise<void> {
  const { target, forward, telemetry } = options;
  const headers: Record<string, string | string[] | undefined> = { ...request.headers };
  headers.host = target.host;
  // 运行时按 Host 判定 authority；Origin 与 Referer 必须同步改写，否则跨站校验会拒绝请求。
  if (typeof headers.origin === 'string') headers.origin = target.origin;
  if (typeof headers.referer === 'string') {
    try {
      const referer = new URL(headers.referer);
      headers.referer = `${target.origin}${referer.pathname}${referer.search}`;
    } catch {
      delete headers.referer;
    }
  }
  if (headers['x-forwarded-for'] === undefined && request.socket.remoteAddress !== undefined) {
    headers['x-forwarded-for'] = request.socket.remoteAddress;
  }
  if (headers['x-forwarded-host'] === undefined && typeof request.headers.host === 'string') {
    headers['x-forwarded-host'] = request.headers.host;
  }
  if (headers['x-forwarded-proto'] === undefined) headers['x-forwarded-proto'] = 'http';
  if (options.requestId !== '') headers['x-chatdsh-request-id'] = options.requestId;

  await telemetry.runSpan('chatdsh.gateway.proxy', {
    'runtime.id': target.host,
  }, async (span) => {
    const carrier = telemetry.inject({});
    if (headers.traceparent === undefined && carrier.traceparent !== undefined) headers.traceparent = carrier.traceparent;
    if (headers.tracestate === undefined && carrier.tracestate !== undefined) headers.tracestate = carrier.tracestate;
    await new Promise<void>((resolve) => {
      const upstream = forward({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port === '' ? undefined : target.port,
        path: request.url ?? '/',
        method: request.method ?? 'GET',
        headers,
      }, (upstreamResponse) => {
        span.setAttribute('http.status_code', upstreamResponse.statusCode ?? 0);
        // 控制平面自己下发的设备 cookie 与运行时的会话 cookie 必须一起回到浏览器。
        const issued = response.getHeader('set-cookie');
        if (issued !== undefined) {
          const upstreamCookies = upstreamResponse.headers['set-cookie'];
          const list = Array.isArray(upstreamCookies) ? [...upstreamCookies] : upstreamCookies === undefined ? [] : [upstreamCookies];
          const own = Array.isArray(issued) ? issued.map(String) : [String(issued)];
          upstreamResponse.headers['set-cookie'] = [...list, ...own];
        }
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
        upstreamResponse.on('end', () => resolve());
      });
      upstream.on('error', (error) => {
        span.recordException(error);
        if (!response.headersSent) sendJson(response, 502, { error: 'runtime-unreachable' });
        else response.end();
        resolve();
      });
      request.pipe(upstream);
    });
  });
}
