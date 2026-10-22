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

import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AccessProvider, ChatdshTelemetry } from '@chatdsh/core-contracts';
import { IDENTITY_HEADERS, CHATDSH_ERROR_CODES, manualProvider, tailscaleProvider } from '@chatdsh/core-contracts';
import type { GatewayConfig, GatewayStore, ReceiptStore, ReplicaStore, ScheduleStore, ShareStore } from './store.ts';
import type { PushHub } from './push.ts';
import { renderSharePage } from './render.ts';
import { AutomationStore, handleWebhook } from './automation.ts';
import { handleLlmRequest, LlmQuotaLedger } from './llm.ts';
import { McpRegistry } from './mcp-registry.ts';

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
}

/** 路由分类，用于指标的 `route` 属性与 span 命名。方法目前不参与分类，保留参数以便后续区分读写。 */
function routeOf(_method: string, path: string): string {
  if (path === '/healthz') return 'healthz';
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
function resolveIdentity(request: IncomingMessage, provider: AccessProvider): { accountId: string; login: string; mode: string; deviceId: string } {
  // 来源身份由提供方决定：Tailscale 取 Serve 注入的头部，手动反代没有身份。
  const access = provider.identityOf(request.headers);
  const login = access.login ?? 'local';
  const deviceId = String(request.headers[IDENTITY_HEADERS.deviceId] ?? 'local');
  return { accountId: '', login, mode: access.source ?? 'local', deviceId };
}

/**
 * 建立控制平面服务。
 * @param context - 配置、存储与遥测。
 * @returns 服务实例。
 */
export function createGatewayServer(context: HandlerContext): GatewayServer {
  const { config, store, replica, share, schedule, receipts, push, telemetry } = context;
  // 可达性提供方按配置选择：Tailscale 取 Serve 注入的头部，手动反代没有来源身份。
  const accessProvider: AccessProvider = config.accessProvider === 'manual' ? manualProvider() : tailscaleProvider();
  const automations = new AutomationStore(store.handle());
  const llmLedger = new LlmQuotaLedger(store, config.llmGateway.quota);
  const mcpRegistry = new McpRegistry(store.handle());

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    const route = routeOf(request.method ?? 'GET', path);
    const started = Date.now();
    const identity = resolveIdentity(request, accessProvider);

    return telemetry.runSpan('chatdsh.gateway.http', {
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
        sendJson(response, 200, { ok: true, service: 'chatdsh-gateway', version: config.version });
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

      const account = telemetry.runSpanSync('chatdsh.gateway.identity', {
        'auth.mode': identity.mode,
      }, (span) => {
        const record = store.ensureAccount(identity.login);
        span.setAttribute('outcome', 'resolved');
        return record;
      });

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
        if (request.method !== 'GET') {
          sendJson(response, 405, { error: 'method-not-allowed' });
          return;
        }
        sendJson(response, 200, { accountId: account.id, automations: automations.list(account.id) });
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
        const unsubscribe = push.subscribe(account.id, identity.deviceId, platform, response);
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
    });
  }

  const server: Server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      telemetry.log('error', 'gateway request failed', { 'error.type': error instanceof Error ? error.name : 'Unknown' });
      if (!response.headersSent) sendJson(response, 500, { error: 'internal' });
      else response.end();
    });
  });

  return {
    start(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => resolve());
      });
    },
    stop(): Promise<void> {
      return new Promise((resolve) => {
        server.close(() => resolve());
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
  headers[IDENTITY_HEADERS.accountId] = options.accountId;
  headers[IDENTITY_HEADERS.identitySource] = 'gateway';
  if (options.deviceId !== '') headers[IDENTITY_HEADERS.deviceId] = options.deviceId;
  if (options.requestId !== '') headers[IDENTITY_HEADERS.requestId] = options.requestId;
  const carrier: Record<string, string> = {};
  if (typeof headers.traceparent === 'string') carrier.traceparent = headers.traceparent;
  if (typeof headers.tracestate === 'string') carrier.tracestate = headers.tracestate;

  await telemetry.runSpan('chatdsh.gateway.proxy', {
    'runtime.id': target.host,
  }, async (span) => {
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
