/**
 * 访问认证契约。
 *
 * 单用户部署没有账号表：部署级访问凭据与节点令牌独立管理，页面不出现账号注册与账号标识
 * 表单。认证方式为受信任网络接入、密码、通行密钥、TOTP 与一次性恢复码；访问会话列表、再次
 * 认证、恢复码重生成各自有独立契约。
 *
 * 凭据原值只在请求体里出现一次，不进入日志、导出与响应形状。
 * @module @chatdsh/core-contracts/access
 */

import { z } from 'zod';
import { chatdshErrorCodeSchema } from './errors.ts';
import {
  countSchema,
  displayNameSchema,
  epochMillisSchema,
  identifierSchema,
} from './primitives.ts';

/** 认证方式。 */
export const ACCESS_AUTH_METHODS = ['trusted-network', 'password', 'passkey', 'totp', 'recovery-code'] as const;

/** 认证方式取值。 */
export type AccessAuthMethod = (typeof ACCESS_AUTH_METHODS)[number];

/** 需要再次认证的敏感动作。 */
export const ACCESS_SENSITIVE_ACTIONS = [
  'change-password',
  'remove-factor',
  'regenerate-recovery-codes',
  'change-access-policy',
  'revoke-all-sessions',
] as const;

/** 需要再次认证的敏感动作取值。 */
export type AccessSensitiveAction = (typeof ACCESS_SENSITIVE_ACTIONS)[number];

/** 再次认证的有效窗口，单位秒。 */
export const REAUTH_WINDOW_SECONDS = 300;

/** 访问会话的绝对有效期，单位秒。 */
export const ACCESS_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** 访问会话最后若干天内仍有活动即可续期，单位秒。 */
export const ACCESS_SESSION_RENEW_WINDOW_SECONDS = 7 * 24 * 60 * 60;

/** 访问层的固定约束。 */
export const ACCESS_SECURITY = {
  /** 访问会话 cookie 名；HttpOnly、Secure、SameSite=Lax、Path 为根。 */
  sessionCookie: 'chatdsh-access',
  /** CSRF 令牌请求头。 */
  csrfHeader: 'x-chatdsh-csrf',
  /** 一次性 WebSocket 票据的有效期，单位秒。 */
  ticketTtlSeconds: 30,
  /** 密码失败 5 次后等待 5 分钟。 */
  lockoutThreshold: 5,
  /** 锁定期初始长度，单位毫秒。 */
  lockoutBaseMs: 5 * 60 * 1000,
  /** 锁定期上限，单位毫秒。 */
  lockoutMaxMs: 60 * 60 * 1000,
  /** 恢复码条数。 */
  recoveryCodeCount: 10,
} as const;

/** 部署的访问策略。 */
export const accessPolicySchema = z.object({
  /** 允许的认证方式，至少一种。 */
  methods: z.array(z.enum(ACCESS_AUTH_METHODS)).min(1),
  /** 是否要求第二因素。 */
  twoFactorRequired: z.boolean(),
  /** 受信任网络接入是否可用；只在该网络来源生效。 */
  trustedNetworkAvailable: z.boolean(),
  /** 再次认证的有效窗口，单位秒。 */
  reauthWindowSeconds: z.number().int().positive().max(REAUTH_WINDOW_SECONDS),
});

/** 部署的访问策略。 */
export type AccessPolicy = z.infer<typeof accessPolicySchema>;

/** 密码登录。 */
export const passwordSignInSchema = z.object({
  method: z.literal('password'),
  /** 密码原值；只在此请求体里出现。 */
  password: z.string().min(1).max(1024),
  /** 双因素已完成时携带第二因素票据。 */
  secondFactorTicket: identifierSchema.optional(),
});

/** 通行密钥登录。 */
export const passkeySignInSchema = z.object({
  method: z.literal('passkey'),
  /** 挑战标识，由服务端下发。 */
  challengeId: identifierSchema,
  /** 凭据标识。 */
  credentialId: identifierSchema,
  /** 客户端数据，base64url 写法。 */
  clientDataJSON: z.string().min(1),
  /** 认证器数据，base64url 写法。 */
  authenticatorData: z.string().min(1),
  /** 签名，base64url 写法。 */
  signature: z.string().min(1),
});

/** TOTP 登录。 */
export const totpSignInSchema = z.object({
  method: z.literal('totp'),
  /** 六位一次性验证码。 */
  code: z.string().regex(/^\d{6}$/),
  /** 第一阶段通过后由服务端下发的票据。 */
  partialTicket: identifierSchema,
});

/** 恢复码登录。 */
export const recoveryCodeSignInSchema = z.object({
  method: z.literal('recovery-code'),
  /** 恢复码原值，只在此请求体里出现。 */
  code: z.string().min(8).max(64),
  /** 第一阶段通过后由服务端下发的票据。 */
  partialTicket: identifierSchema,
});

/** 登录请求。 */
export const accessSignInSchema = z.discriminatedUnion('method', [
  passwordSignInSchema,
  passkeySignInSchema,
  totpSignInSchema,
  recoveryCodeSignInSchema,
]);

/** 登录请求。 */
export type AccessSignIn = z.infer<typeof accessSignInSchema>;

/** 访问会话。 */
export const accessSessionSchema = z.object({
  /** 访问会话标识。 */
  sessionId: identifierSchema,
  /** 客户端名称，取建立时的浏览器与系统描述。 */
  clientName: displayNameSchema,
  /** 建立时刻的毫秒时间戳。 */
  createdAt: epochMillisSchema,
  /** 最近活动时刻的毫秒时间戳。 */
  lastActiveAt: epochMillisSchema,
  /** 到期时刻的毫秒时间戳。 */
  expiresAt: epochMillisSchema,
  /** 续期窗口开始时刻的毫秒时间戳。 */
  renewableFrom: epochMillisSchema,
  /** 是否为当前会话。 */
  current: z.boolean(),
  /** 已撤销时为撤销时刻。 */
  revokedAt: epochMillisSchema.optional(),
});

/** 访问会话。 */
export type AccessSession = z.infer<typeof accessSessionSchema>;

/** 访问会话列表。 */
export const accessSessionListSchema = z.object({
  items: z.array(accessSessionSchema),
  /** 当前会话标识。 */
  currentSessionId: identifierSchema,
});

/** 访问会话列表。 */
export type AccessSessionList = z.infer<typeof accessSessionListSchema>;

/** 登录结果。 */
export const accessSignInResultSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('authenticated'),
    /** 建立或续期的访问会话。 */
    session: accessSessionSchema,
    /** 令牌写入 HttpOnly cookie，响应体不带原值。 */
    tokenWritten: z.literal(true),
  }),
  z.object({
    outcome: z.literal('second-factor-required'),
    /** 第一阶段通过后的票据。 */
    partialTicket: identifierSchema,
    /** 可选第二因素方式。 */
    methods: z.array(z.enum(ACCESS_AUTH_METHODS)).min(1),
    /** 票据到期时刻的毫秒时间戳。 */
    expiresAt: epochMillisSchema,
  }),
  z.object({
    outcome: z.literal('rejected'),
    code: chatdshErrorCodeSchema,
    /** 剩余尝试次数；不限次数时缺省。 */
    attemptsLeft: countSchema.optional(),
    /** 锁定期结束时刻；未锁定或缺省。 */
    lockedUntil: epochMillisSchema.optional(),
  }),
]);

/** 登录结果。 */
export type AccessSignInResult = z.infer<typeof accessSignInResultSchema>;

/** 访问状态，供接入页渲染。 */
export const accessStatusSchema = z.object({
  /** 是否需要认证。 */
  required: z.boolean(),
  /** 当前来源下可用的认证方式。 */
  methods: z.array(z.enum(ACCESS_AUTH_METHODS)),
  /** 是否已建立访问会话。 */
  signedIn: z.boolean(),
  /** 是否需要第二因素。 */
  secondFactorPending: z.boolean(),
  /** 锁定结束时刻；未锁定时缺省。 */
  lockedUntil: epochMillisSchema.optional(),
});

/** 访问状态。 */
export type AccessStatus = z.infer<typeof accessStatusSchema>;

/** TOTP 绑定信息。 */
export const totpEnrollmentSchema = z.object({
  /** 绑定用的 `otpauth://` 地址；二维码内容取它，只在专用安全页面显示。 */
  otpauthUri: z.string().regex(/^otpauth:\/\/totp\/.+$/),
  /** 可复制密钥，base32 写法。 */
  secret: z.string().regex(/^[A-Z2-7]+$/),
  /** 已确认绑定。 */
  confirmed: z.boolean(),
});

/** TOTP 绑定信息。 */
export type TotpEnrollment = z.infer<typeof totpEnrollmentSchema>;

/** 恢复码集合：只在生成时展示一次。 */
export const recoveryCodeSetSchema = z.object({
  /** 恢复码原值，条数固定。 */
  codes: z.array(z.string().min(8).max(64)).length(ACCESS_SECURITY.recoveryCodeCount),
  /** 生成时刻的毫秒时间戳。 */
  generatedAt: epochMillisSchema,
  /** 用户确认已保存；未确认前不得关闭页面。 */
  savedConfirmed: z.boolean(),
});

/** 恢复码集合。 */
export type RecoveryCodeSet = z.infer<typeof recoveryCodeSetSchema>;

/** 再次认证请求。 */
export const reauthRequestSchema = z.object({
  /** 目标敏感动作。 */
  action: z.enum(ACCESS_SENSITIVE_ACTIONS),
  /** 采用的认证方式。 */
  method: z.enum(ACCESS_AUTH_METHODS),
  /** 一次性凭据；受信任网络接入时缺省。 */
  credential: z.string().min(1).max(1024).optional(),
});

/** 再次认证请求。 */
export type ReauthRequest = z.infer<typeof reauthRequestSchema>;

/** 再次认证结果。 */
export const reauthResultSchema = z.object({
  outcome: z.enum(['authorized', 'rejected']),
  /** 失败时的错误码。 */
  code: chatdshErrorCodeSchema.optional(),
  /** 有效窗口结束时刻的毫秒时间戳。 */
  validUntil: epochMillisSchema.optional(),
});

/** 再次认证结果。 */
export type ReauthResult = z.infer<typeof reauthResultSchema>;
