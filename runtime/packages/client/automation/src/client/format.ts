/**
 * 触发条件、投递状态与错误码的文案。
 *
 * 全部是纯函数：同一份取值在任何地方得到同一句话。投递状态的文案按契约的状态机给出，
 * 错误码只翻译已登记的取值，未登记的码原样显示，避免把未知原因说成已知。
 * @module @chatdsh/client-automation/format
 */

import { describeSpec, type ScheduleSpec } from './schedule.ts';
import type { AutomationRecord, AutomationTrigger, DeliveryState, DedupeResult } from './types.ts';

/** 投递状态的名称。 */
export const DELIVERY_STATE_LABELS: Readonly<Record<DeliveryState, string>> = {
  received: '已接收',
  validated: '已校验',
  dispatching: '投递中',
  accepted: '已受理',
  completed: '已完成',
  failed: '失败',
  unconfirmed: '结果未确认',
};

/** 投递状态的徽标色调。 */
export const DELIVERY_STATE_TONES: Readonly<Record<DeliveryState, 'ok' | 'neutral' | 'warn' | 'danger'>> = {
  received: 'neutral',
  validated: 'neutral',
  dispatching: 'warn',
  accepted: 'warn',
  completed: 'ok',
  failed: 'danger',
  unconfirmed: 'warn',
};

/** 去重结果的名称。 */
export const DEDUPE_LABELS: Readonly<Record<DedupeResult, string>> = {
  new: '新事件',
  duplicate: '重复事件，未重复建立会话',
};

/** 来源的名称。 */
export const SOURCE_LABELS: Readonly<Record<string, string>> = {
  github: 'GitHub',
  generic: '通用 webhook',
};

/** 控制平面与宿主会返回的错误码对应的说明。 */
const ERROR_TEXT: Readonly<Record<string, string>> = {
  'automation-not-found': '控制平面没有这条自动化记录，它可能已被删除。',
  'automation-disabled': '这条自动化已停用，控制器不会受理新的投递。',
  'automation-secret-missing': '签名密钥所在的环境变量没有配置，控制器拒绝执行。',
  'automation-trigger-not-webhook': '这条自动化的触发条件是定时，不接受 webhook 投递。',
  'automation-delivery-unconfirmed': '上一次投递的结果尚未确认，控制器在查询原结果。',
  'webhook-unauthorized': '签名密钥不匹配，控制器拒绝了这次投递。',
  'webhook-secret-unconfigured': '签名密钥的环境变量没有配置，控制器按未配置处理并拒绝投递。',
  'webhook-signature-invalid': '签名不合法，控制器拒绝了这次投递。',
  'automation/webhook-invalid': '请求体不是控制器能识别的 JSON 对象。',
  'device-offline': '目标设备当前离线，控制器不建立离线重发任务。',
  'device-not-found': '目标设备没有登记在控制平面。',
  'invalid-payload': '请求内容不合法，缺少必需字段或类型不对。',
  'invalid-json': '请求体不是合法的 JSON。',
  'csrf-required': '写操作需要页面携带的同源标识。',
  'method-not-allowed': '控制平面没有提供这个操作。',
  'control-plane-unreachable': '控制平面不可达，请恢复连接后重试。',
  'gateway/internal': '控制平面返回了无法识别的应答。',
  'schedule-host-unavailable': '原会话所在的运行时没有提供定时任务接口。',
  'unauthorized': '当前访问没有权限执行这个操作。',
};

/**
 * 把错误码翻译成界面说明。
 * @param code - 错误码。
 * @returns 说明文字；未登记的码原样带出。
 */
export function describeCode(code: string): string {
  const known = ERROR_TEXT[code];
  if (known !== undefined) return known;
  return `控制器返回了未登记的错误码：${code}`;
}

/**
 * 把触发条件写成一句话。
 * @param trigger - 触发条件。
 * @param spec - 定时触发的时间方式；缺省时用 cron 表达式描述。
 * @param now - 当前时刻，用于判断单次任务是否已经到了。
 * @returns 摘要。
 */
export function describeTrigger(trigger: AutomationTrigger, spec?: ScheduleSpec, now?: number): string {
  if (trigger.kind === 'webhook') return `webhook 投递 · 签名密钥来自 ${trigger.secretEnv}`;
  if (spec !== undefined) return `定时触发 · ${describeSpec(spec, now)}`;
  return `定时触发 · cron ${trigger.cron}`;
}

/**
 * 把执行目标写成一句话。
 * @param target - 执行目标。
 * @returns 摘要。
 */
export function describeTarget(target: AutomationRecord['target']): string {
  if (target === undefined) return '执行目标未指定';
  const parts: string[] = [];
  parts.push(target.deviceName ?? target.deviceId ?? '执行设备未指定');
  const workspace = target.workspaceName ?? target.workspaceId;
  if (workspace !== undefined) parts.push(`工作区 ${workspace}`);
  if (target.cwd !== undefined) parts.push(`目录 ${target.cwd}`);
  const preset = target.presetName ?? target.presetId;
  if (preset !== undefined) parts.push(`助手 ${preset}`);
  if (target.model !== undefined) parts.push(`模型 ${target.model}`);
  return parts.join(' · ');
}

/**
 * 把一个时刻写成本地日期与时间。
 * @param epochMs - 时刻。
 * @returns 例如「2026年11月1日 22:40」。
 */
export function formatTimestamp(epochMs: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(epochMs));
}

/**
 * 把投递记录里的时间差写成一句话。
 * @param epochMs - 时刻。
 * @param now - 当前时刻。
 * @returns 例如「3 分钟前」。
 */
export function describeAgo(epochMs: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - epochMs) / 1000));
  if (seconds < 60) return `${String(seconds)} 秒前`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)} 小时前`;
  return `${String(Math.round(hours / 24))} 天前`;
}

/**
 * 一条自动化的 webhook 投递地址。
 * @param origin - 页面来源。
 * @param automationId - 自动化标识。
 * @returns 完整地址。
 */
export function webhookUrlOf(origin: string, automationId: string): string {
  return new URL(`/chatdsh/gateway/webhook/${encodeURIComponent(automationId)}`, origin).toString();
}

/**
 * 一条投递记录的摘要行。
 * @param delivery - 投递记录。
 * @returns 来源、接收时间与去重结论。
 */
export function describeDelivery(delivery: {
  readonly source: string;
  readonly receivedAt: number;
  readonly dedupe: DedupeResult;
}): string {
  return `${SOURCE_LABELS[delivery.source] ?? delivery.source} · ${formatTimestamp(delivery.receivedAt)} · ${DEDUPE_LABELS[delivery.dedupe]}`;
}
