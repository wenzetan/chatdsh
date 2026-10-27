/**
 * 控制平面的 HTTP 服务：内置路由加反向代理。
 *
 * 客户端只与控制平面通信，运行时不对外。反代在转发时注入身份头部，运行时侧据此确定
 * 账号、工作区与设备；转发不改写 Host 与 Origin 之外的头部。
 *
 * 每个入站请求一个 `chatdsh.gateway.http` span，反代另有一个 `chatdsh.gateway.proxy`，
 * 身份解析有一个 `chatdsh.gateway.identity`。
 * @module @chatdsh/gateway/server
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';
import type { AccessProvider, ChatdshTelemetry } from '@chatdsh/core-contracts';
import { IDENTITY_HEADERS, CHATDSH_ERROR_CODES, manualProvider, tailscaleProvider } from '@chatdsh/core-contracts';
import type { GatewayConfig, GatewayStore, ReceiptStore, ReplicaStore, ScheduleStore, ShareStore } from './store.ts';
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
  readonly schedule: ScheduleStore;
  /** 已读水位。 */
  readonly receipts: ReceiptStore;
  readonly push: PushHub;
  readonly telemetry: ChatdshTelemetry;
  /** 托管的运行时目标；缺省时按配置的固定地址反代。 */
  readonly runtime?: RuntimeTarget;
  /** 启动路径下发端点要求的口令；缺省时端点关闭。 */
  readonly bootstrapSecret?: string;
}

/** 路由分类，用于指标的 `route` 属性与 span 命名。方法目前不参与分类，保留参数以便后续区分读写。 */
function routeOf(_method: string, path: string): string {
  if (path === '/healthz') return 'healthz';
  if (path === '/chatdsh/gateway/bootstrap') return 'bootstrap';
  if (path === '/chatdsh/gateway/mobile/pair') return 'mobile-pair';
  if (path === '/chatdsh/gateway/mobile/session') return 'mobile-session';
  if (path === MOBILE_TELEMETRY_PATH) return 'mobile-telemetry';
  if (path === '/chatdsh/gateway/mobile/devices') return 'mobile-devices';
  if (path === '/chatdsh/gateway/mobile/pairing') return 'mobile-pairing';
  if (path === '/chatdsh/gateway/ownership') return 'ownership';
  if (path === '/chatdsh/gateway/devices') return 'devices';
  if (path === '/chatdsh/gateway/replica') return 'replica';
  if (path === '/chatdsh/gateway/share') return 'share';
  if (path === '/chatdsh/gateway/shares') return 'share-list';
  if (path === '/chatdsh/gateway/schedule') return 'schedule';
  if (path === '/chatdsh/gateway/receipt') return 'receipt';
  if (path === '/chatdsh/gateway/import') return 'import';
  if (path === '/chatdsh/gateway/events') return 'events';
  if (path.startsWith('/chatdsh/gateway/webhook/')) return 'webhook';
  if (path === '/chatdsh/gateway/automations') return 'automations';
  if (path === '/chatdsh/gateway/mcp') return 'mcp';
  if (path === '/chatdsh/gateway/llm') return 'llm';
  if (path.startsWith('/s/')) return 'snapshot';
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

/**
 * 解析请求身份。
 *
 * 单机形态下账号名来自接入层注入的 `tailscale-user-login`；没有该头部时按本机直连处理，
 * 账号名取 `local`。解析结果同时写入上游请求头部。
 */
function resolveIdentity(request: IncomingMessage, provider: AccessProvider, fallbackDeviceId: string): { accountId: string; login: string; mode: string; deviceId: string } {
  // 来源身份由提供方决定：Tailscale 取 Serve 注入的头部，手动反代没有身份。
  const access = provider.identityOf(request.headers);
  const login = access.login ?? 'local';
  const deviceId = String(request.headers[IDENTITY_HEADERS.deviceId] ?? fallbackDeviceId);
  return { accountId: '', login, mode: access.source ?? 'local', deviceId };
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

/** 取请求的设备标识；没有头部与 cookie 时发一个新标识。 */
function deviceIdOf(request: IncomingMessage): { id: string; issued: boolean } {
  const header = request.headers[IDENTITY_HEADERS.deviceId];
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
  const { config, store, replica, share, schedule, receipts, push, telemetry } = context;
  const mobileRelay = new MobileTelemetryRelay(telemetry);
  // 可达性提供方按配置选择：Tailscale 取 Serve 注入的头部，手动反代没有来源身份。
  const accessProvider: AccessProvider = config.accessProvider === 'manual' ? manualProvider() : tailscaleProvider();
  const automations = new AutomationStore(store.handle());
  const llmLedger = new LlmQuotaLedger(store, config.llmGateway.quota);
  const mcpRegistry = new McpRegistry(store.handle());
  const upgradedSockets = new Set<Duplex>();

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    const route = routeOf(request.method ?? 'GET', path);
    const started = Date.now();
    const device = deviceIdOf(request);
    if (device.issued) {
      response.setHeader('Set-Cookie', `${DEVICE_COOKIE}=${encodeURIComponent(device.id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
    }
    const identity = resolveIdentity(request, accessProvider, device.id);

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

      // 移动端遥测中转：凭设备令牌鉴权，先于网页身份解析，避免匿名请求建立账号。
      if (route === 'mobile-telemetry') {
        await handleMobileTelemetryRequest({ request, response, store, telemetry, relay: mobileRelay });
        return;
      }

      const account = telemetry.runSpanSync('chatdsh.gateway.identity', {
        'auth.mode': identity.mode,
      }, (span) => {
        const record = store.ensureAccount(identity.login);
        span.setAttribute('outcome', 'resolved');
        return record;
      });

      // 每次 API 请求顺手登记设备：账号面板与推送分级都要有设备记录，不能只靠 SSE 连接。
      if (route !== 'static' && route !== 'plugins') {
        store.touchDevice({
          id: identity.deviceId,
          accountId: account.id,
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
            accountId: account.id,
            name: deviceName,
            platform,
            tokenHash: deviceTokenHash(token),
          });
          store.touchDevice({
            id: record.id,
            accountId: account.id,
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
            accountId: record.accountId,
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
            sendJson(response, 200, { accountId: account.id, devices: store.listMobileDevices(account.id) });
            return;
          }
          if (request.method === 'DELETE') {
            span.setAttribute('action', 'revoke');
            const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'gateway'}`);
            const id = url.searchParams.get('id');
            if (id === null || !store.revokeMobileDevice(id, account.id)) {
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
      if (route === 'ownership' || route === 'devices') {
        const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'gateway'}`);
        const requested = url.searchParams.get('accountId');
        if (requested !== null && requested !== account.id) {
          telemetry.event('chatdsh.gateway.auth.failed', { 'auth.mode': identity.mode, 'error.code': 'workspace-forbidden' });
          sendJson(response, 403, { error: 'workspace-forbidden' });
          return;
        }
        if (route === 'ownership') {
          sendJson(response, 200, { accountId: account.id, sessions: store.listSessions(account.id) });
        } else {
          sendJson(response, 200, { accountId: account.id, devices: store.listDevices(account.id) });
        }
        return;
      }

      // 模型入口：额度前置检查与流式转发，身份取控制平面注入的账号头部。
      if (route === 'llm') {
        await telemetry.runSpan('chatdsh.gateway.llm', { provider: 'gateway' }, async (span) => {
          span.setAttribute('outcome', 'forwarded');
          await handleLlmRequest(request, response, {
            config: config.llmGateway,
            ledger: llmLedger,
            telemetry,
            accountId: account.id,
          });
        });
        return;
      }

      // MCP 全局注册：GET 读快照，PUT 覆盖本设备的端点。设备标识取身份头。
      if (route === 'mcp') {
        if (request.method === 'GET') {
          await telemetry.runSpan('chatdsh.gateway.mcp.registry', { action: 'read' }, async (span) => {
            const snapshot = mcpRegistry.snapshot(account.id);
            span.setAttribute('outcome', 'ok');
            sendJson(response, 200, { accountId: account.id, ...snapshot });
          });
          return;
        }
        if (request.method === 'PUT') {
          const deviceId = request.headers[IDENTITY_HEADERS.deviceId];
          if (typeof deviceId !== 'string' || deviceId === '') {
            sendJson(response, 400, { error: 'missing-device-id' });
            return;
          }
          const body = await readBody(request, 256 * 1024);
          const parsed = JSON.parse(body) as { servers?: unknown };
          if (typeof parsed.servers !== 'object' || parsed.servers === null || Array.isArray(parsed.servers)) {
            sendJson(response, 400, { error: 'missing-servers' });
            return;
          }
          await telemetry.runSpan('chatdsh.gateway.mcp.registry', { action: 'write' }, async (span) => {
            try {
              const written = mcpRegistry.upsertServers(account.id, deviceId, parsed.servers as never);
              span.setAttribute('outcome', 'ok');
              telemetry.counter('chatdsh_mcp_registry_writes_total', { description: 'MCP 端点上报次数' })
                .add(1, { outcome: 'ok' });
              sendJson(response, 200, { written, ...mcpRegistry.snapshot(account.id) });
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
          const deviceId = request.headers[IDENTITY_HEADERS.deviceId];
          const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'gateway'}`);
          const server = url.searchParams.get('server');
          if (typeof deviceId !== 'string' || deviceId === '' || server === null) {
            sendJson(response, 400, { error: 'missing-device-id-or-server' });
            return;
          }
          await telemetry.runSpan('chatdsh.gateway.mcp.registry', { action: 'delete' }, async (span) => {
            mcpRegistry.removeServer(account.id, deviceId, server);
            span.setAttribute('outcome', 'ok');
            telemetry.counter('chatdsh_mcp_registry_writes_total', { description: 'MCP 端点上报次数' })
              .add(1, { outcome: 'ok' });
            sendJson(response, 200, mcpRegistry.snapshot(account.id));
          });
          return;
        }
        sendJson(response, 405, { error: 'method-not-allowed' });
        return;
      }

      if (route === 'automations') {
        if (request.method === 'GET') {
          sendJson(response, 200, { accountId: account.id, automations: automations.list(account.id) });
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
          const record = automations.setEnabled(payload.id, account.id, payload.enabled);
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
        // 读副本与写副本都要按账号隔离：查询参数里的会话若归属他人，直接拒绝。
        const requested = url.searchParams.get('sessionId');
        if (requested !== null) {
          const owned = store.getSession(requested);
          if (owned !== undefined && owned.accountId !== account.id) {
            telemetry.event('chatdsh.gateway.auth.failed', {
              'auth.mode': identity.mode,
              'error.code': CHATDSH_ERROR_CODES.workspaceForbidden,
            });
            sendJson(response, 403, { error: CHATDSH_ERROR_CODES.workspaceForbidden });
            return;
          }
        }
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
          const ownership = store.getSession(sessionId);
          if (ownership !== undefined && ownership.accountId !== account.id) {
            telemetry.event('chatdsh.gateway.auth.failed', {
              'auth.mode': identity.mode,
              'error.code': CHATDSH_ERROR_CODES.workspaceForbidden,
            });
            sendJson(response, 403, { error: CHATDSH_ERROR_CODES.workspaceForbidden });
            return;
          }
          if (ownership === undefined) {
            store.upsertSession({
              sessionId,
              accountId: account.id,
              deviceId: identity.deviceId,
              cwd: String(request.headers[IDENTITY_HEADERS.workspaceId] ?? ''),
              kind: 'work',
              createdAt: Date.now(),
            });
          }
          const result = telemetry.runSpanSync('chatdsh.gateway.replica.append', {
            'session.id': sessionId,
            seq: events.length,
            bytes: Buffer.byteLength(body),
          }, (span) => {
            const appended = replica.append(account.id, sessionId, events);
            span.setAttribute('outcome', 'appended');
            return appended;
          });
          // 副本有新事件就通知同账号的在线设备：跨端一致性的来源在这里。
          push.deliver(account.id, JSON.stringify({
            kind: 'replica',
            sessionId,
            watermark: result.watermark,
            appended: events.length,
          }));
          sendJson(response, 200, result);
          return;
        }
        const sessionId = url.searchParams.get('sessionId');
        if (sessionId === null) {
          sendJson(response, 200, { accountId: account.id, watermarks: replica.listWatermarks(account.id) });
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
          sendJson(response, 200, { accountId: account.id, shares: share.list(account.id) });
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
          const ownership = store.getSession(payload.sessionId);
          if (ownership !== undefined && ownership.accountId !== account.id) {
            telemetry.event('chatdsh.gateway.auth.failed', {
              'auth.mode': identity.mode,
              'error.code': CHATDSH_ERROR_CODES.workspaceForbidden,
            });
            sendJson(response, 403, { error: CHATDSH_ERROR_CODES.workspaceForbidden });
            return;
          }
          const record = share.create({
            accountId: account.id,
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
          const revoked = share.revoke(token, account.id);
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
        for (const payload of push.drain(account.id)) response.write(`data: ${payload}\n\n`);
        const platform = typeof request.headers['x-chatdsh-platform'] === 'string'
          ? request.headers['x-chatdsh-platform']
          : identity.mode;
        const unsubscribe = push.subscribe(account.id, identity.deviceId, platform, response, originOf(request));
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

      // 已读水位：写入后向同账号的其他设备投递一条变化，供未读计数同步。
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
          const owned = store.getSession(payload.sessionId);
          if (owned !== undefined && owned.accountId !== account.id) {
            telemetry.event('chatdsh.gateway.auth.failed', {
              'auth.mode': identity.mode,
              'error.code': CHATDSH_ERROR_CODES.workspaceForbidden,
            });
            sendJson(response, 403, { error: CHATDSH_ERROR_CODES.workspaceForbidden });
            return;
          }
          const record = receipts.mark({
            sessionId: payload.sessionId,
            deviceId: identity.deviceId,
            accountId: account.id,
            readUpToSeq: payload.readUpToSeq,
          });
          push.deliver(account.id, JSON.stringify({
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
        sendJson(response, 200, { accountId: account.id, receipts: receipts.list(sessionId, account.id) });
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
        let payload: { sourceSessionId?: unknown; cwd?: unknown };
        try {
          payload = JSON.parse(body) as { sourceSessionId?: unknown; cwd?: unknown };
        } catch {
          sendJson(response, 400, { error: 'invalid-json' });
          return;
        }
        if (typeof payload.sourceSessionId !== 'string') {
          sendJson(response, 400, { error: 'invalid-payload' });
          return;
        }
        const owned = store.getSession(payload.sourceSessionId);
        if (owned !== undefined && owned.accountId !== account.id) {
          telemetry.event('chatdsh.gateway.auth.failed', {
            'auth.mode': identity.mode,
            'error.code': CHATDSH_ERROR_CODES.workspaceForbidden,
          });
          sendJson(response, 403, { error: CHATDSH_ERROR_CODES.workspaceForbidden });
          return;
        }
        const events = replica.read(payload.sourceSessionId);
        if (events.length === 0) {
          sendJson(response, 404, { error: 'replica-unavailable' });
          return;
        }
        const sessionId = randomUUID();
        store.upsertSession({
          sessionId,
          accountId: account.id,
          deviceId: identity.deviceId,
          cwd: typeof payload.cwd === 'string' ? payload.cwd : owned?.cwd ?? '',
          kind: owned?.kind ?? 'work',
          createdAt: Date.now(),
          parentSession: payload.sourceSessionId,
        });
        replica.append(account.id, sessionId, events.map((event) => ({
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

      if (route === 'schedule') {
        const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'gateway'}`);
        if (request.method === 'POST') {
          const body = await readBody(request, 256 * 1024);
          let payload: { sessionId?: unknown; action?: unknown; payload?: unknown; dueAt?: unknown; delayMs?: unknown };
          try {
            payload = JSON.parse(body) as typeof payload;
          } catch {
            sendJson(response, 400, { error: 'invalid-json' });
            return;
          }
          const action = payload.action === 'notify' ? 'notify' : payload.action === 'wake' ? 'wake' : undefined;
          const dueAt = typeof payload.dueAt === 'number'
            ? payload.dueAt
            : typeof payload.delayMs === 'number' ? Date.now() + payload.delayMs : undefined;
          if (action === undefined || dueAt === undefined) {
            sendJson(response, 400, { error: 'invalid-payload' });
            return;
          }
          const record = schedule.create({
            accountId: account.id,
            sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : undefined,
            action,
            payload: typeof payload.payload === 'string' ? payload.payload : undefined,
            dueAt,
          });
          sendJson(response, 200, record);
          return;
        }
        if (request.method === 'DELETE') {
          const id = url.searchParams.get('id');
          if (id === null) {
            sendJson(response, 400, { error: 'invalid-payload' });
            return;
          }
          const cancelled = schedule.cancel(id, account.id);
          sendJson(response, cancelled ? 200 : 404, { cancelled });
          return;
        }
        sendJson(response, 200, { accountId: account.id, tasks: schedule.list(account.id) });
        return;
      }

      // 按账号分派：配置了分派表就按账号标识与登录名依次匹配，都没命中时回落到默认运行时。
      const routedUrl = config.runtimeRoutes[account.id]
        ?? config.runtimeRoutes[identity.login]
        ?? context.runtime?.url()
        ?? config.runtimeUrl;
      const routedTarget = new URL(routedUrl);
      await proxy(request, response, {
        target: routedTarget,
        forward: routedTarget.protocol === 'https:' ? httpsRequest : httpRequest,
        accountId: account.id,
        login: account.login,
        deviceId: identity.deviceId,
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
    const route = routeOf(request.method ?? 'GET', path);
    const device = deviceIdOf(request);
    const identity = resolveIdentity(request, accessProvider, device.id);
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
    // mobile-channel.ts 里。配对与校验都在这里完成，之后把连接桥接到运行时插件。
    if (isMobileChannelPath(path)) {
      const routedUrl = context.runtime?.url() ?? config.runtimeUrl;
      const decision = handleMobileChannel(request, socket, {
        pairingCode: config.pairingCode,
        runtimeUrl: routedUrl,
        store,
        telemetry,
        accountLogin: identity.login,
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
          bridgeSockets(socket, upstreamSocket, head, upstreamHead);
          span.setAttribute('http.status_code', response.statusCode ?? 101);
          span.setAttribute('outcome', 'upgraded');
          span.end();
        },
        (response) => {
          span.setAttribute('http.status_code', response.statusCode ?? 502);
          span.setAttribute('outcome', 'rejected');
          response.resume();
          span.end();
          rejectUpgrade(502, 'runtime', 'runtime-upgrade-rejected');
        },
        (error) => fail(error)
      );
      return;
    }

    try {
      const account = store.ensureAccount(identity.login);
      const routedUrl = config.runtimeRoutes[account.id]
        ?? config.runtimeRoutes[identity.login]
        ?? context.runtime?.url()
        ?? config.runtimeUrl;
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
      headers[IDENTITY_HEADERS.accountId] = account.id;
      headers[IDENTITY_HEADERS.identitySource] = 'gateway';
      if (identity.deviceId !== '') headers[IDENTITY_HEADERS.deviceId] = identity.deviceId;
      const carrier: Record<string, string> = {};
      telemetry.inject(carrier);
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

/**
 * 校验上报的事件形状。
 *
 * 副本带上事件本体：跨设备浏览、会话导入与分享渲染都从副本读内容。遥测不记录本体，
 * 那是遥测的内容边界，与副本的职责不同。
 */
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
    accountId: string;
    login: string;
    deviceId: string;
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
  headers[IDENTITY_HEADERS.accountId] = options.accountId;
  headers[IDENTITY_HEADERS.identitySource] = 'gateway';
  if (options.deviceId !== '') headers[IDENTITY_HEADERS.deviceId] = options.deviceId;
  if (options.requestId !== '') headers[IDENTITY_HEADERS.requestId] = options.requestId;

  await telemetry.runSpan('chatdsh.gateway.proxy', {
    'runtime.id': target.host,
  }, async (span) => {
    const carrier: Record<string, string> = {};
    telemetry.inject(carrier);
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
