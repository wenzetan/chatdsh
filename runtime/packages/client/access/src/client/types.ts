/**
 * 访问界面的数据形状。
 *
 * 字段与 `@chatdsh/core-contracts` 的访问契约逐一对应：登录方式、双因素、访问会话、
 * TOTP 绑定与恢复码。页面状态在契约的 `AccessStatus` 之上增加三项渲染所需的支持信息：
 * 通行密钥不可用的原因、TOTP 是否已经完成绑定、剩余未使用的恢复码条数，这三项由访问
 * 服务按部署实际状态给出。
 * @module @chatdsh/client-access/types
 */

/** 认证方式，与访问契约的取值一致。 */
export type AccessAuthMethod = 'trusted-network' | 'password' | 'passkey' | 'totp' | 'recovery-code';

/** 第二因素方式。 */
export type SecondFactorMethod = 'totp' | 'recovery-code';

/** 需要再次认证的敏感动作，与访问契约的取值一致。 */
export type AccessSensitiveAction =
  | 'change-password'
  | 'remove-factor'
  | 'regenerate-recovery-codes'
  | 'change-access-policy'
  | 'revoke-all-sessions';

/** 通行密钥不可用的原因。 */
export type PasskeyUnavailableReason = 'verifier-library-missing' | 'not-registered' | 'browser-unsupported';

/** 每次生成的恢复码条数，与访问契约一致。 */
export const RECOVERY_CODE_COUNT = 10;

/** 接入页的访问状态。 */
export interface AccessStatus {
  /** 是否需要认证。 */
  readonly required: boolean;
  /** 当前来源下可用的认证方式。 */
  readonly methods: readonly AccessAuthMethod[];
  /** 是否已建立访问会话。 */
  readonly signedIn: boolean;
  /** 是否需要第二因素。 */
  readonly secondFactorPending: boolean;
  /** 锁定结束时刻的毫秒时间戳；未锁定时缺省。 */
  readonly lockedUntil?: number;
  /** 通行密钥不可用的原因；不可用时由访问服务给出。 */
  readonly passkeyUnavailableReason?: PasskeyUnavailableReason;
  /** TOTP 是否已经完成绑定确认。 */
  readonly totpEnrolled: boolean;
  /** 剩余未使用的恢复码条数。 */
  readonly recoveryCodesRemaining: number;
  /** 已登录时的 CSRF 令牌，只保存在页面内存里。 */
  readonly csrfToken?: string;
}

/** 访问会话。 */
export interface AccessSession {
  readonly sessionId: string;
  /** 客户端名称，取建立时的浏览器与系统描述。 */
  readonly clientName: string;
  /** 建立时刻的毫秒时间戳。 */
  readonly createdAt: number;
  /** 最近活动时刻的毫秒时间戳。 */
  readonly lastActiveAt: number;
  /** 到期时刻的毫秒时间戳。 */
  readonly expiresAt: number;
  /** 续期窗口开始时刻的毫秒时间戳。 */
  readonly renewableFrom: number;
  /** 是否为当前会话。 */
  readonly current: boolean;
  /** 已撤销时为撤销时刻。 */
  readonly revokedAt?: number;
}

/** 访问会话列表。 */
export interface AccessSessionList {
  readonly items: readonly AccessSession[];
  readonly currentSessionId: string;
}

/** 登录请求。密码与一次性凭据只在请求体里出现一次。 */
export type AccessSignIn =
  | { readonly method: 'password'; readonly password: string; readonly secondFactorTicket?: string }
  | {
    readonly method: 'passkey';
    readonly challengeId: string;
    readonly credentialId: string;
    readonly clientDataJSON: string;
    readonly authenticatorData: string;
    readonly signature: string;
  }
  | { readonly method: 'totp'; readonly code: string; readonly partialTicket: string }
  | { readonly method: 'recovery-code'; readonly code: string; readonly partialTicket: string };

/** 登录结果。 */
export type AccessSignInResult =
  | { readonly outcome: 'authenticated'; readonly session: AccessSession; readonly tokenWritten: true }
  | {
    readonly outcome: 'second-factor-required';
    readonly partialTicket: string;
    readonly methods: readonly AccessAuthMethod[];
    readonly expiresAt: number;
  }
  | {
    readonly outcome: 'rejected';
    readonly code: string;
    readonly attemptsLeft?: number;
    readonly lockedUntil?: number;
    /** 恢复码是否已经使用过。 */
    readonly used?: boolean;
  };

/** TOTP 绑定信息。 */
export interface TotpEnrollment {
  /** 绑定用的 `otpauth://` 地址。 */
  readonly otpauthUri: string;
  /** 可复制密钥，base32 写法。 */
  readonly secret: string;
  /** 已确认绑定。 */
  readonly confirmed: boolean;
}

/** 恢复码集合，只在生成时展示一次。 */
export interface RecoveryCodeSet {
  readonly codes: readonly string[];
  readonly generatedAt: number;
  readonly savedConfirmed: boolean;
}

/** 恢复码的剩余状态。 */
export interface RecoveryCodeStatus {
  readonly total: number;
  readonly remaining: number;
}

/** 再次认证请求。 */
export interface ReauthRequest {
  readonly action: AccessSensitiveAction;
  readonly method: AccessAuthMethod;
  /** 一次性凭据；受信任网络接入时缺省。 */
  readonly credential?: string;
}

/** 再次认证结果。 */
export interface ReauthResult {
  readonly outcome: 'authorized' | 'rejected';
  readonly code?: string;
  /** 有效窗口结束时刻的毫秒时间戳。 */
  readonly validUntil?: number;
}

/** 通行密钥登录所需的挑战。 */
export interface PasskeyChallenge {
  readonly challengeId: string;
  /** base64url 写法的挑战值，交给浏览器 WebAuthn 接口。 */
  readonly challenge: string;
  readonly expiresAt: number;
}

/** 一次读取的三种状态。 */
export type Loadable<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly value: T }
  | { readonly status: 'failed'; readonly error: unknown };

/** 访问界面的动作名，用于 `chatdsh.client.ui.action` 的 `action` 属性。 */
export type AccessUiAction =
  | 'access-status'
  | 'access-signin'
  | 'access-second-factor'
  | 'access-passkey'
  | 'access-totp-enroll'
  | 'access-totp-confirm'
  | 'access-recovery-generate'
  | 'access-recovery-saved'
  | 'access-sessions'
  | 'access-session-revoke'
  | 'access-sessions-revoke-all'
  | 'access-reauth';

/** 动作结果。 */
export type ActionOutcome = 'ok' | 'failed';

/** 浏览器侧遥测面。 */
export interface AccessTelemetry {
  /**
   * 包一次远端调用，记录耗时与结果。
   * @param method - 调用名，例如 `access/status`。
   * @param work - 实际请求。
   * @returns 请求结果。
   */
  run<T>(method: string, work: () => Promise<T>): Promise<T>;
  /**
   * 记录一次界面动作。
   * @param action - 动作名。
   * @param outcome - 动作结果。
   */
  action(action: AccessUiAction, outcome: ActionOutcome): void;
  /**
   * 记录一次失败。
   * @param error - 失败对象。
   */
  failure(error: unknown): void;
  /**
   * 当前在途调用的 `traceparent` 头值，供跨组件边界传播。
   * @returns 头值；不在调用中时为 `undefined`。
   */
  traceparent(): string | undefined;
}

/** 访问界面的数据入口。 */
export interface AccessGateway {
  /** 读取接入页状态。 */
  status(): Promise<AccessStatus>;
  /** 提交一次登录。 */
  signIn(body: AccessSignIn): Promise<AccessSignInResult>;
  /** 取一次通行密钥挑战。 */
  passkeyChallenge(): Promise<PasskeyChallenge>;
  /** 读取访问会话列表。 */
  sessions(): Promise<AccessSessionList>;
  /**
   * 撤销一条访问会话。
   * @param sessionId - 会话标识。
   */
  revokeSession(sessionId: string): Promise<{ readonly revokedAt: number }>;
  /**
   * 撤销全部访问会话。
   * @param keepCurrent - 是否保留当前会话。
   */
  revokeAllSessions(keepCurrent: boolean): Promise<{ readonly revokedCount: number }>;
  /** 提交一次再次认证。 */
  reauth(body: ReauthRequest): Promise<ReauthResult>;
  /** 开始 TOTP 绑定。 */
  enrollTotp(): Promise<TotpEnrollment>;
  /**
   * 用首个验证码确认 TOTP 绑定。
   * @param code - 六位验证码。
   */
  confirmTotp(code: string): Promise<void>;
  /** 读取恢复码的剩余状态。 */
  recoveryStatus(): Promise<RecoveryCodeStatus>;
  /** 重新生成一批恢复码，旧码立即失效。 */
  generateRecoveryCodes(): Promise<RecoveryCodeSet>;
  /** 确认这批恢复码已经保存。 */
  confirmRecoveryCodesSaved(): Promise<{ readonly savedConfirmed: true }>;
  /**
   * 记录一次界面动作。
   * @param action - 动作名。
   * @param outcome - 动作结果。
   */
  noteAction(action: AccessUiAction, outcome: ActionOutcome): void;
}
