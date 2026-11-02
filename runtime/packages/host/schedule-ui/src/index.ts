/**
 * 原会话定时任务的界面适配。
 *
 * 任务本身由运行时的 `ctx.schedule` 持有：本插件只做视图与校验，把界面的时间方式翻译成
 * `ctx.schedule` 的请求，把存储里的记录翻译成界面字段。插件不建立任何定时器，任务的
 * 发生、跳过、补发与持久化都由原会话所在运行时承担；跨设备继续产生的新会话不会复制任务。
 *
 * 两种入口共用同一套实现：Remote 方法供运行时内的其他插件调用，同源路径
 * `/chatdsh/schedules` 供界面经控制平面的设备前缀访问。取消等于让任务不再发生，任务的
 * 记录随之删除；编辑只改动名称、提醒文本与时间方式。
 * @module @chatdsh/host-schedule-ui
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ChatdshError, type ChatdshErrorCode, type ScheduleSpec, type ScheduleView } from '@chatdsh/core-contracts';
import {
  Remote,
  TypertRemoteService,
  hostWebServerOf,
  scheduleOf,
  sessionsOf,
  telemetryOf,
  type Context,
  type SessionId,
} from '@chatdsh/adapter';

/** 插件名。 */
export const name = 'chatdsh-schedule-ui';

/** 服务名，同时是 Remote 命名空间。 */
export const SERVICE_NAME = 'chatdshSchedules';

/** 界面访问定时任务的路径。 */
export const SCHEDULES_PATH = '/chatdsh/schedules';

/** 写操作要求的请求头。 */
const CSRF_HEADER = 'x-chatdsh-csrf';

/** 请求体上限。 */
const BODY_MAX_BYTES = 64 * 1024;

/** 名称长度上限。 */
const NAME_MAX = 120;

/** 提醒文本长度上限。 */
const PROMPT_MAX = 4000;

/** 本日时刻的写法。 */
const CLOCK_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 支持的 IANA 时区名称。 */
const TIME_ZONES: ReadonlySet<string> = new Set(Intl.supportedValuesOf('timeZone'));

/** 运行时的本地区时，用于界面显示一次性任务的时刻。 */
const LOCAL_ZONE = resolveLocalZone();

/** 定时宿主上的一次任务记录。 */
type HostRecord = Awaited<ReturnType<ReturnType<typeof scheduleOf>['list']>>[number];

/** 定时宿主上的一条目录条目。 */
type HostCatalogEntry = Awaited<ReturnType<ReturnType<typeof scheduleOf>['catalog']>>[number];

/** 定时宿主接受的建立请求。 */
type HostCreateRequest = Parameters<ReturnType<typeof scheduleOf>['create']>[1];

/** 定时宿主接受的时间方式变更。 */
type HostTimingChange = NonNullable<Parameters<ReturnType<typeof scheduleOf>['update']>[0]['change']>;

/** 定时宿主的会话标识类型。 */
type HostSessionId = Parameters<ReturnType<typeof scheduleOf>['create']>[0];

/** 定时宿主的任务标识类型。 */
type HostScheduleId = Parameters<ReturnType<typeof scheduleOf>['delete']>[0]['id'];

/** 用到的遥测面。 */
interface ScheduleTelemetry {
  runSpan<T>(name: string, attributes: Record<string, unknown>, body: (span: { setAttribute(key: string, value: unknown): void }) => Promise<T>): Promise<T>;
  counter(name: string, options?: { description: string }): { add(delta: number, attributes?: Record<string, unknown>): void };
  histogram(name: string, options?: { description: string }): { record(value: number, attributes?: Record<string, unknown>): void };
}

/** 建立定时任务的输入。 */
export interface ScheduleCreateInput {
  /** 原会话标识。 */
  readonly sessionId: string;
  /** 名称。 */
  readonly name: string;
  /** 提醒文本。 */
  readonly prompt: string;
  /** 时间方式。 */
  readonly spec: unknown;
  /** 是否启用；新建时必须启用。 */
  readonly enabled: boolean;
}

/** 编辑定时任务的输入。 */
export interface ScheduleUpdateInput extends ScheduleCreateInput {
  /** 定时任务标识。 */
  readonly scheduleId: string;
}

/** 取消或删除定时任务的输入。 */
export interface ScheduleBindingInput {
  /** 原会话标识。 */
  readonly sessionId: string;
  /** 定时任务标识。 */
  readonly scheduleId: string;
}

/** 取运行时的本地区时；无法确定时退回 UTC。 */
function resolveLocalZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (zone === 'UTC' || TIME_ZONES.has(zone)) return zone;
  return 'UTC';
}

/** 校验时区名称。 */
function timeZoneOf(value: unknown): string {
  if (typeof value === 'string' && (value === 'UTC' || TIME_ZONES.has(value))) return value;
  throw new ChatdshError('request-invalid', '时区需要 IANA 时区名称', { reason: 'time-zone' });
}

/** 校验时间方式。语义（cron 表达式、夏令时边界、未来时刻）由定时宿主判定。 */
function specOfInput(value: unknown): ScheduleSpec {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ChatdshError('request-invalid', '时间方式必须是对象', { reason: 'spec' });
  }
  const candidate = value as Record<string, unknown>;
  const timeZone = timeZoneOf(candidate['timeZone']);
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
    const expression = candidate['expression'];
    if (typeof expression !== 'string' || expression.trim().length < 5 || expression.length > 200) {
      throw new ChatdshError('request-invalid', 'cron 表达式需要五段', { reason: 'spec-cron' });
    }
    return { kind: 'cron', expression: expression.trim(), timeZone };
  }
  throw new ChatdshError('request-invalid', '未知的时间方式', { reason: 'spec-kind' });
}

/** 把宿主记录的时间方式翻译成界面字段。 */
function specOfRecord(record: HostRecord): ScheduleSpec {
  switch (record.kind) {
    case 'at':
    case 'after':
      return { kind: 'once', at: Date.parse(record.scheduledAt), timeZone: LOCAL_ZONE };
    case 'every':
      return { kind: 'interval', everySeconds: record.everySeconds, timeZone: LOCAL_ZONE };
    case 'daily':
      return { kind: 'daily', time: record.time.slice(0, 5), timeZone: record.timeZone };
    case 'weekly':
      return { kind: 'weekly', weekdays: [...record.weekdays], time: record.time.slice(0, 5), timeZone: record.timeZone };
    case 'cron':
      return { kind: 'cron', expression: record.expression, timeZone: record.timeZone };
  }
}

/** 把 `HH:mm` 补成宿主接受的 `HH:mm:ss`。 */
function clockOf(time: string): string {
  return `${time}:00`;
}

/** 把时间方式翻译成建立请求。 */
function createRequestOf(title: string, prompt: string, spec: ScheduleSpec, now: number): HostCreateRequest {
  if (spec.kind === 'once') {
    if (spec.at <= now) return { title, prompt, after_seconds: 1 };
    return { title, prompt, at: new Date(spec.at).toISOString() };
  }
  if (spec.kind === 'interval') return { title, prompt, every_seconds: spec.everySeconds };
  if (spec.kind === 'daily') return { title, prompt, daily: { time: clockOf(spec.time), time_zone: spec.timeZone } };
  if (spec.kind === 'weekly') {
    return { title, prompt, weekly: { time: clockOf(spec.time), time_zone: spec.timeZone, weekdays: [...spec.weekdays] } };
  }
  return { title, prompt, cron: { expression: spec.expression, time_zone: spec.timeZone } };
}

/** 把时间方式翻译成时间变更。已经过去的单次时刻按无效取值拒绝。 */
function changeOf(spec: ScheduleSpec, now: number): HostTimingChange {
  if (spec.kind === 'once') {
    if (spec.at <= now) {
      throw new ChatdshError('request-invalid', '单次时间需要晚于当前时刻', { reason: 'spec-at' });
    }
    return { kind: 'at', at: new Date(spec.at).toISOString() };
  }
  if (spec.kind === 'interval') return { kind: 'every', every_seconds: spec.everySeconds };
  if (spec.kind === 'daily') return { kind: 'daily', daily: { time: clockOf(spec.time), time_zone: spec.timeZone } };
  if (spec.kind === 'weekly') return { kind: 'weekly', weekly: { time: clockOf(spec.time), time_zone: spec.timeZone, weekdays: [...spec.weekdays] } };
  return { kind: 'cron', cron: { expression: spec.expression, time_zone: spec.timeZone } };
}

/** 判断两种时间方式是否等价。 */
function sameSpec(left: ScheduleSpec, right: ScheduleSpec): boolean {
  if (left.kind !== right.kind) return false;
  if (left.timeZone !== right.timeZone) return false;
  switch (left.kind) {
    case 'once':
      return left.at === (right as { at: number }).at;
    case 'interval':
      return left.everySeconds === (right as { everySeconds: number }).everySeconds;
    case 'daily':
      return left.time === (right as { time: string }).time;
    case 'weekly': {
      const other = right as { weekdays: readonly number[]; time: string };
      return left.time === other.time && left.weekdays.length === other.weekdays.length && left.weekdays.every((weekday, index) => weekday === other.weekdays[index]);
    }
    case 'cron':
      return left.expression === (right as { expression: string }).expression;
  }
}

/** 校验名称。 */
function nameOf(value: unknown): string {
  if (typeof value !== 'string') throw new ChatdshError('request-invalid', '定时任务需要名称', { reason: 'name' });
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > NAME_MAX) {
    throw new ChatdshError('request-invalid', `名称取 1 到 ${NAME_MAX} 个字符`, { reason: 'name' });
  }
  return trimmed;
}

/** 校验提醒文本。 */
function promptOf(value: unknown): string {
  if (typeof value !== 'string') throw new ChatdshError('request-invalid', '定时任务需要提醒文本', { reason: 'prompt' });
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > PROMPT_MAX) {
    throw new ChatdshError('request-invalid', `提醒文本取 1 到 ${PROMPT_MAX} 个字符`, { reason: 'prompt' });
  }
  return trimmed;
}

/** 校验会话与任务标识。 */
function bindingOf(input: { sessionId: unknown; scheduleId?: unknown }): { sessionId: string; scheduleId?: string } {
  if (typeof input.sessionId !== 'string' || input.sessionId === '') {
    throw new ChatdshError('request-invalid', '需要原会话标识', { reason: 'session-id' });
  }
  if (input.scheduleId === undefined) return { sessionId: input.sessionId };
  if (typeof input.scheduleId !== 'string' || input.scheduleId === '') {
    throw new ChatdshError('request-invalid', '需要定时任务标识', { reason: 'schedule-id' });
  }
  return { sessionId: input.sessionId, scheduleId: input.scheduleId };
}

/** 把宿主记录整理成界面字段。 */
function viewOfRecord(record: HostRecord, sessionId: string, enabled: boolean, lastRunAt?: number): ScheduleView {
  const nextRunAt = enabled ? Date.parse(record.scheduledAt) : undefined;
  return {
    scheduleId: String(record.id),
    sessionId,
    name: record.title,
    prompt: record.prompt,
    spec: specOfRecord(record),
    enabled,
    ...(nextRunAt !== undefined && Number.isFinite(nextRunAt) ? { nextRunAt } : {}),
    ...(lastRunAt === undefined ? {} : { lastRunAt }),
  };
}

/** 把目录条目整理成界面字段。 */
function viewOfEntry(entry: HostCatalogEntry): ScheduleView {
  const lastRunAt = entry.lastDelivery === undefined ? undefined : Date.parse(entry.lastDelivery.scheduledAt);
  return viewOfRecord(entry, String(entry.sessionId), entry.status === 'active', Number.isFinite(lastRunAt) ? lastRunAt : undefined);
}

/** 把宿主返回的拒绝翻译成契约错误。 */
function failureOf(result: { code?: string }): ChatdshError {
  const code = typeof result.code === 'string' ? result.code : 'internal-error';
  const mapped: ChatdshErrorCode = code === 'schedule_not_found'
    ? 'object-not-found'
    : code === 'schedule_conflict'
      ? 'revision-conflict'
      : code === 'schedule_ended'
        ? 'already-handled'
        : code === 'subagent_session'
          ? 'permission-denied'
          : code === 'internal_schedule'
            ? 'internal-error'
            : 'request-invalid';
  return new ChatdshError(mapped, '运行时拒绝了这次定时任务操作', { reason: code });
}

/** 把宿主抛出的输入错误翻译成契约错误；不属于宿主的错误原样上抛。 */
function hostErrorOf(error: unknown): unknown {
  if (error instanceof ChatdshError) return error;
  const code = typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
  if (code === undefined) return error;
  return failureOf({ code });
}

/** HTTP 状态码。 */
function statusOf(code: string): number {
  switch (code) {
    case 'request-invalid':
      return 400;
    case 'permission-denied':
    case 'csrf-required':
      return 403;
    case 'session-not-found':
    case 'object-not-found':
      return 404;
    case 'payload-too-large':
      return 413;
    case 'revision-conflict':
    case 'already-handled':
      return 409;
    default:
      return 500;
  }
}

/** 读取有界请求体。 */
async function readBody(request: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string, 'utf8');
    bytes += buffer.byteLength;
    if (bytes > limit) throw new ChatdshError('payload-too-large', '请求体超过上限', { reason: 'body' });
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 解析 JSON 请求体。 */
function jsonBodyOf(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ChatdshError('request-invalid', '请求体不是合法 JSON', { reason: 'json' });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ChatdshError('request-invalid', '请求体必须是对象', { reason: 'json' });
  }
  return parsed as Record<string, unknown>;
}

/**
 * 原会话定时任务的界面服务。
 */
export class ChatdshScheduleService extends TypertRemoteService {
  /** 依赖本机 HTTP 服务、原会话运行时与会话注册表。 */
  static inject = ['webServer', 'schedule', 'sessions'];

  /**
   * @param ctx - 宿主上下文。
   */
  constructor(ctx: Context) {
    super(ctx, SERVICE_NAME);
  }

  /** 注册界面访问路径。 */
  async [TypertRemoteService.init](): Promise<void> {
    const release = hostWebServerOf(this.ctx).register({
      kind: 'exact',
      path: SCHEDULES_PATH,
      handler: (request, response) => this.handleHttp(request, response),
    });
    this.ctx.effect(() => () => release(), `${name}/schedules-endpoint`);
  }

  /**
   * 列出一条会话的定时任务。
   * @param sessionId - 原会话标识。
   * @returns 按发生时刻排序的任务。
   */
  @Remote('list')
  async list(sessionId: string): Promise<ScheduleView[]> {
    return this.traced('list', () => this.listSchedules(sessionId));
  }

  /**
   * 在原会话上建立一条定时任务。
   * @param input - 会话、名称、提醒文本与时间方式。
   * @returns 建立的任务。
   */
  @Remote('create')
  async create(input: ScheduleCreateInput): Promise<ScheduleView> {
    return this.traced('create', () => this.createSchedule(input));
  }

  /**
   * 编辑一条定时任务；停用按取消处理。
   * @param input - 会话、任务标识与新的取值。
   * @returns 保存后的任务；取消时返回停用视图。
   */
  @Remote('update')
  async update(input: ScheduleUpdateInput): Promise<ScheduleView> {
    return this.traced('update', () => this.updateSchedule(input));
  }

  /**
   * 取消一条定时任务，让它不再发生。
   * @param input - 会话与任务标识。
   * @returns 停用视图。
   */
  @Remote('cancel')
  async cancel(input: ScheduleBindingInput): Promise<ScheduleView> {
    return this.traced('cancel', () => this.cancelSchedule(input));
  }

  /**
   * 删除一条定时任务。
   * @param input - 会话与任务标识。
   * @returns 是否删除。
   */
  @Remote('remove')
  async remove(input: ScheduleBindingInput): Promise<{ scheduleId: string; removed: boolean }> {
    return this.traced('remove', async () => {
      await this.removeSchedule(input);
      return { scheduleId: input.scheduleId, removed: true };
    });
  }

  /** 列出任务。 */
  private async listSchedules(sessionId: string): Promise<ScheduleView[]> {
    const binding = bindingOf({ sessionId });
    this.assertSession(binding.sessionId);
    const entries = await this.host(() => scheduleOf(this.ctx).catalog());
    return entries.filter((entry) => String(entry.sessionId) === binding.sessionId).map(viewOfEntry);
  }

  /** 建立任务。 */
  private async createSchedule(input: ScheduleCreateInput): Promise<ScheduleView> {
    const binding = bindingOf({ sessionId: input.sessionId });
    this.assertSession(binding.sessionId);
    const name = nameOf(input.name);
    const prompt = promptOf(input.prompt);
    const spec = specOfInput(input.spec);
    if (input.enabled !== true) {
      throw new ChatdshError('request-invalid', '新建的定时任务立即生效，停用请建立之后取消', { reason: 'enabled' });
    }
    const record = await this.host(() => scheduleOf(this.ctx).create(binding.sessionId as SessionId, createRequestOf(name, prompt, spec, Date.now())));
    return viewOfRecord(record, binding.sessionId, true);
  }

  /** 编辑任务；停用按取消处理。 */
  private async updateSchedule(input: ScheduleUpdateInput): Promise<ScheduleView> {
    const binding = bindingOf({ sessionId: input.sessionId, scheduleId: input.scheduleId });
    this.assertSession(binding.sessionId);
    const name = nameOf(input.name);
    const prompt = promptOf(input.prompt);
    const spec = specOfInput(input.spec);
    if (input.enabled !== true) return this.cancelSchedule({ sessionId: binding.sessionId, scheduleId: binding.scheduleId as string });
    const records = await this.host(() => scheduleOf(this.ctx).list({ sessionId: binding.sessionId as SessionId }));
    const expected = records.find((record) => String(record.id) === binding.scheduleId);
    if (expected === undefined) {
      throw new ChatdshError('object-not-found', '定时任务不存在', { reason: 'schedule-missing' });
    }
    const now = Date.now();
    const change = sameSpec(specOfRecord(expected), spec) ? undefined : changeOf(spec, now);
    const result = await this.host(() => scheduleOf(this.ctx).update({
      sessionId: binding.sessionId as SessionId,
      id: binding.scheduleId as HostScheduleId,
      expected,
      title: name,
      prompt,
      ...(change === undefined ? {} : { change }),
    }));
    if ('record' in result) return viewOfRecord(result.record, binding.sessionId, true);
    throw failureOf(result);
  }

  /** 取消任务：让它不再发生并返回停用视图。 */
  private async cancelSchedule(input: ScheduleBindingInput): Promise<ScheduleView> {
    const binding = bindingOf({ sessionId: input.sessionId, scheduleId: input.scheduleId });
    this.assertSession(binding.sessionId);
    const records = await this.host(() => scheduleOf(this.ctx).list({ sessionId: binding.sessionId as SessionId }));
    const expected = records.find((record) => String(record.id) === binding.scheduleId);
    if (expected === undefined) {
      throw new ChatdshError('object-not-found', '定时任务不存在', { reason: 'schedule-missing' });
    }
    const result = await this.host(() => scheduleOf(this.ctx).delete({ sessionId: binding.sessionId as SessionId, id: expected.id }));
    if (!result.deleted) throw failureOf(result);
    return viewOfRecord(expected, binding.sessionId, false);
  }

  /** 删除任务。 */
  private async removeSchedule(input: ScheduleBindingInput): Promise<void> {
    const binding = bindingOf({ sessionId: input.sessionId, scheduleId: input.scheduleId });
    this.assertSession(binding.sessionId);
    const result = await this.host(() => scheduleOf(this.ctx).delete({ sessionId: binding.sessionId as HostSessionId, id: binding.scheduleId as HostScheduleId }));
    if (!result.deleted) throw failureOf(result);
  }

  /** 在宿主的拒绝上做翻译，其余错误原样上抛。 */
  private async host<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw hostErrorOf(error);
    }
  }

  /** 确认会话存在；任务跟随原会话持久化，未知会话不建立任务。 */
  private assertSession(sessionId: string): void {
    if (sessionsOf(this.ctx).get(sessionId as SessionId) === undefined) {
      throw new ChatdshError('session-not-found', '原会话不存在', { reason: 'session-missing' });
    }
  }

  /** 处理界面路径。 */
  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? SCHEDULES_PATH, 'http://127.0.0.1');
    const method = (request.method ?? 'GET').toUpperCase();
    response.setHeader('Cache-Control', 'no-store');
    const send = (status: number, payload: unknown): void => {
      const body = JSON.stringify(payload);
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
      response.end(body);
    };
    const action = method === 'GET' ? 'list' : method === 'POST' ? 'create' : method === 'PUT' ? 'update' : method === 'DELETE' ? 'remove' : 'other';
    try {
      await this.traced(action, async () => {
        if (method !== 'GET' && method !== 'POST' && method !== 'PUT' && method !== 'DELETE') {
          throw new ChatdshError('request-invalid', '不支持的请求方法', { reason: 'method' });
        }
        if (method !== 'GET' && request.headers[CSRF_HEADER] !== '1') {
          throw new ChatdshError('permission-denied', '写操作需要页面携带的同源标识', { reason: 'csrf' });
        }
        if (method === 'GET') {
          const sessionId = url.searchParams.get('sessionId');
          if (sessionId === null || sessionId === '') throw new ChatdshError('request-invalid', '需要原会话标识', { reason: 'session-id' });
          send(200, { schedules: await this.listSchedules(sessionId) });
          return;
        }
        if (method === 'DELETE') {
          const sessionId = url.searchParams.get('sessionId');
          const scheduleId = url.searchParams.get('scheduleId');
          if (sessionId === null || scheduleId === null) throw new ChatdshError('request-invalid', '需要原会话与任务标识', { reason: 'binding' });
          await this.removeSchedule({ sessionId, scheduleId });
          response.writeHead(204);
          response.end();
          return;
        }
        const payload = jsonBodyOf(await readBody(request, BODY_MAX_BYTES));
        if (typeof payload['sessionId'] !== 'string' || payload['sessionId'] === '') {
          throw new ChatdshError('request-invalid', '需要原会话标识', { reason: 'session-id' });
        }
        if (typeof payload['enabled'] !== 'boolean') {
          throw new ChatdshError('request-invalid', '启用状态必须是布尔值', { reason: 'enabled' });
        }
        if (method === 'POST') {
          send(201, await this.createSchedule({
            sessionId: payload['sessionId'],
            name: payload['name'] as string,
            prompt: payload['prompt'] as string,
            spec: payload['spec'],
            enabled: payload['enabled'],
          }));
          return;
        }
        if (typeof payload['scheduleId'] !== 'string' || payload['scheduleId'] === '') {
          throw new ChatdshError('request-invalid', '需要定时任务标识', { reason: 'schedule-id' });
        }
        send(200, await this.updateSchedule({
          sessionId: payload['sessionId'],
          scheduleId: payload['scheduleId'],
          name: payload['name'] as string,
          prompt: payload['prompt'] as string,
          spec: payload['spec'],
          enabled: payload['enabled'],
        }));
      });
    } catch (error) {
      const code = error instanceof ChatdshError ? error.code : 'internal-error';
      send(statusOf(code), { error: code });
    }
  }

  /** 在一次 Remote 调用的 span 里执行，记录结果、计数与耗时。 */
  private async traced<T>(method: string, body: () => Promise<T>): Promise<T> {
    const telemetry = telemetryOf<ScheduleTelemetry>(this.ctx);
    if (telemetry === undefined) return body();
    const counter = telemetry.counter('chatdsh_remote_calls_total', { description: 'Remote 调用数' });
    const duration = telemetry.histogram('chatdsh_remote_call_duration_seconds', { description: 'Remote 调用耗时' });
    const startedAt = Date.now();
    return telemetry.runSpan('chatdsh.runtime.remote.call', { 'rpc.method': method }, async (span) => {
      try {
        const value = await body();
        span.setAttribute('outcome', 'ok');
        counter.add(1, { method, outcome: 'ok' });
        duration.record((Date.now() - startedAt) / 1000, { method });
        return value;
      } catch (error) {
        span.setAttribute('outcome', 'failed');
        counter.add(1, { method, outcome: 'failed', error_code: error instanceof ChatdshError ? error.code : 'internal-error' });
        duration.record((Date.now() - startedAt) / 1000, { method });
        throw error;
      }
    });
  }
}

/** 注册定时任务界面服务。 */
export function apply(ctx: Context): void {
  ctx.plugin(ChatdshScheduleService);
}
