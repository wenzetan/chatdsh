/**
 * 轻量中继服务端的 HTTP 与 WebSocket 服务。
 *
 * 负责设备配对、出站长连接隧道、按设备前缀转发、跨设备会话聚合、只读副本、
 * 白名单设置同步、审批通知推送、访问认证以及移动端 PWA 入口。
 * @module @chatdsh/gateway/server
 */

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import type { ChatdshTelemetry } from '@chatdsh/core-contracts';
import {
  ACCESS_SECURITY,
  accessSignInSchema,
  NODE_HEADERS,
  reauthRequestSchema,
  REAUTH_WINDOW_SECONDS,
} from '@chatdsh/core-contracts';
import type {
  GatewayAccessMode,
  GatewayConfig,
  GatewayStore,
  NodeRole,
  ReceiptStore,
  ReplicaStore,
  SettingsStore,
} from './store.ts';
import { dataRoot, SETTINGS_NAMESPACES } from './store.ts';
import type { PushHub } from './push.ts';
import { createClientHttpHandler } from './client-http.ts';
import type { ClientPrincipal } from './client-security.ts';
import { validateClientOrigin } from './client-security.ts';
import {
  deviceTokenHash,
  handleMobileTelemetryRequest,
  MOBILE_TELEMETRY_PATH,
  readLimitedBody,
} from './mobile-http.ts';
import { MobileTelemetryRelay } from './mobile-telemetry.ts';
import { DEVICE_LINK_PATH, DeviceLinkError, nodeTokenOf, type DeviceLinkHub } from './device-link.ts';
import { aggregateSessions } from './sessions.ts';
import { DevicePluginsError, fetchDevicePlugins } from './device-plugins.ts';
import { AccessStore, type AccessSessionRow } from './access/store.ts';
import { deriveAccessKey, loadAccessMasterKey } from './access/keys.ts';
import { issueCsrfToken, verifyCsrfToken } from './access/csrf.ts';
import {
  ACCESS_SESSION_TTL_MS,
  accessSessionView,
  accessTicketHash,
  accessTokenHash,
  accessTokenOf,
  newAccessToken,
  newSessionId,
  renewalOf,
  serializeAccessCookie,
} from './access/session.ts';
import { burnPasswordTime, verifyAccessPassword } from './access/password.ts';
import { totpEnrolled } from './access/totp.ts';
import { consumeRecoveryCode, generateRecoveryCodes, recoveryCodesRemaining } from './access/recovery.ts';
import { createAccessLimiter } from './access/limit.ts';
import { createNotificationHost, type NotificationHost } from './notifications/index.ts';
import { createDeviceHost, DeviceLifecycle, DeviceTransportRegistry, PairingService, type DeviceHost } from './devices/index.ts';
import { ReplicaContinuityStore } from './replica-continuity/store.ts';
import { SqliteDatabase } from './replica-continuity/sqlite.ts';
import {
  PWA_ICON_PREFIX,
  PWA_MANIFEST_PATH,
  PWA_OFFLINE_PATH,
  PWA_SERVICE_WORKER_PATH,
  renderPwaIndexHtml,
} from './pwa-page.ts';
import { BROWSER_TELEMETRY_PATH, handleBrowserTelemetryRequest } from './browser-telemetry.ts';

/** 服务实例。 */
export interface GatewayServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  url(): string;
}

/** 请求处理的共享上下文。 */
interface HandlerContext {
  readonly config: GatewayConfig;
  readonly store: GatewayStore;
  readonly replica: ReplicaStore;
  readonly receipts: ReceiptStore;
  readonly settings: SettingsStore;
  readonly push: PushHub;
  readonly telemetry: ChatdshTelemetry;
  readonly deviceLink: DeviceLinkHub;
  readonly telemetryRelay?: (signal: string, body: string) => Promise<{ status: number; detail?: string }>;
}

const DEVICE_PROBE_PATH = /^\/chatdsh\/gateway\/devices\/([^/]+)\/probe$/;
const DEVICE_PREFIX_PATH = /^\/d\/([^/]+)(\/.*)?$/;
const DEVICE_PLUGINS_PATH = /^\/chatdsh\/gateway\/devices\/([^/]+)\/plugins$/;
const DEVICE_HOST_PREFIX = '/chatdsh/gateway/devices/';
const MOBILE_PAIR_PATH = '/chatdsh/gateway/mobile/pair';
const NOTIFICATION_PREFIX = '/chatdsh/gateway/notifications';
const ACCESS_PREFIX = '/chatdsh/access';
const REPLICA_RETENTION_PATH = '/chatdsh/gateway/replica/retention';
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

const BROWSER_SECURITY_HEADERS = new Set([
  'origin',
  'referer',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-fetch-user',
]);

const DEVICE_PROXY_BODY_LIMIT = 8 * 1024 * 1024;
const DEVICE_PROXY_TIMEOUT_MS = 60_000;
const CLIENT_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;
const OWNER_CLIENT_ID = 'owner';

type EntryHandler = (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;

function routeOf(_method: string, path: string): string {
  if (path === '/healthz') return 'healthz';
  if (path === '/' || path === '/index.html') return 'pwa-index';
  if (path === BROWSER_TELEMETRY_PATH) return 'browser-telemetry';
  if (path === MOBILE_TELEMETRY_PATH) return 'mobile-telemetry';
  if (path === MOBILE_PAIR_PATH) return 'mobile-pair';
  if (path === '/chatdsh/gateway/mobile/devices') return 'mobile-devices';
  if (path === '/chatdsh/gateway/ownership') return 'ownership';
  if (path === '/chatdsh/gateway/settings') return 'settings';
  if (path === '/chatdsh/gateway/sessions') return 'sessions';
  if (path === '/chatdsh/gateway/devices/pair') return 'device-pair';
  if (DEVICE_PROBE_PATH.test(path)) return 'device-probe';
  if (DEVICE_PLUGINS_PATH.test(path)) return 'device-plugins';
  if (path === '/chatdsh/gateway/devices') return 'devices';
  if (path === REPLICA_RETENTION_PATH) return 'replica-continuity';
  if (path.startsWith(DEVICE_HOST_PREFIX)) return 'device-host';
  if (path === NOTIFICATION_PREFIX || path.startsWith(`${NOTIFICATION_PREFIX}/`)) return 'notifications';
  if (path === ACCESS_PREFIX || path.startsWith(`${ACCESS_PREFIX}/`)) return 'access';
  if (path === '/chatdsh/gateway/replica') return 'replica';
  if (path === '/chatdsh/gateway/receipt') return 'receipt';
  if (path === '/chatdsh/gateway/import') return 'import';
  if (path === '/chatdsh/gateway/events') return 'events';
  if (path.startsWith('/chatdsh/client/')) return 'client';
  if (path === PWA_MANIFEST_PATH) return 'pwa-manifest';
  if (path === PWA_SERVICE_WORKER_PATH) return 'pwa-service-worker';
  if (path === PWA_OFFLINE_PATH) return 'pwa-offline';
  if (path.startsWith(PWA_ICON_PREFIX)) return 'pwa-icon';
  if (DEVICE_PREFIX_PATH.test(path)) return 'device-proxy';
  return 'not-found';
}

const ENTRY_ROUTES: ReadonlySet<string> = new Set([
  'client',
  'device-host',
  'notifications',
  'access',
  'replica-continuity',
  'pwa-manifest',
  'pwa-service-worker',
  'pwa-offline',
  'pwa-icon',
]);

function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
}

const DEVICE_COOKIE = 'chatdsh-device';

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

function deviceIdOf(request: IncomingMessage): { id: string; issued: boolean } {
  const header = request.headers[NODE_HEADERS.id];
  if (typeof header === 'string' && header !== '') return { id: header, issued: false };
  const cookie = cookieOf(request.headers.cookie, DEVICE_COOKIE);
  if (cookie !== undefined) return { id: cookie, issued: false };
  return { id: `web-${randomUUID()}`, issued: true };
}

function originOf(request: IncomingMessage): string {
  const forwardedProto = request.headers['x-forwarded-proto'];
  const proto = (typeof forwardedProto === 'string' ? forwardedProto.split(',')[0]?.trim() : undefined) ?? 'http';
  const forwardedHost = request.headers['x-forwarded-host'];
  const host = (typeof forwardedHost === 'string' ? forwardedHost.split(',')[0]?.trim() : undefined)
    ?? request.headers.host
    ?? '127.0.0.1';
  return `${proto}://${host}`;
}

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

const ACCESS_STATUS_PATH = `${ACCESS_PREFIX}/status`;
const ACCESS_SIGN_IN_PATH = `${ACCESS_PREFIX}/sign-in`;
const ACCESS_SESSIONS_PATH = `${ACCESS_PREFIX}/sessions`;
const ACCESS_SESSION_REVOKE_PATH = `${ACCESS_PREFIX}/sessions/revoke`;
const ACCESS_SESSIONS_REVOKE_ALL_PATH = `${ACCESS_PREFIX}/sessions/revoke-all`;
const ACCESS_REAUTH_PATH = `${ACCESS_PREFIX}/reauth`;
const ACCESS_TOTP_ENROLL_PATH = `${ACCESS_PREFIX}/totp/enroll`;
const ACCESS_TOTP_CONFIRM_PATH = `${ACCESS_PREFIX}/totp/confirm`;
const ACCESS_RECOVERY_PATH = `${ACCESS_PREFIX}/recovery`;
const ACCESS_RECOVERY_SAVED_PATH = `${ACCESS_PREFIX}/recovery/saved`;
const ACCESS_PASSKEY_CHALLENGE_PATH = `${ACCESS_PREFIX}/passkey/challenge`;

interface AccessHandlerOptions {
  readonly origin: string;
  readonly mode: GatewayAccessMode;
  readonly store: AccessStore;
  readonly csrfKey: Buffer;
}

function accessSessionRow(store: AccessStore, request: IncomingMessage, now: number): AccessSessionRow | undefined {
  const token = accessTokenOf(request);
  if (token === undefined) return undefined;
  const row = store.sessionByTokenHash(accessTokenHash(token));
  if (row === undefined || row.revokedAt !== undefined) return undefined;
  const renewal = renewalOf(row, now);
  if (renewal.expired) return undefined;
  if (renewal.renew) store.touchSession(row.sessionId, now, renewal.expiresAt);
  return row;
}

function createAccessHandler(options: AccessHandlerOptions): EntryHandler {
  const { store, csrfKey, mode } = options;
  const limiter = createAccessLimiter(store);

  const jsonBodyOf = (request: IncomingMessage, response: ServerResponse): Promise<Record<string, unknown> | undefined> =>
    jsonObjectOf(request, response, 64 * 1024);

  const startSession = (request: IncomingMessage, response: ServerResponse, now: number): AccessSessionRow => {
    const token = newAccessToken();
    const sessionId = newSessionId();
    const agent = String(request.headers['user-agent'] ?? '');
    const row: AccessSessionRow = {
      sessionId,
      tokenHash: accessTokenHash(token),
      clientName: agent === '' ? platformOf(request) : agent.slice(0, 80),
      createdAt: now,
      lastActiveAt: now,
      expiresAt: now + ACCESS_SESSION_TTL_MS,
    };
    store.insertSession(row);
    response.setHeader('Set-Cookie', serializeAccessCookie(token, Math.floor(ACCESS_SESSION_TTL_MS / 1000)));
    return row;
  };

  const sendAuthenticated = (response: ServerResponse, row: AccessSessionRow): void => {
    response.setHeader('Cache-Control', 'no-store');
    sendJson(response, 200, {
      outcome: 'authenticated',
      session: accessSessionView(row, { currentSessionId: row.sessionId }),
      tokenWritten: true,
    });
  };

  const writeRejectionOf = (request: IncomingMessage, session: AccessSessionRow | undefined): string | undefined => {
    if (request.headers.origin !== options.origin) return 'origin-rejected';
    if (session === undefined) return 'auth-required';
    const expected = issueCsrfToken(csrfKey, session.tokenHash);
    const supplied = request.headers[ACCESS_SECURITY.csrfHeader];
    if (!verifyCsrfToken(Array.isArray(supplied) ? supplied[0] : supplied, expected)) return 'csrf-rejected';
    return undefined;
  };

  const requiredSession = (
    request: IncomingMessage,
    response: ServerResponse,
    now: number,
  ): AccessSessionRow | undefined => {
    const session = accessSessionRow(store, request, now);
    if (session === undefined) {
      const token = accessTokenOf(request);
      sendJson(response, 401, { error: token === undefined ? 'auth-required' : 'access-session-revoked' });
      return undefined;
    }
    return session;
  };

  const reauthOf = async (
    payload: Record<string, unknown>,
    source: string,
    now: number,
  ): Promise<{ outcome: 'authorized'; validUntil: number } | { outcome: 'rejected'; code: string }> => {
    const parsed = reauthRequestSchema.safeParse(payload);
    if (!parsed.success) return { outcome: 'rejected', code: 'request-invalid' };
    if (parsed.data.method === 'trusted-network') {
      return mode === 'disabled'
        ? { outcome: 'authorized', validUntil: now + REAUTH_WINDOW_SECONDS * 1000 }
        : { outcome: 'rejected', code: 'auth-required' };
    }
    if (parsed.data.method !== 'password') return { outcome: 'rejected', code: 'auth-invalid' };
    const decision = limiter.guard(source, now);
    if (!decision.allowed) return { outcome: 'rejected', code: decision.code };
    const credential = store.credential('password');
    const supplied = parsed.data.credential ?? '';
    if (credential === undefined) {
      await burnPasswordTime(supplied);
      limiter.fail(source, now);
      return { outcome: 'rejected', code: 'auth-invalid' };
    }
    if (!(await verifyAccessPassword(supplied, credential.digest))) {
      limiter.fail(source, now);
      return { outcome: 'rejected', code: 'auth-invalid' };
    }
    limiter.succeed(source, now);
    return { outcome: 'authorized', validUntil: now + REAUTH_WINDOW_SECONDS * 1000 };
  };

  return async (request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    if (path !== ACCESS_PREFIX && !path.startsWith(`${ACCESS_PREFIX}/`)) return false;
    const method = request.method ?? 'GET';
    const now = Date.now();
    const source = request.socket.remoteAddress ?? 'unknown';

    if (path === ACCESS_STATUS_PATH) {
      if (method !== 'GET') {
        sendJson(response, 405, { error: 'request-invalid' });
        return true;
      }
      const session = accessSessionRow(store, request, now);
      const lockedUntil = limiter.lockedUntil(source, now);
      response.setHeader('Cache-Control', 'no-store');
      sendJson(response, 200, {
        required: mode === 'required',
        methods: mode === 'required' ? ['password'] : ['trusted-network'],
        signedIn: mode === 'disabled' || session !== undefined,
        secondFactorPending: false,
        totpEnrolled: totpEnrolled(store),
        recoveryCodesRemaining: recoveryCodesRemaining(store),
        passkeyUnavailableReason: 'verifier-library-missing',
        ...(session === undefined ? {} : { csrfToken: issueCsrfToken(csrfKey, session.tokenHash) }),
        ...(lockedUntil === undefined ? {} : { lockedUntil }),
      });
      return true;
    }

    if (path === ACCESS_SIGN_IN_PATH) {
      if (method !== 'POST') {
        sendJson(response, 405, { error: 'request-invalid' });
        return true;
      }
      const payload = await jsonBodyOf(request, response);
      if (payload === undefined) return true;
      const parsed = accessSignInSchema.safeParse(payload);
      if (!parsed.success) {
        sendJson(response, 400, { error: 'request-invalid' });
        return true;
      }
      if (parsed.data.method === 'passkey') {
        sendJson(response, 503, { error: 'passkey-verifier-missing' });
        return true;
      }
      if (parsed.data.method === 'totp') {
        sendJson(response, 503, { error: 'totp-library-missing' });
        return true;
      }
      if (parsed.data.method === 'recovery-code') {
        const ticket = store.consumeTicket('second-factor', accessTicketHash(parsed.data.partialTicket), now);
        if (ticket === undefined) {
          sendJson(response, 401, { error: 'ticket-expired' });
          return true;
        }
        if (!consumeRecoveryCode(store, parsed.data.code, now)) {
          sendJson(response, 401, { error: 'recovery-code-invalid' });
          return true;
        }
        sendAuthenticated(response, startSession(request, response, now));
        return true;
      }
      const decision = limiter.guard(source, now);
      if (!decision.allowed) {
        response.setHeader('Cache-Control', 'no-store');
        sendJson(response, 429, {
          error: decision.code,
          attemptsLeft: decision.attemptsLeft,
          ...(decision.code === 'auth-locked' ? { lockedUntil: decision.lockedUntil } : {}),
        });
        return true;
      }
      const credential = store.credential('password');
      const matches = credential === undefined
        ? (await burnPasswordTime(parsed.data.password), false)
        : await verifyAccessPassword(parsed.data.password, credential.digest);
      if (!matches) {
        const failure = limiter.fail(source, now);
        response.setHeader('Cache-Control', 'no-store');
        sendJson(response, 401, {
          error: 'auth-invalid',
          attemptsLeft: failure.attemptsLeft,
          ...(failure.lockedUntil === undefined ? {} : { lockedUntil: failure.lockedUntil }),
        });
        return true;
      }
      limiter.succeed(source, now);
      if (totpEnrolled(store)) {
        const ticket = randomBytes(16).toString('base64url');
        store.insertTicket('second-factor', accessTicketHash(ticket), now + 5 * 60 * 1000, now);
        sendJson(response, 200, {
          outcome: 'second-factor-required',
          partialTicket: ticket,
          methods: ['recovery-code'],
          expiresAt: now + 5 * 60 * 1000,
        });
        return true;
      }
      sendAuthenticated(response, startSession(request, response, now));
      return true;
    }

    if (path === ACCESS_SESSIONS_PATH) {
      if (method !== 'GET') {
        sendJson(response, 405, { error: 'request-invalid' });
        return true;
      }
      const session = requiredSession(request, response, now);
      if (session === undefined) return true;
      response.setHeader('Cache-Control', 'no-store');
      sendJson(response, 200, {
        items: store.sessions().map((row) => accessSessionView(row, { currentSessionId: session.sessionId })),
        currentSessionId: session.sessionId,
      });
      return true;
    }

    if (path === ACCESS_SESSION_REVOKE_PATH) {
      if (method !== 'POST') {
        sendJson(response, 405, { error: 'request-invalid' });
        return true;
      }
      const session = requiredSession(request, response, now);
      if (session === undefined) return true;
      const rejection = writeRejectionOf(request, session);
      if (rejection !== undefined) {
        sendJson(response, rejection === 'csrf-rejected' ? 403 : 401, { error: rejection });
        return true;
      }
      const payload = await jsonBodyOf(request, response);
      if (payload === undefined) return true;
      const sessionId = payload.sessionId;
      if (typeof sessionId !== 'string' || sessionId === '') {
        sendJson(response, 400, { error: 'request-invalid' });
        return true;
      }
      if (!store.revokeSession(sessionId, now)) {
        sendJson(response, 404, { error: 'object-not-found' });
        return true;
      }
      store.clearReauth(sessionId);
      sendJson(response, 200, { revokedAt: now });
      return true;
    }

    if (path === ACCESS_SESSIONS_REVOKE_ALL_PATH) {
      if (method !== 'POST') {
        sendJson(response, 405, { error: 'request-invalid' });
        return true;
      }
      const session = requiredSession(request, response, now);
      if (session === undefined) return true;
      const rejection = writeRejectionOf(request, session);
      if (rejection !== undefined) {
        sendJson(response, rejection === 'csrf-rejected' ? 403 : 401, { error: rejection });
        return true;
      }
      const payload = await jsonBodyOf(request, response);
      if (payload === undefined) return true;
      if (payload.keepCurrent !== undefined && typeof payload.keepCurrent !== 'boolean') {
        sendJson(response, 400, { error: 'request-invalid' });
        return true;
      }
      const revokedCount = store.revokeAllSessions(now, payload.keepCurrent === true ? session.sessionId : undefined);
      sendJson(response, 200, { revokedCount });
      return true;
    }

    if (path === ACCESS_REAUTH_PATH) {
      if (method !== 'POST') {
        sendJson(response, 405, { error: 'request-invalid' });
        return true;
      }
      const session = requiredSession(request, response, now);
      if (session === undefined) return true;
      const rejection = writeRejectionOf(request, session);
      if (rejection !== undefined) {
        sendJson(response, rejection === 'csrf-rejected' ? 403 : 401, { error: rejection });
        return true;
      }
      const payload = await jsonBodyOf(request, response);
      if (payload === undefined) return true;
      const outcome = await reauthOf(payload, source, now);
      if (outcome.outcome === 'authorized') {
        store.recordReauth(session.sessionId, String(payload.action), now);
        sendJson(response, 200, { outcome: 'authorized', validUntil: outcome.validUntil });
        return true;
      }
      sendJson(response, 401, { outcome: 'rejected', code: outcome.code });
      return true;
    }

    if (path === ACCESS_TOTP_ENROLL_PATH || path === ACCESS_TOTP_CONFIRM_PATH) {
      sendJson(response, 503, { error: 'totp-library-missing' });
      return true;
    }

    if (path === ACCESS_RECOVERY_PATH) {
      const session = requiredSession(request, response, now);
      if (session === undefined) return true;
      if (method === 'GET') {
        sendJson(response, 200, store.recoveryCodeStats());
        return true;
      }
      if (method !== 'POST') {
        sendJson(response, 405, { error: 'request-invalid' });
        return true;
      }
      const rejection = writeRejectionOf(request, session);
      if (rejection !== undefined) {
        sendJson(response, rejection === 'csrf-rejected' ? 403 : 401, { error: rejection });
        return true;
      }
      const codes = generateRecoveryCodes(store, now);
      store.writeCredential('recovery-codes', JSON.stringify({ generatedAt: now, savedConfirmed: false }), now);
      response.setHeader('Cache-Control', 'no-store');
      sendJson(response, 200, { codes, generatedAt: now, savedConfirmed: false });
      return true;
    }

    if (path === ACCESS_RECOVERY_SAVED_PATH) {
      if (method !== 'POST') {
        sendJson(response, 405, { error: 'request-invalid' });
        return true;
      }
      const session = requiredSession(request, response, now);
      if (session === undefined) return true;
      const rejection = writeRejectionOf(request, session);
      if (rejection !== undefined) {
        sendJson(response, rejection === 'csrf-rejected' ? 403 : 401, { error: rejection });
        return true;
      }
      if (store.credential('recovery-codes') === undefined) {
        sendJson(response, 404, { error: 'object-not-found' });
        return true;
      }
      store.writeCredential('recovery-codes', JSON.stringify({ generatedAt: now, savedConfirmed: true }), now);
      sendJson(response, 200, { savedConfirmed: true });
      return true;
    }

    if (path === ACCESS_PASSKEY_CHALLENGE_PATH) {
      sendJson(response, 503, { error: 'passkey-verifier-missing' });
      return true;
    }

    sendJson(response, 404, { error: 'object-not-found' });
    return true;
  };
}

async function jsonObjectOf(
  request: IncomingMessage,
  response: ServerResponse,
  limit: number,
): Promise<Record<string, unknown> | undefined> {
  const text = await readLimitedBody(request, limit);
  if (text === undefined) {
    sendJson(response, 413, { error: 'payload-too-large' });
    return undefined;
  }
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    sendJson(response, 400, { error: 'request-invalid' });
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    sendJson(response, 400, { error: 'request-invalid' });
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

interface ContinuityHandlerOptions {
  readonly store: GatewayStore;
  readonly continuity: ReplicaContinuityStore;
}

function createContinuityHandler(options: ContinuityHandlerOptions): EntryHandler {
  return async (request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    if (path !== REPLICA_RETENTION_PATH) return false;
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'request-invalid' });
      return true;
    }
    const token = nodeTokenOf(request);
    const node = token === '' ? undefined : options.store.nodeByTokenHash(deviceTokenHash(token));
    const headerId = request.headers[NODE_HEADERS.id];
    const deviceId = typeof headerId === 'string' && headerId !== '' ? headerId : node?.id;
    if (node === undefined || deviceId === undefined || deviceId !== node.id) {
      sendJson(response, 401, { error: 'device-token-invalid' });
      return true;
    }
    const payload = await jsonObjectOf(request, response, 16 * 1024);
    if (payload === undefined) return true;
    if (typeof payload.sessionId !== 'string' || payload.sessionId === ''
      || (payload.action !== 'clear' && payload.action !== 'reacquire')) {
      sendJson(response, 400, { error: 'request-invalid' });
      return true;
    }
    const state = payload.action === 'clear'
      ? options.continuity.clear(payload.sessionId)
      : options.continuity.reacquire(payload.sessionId);
    sendJson(response, 200, state);
    return true;
  };
}

interface PwaContent {
  readonly manifestJson: string;
  readonly manifestContentType: string;
  readonly serviceWorkerSource: string;
  readonly offlineHtml: string;
}

const PWA_ICON_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/u;

function createPwaHandler(content: PwaContent, iconRoot: URL): EntryHandler {
  return async (request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    const method = request.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') return false;
    if (path === PWA_MANIFEST_PATH) {
      response.writeHead(200, {
        'Content-Type': content.manifestContentType,
        'Content-Length': String(Buffer.byteLength(content.manifestJson)),
        'Cache-Control': 'no-cache',
      });
      response.end(method === 'HEAD' ? undefined : content.manifestJson);
      return true;
    }
    if (path === PWA_SERVICE_WORKER_PATH) {
      response.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Content-Length': String(Buffer.byteLength(content.serviceWorkerSource)),
        'Cache-Control': 'no-cache',
      });
      response.end(method === 'HEAD' ? undefined : content.serviceWorkerSource);
      return true;
    }
    if (path === PWA_OFFLINE_PATH) {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': String(Buffer.byteLength(content.offlineHtml)),
        'Cache-Control': 'public, max-age=86400',
      });
      response.end(method === 'HEAD' ? undefined : content.offlineHtml);
      return true;
    }
    if (!path.startsWith(PWA_ICON_PREFIX)) return false;
    const name = path.slice(PWA_ICON_PREFIX.length);
    if (!PWA_ICON_NAME.test(name)) {
      sendJson(response, 404, { error: 'object-not-found' });
      return true;
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(new URL(name, iconRoot));
    } catch {
      sendJson(response, 404, { error: 'object-not-found' });
      return true;
    }
    response.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': String(bytes.length),
      'Cache-Control': 'public, max-age=86400, immutable',
    });
    response.end(method === 'HEAD' ? undefined : bytes);
    return true;
  };
}

async function loadWorkspaceModule(relative: string): Promise<Record<string, unknown>> {
  return await import(new URL(relative, import.meta.url).href) as Record<string, unknown>;
}

/** 建立轻量中继服务端。 */
export function createGatewayServer(context: HandlerContext): GatewayServer {
  const { config: rawConfig, store, replica, receipts, settings, push, telemetry } = context;
  const config: GatewayConfig = {
    ...rawConfig,
    accessMode: rawConfig.accessMode ?? 'disabled',
    pwaVersion: rawConfig.pwaVersion ?? rawConfig.version,
  };
  if (config.publicUrl === undefined && (config.host === '0.0.0.0' || config.host === '::')) {
    throw new Error('监听通配地址时必须配置 CHATDSH_PUBLIC_URL，公共入口按精确 origin 校验来源');
  }
  if (config.publicUrl !== undefined) validateClientOrigin(config.publicUrl);

  const mobileRelay = new MobileTelemetryRelay(telemetry);
  const upgradedSockets = new Set<Duplex>();
  let entryHandlers: readonly EntryHandler[] | undefined;

  const accessStore = new AccessStore(store.handle());
  const accessMasterKey = loadAccessMasterKey(join(dataRoot(), 'access', 'master.key'));
  const accessCsrfKey = deriveAccessKey(accessMasterKey, 'csrf');
  const cursorKey = createHmac('sha256', accessMasterKey).update('chatdsh/gateway/cursor/v1', 'utf8').digest();
  const continuityStore = new ReplicaContinuityStore(new SqliteDatabase(store.handle()));
  const notifications: NotificationHost = createNotificationHost({
    database: store.handle(),
    push,
    telemetry,
    deliveryMode: config.pushMode,
  });
  const pwaModule = loadWorkspaceModule('../../packages/client/pwa/lib/index.js');
  const pwaIconRoot = new URL('../../packages/client/pwa/assets/icons/', import.meta.url);
  let pwaContent: PwaContent | undefined;
  let deviceHost: DeviceHost | undefined;

  function publicOrigin(): string {
    if (config.publicUrl !== undefined) return config.publicUrl;
    const address = server.address();
    const port = address !== null && typeof address === 'object' ? address.port : config.port;
    return `http://${config.host}:${port}`;
  }

  function callerIdOf(request: IncomingMessage): string {
    return cookieOf(request.headers.cookie, DEVICE_COOKIE) ?? OWNER_CLIENT_ID;
  }

  function authenticateClient(request: IncomingMessage): ClientPrincipal {
    return {
      clientId: callerIdOf(request),
      authentication: 'cookie',
      expiresAt: Date.now() + CLIENT_SESSION_WINDOW_MS,
      deviceIds: 'all',
    };
  }

  function localDeviceIdOf(): string {
    return store.listNodes().find((node) => node.role === 'host' || node.role === 'both')?.id ?? 'local';
  }

  function entryHandlersOf(): readonly EntryHandler[] {
    if (entryHandlers !== undefined) return entryHandlers;
    const origin = publicOrigin();
    const content = pwaContent;
    if (content === undefined) {
      throw new Error('公共入口在启动装配完成之前被请求');
    }
    const transports = new DeviceTransportRegistry();
    const lifecycle = new DeviceLifecycle({
      store,
      telemetry,
      deviceLink: context.deviceLink,
      transports,
      pairing: new PairingService(),
      controlUrl: origin,
      currentExecutorId: localDeviceIdOf(),
    });
    deviceHost = createDeviceHost({ lifecycle, telemetry, transports, controlUrl: origin });
    entryHandlers = [
      deviceHost.handle,
      notifications.handle,
      createAccessHandler({ origin, mode: config.accessMode, store: accessStore, csrfKey: accessCsrfKey }),
      createContinuityHandler({ store, continuity: continuityStore }),
      createPwaHandler(content, pwaIconRoot),
      createClientHttpHandler({
        origin,
        authenticate: authenticateClient,
        store,
        replica,
        receipts,
        telemetry,
        cursorKey,
        online: (deviceId) => context.deviceLink.online(deviceId),
      }),
    ];
    return entryHandlers;
  }

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

  async function proxyToDevice(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
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
          DEVICE_PROXY_TIMEOUT_MS,
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
    const route = routeOf(request.method ?? 'GET', path);
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
        });
        return;
      }

      if (route === 'pwa-index') {
        const html = renderPwaIndexHtml({ version: config.version, deviceId: device.id });
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(html),
          'Cache-Control': 'no-store',
        });
        response.end(html);
        return;
      }

      if (route === 'browser-telemetry') {
        await handleBrowserTelemetryRequest({
          telemetry,
          origin: publicOrigin(),
          ...(context.telemetryRelay === undefined ? {} : { relay: {
            enabled: telemetry.enabled,
            reason: telemetry.reason,
            relay: context.telemetryRelay,
          } }),
        }, request, response);
        return;
      }

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
          const sessionCount = snapshot.devices.reduce((total, item) => total + item.sessions.length, 0);
          span.setAttribute('device.count', snapshot.devices.length);
          span.setAttribute('session.count', sessionCount);
          span.setAttribute('outcome', 'ok');
          sendJson(response, 200, snapshot);
        });
        return;
      }

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

      if (route === 'mobile-telemetry') {
        await handleMobileTelemetryRequest({ request, response, store, telemetry, relay: mobileRelay });
        return;
      }

      if (route === 'mobile-pair') {
        await telemetry.runSpan('chatdsh.gateway.mobile.pairing', {}, async (span) => {
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
            telemetry.counter('chatdsh_mobile_devices_total', { description: '手机设备管理操作' })
              .add(1, { action: 'pair', outcome: 'rejected' });
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
          let payload: { code?: unknown; deviceName?: unknown; name?: unknown; platform?: unknown };
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
          const platform = typeof payload.platform === 'string' && payload.platform.trim() !== ''
            ? payload.platform.trim().slice(0, 32)
            : 'mobile';
          const nameValue = typeof payload.deviceName === 'string'
            ? payload.deviceName
            : (typeof payload.name === 'string' ? payload.name : '');
          const deviceName = nameValue.trim() === '' ? platform : nameValue.trim().slice(0, 80);
          const token = randomBytes(32).toString('base64url');
          const record = store.registerMobileDevice({
            id: randomUUID(),
            name: deviceName,
            platform,
            tokenHash: deviceTokenHash(token),
          });
          span.setAttribute('outcome', 'paired');
          telemetry.counter('chatdsh_mobile_devices_total', { description: '手机设备管理操作' })
            .add(1, { action: 'pair', outcome: 'ok' });
          response.setHeader('Cache-Control', 'no-store');
          sendJson(response, 200, { deviceId: record.id, token });
        });
        return;
      }

      if (route !== 'not-found') {
        store.touchDevice({
          id: device.id,
          origin: originOf(request),
          platform: platformOf(request),
          lastSeenAt: Date.now(),
        });
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

      if (route === 'device-proxy') {
        await proxyToDevice(request, response, path);
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
          push.deliver(JSON.stringify({
            kind: 'replica',
            sessionId,
            watermark: result.watermark,
            appended: events.length,
          }));
          const approvalCallIdOf = (requestId: string): string => {
            if (requestId === '') return '';
            for (const stored of replica.read(sessionId)) {
              if (stored.kind !== 'approval/asked') continue;
              if (approvalIdOf(stored.payload) !== requestId) continue;
              return approvalInfoOf(stored.payload).callId;
            }
            return '';
          };
          for (const event of events) {
            if (event.kind === 'approval/asked') {
              const asked = approvalInfoOf(event.payload);
              push.deliver(JSON.stringify({ kind: 'approval', sessionId, toolName: asked.toolName, callId: asked.callId }));
            }
            if (event.kind === 'approval/decided') {
              const decided = approvalInfoOf(event.payload);
              const callId = decided.callId === '' ? approvalCallIdOf(approvalIdOf(event.payload)) : decided.callId;
              push.withdraw(sessionId, callId);
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
          watermark: replica.watermarkOf(sessionId) ?? null,
          events: replica.read(sessionId, upToSeq === null ? undefined : Number.parseInt(upToSeq, 10)),
        });
        return;
      }

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

      if (ENTRY_ROUTES.has(route)) {
        for (const handler of entryHandlersOf()) {
          if (await handler(request, response)) return;
        }
      }

      sendJson(response, 404, { error: 'not-found' });
    }));
  }

  const server: Server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      telemetry.log('error', 'gateway request failed', { 'error.type': error instanceof Error ? error.name : 'Unknown' });
      if (!response.headersSent) sendJson(response, 500, { error: 'internal' });
      else response.end();
    });
  });

  server.on('upgrade', (request, socket, head) => {
    upgradedSockets.add(socket);
    socket.once('close', () => upgradedSockets.delete(socket));
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    if (path === DEVICE_LINK_PATH) {
      context.deviceLink.handleUpgrade(request, socket);
      return;
    }
    if (DEVICE_PREFIX_PATH.test(path)) {
      const matched = DEVICE_PREFIX_PATH.exec(path);
      let deviceId = '';
      try {
        deviceId = matched?.[1] === undefined ? '' : decodeURIComponent(matched[1]);
      } catch {
        deviceId = '';
      }
      void telemetry.runSpan('chatdsh.gateway.device.proxy', {
        deviceId,
        'http.method': request.method ?? 'GET',
      }, async (span) => {
        const result = await context.deviceLink.handleDeviceUpgrade(request, socket, head);
        span.setAttribute('outcome', result.outcome);
        span.setAttribute('http.status_code', result.status);
        if (result.errorType !== undefined) {
          span.setAttribute('error.type', result.errorType);
          span.setAttribute('error.code', result.code);
        }
        telemetry.counter('chatdsh_gateway_device_proxies_total', { description: '按设备路由的转发次数' })
          .add(1, { outcome: result.outcome });
      }).catch((error: unknown) => {
        telemetry.log('error', 'gateway device upgrade failed', {
          'error.type': error instanceof Error ? error.name : 'Unknown',
        });
        if (!socket.destroyed) socket.destroy();
      });
      return;
    }
    const body = JSON.stringify({ error: 'not-found' });
    socket.write(
      'HTTP/1.1 404 Not Found\r\n' +
      'Content-Type: application/json; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      'Connection: close\r\n\r\n' +
      body,
    );
    socket.destroy();
  });

  return {
    async start(): Promise<void> {
      const pwa = await pwaModule;
      const buildPwa = pwa.pwaStaticContent as (options: { version: string; serviceWorkerVersion: string }) => PwaContent;
      pwaContent = buildPwa({ version: config.pwaVersion, serviceWorkerVersion: config.pwaVersion });
      notifications.start();
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => resolve());
      });
    },
    async stop(): Promise<void> {
      deviceHost?.stop();
      for (const socket of upgradedSockets) socket.destroy();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2000);
        timer.unref();
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
        server.closeAllConnections();
      });
      await notifications.close();
    },
    url(): string {
      const address = server.address();
      if (address === null || typeof address === 'string') return `http://${config.host}:${config.port}`;
      return `http://${config.host}:${address.port}`;
    },
  };
}

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

/** 取副本事件的业务数据；同时兼容完整信封与裸数据。 */
function replicaPayloadDataOf(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null) return payload;
  const record = payload as { type?: unknown; data?: unknown };
  if (typeof record.type === 'string' && Object.hasOwn(record, 'data')) return record.data;
  return payload;
}

function approvalInfoOf(payload: unknown): { toolName: string; callId: string } {
  const data = replicaPayloadDataOf(payload);
  if (typeof data !== 'object' || data === null) return { toolName: '', callId: '' };
  const record = data as { toolName?: unknown; callId?: unknown; request?: { callId?: unknown; toolName?: unknown } };
  const toolName = typeof record.toolName === 'string' ? record.toolName : (typeof record.request?.toolName === 'string' ? record.request.toolName : '');
  const callId = typeof record.callId === 'string' ? record.callId : (typeof record.request?.callId === 'string' ? record.request.callId : '');
  return { toolName, callId };
}

function approvalIdOf(payload: unknown): string {
  const data = replicaPayloadDataOf(payload);
  if (typeof data !== 'object' || data === null) return '';
  const record = data as { id?: unknown; request?: { id?: unknown } };
  if (typeof record.id === 'string') return record.id;
  return typeof record.request?.id === 'string' ? record.request.id : '';
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
