/**
 * 通知中心的浏览器侧装配。
 *
 * 把数据入口、列表状态机、系统通知与实时事件流接在一起：设置读一次之后用于裁剪系统通知，
 * 事件流到达的四种事件分别更新列表与关闭已展示的通知，点击系统通知交给外壳打开业务页面。
 * @module @chatdsh/client-notifications/runtime
 */

import { NotificationCenter } from './center.ts';
import { createNotificationGateway, type NotificationGateway } from './gateway.ts';
import { SystemNotifier } from './system.ts';
import { createNotificationTelemetry, type NotificationTelemetry } from './telemetry.ts';
import type { NavigationTarget, NotificationSettings, PushEvent } from './types.ts';

/** 控制平面的推送通道。 */
export const EVENTS_PATH = '/chatdsh/gateway/events';

/** 推送事件的种类。 */
const PUSH_EVENT_KINDS = ['notification', 'notification-read', 'notification-handled', 'notification-withdraw'] as const;

/** 运行时构造依赖。 */
export interface NotificationsRuntimeOptions {
  /** 访问客户端标识。 */
  readonly clientId: string;
  /** 当前设备标识。 */
  readonly deviceId: string;
  /** 控制平面地址；缺省用同源地址。 */
  readonly baseUrl?: string;
  /** 发请求的实现。 */
  readonly fetchImpl?: typeof fetch;
  /** 遥测面。 */
  readonly telemetry?: NotificationTelemetry;
  /** 打开业务页面的动作。 */
  readonly navigate?: (target: NavigationTarget) => void;
}

/**
 * 把一段事件流数据解析成推送事件。
 * @param text - `data:` 之后的 JSON 文本。
 * @returns 推送事件。
 */
export function pushEventOf(text: string): PushEvent {
  const parsed = JSON.parse(text) as { kind?: unknown };
  if (typeof parsed.kind !== 'string' || !(PUSH_EVENT_KINDS as readonly string[]).includes(parsed.kind)) {
    throw new Error(`通知事件种类不在约定之内：${String(parsed.kind)}`);
  }
  return parsed as PushEvent;
}

/** 通知中心的浏览器侧运行时。 */
export class NotificationsRuntime {
  /** 访问客户端标识。 */
  readonly clientId: string;

  /** 当前设备标识。 */
  readonly deviceId: string;

  /** 遥测面。 */
  readonly telemetry: NotificationTelemetry;

  /** 数据入口。 */
  readonly gateway: NotificationGateway;

  /** 系统通知面。 */
  readonly notifier: SystemNotifier;

  /** 列表状态机。 */
  readonly center: NotificationCenter;

  private readonly navigate: ((target: NavigationTarget) => void) | undefined;
  private settings: NotificationSettings | undefined;
  private focusedSession: string | undefined;
  private source: EventSource | undefined;

  constructor(options: NotificationsRuntimeOptions) {
    this.clientId = options.clientId;
    this.deviceId = options.deviceId;
    this.navigate = options.navigate;
    this.telemetry = options.telemetry ?? createNotificationTelemetry();
    this.gateway = createNotificationGateway({
      clientId: options.clientId,
      deviceId: options.deviceId,
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      telemetry: this.telemetry,
    });
    this.notifier = new SystemNotifier({
      onOpen: (input) => {
        if (input.sessionId === undefined) return;
        this.navigate?.({
          sessionId: input.sessionId,
          ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
          ...(input.objectId === undefined ? {} : { objectId: input.objectId }),
          kind: input.kind,
        });
      },
    });
    this.center = new NotificationCenter({
      gateway: this.gateway,
      onWithdraw: (event) => {
        void this.notifier.withdraw(event.tags);
      },
    });
  }

  /** 读取设置并打开事件流。 */
  async start(): Promise<void> {
    this.settings = await this.gateway.readSettings();
    this.openStream();
  }

  /** 关闭事件流。 */
  stop(): void {
    this.source?.close();
    this.source = undefined;
  }

  /**
   * 重新读取设置；设置分区保存之后调用。
   * @returns 读到的新设置。
   */
  async refreshSettings(): Promise<NotificationSettings> {
    const settings = await this.gateway.readSettings();
    this.settings = settings;
    return settings;
  }

  /** 读当前生效的设置。 */
  settingsSnapshot(): NotificationSettings | undefined {
    return this.settings;
  }

  /**
   * 记录当前聚焦的会话，供聚焦静默与宿主判定使用。
   * @param sessionId - 会话标识；缺省表示离开。
   */
  async setFocusedSession(sessionId: string | undefined): Promise<void> {
    this.noteFocus(sessionId);
    await this.center.reportFocus(sessionId ?? '');
  }

  /**
   * 记录当前聚焦的会话，只保存在本地，供聚焦静默判断。
   * @param sessionId - 会话标识；缺省表示离开。
   */
  noteFocus(sessionId: string | undefined): void {
    this.focusedSession = sessionId;
  }

  /** 读当前聚焦的会话。 */
  focusedSessionId(): string | undefined {
    return this.focusedSession;
  }

  /**
   * 处理一条事件流数据。
   * @param text - `data:` 之后的 JSON 文本。
   */
  async accept(text: string): Promise<void> {
    const event = pushEventOf(text);
    this.center.applyEvent(event);
    if (event.kind !== 'notification') return;
    const settings = this.settings;
    if (settings === undefined) return;
    for (const item of event.items) {
      await this.notifier.show({
        id: item.id,
        kind: item.kind,
        title: item.title,
        ...(item.summary === undefined ? {} : { summary: item.summary }),
        ...(item.preview === undefined ? {} : { preview: item.preview }),
        ...(item.tag === undefined ? {} : { tag: item.tag }),
        ...(item.deviceId === undefined ? {} : { deviceId: item.deviceId }),
        ...(item.sessionId === undefined ? {} : { sessionId: item.sessionId }),
        ...(item.objectId === undefined ? {} : { objectId: item.objectId }),
        createdAt: item.createdAt,
      }, {
        privacy: settings.privacy,
        messagePreview: settings.messagePreview,
        quietWhenFocused: settings.quietWhenFocused,
      }, this.focusedSession);
    }
  }

  /** 打开事件流。 */
  private openStream(): void {
    if (typeof EventSource === 'undefined') throw new Error('当前环境没有 EventSource，通知中心无法接收实时更新');
    const source = new EventSource(EVENTS_PATH);
    source.onmessage = (event: MessageEvent<string>) => {
      void this.accept(event.data);
    };
    this.source = source;
  }
}
