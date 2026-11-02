/**
 * 访问界面的数据入口。
 *
 * 访问接口位于同源 `/chatdsh/access` 下。请求使用 Cookie 认证，写操作附带
 * `x-chatdsh-csrf`；CSRF 令牌只保存在页面内存里，由状态响应下发。每个响应都按字段逐项
 * 校验，形状不符直接失败；错误响应里的错误码、剩余次数、锁定时刻与恢复码使用标记一并
 * 带出，界面据此给出具体原因与倒计时。
 * @module @chatdsh/client-access/gateway
 */

import { browserTelemetry } from './telemetry.ts';
import type {
  AccessGateway,
  AccessSession,
  AccessSessionList,
  AccessSignIn,
  AccessSignInResult,
  AccessStatus,
  AccessTelemetry,
  AccessUiAction,
  ActionOutcome,
  PasskeyChallenge,
  PasskeyUnavailableReason,
  ReauthRequest,
  ReauthResult,
  RecoveryCodeSet,
  RecoveryCodeStatus,
  TotpEnrollment,
} from './types.ts';

/** 访问接口的挂载前缀。 */
export const ACCESS_PREFIX = '/chatdsh/access';

/** 接入页状态。 */
export const STATUS_PATH = `${ACCESS_PREFIX}/status`;

/** 登录。 */
export const SIGN_IN_PATH = `${ACCESS_PREFIX}/sign-in`;

/** 通行密钥挑战。 */
export const PASSKEY_CHALLENGE_PATH = `${ACCESS_PREFIX}/passkey/challenge`;

/** 访问会话列表。 */
export const SESSIONS_PATH = `${ACCESS_PREFIX}/sessions`;

/** 撤销单条访问会话。 */
export const SESSION_REVOKE_PATH = `${ACCESS_PREFIX}/sessions/revoke`;

/** 撤销全部访问会话。 */
export const SESSIONS_REVOKE_ALL_PATH = `${ACCESS_PREFIX}/sessions/revoke-all`;

/** 再次认证。 */
export const REAUTH_PATH = `${ACCESS_PREFIX}/reauth`;

/** 开始 TOTP 绑定。 */
export const TOTP_ENROLL_PATH = `${ACCESS_PREFIX}/totp/enroll`;

/** 确认 TOTP 绑定。 */
export const TOTP_CONFIRM_PATH = `${ACCESS_PREFIX}/totp/confirm`;

/** 恢复码的读取与生成。 */
export const RECOVERY_PATH = `${ACCESS_PREFIX}/recovery`;

/** 恢复码已保存确认。 */
export const RECOVERY_SAVED_PATH = `${ACCESS_PREFIX}/recovery/saved`;

/** 写操作要求的请求头，跨站表单无法携带。 */
export const CSRF_HEADER = 'x-chatdsh-csrf';

/** 一次访问调用失败。 */
export class AccessCallError extends Error {
  /** 错误码，取自访问服务响应或本入口自己的失败码。 */
  readonly code: string;
  /** HTTP 状态码；网络失败时为 0。 */
  readonly status: number;
  /** 剩余尝试次数。 */
  readonly attemptsLeft: number | undefined;
  /** 锁定结束时刻的毫秒时间戳。 */
  readonly lockedUntil: number | undefined;
  /** 恢复码是否已经被使用过。 */
  readonly used: boolean | undefined;

  /**
   * @param code - 错误码。
   * @param status - HTTP 状态码。
   * @param details - 服务端给出的附加判定。
   */
  constructor(
    code: string,
    status: number,
    details: { readonly attemptsLeft?: number; readonly lockedUntil?: number; readonly used?: boolean } = {},
  ) {
    super(`${code}（${String(status)}）`);
    this.name = 'AccessCallError';
    this.code = code;
    this.status = status;
    this.attemptsLeft = details.attemptsLeft;
    this.lockedUntil = details.lockedUntil;
    this.used = details.used;
  }
}

/** 数据入口的构造依赖。 */
export interface AccessGatewayOptions {
  /** 发请求的实现；浏览器里是全局 `fetch`。 */
  readonly fetchImpl?: typeof fetch;
  /** 遥测面。 */
  readonly telemetry?: AccessTelemetry;
}

/** 一次请求的参数。 */
interface AccessRequest {
  readonly method?: 'GET' | 'POST';
  readonly body?: unknown;
  /** 写操作：补上 CSRF 令牌。 */
  readonly write?: boolean;
}

const AUTH_METHODS = ['trusted-network', 'password', 'passkey', 'totp', 'recovery-code'] as const;

const PASSKEY_REASONS = ['verifier-library-missing', 'not-registered', 'browser-unsupported'] as const;

/** 断言响应体是一个对象。 */
function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AccessCallError('gateway/invalid-response', 200);
  }
  return value as Record<string, unknown>;
}

/** 读一个必填字符串字段。 */
function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value === '') throw new AccessCallError('gateway/invalid-response', 200);
  return value;
}

/** 读一个必填布尔字段。 */
function requireBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') throw new AccessCallError('gateway/invalid-response', 200);
  return value;
}

/** 读一个必填的非负整数字段。 */
function requireCount(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new AccessCallError('gateway/invalid-response', 200);
  }
  return value;
}

/** 读一个可选的非负整数字段。 */
function optionalCount(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new AccessCallError('gateway/invalid-response', 200);
  }
  return value;
}

/** 读一个可选的字符串字段。 */
function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '') throw new AccessCallError('gateway/invalid-response', 200);
  return value;
}

/** 校验认证方式数组。 */
function parseMethods(value: unknown): readonly AccessStatus['methods'][number][] {
  if (!Array.isArray(value)) throw new AccessCallError('gateway/invalid-response', 200);
  return value.map((item) => {
    if (typeof item !== 'string' || !(AUTH_METHODS as readonly string[]).includes(item)) {
      throw new AccessCallError('gateway/invalid-response', 200);
    }
    return item as AccessStatus['methods'][number];
  });
}

/** 校验一条访问会话。 */
function parseSession(value: unknown): AccessSession {
  const record = requireRecord(value);
  const revokedAt = optionalCount(record, 'revokedAt');
  return {
    sessionId: requireString(record, 'sessionId'),
    clientName: requireString(record, 'clientName'),
    createdAt: requireCount(record, 'createdAt'),
    lastActiveAt: requireCount(record, 'lastActiveAt'),
    expiresAt: requireCount(record, 'expiresAt'),
    renewableFrom: requireCount(record, 'renewableFrom'),
    current: requireBoolean(record, 'current'),
    ...(revokedAt === undefined ? {} : { revokedAt }),
  };
}

/**
 * 校验接入页状态。
 * @param value - 响应体。
 * @returns 访问状态。
 */
export function parseStatus(value: unknown): AccessStatus {
  const record = requireRecord(value);
  const lockedUntil = optionalCount(record, 'lockedUntil');
  const csrfToken = optionalString(record, 'csrfToken');
  const reason = optionalString(record, 'passkeyUnavailableReason');
  if (reason !== undefined && !(PASSKEY_REASONS as readonly string[]).includes(reason)) {
    throw new AccessCallError('gateway/invalid-response', 200);
  }
  return {
    required: requireBoolean(record, 'required'),
    methods: parseMethods(record['methods']),
    signedIn: requireBoolean(record, 'signedIn'),
    secondFactorPending: requireBoolean(record, 'secondFactorPending'),
    totpEnrolled: requireBoolean(record, 'totpEnrolled'),
    recoveryCodesRemaining: requireCount(record, 'recoveryCodesRemaining'),
    ...(lockedUntil === undefined ? {} : { lockedUntil }),
    ...(csrfToken === undefined ? {} : { csrfToken }),
    ...(reason === undefined ? {} : { passkeyUnavailableReason: reason as PasskeyUnavailableReason }),
  };
}

/**
 * 校验登录结果。
 * @param value - 响应体。
 * @returns 登录结果。
 */
export function parseSignInResult(value: unknown): AccessSignInResult {
  const record = requireRecord(value);
  const outcome = record['outcome'];
  if (outcome === 'authenticated') {
    return { outcome, session: parseSession(record['session']), tokenWritten: true };
  }
  if (outcome === 'second-factor-required') {
    const methods = parseMethods(record['methods']);
    if (methods.every((method) => method !== 'totp' && method !== 'recovery-code')) {
      throw new AccessCallError('gateway/invalid-response', 200);
    }
    return {
      outcome,
      partialTicket: requireString(record, 'partialTicket'),
      methods,
      expiresAt: requireCount(record, 'expiresAt'),
    };
  }
  if (outcome === 'rejected') {
    const attemptsLeft = optionalCount(record, 'attemptsLeft');
    const lockedUntil = optionalCount(record, 'lockedUntil');
    const used = record['used'];
    return {
      outcome,
      code: requireString(record, 'code'),
      ...(attemptsLeft === undefined ? {} : { attemptsLeft }),
      ...(lockedUntil === undefined ? {} : { lockedUntil }),
      ...(typeof used === 'boolean' ? { used } : {}),
    };
  }
  throw new AccessCallError('gateway/invalid-response', 200);
}

/**
 * 校验访问会话列表。
 * @param value - 响应体。
 * @returns 会话列表。
 */
export function parseSessionList(value: unknown): AccessSessionList {
  const record = requireRecord(value);
  const items = record['items'];
  if (!Array.isArray(items)) throw new AccessCallError('gateway/invalid-response', 200);
  return { items: items.map(parseSession), currentSessionId: requireString(record, 'currentSessionId') };
}

/**
 * 校验 TOTP 绑定信息。
 * @param value - 响应体。
 * @returns 绑定信息。
 */
export function parseTotpEnrollment(value: unknown): TotpEnrollment {
  const record = requireRecord(value);
  const otpauthUri = requireString(record, 'otpauthUri');
  if (!otpauthUri.startsWith('otpauth://totp/')) throw new AccessCallError('gateway/invalid-response', 200);
  const secret = requireString(record, 'secret');
  if (!/^[A-Z2-7]+$/.test(secret)) throw new AccessCallError('gateway/invalid-response', 200);
  return { otpauthUri, secret, confirmed: requireBoolean(record, 'confirmed') };
}

/**
 * 校验恢复码集合。
 * @param value - 响应体。
 * @returns 恢复码集合。
 */
export function parseRecoveryCodeSet(value: unknown): RecoveryCodeSet {
  const record = requireRecord(value);
  const codes = record['codes'];
  if (!Array.isArray(codes) || codes.length !== 10) throw new AccessCallError('gateway/invalid-response', 200);
  if (codes.some((code) => typeof code !== 'string' || code.length < 8 || code.length > 64)) {
    throw new AccessCallError('gateway/invalid-response', 200);
  }
  return {
    codes: codes as string[],
    generatedAt: requireCount(record, 'generatedAt'),
    savedConfirmed: requireBoolean(record, 'savedConfirmed'),
  };
}

/**
 * 校验恢复码的剩余状态。
 * @param value - 响应体。
 * @returns 剩余状态。
 */
export function parseRecoveryCodeStatus(value: unknown): RecoveryCodeStatus {
  const record = requireRecord(value);
  const total = requireCount(record, 'total');
  const remaining = requireCount(record, 'remaining');
  if (remaining > total) throw new AccessCallError('gateway/invalid-response', 200);
  return { total, remaining };
}

/**
 * 校验再次认证结果。
 * @param value - 响应体。
 * @returns 再次认证结果。
 */
export function parseReauthResult(value: unknown): ReauthResult {
  const record = requireRecord(value);
  const outcome = record['outcome'];
  if (outcome !== 'authorized' && outcome !== 'rejected') throw new AccessCallError('gateway/invalid-response', 200);
  const code = optionalString(record, 'code');
  const validUntil = optionalCount(record, 'validUntil');
  return {
    outcome,
    ...(code === undefined ? {} : { code }),
    ...(validUntil === undefined ? {} : { validUntil }),
  };
}

/**
 * 校验通行密钥挑战。
 * @param value - 响应体。
 * @returns 挑战。
 */
export function parsePasskeyChallenge(value: unknown): PasskeyChallenge {
  const record = requireRecord(value);
  return {
    challengeId: requireString(record, 'challengeId'),
    challenge: requireString(record, 'challenge'),
    expiresAt: requireCount(record, 'expiresAt'),
  };
}

/** 从失败响应里取错误码与附加判定。 */
async function failureOf(response: Response): Promise<AccessCallError> {
  const text = await response.text();
  if (text === '') return new AccessCallError('request-failed', response.status);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new AccessCallError('request-failed', response.status);
  }
  const record = requireRecord(body);
  const code = typeof record['error'] === 'string' && record['error'] !== '' ? record['error'] : 'request-failed';
  const attemptsLeft = optionalCount(record, 'attemptsLeft');
  const lockedUntil = optionalCount(record, 'lockedUntil');
  const used = record['used'];
  return new AccessCallError(code, response.status, {
    ...(attemptsLeft === undefined ? {} : { attemptsLeft }),
    ...(lockedUntil === undefined ? {} : { lockedUntil }),
    ...(typeof used === 'boolean' ? { used } : {}),
  });
}

/**
 * 建立真实的访问数据入口。
 * @param options - 依赖。
 * @returns 数据入口。
 */
export function createAccessGateway(options: AccessGatewayOptions = {}): AccessGateway {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const telemetry = options.telemetry ?? browserTelemetry;
  let csrfToken: string | undefined;

  /**
   * 发起一次访问请求。
   * @param method - 遥测调用名。
   * @param path - 请求路径。
   * @param request - 请求参数。
   * @returns 响应体。
   */
  const send = async (method: string, path: string, request: AccessRequest = {}): Promise<unknown> =>
    await telemetry.run(method, async () => {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (request.write === true) {
        if (csrfToken !== undefined) headers[CSRF_HEADER] = csrfToken;
        headers['content-type'] = 'application/json';
      }
      const traceparent = telemetry.traceparent();
      if (traceparent !== undefined) headers['traceparent'] = traceparent;
      const init: RequestInit = { headers, credentials: 'same-origin' };
      if (request.method !== undefined) init.method = request.method;
      if (request.body !== undefined) init.body = JSON.stringify(request.body);
      const response = await fetchImpl(path, init).catch(() => {
        throw new AccessCallError('gateway/offline', 0);
      });
      if (!response.ok) throw await failureOf(response);
      const text = await response.text();
      return text === '' ? undefined : (JSON.parse(text) as unknown);
    });

  return {
    async status(): Promise<AccessStatus> {
      const status = parseStatus(await send('access/status', STATUS_PATH));
      csrfToken = status.csrfToken;
      return status;
    },

    async signIn(body: AccessSignIn): Promise<AccessSignInResult> {
      return parseSignInResult(await send('access/sign-in', SIGN_IN_PATH, { method: 'POST', body, write: true }));
    },

    async passkeyChallenge(): Promise<PasskeyChallenge> {
      return parsePasskeyChallenge(await send('access/passkey-challenge', PASSKEY_CHALLENGE_PATH, { method: 'POST', write: true }));
    },

    async sessions(): Promise<AccessSessionList> {
      return parseSessionList(await send('access/sessions', SESSIONS_PATH));
    },

    async revokeSession(sessionId: string): Promise<{ readonly revokedAt: number }> {
      const value = requireRecord(await send('access/session-revoke', SESSION_REVOKE_PATH, {
        method: 'POST',
        write: true,
        body: { sessionId },
      }));
      return { revokedAt: requireCount(value, 'revokedAt') };
    },

    async revokeAllSessions(keepCurrent: boolean): Promise<{ readonly revokedCount: number }> {
      const value = requireRecord(await send('access/sessions-revoke-all', SESSIONS_REVOKE_ALL_PATH, {
        method: 'POST',
        write: true,
        body: { keepCurrent },
      }));
      return { revokedCount: requireCount(value, 'revokedCount') };
    },

    async reauth(body: ReauthRequest): Promise<ReauthResult> {
      return parseReauthResult(await send('access/reauth', REAUTH_PATH, { method: 'POST', write: true, body }));
    },

    async enrollTotp(): Promise<TotpEnrollment> {
      return parseTotpEnrollment(await send('access/totp-enroll', TOTP_ENROLL_PATH, { method: 'POST', write: true }));
    },

    async confirmTotp(code: string): Promise<void> {
      const value = requireRecord(await send('access/totp-confirm', TOTP_CONFIRM_PATH, {
        method: 'POST',
        write: true,
        body: { code },
      }));
      if (value['confirmed'] !== true) throw new AccessCallError('gateway/invalid-response', 200);
    },

    async recoveryStatus(): Promise<RecoveryCodeStatus> {
      return parseRecoveryCodeStatus(await send('access/recovery-status', RECOVERY_PATH));
    },

    async generateRecoveryCodes(): Promise<RecoveryCodeSet> {
      return parseRecoveryCodeSet(await send('access/recovery-generate', RECOVERY_PATH, { method: 'POST', write: true }));
    },

    async confirmRecoveryCodesSaved(): Promise<{ readonly savedConfirmed: true }> {
      const value = requireRecord(await send('access/recovery-saved', RECOVERY_SAVED_PATH, { method: 'POST', write: true }));
      if (value['savedConfirmed'] !== true) throw new AccessCallError('gateway/invalid-response', 200);
      return { savedConfirmed: true };
    },

    noteAction(action: AccessUiAction, outcome: ActionOutcome): void {
      telemetry.action(action, outcome);
    },
  };
}
