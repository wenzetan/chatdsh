/**
 * 自动化面板的数据入口。
 *
 * 面板按同源相对路径访问控制平面的真实接口：自动化记录的读取、建立、编辑、删除与启停，
 * 投递记录的分页，执行节点与按设备分组的会话，以及原会话定时任务（经 `/d/<deviceId>/`
 * 前缀送到原会话所在的运行时）。返回值在这里逐项核对形状，形状不符按失败抛出并带上错误
 * 码，界面据码给出说明，不把残缺数据渲染成成功。
 *
 * 控制平面尚未提供某个操作时，应答是 404 或 405，界面显示「控制平面没有提供这个操作」，
 * 不把失败画成成功。
 * @module @chatdsh/client-automation/gateway
 */

import type {
  AutomationDelivery,
  AutomationDraftInput,
  AutomationGateway,
  AutomationRecord,
  DeliveryPage,
  DeliveryQuery,
  DeliveryState,
  DeviceSessions,
  DeviceSummary,
  PanelTelemetry,
  ScheduleView,
  SessionSummary,
  SessionsSnapshot,
} from './types.ts';
import type { ScheduleSpec } from './schedule.ts';

/** 控制平面的接口路径。 */
export const AUTOMATIONS_PATH = '/chatdsh/gateway/automations';
export const DELIVERIES_PATH = '/chatdsh/gateway/automation-deliveries';
export const DEVICES_PATH = '/chatdsh/gateway/devices';
export const SESSIONS_PATH = '/chatdsh/gateway/sessions';

/** 原会话定时任务的路径：经设备前缀送到原会话所在的运行时。 */
export function schedulesPathOf(deviceId: string): string {
  return `/d/${encodeURIComponent(deviceId)}/chatdsh/schedules`;
}

/** 写操作要求的请求头，跨站表单无法携带。 */
export const CSRF_HEADER = 'x-chatdsh-csrf';

/** 投递状态的取值集合。 */
const DELIVERY_STATES: readonly string[] = [
  'received',
  'validated',
  'dispatching',
  'accepted',
  'completed',
  'failed',
  'unconfirmed',
];

/** 一次调用失败。 */
export class AutomationCallError extends Error {
  /**
   * @param code - 错误码，取自返回体或本端的失败分类。
   * @param message - 面向用户的说明。
   * @param status - HTTP 状态码；没有拿到应答时为 0。
   */
  constructor(readonly code: string, message: string, readonly status = 0) {
    super(message);
    this.name = 'AutomationCallError';
  }
}

/** 断言一个对象。 */
function requireRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AutomationCallError('gateway/internal', `${what}的返回形状不符合约定`);
  }
  return value as Record<string, unknown>;
}

/** 断言一个字符串。 */
function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new AutomationCallError('gateway/internal', `${what}的返回形状不符合约定`);
  }
  return value;
}

/** 断言一个非负整数。 */
function requireNumber(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new AutomationCallError('gateway/internal', `${what}的返回形状不符合约定`);
  }
  return value;
}

/** 断言一个数组。 */
function requireArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new AutomationCallError('gateway/internal', `${what}的返回形状不符合约定`);
  return value;
}

/** 读一个可选的字符串字段。 */
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** 读一条自动化记录。 */
function recordOf(value: unknown): AutomationRecord {
  const record = requireRecord(value, '自动化记录');
  const trigger = requireRecord(record['trigger'], '自动化记录的触发条件');
  const kind = trigger['kind'];
  const parsedTrigger: AutomationRecord['trigger'] = kind === 'webhook'
    ? { kind: 'webhook', secretEnv: requireString(trigger['secretEnv'], '触发条件的密钥环境变量名') }
    : kind === 'schedule'
      ? { kind: 'schedule', cron: typeof trigger['cron'] === 'string' ? trigger['cron'] : '' }
      : (() => {
        throw new AutomationCallError('gateway/internal', '自动化记录的触发条件类型不符合约定');
      })();
  const spec = record['spec'] === undefined ? undefined : specOf(record['spec']);
  if (parsedTrigger.kind === 'schedule' && spec === undefined && parsedTrigger.cron === '') {
    throw new AutomationCallError('gateway/internal', '定时触发的记录既没有 cron 表达式也没有时间方式');
  }
  const action = requireRecord(record['action'], '自动化记录的动作');
  if (action['kind'] !== 'start-session') {
    throw new AutomationCallError('gateway/internal', '自动化记录的动作类型不符合约定');
  }
  const target = record['target'] === undefined ? undefined : requireRecord(record['target'], '自动化记录的执行目标');
  const lastDelivery = record['lastDelivery'] === undefined
    ? undefined
    : requireRecord(record['lastDelivery'], '自动化记录的最近投递');
  const revision = record['revision'];
  return {
    id: requireString(record['id'], '自动化记录'),
    name: requireString(record['name'], '自动化记录'),
    trigger: parsedTrigger,
    action: {
      kind: 'start-session',
      prompt: requireString(action['prompt'], '动作的提示词'),
      ...(optionalString(action['workspaceId']) === undefined ? {} : { workspaceId: optionalString(action['workspaceId']) }),
    },
    enabled: record['enabled'] === true,
    createdAt: requireNumber(record['createdAt'], '自动化记录'),
    ...(typeof revision === 'number' ? { revision } : {}),
    ...(spec === undefined ? {} : { spec }),
    ...(target === undefined ? {} : {
      target: {
        ...(optionalString(target['deviceId']) === undefined ? {} : { deviceId: optionalString(target['deviceId']) }),
        ...(optionalString(target['deviceName']) === undefined ? {} : { deviceName: optionalString(target['deviceName']) }),
        ...(optionalString(target['workspaceId']) === undefined ? {} : { workspaceId: optionalString(target['workspaceId']) }),
        ...(optionalString(target['workspaceName']) === undefined ? {} : { workspaceName: optionalString(target['workspaceName']) }),
        ...(optionalString(target['cwd']) === undefined ? {} : { cwd: optionalString(target['cwd']) }),
        ...(optionalString(target['presetId']) === undefined ? {} : { presetId: optionalString(target['presetId']) }),
        ...(optionalString(target['presetName']) === undefined ? {} : { presetName: optionalString(target['presetName']) }),
        ...(optionalString(target['model']) === undefined ? {} : { model: optionalString(target['model']) }),
      },
    }),
    ...(lastDelivery === undefined ? {} : {
      lastDelivery: {
        state: stateOf(lastDelivery['state']),
        receivedAt: requireNumber(lastDelivery['receivedAt'], '最近投递的接收时刻'),
        ...(optionalString(lastDelivery['code']) === undefined ? {} : { code: optionalString(lastDelivery['code']) }),
      },
    }),
  };
}

/** 读一个投递状态。 */
function stateOf(value: unknown): DeliveryState {
  if (typeof value !== 'string' || !DELIVERY_STATES.includes(value)) {
    throw new AutomationCallError('gateway/internal', '投递状态的取值不符合约定');
  }
  return value as DeliveryState;
}

/** 读一条投递记录。 */
function deliveryOf(value: unknown): AutomationDelivery {
  const record = requireRecord(value, '投递记录');
  const source = record['source'];
  if (source !== 'github' && source !== 'generic') {
    throw new AutomationCallError('gateway/internal', '投递记录的来源不符合约定');
  }
  const dedupe = record['dedupe'];
  if (dedupe !== 'new' && dedupe !== 'duplicate') {
    throw new AutomationCallError('gateway/internal', '投递记录的去重结果不符合约定');
  }
  const completedAt = record['completedAt'];
  const sessionId = optionalString(record['sessionId']);
  const code = optionalString(record['code']);
  return {
    deliveryId: requireString(record['deliveryId'], '投递记录'),
    automationId: requireString(record['automationId'], '投递记录'),
    eventId: requireString(record['eventId'], '投递记录'),
    source,
    receivedAt: requireNumber(record['receivedAt'], '投递记录'),
    dedupe,
    state: stateOf(record['state']),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(typeof completedAt === 'number' ? { completedAt } : {}),
    ...(code === undefined ? {} : { code }),
  };
}

/** 读一台执行节点。 */
function deviceOf(value: unknown): DeviceSummary {
  const record = requireRecord(value, '执行节点');
  return {
    id: requireString(record['id'], '执行节点'),
    name: requireString(record['name'], '执行节点'),
    platform: requireString(record['platform'], '执行节点'),
    online: record['online'] === true,
    lastSeenAt: requireNumber(record['lastSeenAt'], '执行节点'),
  };
}

/** 读一条会话。 */
function sessionOf(value: unknown): SessionSummary {
  const record = requireRecord(value, '会话条目');
  return {
    sessionId: requireString(record['sessionId'], '会话条目'),
    title: requireString(record['title'], '会话条目'),
    updatedAt: requireNumber(record['updatedAt'], '会话条目'),
    cwd: typeof record['cwd'] === 'string' ? record['cwd'] : '',
    workspaceName: typeof record['workspaceName'] === 'string' ? record['workspaceName'] : '',
  };
}

/** 读一台设备与它名下的会话。 */
function deviceSessionsOf(value: unknown): DeviceSessions {
  const record = requireRecord(value, '会话聚合里的设备条目');
  return {
    deviceId: requireString(record['deviceId'], '会话聚合里的设备条目'),
    name: requireString(record['name'], '会话聚合里的设备条目'),
    platform: requireString(record['platform'], '会话聚合里的设备条目'),
    online: record['online'] === true,
    lastSeenAt: requireNumber(record['lastSeenAt'], '会话聚合里的设备条目'),
    sessions: requireArray(record['sessions'], '会话聚合里的会话列表').map(sessionOf),
  };
}

/** 读一种触发方式。 */
function specOf(value: unknown): ScheduleSpec {
  const record = requireRecord(value, '定时任务的触发方式');
  const timeZone = requireString(record['timeZone'], '定时任务的时区');
  switch (record['kind']) {
    case 'once':
      return { kind: 'once', at: requireNumber(record['at'], '单次任务的时刻'), timeZone };
    case 'interval':
      return { kind: 'interval', everySeconds: requireNumber(record['everySeconds'], '固定间隔任务的间隔'), timeZone };
    case 'daily':
      return { kind: 'daily', time: requireString(record['time'], '每日任务的时刻'), timeZone };
    case 'weekly':
      return {
        kind: 'weekly',
        weekdays: requireArray(record['weekdays'], '每周任务的星期').map((weekday) => requireNumber(weekday, '每周任务的星期')),
        time: requireString(record['time'], '每周任务的时刻'),
        timeZone,
      };
    case 'cron':
      return { kind: 'cron', expression: requireString(record['expression'], 'cron 表达式'), timeZone };
    default:
      throw new AutomationCallError('gateway/internal', '定时任务的触发方式不符合约定');
  }
}

/** 读一条定时任务。 */
function scheduleOf(value: unknown): ScheduleView {
  const record = requireRecord(value, '定时任务');
  const nextRunAt = record['nextRunAt'];
  const lastRunAt = record['lastRunAt'];
  return {
    scheduleId: requireString(record['scheduleId'], '定时任务'),
    sessionId: requireString(record['sessionId'], '定时任务'),
    name: requireString(record['name'], '定时任务'),
    prompt: requireString(record['prompt'], '定时任务'),
    spec: specOf(record['spec']),
    enabled: record['enabled'] === true,
    ...(typeof nextRunAt === 'number' ? { nextRunAt } : {}),
    ...(typeof lastRunAt === 'number' ? { lastRunAt } : {}),
  };
}

/** 构造数据入口所需的依赖。 */
export interface AutomationGatewayOptions {
  /** 同源请求的基地址；缺省用当前页面地址。 */
  readonly origin?: string;
  /** 浏览器侧遥测。 */
  readonly telemetry: PanelTelemetry;
  /** `fetch` 实现；缺省用全局实现。 */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * 构造自动化面板的数据入口。
 * @param options - 遥测与可选的基地址。
 * @returns 数据入口。
 */
export function createAutomationGateway(options: AutomationGatewayOptions): AutomationGateway {
  const origin = options.origin ?? (typeof location === 'undefined' ? 'http://127.0.0.1' : location.origin);
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const telemetry = options.telemetry;

  /**
   * 发一次请求，拿到状态码与解析后的返回体。
   * @param path - 相对路径。
   * @param init - 请求参数。
   * @returns 状态码与返回体。
   */
  const exchange = async (path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> => {
    let response: Response;
    try {
      response = await doFetch(new URL(path, origin), init);
    } catch (error) {
      throw new AutomationCallError('control-plane-unreachable', `控制平面不可达，请恢复连接后重试：${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status === 204) return { status: response.status, body: undefined };
    const text = await response.text();
    if (text === '') return { status: response.status, body: undefined };
    try {
      return { status: response.status, body: JSON.parse(text) as unknown };
    } catch {
      // 未知路径落到外壳的静态处理，应答不是 JSON：按「控制平面没有提供这个操作」处理。
      if (response.status === 404 || response.status === 405) {
        throw new AutomationCallError('method-not-allowed', describeFailure('method-not-allowed', response.status), response.status);
      }
      throw new AutomationCallError('gateway/internal', `控制平面返回的不是 JSON（${String(response.status)}）`, response.status);
    }
  };

  /**
   * 发一次请求，非 2xx 按失败抛出。
   * @param path - 相对路径。
   * @param init - 请求参数。
   * @returns 解析后的返回体。
   */
  const call = async (path: string, init?: RequestInit): Promise<unknown> => {
    const answer = await exchange(path, init);
    if (answer.status >= 200 && answer.status < 300) return answer.body;
    const code = typeof answer.body === 'object' && answer.body !== null && typeof (answer.body as { error?: unknown }).error === 'string'
      ? (answer.body as { error: string }).error
      : answer.status === 405 ? 'method-not-allowed' : 'gateway/internal';
    throw new AutomationCallError(code, describeFailure(code, answer.status), answer.status);
  };

  /** 写操作的公共请求头。 */
  const writeHeaders = { 'content-type': 'application/json', [CSRF_HEADER]: '1' } as const;

  return {
    async automations(): Promise<readonly AutomationRecord[]> {
      const body = requireRecord(await call(AUTOMATIONS_PATH), '自动化列表');
      return requireArray(body['automations'], '自动化列表').map(recordOf);
    },

    async create(input: AutomationDraftInput): Promise<AutomationRecord> {
      const body = await call(AUTOMATIONS_PATH, { method: 'POST', headers: writeHeaders, body: JSON.stringify(input) });
      return recordOf(body);
    },

    async update(id: string, input: AutomationDraftInput): Promise<AutomationRecord> {
      const body = await call(AUTOMATIONS_PATH, { method: 'PUT', headers: writeHeaders, body: JSON.stringify({ id, ...input }) });
      return recordOf(body);
    },

    async remove(id: string): Promise<void> {
      await call(`${AUTOMATIONS_PATH}?id=${encodeURIComponent(id)}`, { method: 'DELETE', headers: { [CSRF_HEADER]: '1' } });
    },

    async setEnabled(id: string, enabled: boolean): Promise<AutomationRecord> {
      const body = await call(AUTOMATIONS_PATH, {
        method: 'PATCH',
        headers: writeHeaders,
        body: JSON.stringify({ id, enabled }),
      });
      return recordOf(body);
    },

    async deliveries(query: DeliveryQuery): Promise<DeliveryPage> {
      const search = new URLSearchParams({ limit: String(query.limit) });
      if (query.automationId !== undefined) search.set('automationId', query.automationId);
      if (query.state !== undefined) search.set('state', query.state);
      if (query.cursor !== undefined) search.set('cursor', query.cursor);
      const body = requireRecord(await call(`${DELIVERIES_PATH}?${search.toString()}`), '投递记录');
      const cursor = body['nextCursor'];
      return {
        deliveries: requireArray(body['deliveries'], '投递记录').map(deliveryOf),
        ...(typeof cursor === 'string' && cursor !== '' ? { nextCursor: cursor } : {}),
      };
    },

    async devices(): Promise<readonly DeviceSummary[]> {
      const body = requireRecord(await call(DEVICES_PATH), '执行节点列表');
      return requireArray(body['devices'], '执行节点列表').map(deviceOf);
    },

    async sessions(): Promise<SessionsSnapshot> {
      const body = requireRecord(await call(SESSIONS_PATH), '会话聚合');
      return { devices: requireArray(body['devices'], '会话聚合的设备列表').map(deviceSessionsOf) };
    },

    async schedules(deviceId: string, sessionId: string): Promise<readonly ScheduleView[]> {
      const path = `${schedulesPathOf(deviceId)}?sessionId=${encodeURIComponent(sessionId)}`;
      const body = requireRecord(await call(path), '定时任务列表');
      return requireArray(body['schedules'], '定时任务列表').map(scheduleOf);
    },

    async createSchedule(input): Promise<ScheduleView> {
      const body = await call(schedulesPathOf(input.deviceId), {
        method: 'POST',
        headers: writeHeaders,
        body: JSON.stringify({
          sessionId: input.sessionId,
          name: input.name,
          prompt: input.prompt,
          spec: input.spec,
          enabled: input.enabled,
        }),
      });
      return scheduleOf(body);
    },

    async updateSchedule(input): Promise<ScheduleView> {
      const body = await call(schedulesPathOf(input.deviceId), {
        method: 'PUT',
        headers: writeHeaders,
        body: JSON.stringify({
          sessionId: input.sessionId,
          scheduleId: input.scheduleId,
          name: input.name,
          prompt: input.prompt,
          spec: input.spec,
          enabled: input.enabled,
        }),
      });
      return scheduleOf(body);
    },

    async removeSchedule(input): Promise<void> {
      const search = new URLSearchParams({ sessionId: input.sessionId, scheduleId: input.scheduleId });
      await call(`${schedulesPathOf(input.deviceId)}?${search.toString()}`, {
        method: 'DELETE',
        headers: { [CSRF_HEADER]: '1' },
      });
    },

    noteAction(action, outcome): void {
      telemetry.action(action, outcome);
    },
  };
}

/**
 * 把错误码翻译成界面说明。
 * @param code - 错误码。
 * @param status - HTTP 状态码。
 * @returns 说明文字。
 */
export function describeFailure(code: string, status = 0): string {
  switch (code) {
    case 'control-plane-unreachable':
      return '控制平面不可达，请恢复连接后重试。';
    case 'method-not-allowed':
      return '控制平面没有提供这个操作。';
    case 'runtime-unreachable':
      return '控制平面没有这个接口的处理程序，请求被转给了运行时，运行时当前不可达。';
    case 'csrf-required':
      return '写操作需要页面携带的同源标识。';
    case 'device-offline':
      return '目标设备离线，控制平面不建立离线重发任务。';
    case 'automation-not-found':
      return '这条自动化记录不存在，它可能已被删除。';
    case 'invalid-payload':
      return '请求内容不合法：缺少必需字段或字段类型不对。';
    case 'automation-secret-missing':
      return '签名密钥所在的环境变量没有配置。';
    case 'schedule-host-unavailable':
      return '原会话所在的运行时没有提供定时任务接口。';
    default:
      return status === 0 ? `请求失败（${code}）` : `请求失败（${code}，HTTP ${String(status)}）`;
  }
}
