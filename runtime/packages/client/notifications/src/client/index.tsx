/**
 * 通知客户端插件的浏览器入口。
 *
 * 设置页里的区段是完整的通知中心：列表、投递设置、权限与订阅。区段在挂载时建立运行时，
 * 读一次设置并打开控制平面的事件流；客户端标识与设备标识按浏览器本地存储固定下来，
 * 刷新之后仍是同一个访问客户端。
 * @module @chatdsh/client-notifications/client
 */

import { Panel, Skeleton, StatusLine } from '@chatdsh/core-ui-kit';
import { useEffect, useState } from 'react';
import { NotificationsPanel } from './panel.tsx';
import { EVENTS_PATH, NotificationsRuntime } from './runtime.ts';
import type { NavigationTarget } from './types.ts';

/** 席位名。 */
export const SECTION_SLOT = 'settings.section';

/** 区段标识。 */
export const SECTION_ID = 'chatdsh-notifications';

/** 浏览器侧依赖：只等席位服务。 */
export const inject = ['slots'];

/** 访问客户端标识的本地存储键。 */
const CLIENT_ID_KEY = 'chatdsh-notifications.client-id';

/** 设备标识的本地存储键。 */
const DEVICE_ID_KEY = 'chatdsh-notifications.device-id';

/** 席位服务的最小形状。 */
interface ClientSlots {
  inject(key: string, callback: () => () => void): () => void;
  register(spec: { name: string; id?: string; order?: number; label?: () => string; locale?: string }, Component: () => unknown): () => void;
}

/** 客户端根上下文的可用面。 */
interface ClientContext {
  readonly slots: ClientSlots;
}

/**
 * 取一个稳定的浏览器侧标识。
 * @param storage - 存储面。
 * @param key - 键。
 * @param prefix - 新标识的前缀。
 * @returns 标识。
 */
export function stableId(storage: Storage | undefined, key: string, prefix: string): string {
  if (storage === undefined) return `${prefix}-${crypto.randomUUID()}`;
  const existing = storage.getItem(key);
  if (existing !== null && existing !== '') return existing;
  const created = `${prefix}-${crypto.randomUUID()}`;
  storage.setItem(key, created);
  return created;
}

/**
 * 打开关联会话。
 * @param target - 业务目标。
 */
export function openSession(target: NavigationTarget): void {
  window.location.hash = `#/session/${encodeURIComponent(target.sessionId)}`;
}

/** 设置页区段。 */
export function NotificationsSection() {
  const [runtime, setRuntime] = useState<NotificationsRuntime | undefined>(undefined);
  const [focusedSession, setFocusedSession] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  useEffect(function buildRuntime() {
    const storage = typeof window === 'undefined' ? undefined : window.localStorage;
    const created = new NotificationsRuntime({
      clientId: stableId(storage, CLIENT_ID_KEY, 'client'),
      deviceId: stableId(storage, DEVICE_ID_KEY, 'web'),
      navigate: openSession,
    });
    setRuntime(created);
    void created.start().catch((error: unknown) => {
      setFailure(`通知中心启动失败：${error instanceof Error ? error.message : String(error)}。`);
    });
    return () => created.stop();
  }, []);

  /* 跟随地址里的当前会话，供聚焦静默与界面说明使用；只记录在本地，不写宿主。 */
  useEffect(function trackFocus() {
    if (runtime === undefined) return undefined;
    const sync = (): void => {
      const match = /^#\/session\/([^/?#]+)/.exec(window.location.hash);
      const sessionId = match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
      runtime.noteFocus(sessionId);
      setFocusedSession(sessionId);
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, [runtime]);

  if (failure !== undefined) return <StatusLine tone="danger">{failure}</StatusLine>;
  if (runtime === undefined) {
    return (
      <Panel title="通知中心" subtitle="正在读取通知设置">
        <Skeleton rows={3} />
      </Panel>
    );
  }
  return (
    <NotificationsPanel
      center={runtime.center}
      gateway={runtime.gateway}
      notifier={runtime.notifier}
      telemetry={runtime.telemetry}
      {...(focusedSession === undefined ? {} : { focusedSession })}
      onOpenSession={openSession}
    />
  );
}

/**
 * 注册设置页区段。
 * @param ctx - 客户端根上下文。
 */
export async function apply(ctx: ClientContext): Promise<void> {
  ctx.slots.inject(SECTION_SLOT, () => ctx.slots.register({
    name: SECTION_SLOT,
    id: SECTION_ID,
    order: 75,
    label: () => '通知',
    locale: 'chatdsh.notifications',
  }, NotificationsSection));
}

export { EVENTS_PATH };
export { NotificationsPanel, type NotificationsPanelProps } from './panel.tsx';
export { NotificationCenter, type CenterState, type NotificationCenterOptions } from './center.ts';
export { NotificationRequestError, createNotificationGateway, type NotificationGateway, type NotificationGatewayOptions } from './gateway.ts';
export { NotificationsRuntime, pushEventOf, type NotificationsRuntimeOptions } from './runtime.ts';
export {
  PRODUCT_NAME,
  SYSTEM_ACTION_LABELS,
  SystemNotifier,
  contentOf,
  type ShowResult,
  type SubscribeResult,
  type SubscriptionSupport,
  type SystemNotificationInput,
  type SystemNotificationSettings,
  type SystemNotifierOptions,
} from './system.ts';
export { createNotificationTelemetry, type NotificationTelemetry, type NotificationTelemetryOptions } from './telemetry.ts';
export * from './types.ts';
