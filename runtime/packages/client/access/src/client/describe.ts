/**
 * 访问界面的文案：错误码、认证方式、敏感动作、时刻与倒计时。
 *
 * 这些函数不接触网络与浏览器存储。访问服务返回的错误码在这里折成中文说明，未知错误码
 * 原样带出，界面不会把失败显示成成功或空白。
 * @module @chatdsh/client-access/describe
 */

import { AccessCallError } from './gateway.ts';
import type { AccessAuthMethod, AccessSensitiveAction, PasskeyUnavailableReason } from './types.ts';

/** 认证方式的中文名。 */
export const METHOD_LABELS: Readonly<Record<AccessAuthMethod, string>> = {
  'trusted-network': '受信任网络',
  password: '密码',
  passkey: '通行密钥',
  totp: '验证码',
  'recovery-code': '恢复码',
};

/** 敏感动作的中文名。 */
export const SENSITIVE_ACTION_LABELS: Readonly<Record<AccessSensitiveAction, string>> = {
  'change-password': '修改密码',
  'remove-factor': '移除验证方式',
  'regenerate-recovery-codes': '重新生成恢复码',
  'change-access-policy': '修改访问策略',
  'revoke-all-sessions': '撤销全部访问会话',
};

/** 通行密钥不可用原因的说明。 */
export const PASSKEY_REASON_TEXT: Readonly<Record<PasskeyUnavailableReason, string>> = {
  'verifier-library-missing': '访问服务没有接入成熟的通行密钥校验库，本部署无法使用通行密钥登录。',
  'not-registered': '当前部署没有登记通行密钥，请先绑定通行密钥再使用这种登录方式。',
  'browser-unsupported': '当前浏览器不支持 WebAuthn，无法使用通行密钥登录。',
};

/** 访问错误码的中文说明。 */
const ERROR_TEXT: Readonly<Record<string, string>> = {
  'auth-invalid': '密码或验证码不正确。',
  'auth-locked': '连续失败次数过多，访问已进入等待期。',
  'auth-rate-limited': '尝试过于频繁，请稍后再试。',
  'totp-invalid': '验证码不正确，或该验证码的时间片已经被使用。',
  'recovery-code-invalid': '恢复码无效。',
  'passkey-rejected': '通行密钥校验未通过。',
  'reauth-required': '该动作需要再次认证。',
  'last-factor-required': '这是最后一种可用的验证方式，不能移除。',
  'access-session-revoked': '访问会话已经撤销或到期，请重新登录。',
  'ticket-expired': '第二因素票据已经过期，请重新输入密码。',
  'csrf-rejected': '请求校验失败，请刷新页面后重试。',
  'origin-rejected': '请求来源与部署地址不符。',
  'request-invalid': '请求内容不符合约定。',
  'internal-error': '访问服务内部错误。',
  'object-not-found': '目标不存在。',
  'permission-denied': '当前访问会话没有执行该动作的权限。',
  'gateway/offline': '访问服务不可达，请检查网络与控制平面。',
  'gateway/invalid-response': '访问服务返回的内容不符合约定。',
  'request-failed': '请求失败。',
};

/**
 * 把一次失败写成可读的原因。
 * @param error - 失败对象。
 * @returns 中文说明，未知错误码带出原码。
 */
export function describeAccessFailure(error: unknown): string {
  if (error instanceof AccessCallError) {
    const text = ERROR_TEXT[error.code];
    if (text !== undefined) return text;
    return `访问服务返回错误码 ${error.code}。`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 从失败对象里取错误码。
 * @param error - 失败对象。
 * @returns 错误码；传入值属于其他失败对象时为 `undefined`。
 */
export function accessErrorCodeOf(error: unknown): string | undefined {
  return error instanceof AccessCallError ? error.code : undefined;
}

/** 补两位数字。 */
function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * 把毫秒时刻写成日期与时间。
 * @param moment - 毫秒时间戳。
 * @returns 例如 `2026年11月01日 22:41`。
 */
export function formatMoment(moment: number): string {
  const date = new Date(moment);
  return `${String(date.getFullYear())}年${pad(date.getMonth() + 1)}月${pad(date.getDate())}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 把毫秒时刻写成时分。
 * @param moment - 毫秒时间戳。
 * @returns 例如 `22:41`。
 */
export function formatTimeOfDay(moment: number): string {
  const date = new Date(moment);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 把毫秒时刻写成相对时间。
 * @param moment - 毫秒时间戳。
 * @param now - 当前时刻。
 * @returns 相对描述。
 */
export function formatRelative(moment: number, now: number): string {
  const elapsed = now - moment;
  if (elapsed < 0) return '刚刚';
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${String(minutes)} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)} 小时前`;
  return `${String(Math.floor(hours / 24))} 天前`;
}

/**
 * 把剩余毫秒数写成 ``4 分 59 秒``。
 * @param remainingMs - 剩余毫秒数。
 * @returns 中文时长；已经到期时返回 `0 秒`。
 */
export function formatRemaining(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes === 0 ? `${String(seconds)} 秒` : `${String(minutes)} 分 ${String(seconds)} 秒`;
}

/**
 * 把剩余毫秒数写成 ``04:59``。
 * @param remainingMs - 剩余毫秒数。
 * @returns 时钟写法。
 */
export function formatClock(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  return `${pad(Math.floor(totalSeconds / 60))}:${pad(totalSeconds % 60)}`;
}

/** TOTP 时间片长度，单位毫秒。 */
export const TOTP_PERIOD_MS = 30_000;

/**
 * 当前时间片还剩多少秒。
 * @param now - 当前时刻的毫秒时间戳。
 * @returns 剩余秒数，取值为 1 到 30。
 */
export function timeStepSecondsLeft(now: number): number {
  const elapsed = now % TOTP_PERIOD_MS;
  const left = Math.ceil((TOTP_PERIOD_MS - elapsed) / 1000);
  return left === 0 ? 30 : left;
}
