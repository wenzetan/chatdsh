/**
 * 系统通知与浏览器权限。
 *
 * 页面内通知走浏览器真实的 `Notification` 接口，内容按设置的隐私级别裁剪：默认只显示产品
 * 与事件类型，摘要需要摘要级别，消息原文需要预览级别并明确开启消息预览。弹出之前检查权限
 * 与当前会话聚焦静默；展示过通知按稳定 tag 记在本地，撤回事件到达时逐个关闭。点击通知只
 * 调用界面给出的打开动作，跳转到经过访问认证的业务页面。
 *
 * 推送订阅需要已注册的 Service Worker 与宿主下发的 VAPID 公钥，两者都不具备时本模块如实
 * 报告当前环境不支持订阅，不伪造订阅结果。
 * @module @chatdsh/client-notifications/system
 */

import type { NotificationKind, NotificationPermissionState, PrivacyLevel, SubscriptionInput } from './types.ts';

/** 系统通知里显示的产品名称。 */
export const PRODUCT_NAME = 'ChatDSH';

/** 系统通知按钮的可访问名称。 */
export const SYSTEM_ACTION_LABELS = Object.freeze({
  open: '打开业务页面',
  close: '关闭通知',
});

/** 一条准备展示的系统通知。 */
export interface SystemNotificationInput {
  /** 通知标识。 */
  readonly id: string;
  /** 事件类型。 */
  readonly kind: NotificationKind;
  /** 业务标题。 */
  readonly title: string;
  /** 摘要。 */
  readonly summary?: string;
  /** 命令或消息原文。 */
  readonly preview?: string;
  /** 稳定 tag。 */
  readonly tag?: string;
  /** 关联设备。 */
  readonly deviceId?: string;
  /** 关联会话。 */
  readonly sessionId?: string;
  /** 关联对象的稳定标识。 */
  readonly objectId?: string;
  /** 事件发生时刻。 */
  readonly createdAt: number;
}

/** 展示系统通知时需要的内容设置。 */
export interface SystemNotificationSettings {
  /** 隐私级别。 */
  readonly privacy: PrivacyLevel;
  /** 是否允许消息预览。 */
  readonly messagePreview: boolean;
  /** 当前会话聚焦时静默。 */
  readonly quietWhenFocused: boolean;
}

/** 一次展示的结果。 */
export interface ShowResult {
  /** 是否真的展示了系统通知。 */
  readonly shown: boolean;
  /** 没有展示时的原因。 */
  readonly reason?: 'unsupported' | 'default' | 'denied' | 'quiet';
  /** 展示时使用的 tag。 */
  readonly tag?: string;
}

/** 浏览器侧可用面。 */
export interface SystemNotifierEnvironment {
  /** 通知构造器；不支持时缺省。 */
  readonly Notification?: typeof Notification;
  /** 导航面。 */
  readonly navigator?: Navigator;
  /** 文档面。 */
  readonly document?: Document;
  /** 把窗口带到前台。 */
  readonly focus?: () => void;
}

/** 展示系统通知的依赖。 */
export interface SystemNotifierOptions {
  /** 浏览器侧可用面；缺省取全局对象。 */
  readonly environment?: SystemNotifierEnvironment;
  /** 当前时刻的毫秒时间戳。 */
  readonly now?: () => number;
  /** 点击通知之后打开业务页面的动作。 */
  readonly onOpen?: (input: SystemNotificationInput) => void;
}

/** 一条已经展示过的通知。 */
interface ShownNotification {
  readonly tag: string;
  /** 页面内展示的通知实例。 */
  readonly instance?: Notification;
  /** 经 Service Worker 展示的登记，撤回时按 tag 查找。 */
  readonly registration?: ServiceWorkerRegistration;
}

/** 订阅能力的探测结果。 */
export interface SubscriptionSupport {
  /** 当前环境是否能建立推送订阅。 */
  readonly supported: boolean;
  /** 不能建立时的说明。 */
  readonly reason?: string;
}

/** 一次订阅建立的结果。 */
export type SubscribeResult =
  | { readonly ok: true; readonly input: SubscriptionInput }
  | { readonly ok: false; readonly reason: string };

/** 读取全局对象上的可用面。 */
function defaultEnvironment(): SystemNotifierEnvironment {
  const global = globalThis as unknown as SystemNotifierEnvironment & { focus?: () => void };
  return {
    ...(global.Notification === undefined ? {} : { Notification: global.Notification }),
    ...(global.navigator === undefined ? {} : { navigator: global.navigator }),
    ...(global.document === undefined ? {} : { document: global.document }),
    ...(global.focus === undefined ? {} : { focus: () => global.focus?.() }),
  };
}

/** 系统通知的展示面。 */
export class SystemNotifier {
  private readonly environment: SystemNotifierEnvironment;
  private readonly onOpen: ((input: SystemNotificationInput) => void) | undefined;
  private readonly shown = new Map<string, ShownNotification>();

  constructor(options: SystemNotifierOptions = {}) {
    this.environment = options.environment ?? defaultEnvironment();
    this.onOpen = options.onOpen;
  }

  /** 读当前系统通知权限。 */
  permission(): NotificationPermissionState {
    const implementation = this.environment.Notification;
    if (implementation === undefined) return 'unsupported';
    const value = implementation.permission;
    if (value === 'granted' || value === 'denied' || value === 'default') return value;
    return 'unsupported';
  }

  /**
   * 请求浏览器通知权限。
   * @returns 请求之后的权限状态。
   */
  async requestPermission(): Promise<NotificationPermissionState> {
    const implementation = this.environment.Notification;
    if (implementation === undefined) return 'unsupported';
    const result = await implementation.requestPermission();
    if (result === 'granted' || result === 'denied' || result === 'default') return result;
    return 'unsupported';
  }

  /**
   * 展示一条系统通知。
   * @param input - 通知内容。
   * @param settings - 隐私级别、消息预览与聚焦静默的取值。
   * @param focusedSession - 当前访问客户端聚焦的会话。
   * @returns 展示结果。
   */
  async show(input: SystemNotificationInput, settings: SystemNotificationSettings, focusedSession?: string): Promise<ShowResult> {
    const state = this.permission();
    if (state === 'unsupported') return { shown: false, reason: 'unsupported' };
    if (state !== 'granted') return { shown: false, reason: state };
    if (settings.quietWhenFocused && focusedSession !== undefined && input.sessionId === focusedSession && (this.environment.document?.hasFocus() ?? false)) {
      return { shown: false, reason: 'quiet' };
    }
    const tag = input.tag ?? `notification-${input.id}`;
    this.close(tag);
    const content = contentOf(input, settings);
    const registration = await this.registration();
    if (registration !== undefined) {
      const options = {
        tag,
        ...(content.body === undefined ? {} : { body: content.body }),
        lang: 'zh-CN',
        data: { id: input.id, sessionId: input.sessionId, deviceId: input.deviceId, objectId: input.objectId },
        actions: [{ action: 'open', title: SYSTEM_ACTION_LABELS.open }],
      };
      await registration.showNotification(content.title, options as NotificationOptions);
      this.shown.set(tag, { tag, registration });
      return { shown: true, tag };
    }
    const implementation = this.environment.Notification;
    if (implementation === undefined) return { shown: false, reason: 'unsupported' };
    const instance = new implementation(content.title, {
      tag,
      ...(content.body === undefined ? {} : { body: content.body }),
      lang: 'zh-CN',
    });
    instance.onclick = () => {
      this.environment.focus?.();
      this.onOpen?.(input);
    };
    this.shown.set(tag, { tag, instance });
    return { shown: true, tag };
  }

  /**
   * 按 tag 关闭已经展示的通知。
   * @param tags - 要关闭的 tag。
   * @returns 实际关闭的条数。
   */
  async withdraw(tags: readonly string[]): Promise<number> {
    const registrations = new Set(
      [...this.shown.values()]
        .filter((item) => tags.includes(item.tag))
        .map((item) => item.registration)
        .filter((item): item is ServiceWorkerRegistration => item !== undefined),
    );
    let closed = 0;
    for (const tag of tags) {
      if (!this.shown.has(tag)) continue;
      this.close(tag);
      closed += 1;
    }
    for (const registration of registrations) {
      const active = await registration.getNotifications();
      for (const notification of active) {
        if (!tags.includes(notification.tag)) continue;
        notification.close();
      }
    }
    return closed;
  }

  /** 当前登记在本地、尚未关闭的 tag。 */
  activeTags(): string[] {
    return [...this.shown.keys()];
  }

  /**
   * 探测浏览器推送订阅的能力。
   * @returns 探测结果。
   */
  async subscriptionSupport(): Promise<SubscriptionSupport> {
    const navigator = this.environment.navigator;
    if (navigator === undefined || navigator.serviceWorker === undefined) {
      return { supported: false, reason: '当前环境没有 Service Worker，浏览器推送订阅不可用。' };
    }
    const registrations = await navigator.serviceWorker.getRegistrations();
    if (registrations.length === 0) {
      return { supported: false, reason: '当前页面没有已注册的 Service Worker，浏览器推送订阅不可用；系统通知由页面内的通知接口直接展示。' };
    }
    const registration = registrations[0];
    if (registration === undefined || registration.pushManager === undefined) {
      return { supported: false, reason: '已注册的 Service Worker 没有推送管理器，浏览器推送订阅不可用。' };
    }
    return { supported: true };
  }

  /**
   * 建立浏览器推送订阅。
   *
   * 订阅需要宿主下发的 VAPID 公钥，这个接口还没有出现在通知路由里，因此这里如实报告缺少
   * 的前置条件；拿到公钥的安装版客户端复用同一条路径。
   * @returns 订阅材料或不能建立的原因。
   */
  async subscribe(): Promise<SubscribeResult> {
    const support = await this.subscriptionSupport();
    if (!support.supported) return { ok: false, reason: support.reason ?? '当前环境不支持浏览器推送订阅。' };
    return { ok: false, reason: '宿主还没有下发 VAPID 公钥，浏览器推送订阅需要它；订阅保存的入口继续可用。' };
  }

  /** 撤回一条页面内展示的通知。 */
  private close(tag: string): void {
    const record = this.shown.get(tag);
    if (record === undefined) return;
    record.instance?.close();
    this.shown.delete(tag);
  }

  /** 取一个可以用来展示通知的 Service Worker 登记。 */
  private async registration(): Promise<ServiceWorkerRegistration | undefined> {
    const navigator = this.environment.navigator;
    if (navigator === undefined || navigator.serviceWorker === undefined) return undefined;
    const registrations = await navigator.serviceWorker.getRegistrations();
    return registrations[0];
  }
}

/**
 * 按隐私级别裁剪系统通知的内容。
 * @param input - 通知内容。
 * @param settings - 隐私级别与消息预览开关。
 * @returns 标题与正文。
 */
export function contentOf(input: SystemNotificationInput, settings: SystemNotificationSettings): { title: string; body?: string } {
  const title = `${PRODUCT_NAME} · ${KIND_NAME_OF[input.kind]}`;
  if (settings.privacy === 'type') return { title };
  if (settings.privacy === 'preview' && settings.messagePreview && input.preview !== undefined && input.preview !== '') {
    return { title, body: input.preview };
  }
  const body = input.summary !== undefined && input.summary !== '' ? input.summary : undefined;
  return body === undefined ? { title } : { title, body };
}

/** 系统通知标题里的事件类型名称。 */
const KIND_NAME_OF: Readonly<Record<NotificationKind, string>> = {
  approval: '审批请求',
  question: '提问',
  'run-finished': '执行完成',
  'run-failed': '执行失败',
  automation: '自动化',
  share: '分享',
  device: '设备',
  system: '系统',
};
