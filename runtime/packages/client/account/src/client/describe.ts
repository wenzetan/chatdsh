/**
 * 设备面板的文案：角色、平台、时刻、有效期与失败原因。
 *
 * 这些函数不接触网络与浏览器环境。控制平面返回的错误码在这里折成中文说明，未知错误码
 * 原样带出，界面不会把失败显示成空列表或零值。
 * @module @chatdsh/client-account/describe
 */

import { DeviceCallError } from './gateway.ts';
import type { DeviceRole, LinkCheck } from './types.ts';

/** 角色的中文名。 */
export const ROLE_LABELS: Readonly<Record<DeviceRole, string>> = {
  host: '宿主',
  executor: '执行节点',
  both: '宿主与执行节点',
};

/** 平台标识的中文名；未列出的平台保留原值。 */
const PLATFORM_LABELS: Readonly<Record<string, string>> = {
  linux: 'Linux',
  darwin: 'macOS',
  win32: 'Windows',
  android: 'Android',
  ios: 'iOS',
  web: '浏览器',
};

/**
 * 取平台的展示名。
 * @param platform - 平台标识。
 * @returns 展示名。
 */
export function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform;
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
 * 把毫秒时刻写成相对时间。
 * @param moment - 毫秒时间戳。
 * @param now - 当前时刻。
 * @returns 相对描述。
 */
export function formatRelative(moment: number, now: number): string {
  const elapsed = now - moment;
  if (elapsed < 60_000) return '刚刚';
  if (elapsed < 3_600_000) return `${String(Math.floor(elapsed / 60_000))} 分钟前`;
  if (elapsed < 86_400_000) return `${String(Math.floor(elapsed / 3_600_000))} 小时前`;
  if (elapsed < 172_800_000) return '昨天';
  if (elapsed < 2_592_000_000) return `${String(Math.floor(elapsed / 86_400_000))} 天前`;
  return formatMoment(moment);
}

/**
 * 把剩余有效期写成倒计时。
 * @param expiresAt - 到期时刻。
 * @param now - 当前时刻。
 * @returns `04:59` 或 `已过期`。
 */
export function formatRemaining(expiresAt: number, now: number): string {
  const remaining = expiresAt - now;
  if (remaining <= 0) return '已过期';
  const total = Math.ceil(remaining / 1000);
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/** 不可达原因码的中文说明。 */
const LINK_REASONS: Readonly<Record<string, string>> = {
  'device-offline': '执行节点离线',
  'device-token-revoked': '设备令牌已撤销',
  'device-timeout': '请求在超时时间内没有返回',
  'device-unreachable': '沿设备连接的请求没有完成',
  'device-path-invalid': '链路请求路径不被接受',
  'device-channel-limit': '设备通道数量达到上限',
  'device-channel-reset': '设备通道被重置',
  'internal-error': '链路内部处理失败',
};

/**
 * 把链路检查结果写成一句话。
 * @param check - 检查结果。
 * @returns 可达时给出延迟，不可达时给出原因。
 */
export function linkCheckText(check: LinkCheck): string {
  if (check.reachable) {
    return check.latencyMs === undefined ? '可达' : `可达，往返延迟 ${String(check.latencyMs)} 毫秒`;
  }
  const code = check.code ?? 'device-unreachable';
  return `不可达：${LINK_REASONS[code] ?? code}（${code}）`;
}

/**
 * 把一次失败折成中文说明。
 * @param error - 失败对象。
 * @returns 面向用户的说明。
 */
export function describeFailure(error: unknown): string {
  if (error instanceof DeviceCallError) {
    const code = error.code;
    if (code === 'device-token-required') return '这个页面没有携带设备凭据。设备管理由控制平面签发的设备凭据授权，请从控制平面打开这一页。';
    if (code === 'device-token-invalid') return '设备凭据无效或已经失效，请从控制平面重新进入。';
    if (code === 'device-token-revoked') return '这台设备已被撤销，旧凭据不再被接受。';
    if (code === 'device-unknown') return '控制平面里没有这台设备，列表可能已经变化。';
    if (code === 'device-role-mismatch') return '链路检查只针对执行节点，访问客户端没有这条通道。';
    if (code === 'already-handled') return '这台设备已经撤销过，列表已经是最新状态。';
    if (code === 'pairing-code-invalid') return '配对码无效，请核对后重新输入。';
    if (code === 'pairing-code-expired') return '配对码已过期或已经用过，请重新签发。';
    if (code === 'pairing-rate-limited') {
      const wait = error.retryAfterMs === undefined ? '' : `请在 ${String(Math.ceil(error.retryAfterMs / 1000))} 秒后重试。`;
      return `配对尝试过于频繁，${wait}`;
    }
    if (code === 'origin-rejected') return '控制平面拒绝了来自这个来源的请求。';
    if (code === 'request-invalid') return '控制平面没有接受这次请求的格式。';
    if (code === 'payload-too-large') return '请求内容超过控制平面的上限。';
    if (code === 'gateway/offline') return '控制平面不可达，请检查网络后重试。';
    if (code === 'gateway/invalid-response') return '控制平面返回的形状不符合约定。';
    if (code === 'internal-error') return '控制平面内部处理失败，请稍后重试。';
    return `控制平面拒绝了这次请求（${code}）。`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
