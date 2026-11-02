/**
 * 自动化的存储、执行目标校验与 webhook 投递处理。
 *
 * 一张表存自动化记录，另一张表存投递记录。投递按 `(automation_id, event_id)` 唯一：
 * 同一外部事件重复投递只保留一行，尝试次数累加，已收下的事件不再建立会话。执行目标
 * 保存明确的设备标识，设备取自控制平面的 `node_devices`，工作区取自会话归属里该设备
 * 登记过的 `workspace_id`，在线状态由设备长连接表经环境注入给出。没有长连接的设备按
 * 离线处理：离线目标在建立记录与投递事件时都被拒绝，控制平面不排队也不建立重发任务。
 *
 * 控制平面只持有记录与投递结果，不运行定时调度；定时任务由原会话所在运行时的
 * `ctx.schedule` 承担。投递被收下之后，建立会话交给注入的派发器；没有派发器时记录停在
 * 已收下状态，会话标识留空。
 * @module @chatdsh/gateway/automation
 */

import { createHash, randomUUID } from 'node:crypto';
import { posix, win32 } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  AUTOMATION_ERROR_CODES,
  ChatdshError,
  type AutomationAction,
  type AutomationDeliveryState,
  type AutomationDedupeResult,
  type AutomationEvent,
  type AutomationEventSource,
  type AutomationRecord as ContractAutomationRecord,
  type AutomationTrigger,
  type ScheduleSpec,
} from '@chatdsh/core-contracts';
import { WebhookInvalidError, normalizeWebhook } from '@chatdsh/forge-bridge';
import { migrateAccountColumns } from './store.ts';

export type {
  AutomationDeliveryState,
  AutomationDedupeResult,
  AutomationEvent,
  AutomationEventSource,
  AutomationRecord as ContractAutomationRecord,
  AutomationTrigger,
  ScheduleSpec,
} from '@chatdsh/core-contracts';

/** 展示名的长度上限。 */
const NAME_MAX = 80;

/** 提示词的长度上限。 */
const PROMPT_MAX = 4000;

/** 标识的长度上限。 */
const IDENTIFIER_MAX = 200;

/** 名称类字段的长度上限。 */
const LABEL_MAX = 120;

/** 签名密钥所在环境变量名的写法。 */
const SECRET_ENV_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/** 自动化标识、设备标识与工作区标识的写法。 */
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

/** 五段式 cron 表达式里允许出现的字符。 */
const CRON_TOKEN_PATTERN = /^[0-9*/,\-]+$/;

/** 本日时刻的写法。 */
const CLOCK_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 支持的 IANA 时区名称。 */
const TIME_ZONES: ReadonlySet<string> = new Set(Intl.supportedValuesOf('timeZone'));

/** 投递失败原因的固定取值，不含请求原文。 */
export const AUTOMATION_FAILURE_REASONS = [
  'automation-disabled',
  'trigger',
  'secret',
  'signature',
  'payload',
  'target-unknown',
  'target-role',
  'target-offline',
  'dispatch',
  'unconfirmed',
] as const;

/** 投递失败原因。 */
export type AutomationFailureReason = (typeof AUTOMATION_FAILURE_REASONS)[number];

/** 执行目标。设备标识必填，其余字段省略时由目标设备取默认值。 */
export interface AutomationTarget {
  /** 执行设备标识。 */
  readonly deviceId: string;
  /** 目标工作区标识。 */
  readonly workspaceId?: string;
  /** 目标目录的绝对路径。 */
  readonly cwd?: string;
  /** 助手或 preset 标识。 */
  readonly presetId?: string;
  /** 助手或 preset 的展示名，仅用于显示。 */
  readonly presetName?: string;
  /** 模型标识。 */
  readonly model?: string;
}

/** 一条自动化记录。 */
export interface AutomationRecord extends ContractAutomationRecord {
  /** 修订号，每次成功写入后加一。 */
  readonly revision: number;
  /** 最近一次写入的时刻。 */
  readonly updatedAt?: number;
  /** 执行目标。 */
  readonly target?: AutomationTarget;
  /** 定时触发的时间方式，只用于界面展示与控制平面记录。 */
  readonly spec?: ScheduleSpec;
}

/** 存储层的新建输入；`create` 只做落库，不校验执行目标。 */
export interface AutomationCreateInput {
  readonly id: string;
  readonly name: string;
  readonly trigger: AutomationTrigger;
  readonly action: AutomationAction;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly revision?: number;
  readonly updatedAt?: number;
  readonly target?: AutomationTarget;
  readonly spec?: ScheduleSpec;
}

/** 一条投递记录。 */
export interface AutomationDeliveryRecord {
  /** 投递标识。 */
  readonly deliveryId: string;
  /** 命中的自动化标识。 */
  readonly automationId: string;
  /** 外部事件标识。 */
  readonly eventId: string;
  /** 事件来源。 */
  readonly source: AutomationEventSource;
  /** 首次接收时刻。 */
  readonly receivedAt: number;
  /** 最近一次投递的去重结果。 */
  readonly dedupe: AutomationDedupeResult;
  /** 当前状态。 */
  readonly state: AutomationDeliveryState;
  /** 建立的执行会话。 */
  readonly sessionId?: string;
  /** 完成时刻。 */
  readonly completedAt?: number;
  /** 失败或未确认时的错误码。 */
  readonly code?: string;
  /** 失败原因的固定取值。 */
  readonly reason?: AutomationFailureReason;
  /** 尝试次数。 */
  readonly attempts: number;
  /** 最近一次应答的 HTTP 状态码。 */
  readonly httpStatus?: number;
  /** 最近一次尝试的时刻。 */
  readonly lastAttemptAt?: number;
}

/** 投递记录查询。 */
export interface AutomationDeliveryQuery {
  /** 自动化过滤。 */
  readonly automationId?: string;
  /** 状态过滤。 */
  readonly state?: AutomationDeliveryState;
  /** 来源过滤。 */
  readonly source?: AutomationEventSource;
  /** 上一页游标。 */
  readonly cursor?: string;
  /** 每页条数。 */
  readonly limit: number;
}

/** 投递记录的一页。 */
export interface AutomationDeliveryPage {
  /** 这一页的记录。 */
  readonly deliveries: readonly AutomationDeliveryRecord[];
  /** 下一页游标；没有更多记录时缺省。 */
  readonly nextCursor?: string;
}

/** 投递记录的一行。 */
interface DeliveryRow {
  readonly automation_id: string;
  readonly event_id: string;
  readonly delivery_id: string | null;
  readonly source: string;
  readonly received_at: number;
  readonly dedupe: string;
  readonly state: string;
  readonly session_id: string | null;
  readonly completed_at: number | null;
  readonly code: string | null;
  readonly reason: string | null;
  readonly attempts: number;
  readonly http_status: number | null;
  readonly last_attempt_at: number | null;
}

/** 存储里的一行。 */
interface AutomationRow {
  readonly id: string;
  readonly name: string;
  readonly trigger: string;
  readonly action: string;
  readonly enabled: number;
  readonly created_at: number;
  readonly revision: number;
  readonly updated_at: number | null;
  readonly target: string | null;
  readonly spec: string | null;
}

/** 执行节点的一行。 */
interface NodeRow {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly role: string;
  readonly last_seen_at: number;
}

/** 执行节点的只读视图。 */
export interface AutomationNode {
  /** 设备标识。 */
  readonly id: string;
  /** 设备名称。 */
  readonly name: string;
  /** 平台。 */
  readonly platform: string;
  /** 设备角色。 */
  readonly role: 'host' | 'executor' | 'both';
  /** 最近一次活动时刻。 */
  readonly lastSeenAt: number;
}

/** 一次会话建立的请求。 */
export interface AutomationSessionRequest {
  /** 命中的自动化标识。 */
  readonly automationId: string;
  /** 外部事件标识。 */
  readonly eventId: string;
  /** 执行目标。 */
  readonly target: AutomationTarget;
  /** 交给会话的提示词。 */
  readonly prompt: string;
}

/** 会话建立的结果。 */
export interface AutomationSessionResult {
  /** 建立的会话标识。 */
  readonly sessionId: string;
}

/** 把收下的投递交给目标设备建立会话。由控制平面接入运行时后提供。 */
export interface AutomationDispatcher {
  /**
   * 在目标设备上建立会话。
   * @param request - 自动化、事件、目标与提示词。
   * @returns 建立的会话标识。
   */
  start(request: AutomationSessionRequest): Promise<AutomationSessionResult>;
}

/** 存储环境：在线判定由设备长连接表注入。 */
export interface AutomationEnvironment {
  /**
   * 目标设备的在线判定。
   * @param deviceId - 设备标识。
   * @returns 是否有活动的设备长连接。
   */
  readonly online: (deviceId: string) => boolean;
}

/** 投递处理的结果。 */
export interface WebhookResult {
  /** HTTP 状态码。 */
  readonly status: number;
  /** 响应体。 */
  readonly body: Readonly<Record<string, unknown>>;
}

/** 取一个字符串字段并去掉首尾空白；不符合要求时返回 undefined。 */
function textOf(value: unknown, min: number, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) return undefined;
  return trimmed;
}

/** 判断一个路径是否为绝对路径，同时接受 POSIX 与 Windows 的写法。 */
function isAbsolutePath(value: string): boolean {
  return posix.isAbsolute(value) || win32.isAbsolute(value);
}

/** 按键名大小写不敏感地取一个头。 */
function headerOf(headers: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/** 投递标识由自动化与事件标识确定，重试得到同一个标识。 */
function deliveryIdOf(automationId: string, eventId: string): string {
  return `delivery-${createHash('sha256').update(`${automationId}\u0000${eventId}`, 'utf8').digest('hex').slice(0, 32)}`;
}

/** 把 JSON 文本解析成对象；解析失败返回 undefined。 */
function objectOf(value: string | null): Record<string, unknown> | undefined {
  if (value === null) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

/** 五段式 cron 表达式的形状校验。语义校验由运行时定时宿主承担。 */
function cronShapeError(expression: string): string | undefined {
  if (expression.length < 5 || expression.length > 200) return 'cron-invalid';
  const fields = expression.split(/\s+/);
  if (fields.length !== 5) return 'cron-invalid';
  for (const field of fields) {
    if (!CRON_TOKEN_PATTERN.test(field)) return 'cron-invalid';
  }
  return undefined;
}

/** 时区名称校验。 */
function timeZoneOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value === 'UTC' || TIME_ZONES.has(value)) return value;
  return undefined;
}

/**
 * 校验一种定时时间方式。
 * @param value - 未校验的取值。
 * @returns 时间方式；形状不合法时抛出 `request-invalid`。
 */
function specOf(value: unknown): ScheduleSpec {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ChatdshError('request-invalid', '定时时间方式必须是对象', { reason: 'spec-invalid' });
  }
  const candidate = value as Record<string, unknown>;
  const timeZone = timeZoneOf(candidate['timeZone']);
  if (timeZone === undefined) {
    throw new ChatdshError('request-invalid', '定时时间方式缺少合法时区', { reason: 'spec-time-zone' });
  }
  const kind = candidate['kind'];
  if (kind === 'once') {
    const at = candidate['at'];
    if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) {
      throw new ChatdshError('request-invalid', '单次时间方式需要毫秒时刻', { reason: 'spec-at' });
    }
    return { kind: 'once', at, timeZone };
  }
  if (kind === 'interval') {
    const everySeconds = candidate['everySeconds'];
    if (typeof everySeconds !== 'number' || !Number.isSafeInteger(everySeconds) || everySeconds < 60) {
      throw new ChatdshError('request-invalid', '固定间隔不少于 60 秒', { reason: 'spec-interval' });
    }
    return { kind: 'interval', everySeconds, timeZone };
  }
  if (kind === 'daily') {
    const time = candidate['time'];
    if (typeof time !== 'string' || !CLOCK_PATTERN.test(time)) {
      throw new ChatdshError('request-invalid', '每日时间方式需要 HH:mm 时刻', { reason: 'spec-time' });
    }
    return { kind: 'daily', time, timeZone };
  }
  if (kind === 'weekly') {
    const time = candidate['time'];
    if (typeof time !== 'string' || !CLOCK_PATTERN.test(time)) {
      throw new ChatdshError('request-invalid', '每周时间方式需要 HH:mm 时刻', { reason: 'spec-time' });
    }
    const weekdays = candidate['weekdays'];
    if (!Array.isArray(weekdays) || weekdays.length === 0) {
      throw new ChatdshError('request-invalid', '每周时间方式需要星期集合', { reason: 'spec-weekdays' });
    }
    const normalized: number[] = [];
    for (const weekday of weekdays) {
      if (typeof weekday !== 'number' || !Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
        throw new ChatdshError('request-invalid', '星期编号取 1 到 7', { reason: 'spec-weekdays' });
      }
      if (normalized.includes(weekday)) {
        throw new ChatdshError('request-invalid', '星期编号不得重复', { reason: 'spec-weekdays' });
      }
      normalized.push(weekday);
    }
    normalized.sort((left, right) => left - right);
    return { kind: 'weekly', weekdays: normalized, time, timeZone };
  }
  if (kind === 'cron') {
    const expression = textOf(candidate['expression'], 5, 200);
    if (expression === undefined || cronShapeError(expression) !== undefined) {
      throw new ChatdshError('request-invalid', 'cron 表达式需要五段', { reason: 'spec-cron' });
    }
    return { kind: 'cron', expression, timeZone };
  }
  throw new ChatdshError('request-invalid', '未知的定时时间方式', { reason: 'spec-kind' });
}

/** 执行目标的校验结果。 */
interface ParsedTarget {
  readonly target: AutomationTarget;
}

/** 解析执行目标。 */
function targetOf(value: unknown): ParsedTarget {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ChatdshError('request-invalid', '自动化需要执行目标', { reason: 'target-missing' });
  }
  const candidate = value as Record<string, unknown>;
  const deviceId = textOf(candidate['deviceId'], 1, IDENTIFIER_MAX);
  if (deviceId === undefined || !IDENTIFIER_PATTERN.test(deviceId)) {
    throw new ChatdshError('request-invalid', '执行目标缺少合法的设备标识', { reason: 'target-device' });
  }
  const workspaceId = candidate['workspaceId'] === undefined ? undefined : textOf(candidate['workspaceId'], 1, IDENTIFIER_MAX);
  if (candidate['workspaceId'] !== undefined && (workspaceId === undefined || !IDENTIFIER_PATTERN.test(workspaceId))) {
    throw new ChatdshError('request-invalid', '工作区标识写法不合法', { reason: 'target-workspace' });
  }
  const cwd = candidate['cwd'] === undefined ? undefined : textOf(candidate['cwd'], 1, 4096);
  if (candidate['cwd'] !== undefined && (cwd === undefined || !isAbsolutePath(cwd))) {
    throw new ChatdshError('request-invalid', '目标目录需要绝对路径', { reason: 'target-cwd' });
  }
  const presetId = candidate['presetId'] === undefined ? undefined : textOf(candidate['presetId'], 1, IDENTIFIER_MAX);
  if (candidate['presetId'] !== undefined && presetId === undefined) {
    throw new ChatdshError('request-invalid', '助手或 preset 标识写法不合法', { reason: 'target-preset' });
  }
  const presetName = candidate['presetName'] === undefined ? undefined : textOf(candidate['presetName'], 1, LABEL_MAX);
  if (candidate['presetName'] !== undefined && presetName === undefined) {
    throw new ChatdshError('request-invalid', '助手或 preset 名称写法不合法', { reason: 'target-preset' });
  }
  const model = candidate['model'] === undefined ? undefined : textOf(candidate['model'], 1, IDENTIFIER_MAX);
  if (candidate['model'] !== undefined && model === undefined) {
    throw new ChatdshError('request-invalid', '模型标识写法不合法', { reason: 'target-model' });
  }
  return {
    target: {
      deviceId,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(presetId === undefined ? {} : { presetId }),
      ...(presetName === undefined ? {} : { presetName }),
      ...(model === undefined ? {} : { model }),
    },
  };
}

/** 一份校验过的表单取值。 */
interface ParsedDraft {
  readonly name: string;
  readonly trigger: AutomationTrigger;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly target: AutomationTarget;
  readonly spec?: ScheduleSpec;
  readonly id?: string;
  readonly revision?: number;
}

/**
 * 解析并校验一份新建或编辑的取值。
 * @param payload - 请求体解析后的取值。
 * @param editingId - 编辑时的记录标识；新建时缺省。
 * @returns 校验过的取值。
 */
function draftOf(payload: unknown, editingId?: string): ParsedDraft {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new ChatdshError('request-invalid', '自动化取值必须是对象', { reason: 'payload' });
  }
  const candidate = payload as Record<string, unknown>;
  const name = textOf(candidate['name'], 1, NAME_MAX);
  if (name === undefined) throw new ChatdshError('request-invalid', '自动化名称需要 1 到 80 个字符', { reason: 'name' });
  const prompt = textOf(candidate['prompt'], 1, PROMPT_MAX);
  if (prompt === undefined) throw new ChatdshError('request-invalid', '提示词需要 1 到 4000 个字符', { reason: 'prompt' });
  if (typeof candidate['enabled'] !== 'boolean') {
    throw new ChatdshError('request-invalid', '启用状态必须是布尔值', { reason: 'enabled' });
  }

  const rawTrigger = candidate['trigger'];
  if (typeof rawTrigger !== 'object' || rawTrigger === null || Array.isArray(rawTrigger)) {
    throw new ChatdshError('request-invalid', '触发条件必须是对象', { reason: 'trigger' });
  }
  const triggerValue = rawTrigger as Record<string, unknown>;
  let trigger: AutomationTrigger;
  if (triggerValue['kind'] === 'webhook') {
    const secretEnv = textOf(triggerValue['secretEnv'], 1, 64);
    if (secretEnv === undefined || !SECRET_ENV_PATTERN.test(secretEnv)) {
      throw new ChatdshError('request-invalid', '签名密钥环境变量名需要大写字母、数字与下划线', { reason: 'trigger-secret-env' });
    }
    trigger = { kind: 'webhook', secretEnv };
  } else if (triggerValue['kind'] === 'schedule') {
    const cron = triggerValue['cron'] === undefined ? '' : textOf(triggerValue['cron'], 0, 200);
    if (cron === undefined) throw new ChatdshError('request-invalid', 'cron 表达式写法不合法', { reason: 'trigger-cron' });
    if (cron !== '' && cronShapeError(cron) !== undefined) {
      throw new ChatdshError('request-invalid', 'cron 表达式需要五段', { reason: 'trigger-cron' });
    }
    trigger = { kind: 'schedule', cron };
  } else {
    throw new ChatdshError('request-invalid', '触发方式取 webhook 或 schedule', { reason: 'trigger-kind' });
  }

  const rawSpec = candidate['spec'];
  const spec = rawSpec === undefined || rawSpec === null ? undefined : specOf(rawSpec);
  if (spec !== undefined && trigger.kind !== 'schedule') {
    throw new ChatdshError('request-invalid', '定时时间方式只能用于定时触发', { reason: 'spec-mismatch' });
  }
  if (spec !== undefined && spec.kind === 'cron' && trigger.kind === 'schedule' && trigger.cron !== '' && trigger.cron !== spec.expression) {
    throw new ChatdshError('request-invalid', 'cron 表达式与时间方式不一致', { reason: 'spec-mismatch' });
  }

  const { target } = targetOf(candidate['target']);

  const idValue = editingId ?? (candidate['id'] === undefined ? undefined : textOf(candidate['id'], 1, IDENTIFIER_MAX));
  if (idValue !== undefined && !IDENTIFIER_PATTERN.test(idValue)) {
    throw new ChatdshError('request-invalid', '自动化标识写法不合法', { reason: 'id' });
  }
  const revisionValue = candidate['revision'];
  if (revisionValue !== undefined && (typeof revisionValue !== 'number' || !Number.isSafeInteger(revisionValue) || revisionValue < 0)) {
    throw new ChatdshError('request-invalid', '修订号必须是非负整数', { reason: 'revision' });
  }

  return {
    name,
    trigger,
    prompt,
    enabled: candidate['enabled'],
    target,
    ...(spec === undefined ? {} : { spec }),
    ...(idValue === undefined ? {} : { id: idValue }),
    ...(revisionValue === undefined ? {} : { revision: revisionValue }),
  };
}

/** 行转换成记录。 */
function toRecord(row: AutomationRow): AutomationRecord {
  const target = objectOf(row.target);
  const spec = objectOf(row.spec);
  return {
    id: row.id,
    name: row.name,
    trigger: JSON.parse(row.trigger) as AutomationTrigger,
    action: JSON.parse(row.action) as AutomationAction,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    revision: row.revision,
    ...(row.updated_at === null ? {} : { updatedAt: row.updated_at }),
    ...(target === undefined ? {} : { target: target as unknown as AutomationTarget }),
    ...(spec === undefined ? {} : { spec: spec as unknown as ScheduleSpec }),
  };
}

/** 行转换成投递记录。 */
function toDelivery(row: DeliveryRow): AutomationDeliveryRecord {
  return {
    deliveryId: row.delivery_id ?? deliveryIdOf(row.automation_id, row.event_id),
    automationId: row.automation_id,
    eventId: row.event_id,
    source: row.source as AutomationEventSource,
    receivedAt: row.received_at,
    dedupe: row.dedupe as AutomationDedupeResult,
    state: row.state as AutomationDeliveryState,
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.code === null ? {} : { code: row.code }),
    ...(row.reason === null ? {} : { reason: row.reason as AutomationFailureReason }),
    attempts: row.attempts,
    ...(row.http_status === null ? {} : { httpStatus: row.http_status }),
    ...(row.last_attempt_at === null ? {} : { lastAttemptAt: row.last_attempt_at }),
  };
}

/** 行转换成执行节点。 */
function toNode(row: NodeRow): AutomationNode {
  if (row.role !== 'host' && row.role !== 'executor' && row.role !== 'both') {
    throw new Error(`node_devices.role 取值非法：${row.role}`);
  }
  return { id: row.id, name: row.name, platform: row.platform, role: row.role, lastSeenAt: row.last_seen_at };
}

/** 一页投递记录最多包含的条数。 */
export const DELIVERY_PAGE_MAX = 200;

/**
 * 自动化存储。
 *
 * 表在构造时建立，旧库补齐新增的列。`recordEvent` 按事件标识去重：已收下的事件返回
 * 重复，失败的事件可以重新投递；投递查询按接收时刻倒序分页。
 */
export class AutomationStore {
  private readonly database: DatabaseSync;
  private readonly environment: AutomationEnvironment;
  private dispatcher: AutomationDispatcher | undefined;
  private readonly pending = new Set<Promise<void>>();
  private nodeTableChecked = false;
  private nodeTablePresent = false;

  /**
   * @param database - 与控制平面共用的数据库连接。
   * @param environment - 在线判定；缺省按没有长连接处理。
   */
  constructor(database: DatabaseSync, environment?: Partial<AutomationEnvironment>) {
    this.database = database;
    this.environment = { online: environment?.online ?? (() => false) };
    migrateAccountColumns(this.database);
    this.database.exec(`
      create table if not exists automations (
        id text primary key,
        name text not null,
        trigger text not null,
        action text not null,
        enabled integer not null,
        created_at integer not null
      );
      create table if not exists automation_events (
        automation_id text not null,
        event_id text not null,
        received_at integer not null,
        source text not null,
        primary key (automation_id, event_id)
      );
    `);
    this.ensureColumn('automations', 'revision', 'integer not null default 0');
    this.ensureColumn('automations', 'updated_at', 'integer');
    this.ensureColumn('automations', 'target', 'text');
    this.ensureColumn('automations', 'spec', 'text');
    this.ensureColumn('automation_events', 'delivery_id', 'text');
    this.ensureColumn('automation_events', 'dedupe', "text not null default 'new'");
    this.ensureColumn('automation_events', 'state', "text not null default 'accepted'");
    this.ensureColumn('automation_events', 'session_id', 'text');
    this.ensureColumn('automation_events', 'completed_at', 'integer');
    this.ensureColumn('automation_events', 'code', 'text');
    this.ensureColumn('automation_events', 'reason', 'text');
    this.ensureColumn('automation_events', 'attempts', 'integer not null default 1');
    this.ensureColumn('automation_events', 'http_status', 'integer');
    this.ensureColumn('automation_events', 'last_attempt_at', 'integer');
  }

  /** 补齐旧库缺少的列；重复执行是空操作。 */
  private ensureColumn(table: string, column: string, definition: string): void {
    const rows = this.database.prepare(`select name from pragma_table_info('${table}')`).all() as unknown as { name: string }[];
    if (rows.some((row) => row.name === column)) return;
    this.database.exec(`alter table ${table} add column ${column} ${definition}`);
  }

  /** 注册建立会话的派发器。控制平面接入运行时之后调用。 */
  attachDispatcher(dispatcher: AutomationDispatcher): void {
    this.dispatcher = dispatcher;
  }

  /** 等待全部在途派发结束，用于停机与测试收尾。 */
  async settle(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  /** 建立一条自动化记录。标识重复时抛出。 */
  create(record: AutomationCreateInput): void {
    this.database
      .prepare(
        `insert into automations (id, name, trigger, action, enabled, created_at, revision, updated_at, target, spec)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.name,
        JSON.stringify(record.trigger),
        JSON.stringify(record.action),
        record.enabled ? 1 : 0,
        record.createdAt,
        record.revision ?? 0,
        record.updatedAt ?? null,
        record.target === undefined ? null : JSON.stringify(record.target),
        record.spec === undefined ? null : JSON.stringify(record.spec),
      );
  }

  /**
   * 校验并写入一份新建的取值。
   * @param payload - 请求体解析后的取值。
   * @returns 写入的记录。
   */
  createDraft(payload: unknown): AutomationRecord {
    const draft = draftOf(payload);
    const id = draft.id ?? `automation-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    if (this.get(id) !== undefined) {
      throw new ChatdshError('object-in-use', '自动化标识已经存在', { reason: 'id-exists' });
    }
    this.assertTargetUsable(draft.target);
    const now = Date.now();
    this.create({
      id,
      name: draft.name,
      trigger: draft.trigger,
      action: { kind: 'start-session', prompt: draft.prompt, ...(draft.target.workspaceId === undefined ? {} : { workspaceId: draft.target.workspaceId }) },
      enabled: draft.enabled,
      createdAt: now,
      updatedAt: now,
      target: draft.target,
      ...(draft.spec === undefined ? {} : { spec: draft.spec }),
    });
    const stored = this.get(id);
    if (stored === undefined) throw new ChatdshError('internal-error', '自动化记录写入之后读不回来');
    return stored;
  }

  /**
   * 校验并更新一份取值，按修订号比较交换。
   * @param payload - 请求体解析后的取值，必须带记录标识与修订号。
   * @returns 更新后的记录；记录不存在时返回 undefined。
   */
  updateDraft(payload: unknown): AutomationRecord | undefined {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new ChatdshError('request-invalid', '自动化取值必须是对象', { reason: 'payload' });
    }
    const candidate = payload as Record<string, unknown>;
    const id = textOf(candidate['id'], 1, IDENTIFIER_MAX);
    if (id === undefined || !IDENTIFIER_PATTERN.test(id)) {
      throw new ChatdshError('request-invalid', '更新需要记录标识', { reason: 'id' });
    }
    const draft = draftOf(candidate, id);
    if (draft.revision === undefined) {
      throw new ChatdshError('request-invalid', '更新需要携带修订号', { reason: 'revision' });
    }
    this.assertTargetUsable(draft.target);
    const now = Date.now();
    const result = this.database
      .prepare(
        `update automations
            set name = ?, trigger = ?, action = ?, enabled = ?, target = ?, spec = ?, revision = revision + 1, updated_at = ?
          where id = ? and revision = ?`,
      )
      .run(
        draft.name,
        JSON.stringify(draft.trigger),
        JSON.stringify({ kind: 'start-session', prompt: draft.prompt, ...(draft.target.workspaceId === undefined ? {} : { workspaceId: draft.target.workspaceId }) }),
        draft.enabled ? 1 : 0,
        JSON.stringify(draft.target),
        draft.spec === undefined ? null : JSON.stringify(draft.spec),
        now,
        id,
        draft.revision,
      );
    if (Number(result.changes) === 0) {
      const current = this.get(id);
      if (current === undefined) return undefined;
      throw new ChatdshError('revision-conflict', '修订号落后于服务端保存的版本', { revision: current.revision });
    }
    return this.get(id);
  }

  /** 读一条记录。 */
  get(id: string): AutomationRecord | undefined {
    const row = this.database
      .prepare('select id, name, trigger, action, enabled, created_at, revision, updated_at, target, spec from automations where id = ?')
      .get(id) as unknown as AutomationRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  /** 列出记录。 */
  list(): AutomationRecord[] {
    const rows = this.database
      .prepare('select id, name, trigger, action, enabled, created_at, revision, updated_at, target, spec from automations order by created_at')
      .all() as unknown as AutomationRow[];
    return rows.map(toRecord);
  }

  /**
   * 切换一条自动化的启用状态。
   * @param id - 自动化标识。
   * @param enabled - 目标状态。
   * @returns 更新后的记录；记录不存在时返回 undefined。
   */
  setEnabled(id: string, enabled: boolean): AutomationRecord | undefined {
    const result = this.database
      .prepare('update automations set enabled = ?, revision = revision + 1, updated_at = ? where id = ?')
      .run(enabled ? 1 : 0, Date.now(), id);
    if (Number(result.changes) === 0) return undefined;
    return this.get(id);
  }

  /**
   * 删除一条记录与它的全部投递记录。
   * @param id - 自动化标识。
   * @returns 是否删除了记录。
   */
  remove(id: string): boolean {
    const result = this.database.prepare('delete from automations where id = ?').run(id);
    if (Number(result.changes) === 0) return false;
    this.database.prepare('delete from automation_events where automation_id = ?').run(id);
    return true;
  }

  /** 取执行节点；控制平面没有这张表时视为不存在。 */
  nodeOf(deviceId: string): AutomationNode | undefined {
    if (!this.hasNodeTable()) return undefined;
    const row = this.database
      .prepare('select id, name, platform, role, last_seen_at from node_devices where id = ?')
      .get(deviceId) as unknown as NodeRow | undefined;
    return row === undefined ? undefined : toNode(row);
  }

  /** 目标工作区是否已由该设备登记在会话归属里。 */
  workspaceKnown(deviceId: string, workspaceId: string): boolean {
    const row = this.database
      .prepare('select 1 as hit from sessions where device_id = ? and workspace_id = ? and deleted_at is null limit 1')
      .get(deviceId, workspaceId) as { hit: number } | undefined;
    return row !== undefined;
  }

  /** 目标设备的在线判定。 */
  online(deviceId: string): boolean {
    return this.environment.online(deviceId);
  }

  /** 检查执行目标：设备已登记、角色允许执行、在线、工作区归属成立。 */
  private assertTargetUsable(target: AutomationTarget): void {
    const node = this.nodeOf(target.deviceId);
    if (node === undefined) throw new ChatdshError('device-unknown', '执行设备没有登记', { reason: 'target-unknown' });
    if (node.role === 'host') throw new ChatdshError('device-role-mismatch', '执行设备不承担会话执行', { reason: 'target-role' });
    if (!this.online(target.deviceId)) throw new ChatdshError('device-offline', '执行设备离线', { reason: 'target-offline' });
    if (target.workspaceId !== undefined && !this.workspaceKnown(target.deviceId, target.workspaceId)) {
      throw new ChatdshError('workspace-forbidden', '工作区不属于该执行设备', { reason: 'target-workspace' });
    }
  }

  /** 记录一次投递；同一事件重复投递返回 false，并累加尝试次数。 */
  recordEvent(event: AutomationEvent): boolean {
    const existing = this.delivery(event.automationId, event.eventId);
    if (existing !== undefined && (existing.state === 'accepted' || existing.state === 'completed')) {
      this.database
        .prepare("update automation_events set dedupe = 'duplicate', attempts = attempts + 1, last_attempt_at = ?, http_status = ? where automation_id = ? and event_id = ?")
        .run(Date.now(), 202, event.automationId, event.eventId);
      return false;
    }
    this.upsertDelivery({
      automationId: event.automationId,
      eventId: event.eventId,
      source: event.source,
      receivedAt: event.receivedAt,
      dedupe: 'new',
      state: 'accepted',
      attempts: 1,
      httpStatus: 202,
    });
    return true;
  }

  /** 某个自动化是否已收下过该事件。 */
  hasEvent(automationId: string, eventId: string): boolean {
    const row = this.database
      .prepare("select 1 as hit from automation_events where automation_id = ? and event_id = ? and state in ('accepted', 'completed')")
      .get(automationId, eventId) as { hit: number } | undefined;
    return row !== undefined;
  }

  /** 某个自动化的全部已收下投递记录，按接收时间排序。 */
  eventsOf(automationId: string): AutomationEvent[] {
    const rows = this.database
      .prepare("select automation_id, event_id, received_at, source from automation_events where automation_id = ? and state in ('accepted', 'completed') order by received_at")
      .all(automationId) as unknown as EventRow[];
    return rows.map((row) => ({
      automationId: row.automation_id,
      eventId: row.event_id,
      receivedAt: row.received_at,
      source: row.source as AutomationEvent['source'],
    }));
  }

  /** 取一条投递记录。 */
  delivery(automationId: string, eventId: string): AutomationDeliveryRecord | undefined {
    const row = this.database
      .prepare(`select ${DELIVERY_COLUMNS} from automation_events where automation_id = ? and event_id = ?`)
      .get(automationId, eventId) as unknown as DeliveryRow | undefined;
    return row === undefined ? undefined : toDelivery(row);
  }

  /** 某个自动化最近一次投递的摘要。 */
  lastDeliveryOf(automationId: string): { state: AutomationDeliveryState; receivedAt: number; code?: string } | undefined {
    const row = this.database
      .prepare('select state, received_at, code from automation_events where automation_id = ? order by received_at desc, event_id desc limit 1')
      .get(automationId) as { state: string; received_at: number; code: string | null } | undefined;
    if (row === undefined) return undefined;
    return {
      state: row.state as AutomationDeliveryState,
      receivedAt: row.received_at,
      ...(row.code === null ? {} : { code: row.code }),
    };
  }

  /**
   * 分页读取投递记录。
   * @param query - 过滤条件、每页条数与游标。
   * @returns 这一页的记录与下一页游标。
   */
  deliveries(query: AutomationDeliveryQuery): AutomationDeliveryPage {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > DELIVERY_PAGE_MAX) {
      throw new ChatdshError('request-invalid', `每页条数取 1 到 ${DELIVERY_PAGE_MAX}`, { reason: 'limit' });
    }
    const clauses: string[] = [];
    const parameters: (string | number)[] = [];
    if (query.automationId !== undefined) {
      clauses.push('automation_id = ?');
      parameters.push(query.automationId);
    }
    if (query.state !== undefined) {
      clauses.push('state = ?');
      parameters.push(query.state);
    }
    if (query.source !== undefined) {
      clauses.push('source = ?');
      parameters.push(query.source);
    }
    if (query.cursor !== undefined) {
      const cursor = decodeDeliveryCursor(query.cursor);
      if (cursor === undefined) throw new ChatdshError('cursor-invalid', '投递游标无法解码', { reason: 'cursor' });
      clauses.push('(received_at < ? or (received_at = ? and event_id < ?))');
      parameters.push(cursor[0], cursor[0], cursor[1]);
    }
    const where = clauses.length === 0 ? '' : ` where ${clauses.join(' and ')}`;
    const rows = this.database
      .prepare(`select ${DELIVERY_COLUMNS} from automation_events${where} order by received_at desc, event_id desc limit ?`)
      .all(...parameters, query.limit + 1) as unknown as DeliveryRow[];
    const page = rows.slice(0, query.limit).map(toDelivery);
    const last = page.at(-1);
    const hasMore = rows.length > query.limit && last !== undefined;
    return {
      deliveries: page,
      ...(hasMore ? { nextCursor: encodeDeliveryCursor(last.receivedAt, last.eventId) } : {}),
    };
  }

  /** 收下一次 webhook 投递；已收下的事件按重复返回，失败的事件可以重试。 */
  acceptDelivery(input: {
    readonly automationId: string;
    readonly eventId: string;
    readonly source: AutomationEventSource;
    readonly receivedAt: number;
    readonly duplicate: boolean;
  }): AutomationDeliveryRecord {
    if (input.duplicate) {
      this.database
        .prepare("update automation_events set dedupe = 'duplicate', attempts = attempts + 1, last_attempt_at = ?, http_status = ? where automation_id = ? and event_id = ?")
        .run(Date.now(), 202, input.automationId, input.eventId);
    } else {
      this.upsertDelivery({
        automationId: input.automationId,
        eventId: input.eventId,
        source: input.source,
        receivedAt: input.receivedAt,
        dedupe: 'new',
        state: 'accepted',
        attempts: 1,
        httpStatus: 202,
      });
    }
    const stored = this.delivery(input.automationId, input.eventId);
    if (stored === undefined) throw new ChatdshError('internal-error', '投递记录写入之后读不回来');
    return stored;
  }

  /** 记录一次失败的投递；同一事件保留一行，尝试次数累加。 */
  rejectDelivery(input: {
    readonly automationId: string;
    readonly eventId: string;
    readonly source: AutomationEventSource;
    readonly receivedAt: number;
    readonly code: string;
    readonly reason: AutomationFailureReason;
    readonly httpStatus: number;
  }): AutomationDeliveryRecord {
    this.upsertDelivery({
      automationId: input.automationId,
      eventId: input.eventId,
      source: input.source,
      receivedAt: input.receivedAt,
      dedupe: 'new',
      state: 'failed',
      attempts: 1,
      httpStatus: input.httpStatus,
      code: input.code,
      reason: input.reason,
    });
    const stored = this.delivery(input.automationId, input.eventId);
    if (stored === undefined) throw new ChatdshError('internal-error', '投递记录写入之后读不回来');
    return stored;
  }

  /** 插入或更新一条投递记录，更新时累加尝试次数。 */
  private upsertDelivery(input: DeliverySeed): void {
    this.database
      .prepare(
        `insert into automation_events
           (automation_id, event_id, delivery_id, source, received_at, dedupe, state, session_id, completed_at, code, reason, attempts, http_status, last_attempt_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(automation_id, event_id) do update set
           dedupe = excluded.dedupe,
           state = excluded.state,
           session_id = coalesce(excluded.session_id, automation_events.session_id),
           completed_at = coalesce(excluded.completed_at, automation_events.completed_at),
           code = excluded.code,
           reason = excluded.reason,
           attempts = automation_events.attempts + 1,
           http_status = excluded.http_status,
           last_attempt_at = excluded.last_attempt_at`,
      )
      .run(
        input.automationId,
        input.eventId,
        deliveryIdOf(input.automationId, input.eventId),
        input.source,
        input.receivedAt,
        input.dedupe,
        input.state,
        input.sessionId ?? null,
        input.completedAt ?? null,
        input.code ?? null,
        input.reason ?? null,
        input.attempts,
        input.httpStatus ?? null,
        Date.now(),
      );
  }

  /** 把一条投递标记成派发中。 */
  private markDispatching(automationId: string, eventId: string): void {
    this.database
      .prepare("update automation_events set state = 'dispatching', last_attempt_at = ? where automation_id = ? and event_id = ?")
      .run(Date.now(), automationId, eventId);
  }

  /** 把一条投递标记成完成。 */
  private markCompleted(automationId: string, eventId: string, sessionId: string): void {
    this.database
      .prepare("update automation_events set state = 'completed', session_id = ?, completed_at = ?, code = null, reason = null, last_attempt_at = ? where automation_id = ? and event_id = ?")
      .run(sessionId, Date.now(), Date.now(), automationId, eventId);
  }

  /** 把一条投递标记成派发失败或未确认。 */
  private markDispatchFailed(automationId: string, eventId: string, state: 'failed' | 'unconfirmed', code: string, reason: AutomationFailureReason): void {
    this.database
      .prepare('update automation_events set state = ?, code = ?, reason = ?, last_attempt_at = ? where automation_id = ? and event_id = ?')
      .run(state, code, reason, Date.now(), automationId, eventId);
  }

  /**
   * 把已收下的投递交给派发器。
   *
   * 派发在后台进行，webhook 应答不等待它；`settle` 等待在途派发结束。
   */
  dispatch(record: AutomationRecord, eventId: string): void {
    const dispatcher = this.dispatcher;
    const target = record.target;
    if (dispatcher === undefined || target === undefined) return;
    const task = (async (): Promise<void> => {
      this.markDispatching(record.id, eventId);
      try {
        const result = await dispatcher.start({
          automationId: record.id,
          eventId,
          target,
          prompt: record.action.prompt,
        });
        this.markCompleted(record.id, eventId, result.sessionId);
      } catch (error) {
        const code = error instanceof ChatdshError ? error.code : 'internal-error';
        const state = error instanceof ChatdshError && error.code === 'automation-delivery-unconfirmed' ? 'unconfirmed' : 'failed';
        const reason: AutomationFailureReason = state === 'unconfirmed' ? 'unconfirmed' : 'dispatch';
        this.markDispatchFailed(record.id, eventId, state, code, reason);
      }
    })();
    this.pending.add(task);
    void task.then(() => this.pending.delete(task));
  }

  /** 在线表只在控制平面完整装配时存在。 */
  private hasNodeTable(): boolean {
    if (this.nodeTableChecked) return this.nodeTablePresent;
    const row = this.database.prepare("select 1 as hit from sqlite_master where type = 'table' and name = 'node_devices'").get() as { hit: number } | undefined;
    this.nodeTableChecked = true;
    this.nodeTablePresent = row !== undefined;
    return this.nodeTablePresent;
  }
}

/** 查询投递记录时固定的列。 */
const DELIVERY_COLUMNS =
  'automation_id, event_id, delivery_id, source, received_at, dedupe, state, session_id, completed_at, code, reason, attempts, http_status, last_attempt_at';

/** 投递记录的一行的来源字段子集。 */
interface EventRow {
  readonly automation_id: string;
  readonly event_id: string;
  readonly received_at: number;
  readonly source: string;
}

/** 写入一条投递记录需要的字段。 */
interface DeliverySeed {
  readonly automationId: string;
  readonly eventId: string;
  readonly source: AutomationEventSource;
  readonly receivedAt: number;
  readonly dedupe: AutomationDedupeResult;
  readonly state: AutomationDeliveryState;
  readonly attempts: number;
  readonly httpStatus?: number;
  readonly code?: string;
  readonly reason?: AutomationFailureReason;
  readonly sessionId?: string;
  readonly completedAt?: number;
}

/** 游标编码成不透明字符串。 */
function encodeDeliveryCursor(receivedAt: number, eventId: string): string {
  return Buffer.from(JSON.stringify([receivedAt, eventId]), 'utf8').toString('base64url');
}

/** 解码游标；形状不符返回 undefined。 */
function decodeDeliveryCursor(cursor: string): [number, string] | undefined {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return undefined;
  const [receivedAt, eventId] = parsed;
  if (typeof receivedAt !== 'number' || !Number.isSafeInteger(receivedAt) || receivedAt < 0) return undefined;
  if (typeof eventId !== 'string' || eventId === '' || eventId.length > IDENTIFIER_MAX) return undefined;
  return [receivedAt, eventId];
}

/** 从请求头与请求体推出去重用的来源与事件标识；推不出来时返回 undefined。 */
function derivedEvent(headers: Readonly<Record<string, string | undefined>>, body: string): { eventId: string; source: AutomationEventSource } | undefined {
  const source: AutomationEventSource = headerOf(headers, 'x-github-event') === undefined ? 'generic' : 'github';
  const delivery = headerOf(headers, 'x-github-delivery');
  if (delivery !== undefined && delivery !== '' && delivery.length <= IDENTIFIER_MAX) {
    return { eventId: delivery, source };
  }
  if (body.trim() === '') return undefined;
  return { eventId: createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 32), source };
}

/**
 * 处理一次 webhook 投递。
 *
 * 校验顺序固定：记录存在 → 记录启用 → 触发方式为 webhook → 密钥已配置且匹配 →
 * 请求体合法 → 去重 → 目标可用。前四步不读取请求体，因此未鉴权的载荷不会交给解析器。
 * 失败与重复都写一条投递记录，同一事件只保留一行。
 * @param store - 自动化存储。
 * @param automationId - 路径里的自动化标识。
 * @param headers - 请求头。
 * @param body - 原始请求体。
 * @returns 状态码与响应体。
 */
export function handleWebhook(
  store: AutomationStore,
  automationId: string,
  headers: Readonly<Record<string, string | undefined>>,
  body: string,
): WebhookResult {
  const record = store.get(automationId);
  if (record === undefined) {
    return { status: 404, body: { error: AUTOMATION_ERROR_CODES.notFound } };
  }
  const derived = derivedEvent(headers, body);
  const reject = (status: number, bodyError: string, code: string, reason: AutomationFailureReason): WebhookResult => {
    if (derived !== undefined && record.enabled && record.trigger.kind === 'webhook') {
      store.rejectDelivery({
        automationId,
        eventId: derived.eventId,
        source: derived.source,
        receivedAt: Date.now(),
        code,
        reason,
        httpStatus: status,
      });
    }
    return { status, body: { error: bodyError } };
  };

  if (!record.enabled) {
    return reject(404, 'automation-disabled', 'automation-disabled', 'automation-disabled');
  }
  if (record.trigger.kind !== 'webhook') {
    return reject(400, 'automation-trigger-not-webhook', 'automation-trigger-not-webhook', 'trigger');
  }

  const expected = process.env[record.trigger.secretEnv];
  if (expected === undefined || expected === '') {
    return reject(503, 'webhook-secret-unconfigured', 'automation-secret-missing', 'secret');
  }
  if (headerOf(headers, 'x-chatdsh-webhook-secret') !== expected) {
    return reject(401, AUTOMATION_ERROR_CODES.unauthorized, 'webhook-signature-invalid', 'signature');
  }

  let event: Omit<AutomationEvent, 'automationId'> & { automationId: string };
  try {
    event = normalizeWebhook({ headers, body });
  } catch (error) {
    if (error instanceof WebhookInvalidError) {
      return reject(400, error.code, error.code, 'payload');
    }
    throw error;
  }

  const previous = store.delivery(automationId, event.eventId);
  if (previous !== undefined && (previous.state === 'accepted' || previous.state === 'completed')) {
    store.acceptDelivery({ automationId, eventId: event.eventId, source: event.source, receivedAt: event.receivedAt, duplicate: true });
    return { status: 202, body: { duplicate: true } };
  }

  const target = record.target;
  if (target !== undefined) {
    const node = store.nodeOf(target.deviceId);
    if (node === undefined) {
      return reject(404, 'device-unknown', 'device-unknown', 'target-unknown');
    }
    if (node.role === 'host') {
      return reject(409, 'device-role-mismatch', 'device-role-mismatch', 'target-role');
    }
    if (!store.online(target.deviceId)) {
      return reject(409, 'device-offline', 'device-offline', 'target-offline');
    }
  }

  store.acceptDelivery({ automationId, eventId: event.eventId, source: event.source, receivedAt: event.receivedAt, duplicate: false });
  store.dispatch(record, event.eventId);
  return { status: 202, body: { accepted: true } };
}
