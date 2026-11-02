/**
 * 通知中心的 HTTP 数据入口。
 *
 * 全部请求发给控制平面的通知前缀，按访问客户端标识与设备标识区分：列表分页、已读、业务
 * 已处理、设置读写、订阅、验证通知与聚焦会话。失败按状态码与错误码抛出，调用方决定如何
 * 呈现；设置写入的版本冲突作为正常结果返回，便于界面提示重新读取。
 * @module @chatdsh/client-notifications/gateway
 */

import type { NotificationTelemetry } from './telemetry.ts';
import type {
  HandledResult,
  NotificationPage,
  NotificationQuery,
  NotificationSettings,
  ProbeOutcome,
  ReadResult,
  SettingsDraft,
  SettingsSaveResult,
  SubscriptionInput,
  SubscriptionView,
} from './types.ts';

/** 通知中心在控制平面上的挂载前缀。 */
export const NOTIFICATION_PREFIX = '/chatdsh/gateway/notifications';

/** 访问客户端标识的请求头名称。 */
export const CLIENT_HEADER = 'x-chatdsh-client';

/** 设备标识的请求头名称。 */
export const DEVICE_HEADER = 'x-chatdsh-node-id';

/** 一次请求被拒绝时抛出的错误。 */
export class NotificationRequestError extends Error {
  /** 应答状态码。 */
  readonly status: number;

  /** 服务端给出的错误码。 */
  readonly code: string;

  /**
   * @param status - 应答状态码。
   * @param code - 服务端给出的错误码。
   * @param message - 说明。
   */
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'NotificationRequestError';
    this.status = status;
    this.code = code;
  }
}

/** 数据入口的构造依赖。 */
export interface NotificationGatewayOptions {
  /** 访问客户端标识，已读与聚焦按它记录。 */
  readonly clientId: string;
  /** 当前设备标识；每次请求时读取。 */
  readonly deviceId: string | (() => string);
  /** 控制平面地址；缺省用当前页面的同源地址。 */
  readonly baseUrl?: string;
  /** 发请求的实现。 */
  readonly fetchImpl?: typeof fetch;
  /** 遥测面。 */
  readonly telemetry?: NotificationTelemetry;
}

/** 通知中心的数据入口。 */
export interface NotificationGateway {
  /** 读一页通知。 */
  list(query: NotificationQuery): Promise<NotificationPage>;
  /** 标记已读；同一客户端重复提交按幂等处理。 */
  markRead(ids: readonly string[]): Promise<ReadResult>;
  /** 标记业务已处理。 */
  markHandled(ids: readonly string[]): Promise<HandledResult>;
  /** 读生效中的设置。 */
  readSettings(): Promise<NotificationSettings>;
  /** 写入设置，带上读到的版本号。 */
  saveSettings(draft: SettingsDraft, revision: number): Promise<SettingsSaveResult>;
  /** 读当前设备的订阅状态。 */
  readSubscription(): Promise<SubscriptionView>;
  /** 保存订阅。 */
  saveSubscription(input: SubscriptionInput): Promise<SubscriptionView>;
  /** 退订当前设备。 */
  removeSubscription(): Promise<{ readonly removed: number }>;
  /** 发送一条验证通知。 */
  sendProbe(): Promise<ProbeOutcome>;
  /** 回报验证通知的系统实际接收。 */
  reportProbeReceipt(probeId: string, receivedAt: number): Promise<ProbeOutcome>;
  /** 记录当前访问客户端聚焦的会话；空串表示离开。 */
  setFocus(sessionId: string): Promise<{ readonly focused: boolean; readonly sessionId: string }>;
}

/** 把查询转成请求参数。 */
function queryString(query: NotificationQuery): string {
  const params = new URLSearchParams();
  params.set('filter', query.filter);
  params.set('limit', String(query.limit));
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  if (query.deviceId !== undefined) params.set('deviceId', query.deviceId);
  if (query.sessionId !== undefined) params.set('sessionId', query.sessionId);
  if (query.since !== undefined) params.set('since', String(query.since));
  if (query.until !== undefined) params.set('until', String(query.until));
  return params.toString();
}

/**
 * 建立通知中心的数据入口。
 * @param options - 标识、地址、发送实现与遥测面。
 * @returns 数据入口。
 */
export function createNotificationGateway(options: NotificationGatewayOptions): NotificationGateway {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? '';
  const deviceIdOf = typeof options.deviceId === 'string' ? () => options.deviceId as string : options.deviceId;

  /** 按遥测面记录一次调用。 */
  const run = <T>(method: string, work: () => Promise<T>): Promise<T> => (
    options.telemetry === undefined ? work() : options.telemetry.run(method, work)
  );

  /** 发一次请求并解析应答。 */
  const request = async <T>(
    verb: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    call: { readonly body?: unknown; readonly name: string; readonly omitDevice?: boolean },
  ): Promise<{ status: number; payload: T }> => {
    const send = async (): Promise<{ status: number; payload: T }> => {
      const response = await fetchImpl(`${baseUrl}${NOTIFICATION_PREFIX}${path}`, {
        method: verb,
        headers: {
          accept: 'application/json',
          [CLIENT_HEADER]: options.clientId,
          ...(call.omitDevice === true ? {} : { [DEVICE_HEADER]: deviceIdOf() }),
          ...(call.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
      });
      const text = await response.text();
      if (!response.ok) {
        const parsed = text === '' ? undefined : JSON.parse(text) as { error?: unknown; settings?: unknown };
        const code = typeof parsed?.error === 'string' ? parsed.error : `http-${response.status}`;
        throw new NotificationRequestError(response.status, code, `通知接口拒绝请求：${code}`);
      }
      return { status: response.status, payload: (text === '' ? undefined : JSON.parse(text)) as T };
    };
    return run(call.name, send);
  };

  return {
    async list(query: NotificationQuery): Promise<NotificationPage> {
      // 列表请求不带设备标识头：宿主对列表优先取标识头作为设备范围，带上之后只能看到本设备
      // 的记录。通知中心默认展示同一用户的全部设备，设备过滤由查询参数决定。
      const { payload } = await request<NotificationPage>('GET', `/?${queryString(query)}`, {
        name: 'notifications.list',
        omitDevice: true,
      });
      return payload;
    },

    async markRead(ids: readonly string[]): Promise<ReadResult> {
      const { payload } = await request<ReadResult>('POST', '/read', { body: { ids }, name: 'notifications.read' });
      return payload;
    },

    async markHandled(ids: readonly string[]): Promise<HandledResult> {
      const { payload } = await request<HandledResult>('POST', '/handled', { body: { ids }, name: 'notifications.handled' });
      return payload;
    },

    async readSettings(): Promise<NotificationSettings> {
      const { payload } = await request<NotificationSettings>('GET', '/settings', { name: 'notifications.settings.read' });
      return payload;
    },

    async saveSettings(draft: SettingsDraft, revision: number): Promise<SettingsSaveResult> {
      return run('notifications.settings.save', async (): Promise<SettingsSaveResult> => {
        const response = await fetchImpl(`${baseUrl}${NOTIFICATION_PREFIX}/settings`, {
          method: 'PUT',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            [CLIENT_HEADER]: options.clientId,
            [DEVICE_HEADER]: deviceIdOf(),
          },
          body: JSON.stringify({ ...draft, revision }),
        });
        const text = await response.text();
        const parsed = (text === '' ? undefined : JSON.parse(text)) as
          | (NotificationSettings & { error?: unknown; settings?: NotificationSettings })
          | undefined;
        if (response.status === 409 && parsed !== undefined && typeof parsed.error === 'string' && parsed.settings !== undefined) {
          return { ok: false, code: parsed.error, current: parsed.settings };
        }
        if (!response.ok || parsed === undefined) {
          const code = typeof parsed?.error === 'string' ? parsed.error : `http-${response.status}`;
          throw new NotificationRequestError(response.status, code, `通知设置写入被拒绝：${code}`);
        }
        return { ok: true, settings: parsed };
      });
    },

    async readSubscription(): Promise<SubscriptionView> {
      const { payload } = await request<SubscriptionView>('GET', '/subscription', { name: 'notifications.subscription.read' });
      return payload;
    },

    async saveSubscription(input: SubscriptionInput): Promise<SubscriptionView> {
      const { payload } = await request<SubscriptionView>('POST', '/subscription', {
        body: {
          endpoint: input.endpoint,
          keys: { p256dh: input.p256dh, auth: input.auth },
          permission: input.permission,
        },
        name: 'notifications.subscription.save',
      });
      return payload;
    },

    async removeSubscription(): Promise<{ readonly removed: number }> {
      const { payload } = await request<{ removed: number }>('DELETE', '/subscription', { name: 'notifications.subscription.remove' });
      return payload;
    },

    async sendProbe(): Promise<ProbeOutcome> {
      return run('notifications.probe', async (): Promise<ProbeOutcome> => {
        const response = await fetchImpl(`${baseUrl}${NOTIFICATION_PREFIX}/probe`, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            [CLIENT_HEADER]: options.clientId,
            [DEVICE_HEADER]: deviceIdOf(),
          },
          body: JSON.stringify({ deviceId: deviceIdOf() }),
        });
        const text = await response.text();
        const parsed = (text === '' ? undefined : JSON.parse(text)) as (ProbeOutcome & { error?: unknown }) | undefined;
        if (response.status === 502 && parsed !== undefined && parsed.probe !== undefined) return parsed;
        if (!response.ok || parsed === undefined) {
          const code = typeof parsed?.error === 'string' ? parsed.error : `http-${response.status}`;
          throw new NotificationRequestError(response.status, code, `验证通知发送失败：${code}`);
        }
        return parsed;
      });
    },

    async reportProbeReceipt(probeId: string, receivedAt: number): Promise<ProbeOutcome> {
      const { payload } = await request<ProbeOutcome>('POST', '/probe/receipt', {
        body: { probeId, receivedAt },
        name: 'notifications.probe.receipt',
      });
      return payload;
    },

    async setFocus(sessionId: string): Promise<{ readonly focused: boolean; readonly sessionId: string }> {
      const { payload } = await request<{ focused: boolean; sessionId: string }>('POST', '/focus', {
        body: { deviceId: deviceIdOf(), sessionId },
        name: 'notifications.focus',
      });
      return payload;
    },
  } satisfies NotificationGateway;
}
