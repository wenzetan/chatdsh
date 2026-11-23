/**
 * 通知宿主：通知记录、已读、设置、订阅与验证通知的组装。
 *
 * 宿主把存储、投递与路由装在一起，并接入推送中枢：中枢收到业务事件里的通知类载荷之后
 * 交给宿主生成记录并按设置投递，审批决定之后由中枢转发撤回。路由挂在通知中心前缀下，
 * 由控制平面的请求分发在匹配到该前缀时调用。
 * @module @chatdsh/gateway/notifications
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { CHATDSH_ERROR_CODES, type NotificationDeliveryResult, type NotificationProbe, type PushSubscriptionView } from '@chatdsh/core-contracts';
import type { DeliveryResult, NotificationSink, PushHub, PushMode } from '../push.ts';
import { createNotificationDelivery, type DeliveryTelemetry, type NotificationDelivery } from './delivery.ts';
import type { NotificationIntent } from './intents.ts';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  NotificationStore,
  type NotificationInput,
  type NotificationRow,
  type StoredNotificationSettings,
} from './records.ts';
import { handleNotificationRequest, NOTIFICATION_ROUTE_PREFIX } from './routes.ts';
import { PRODUCT_NAME } from './privacy.ts';

/** 订阅保留期，单位毫秒；超过没有更新的订阅标记为过期。 */
export const SUBSCRIPTION_TTL_MS = 30 * 24 * 3600 * 1000;

/** 订阅清理的扫描间隔，单位毫秒。 */
const PRUNE_INTERVAL_MS = 10 * 60 * 1000;

/** 通知宿主的构造输入。 */
export interface NotificationHostOptions {
  /** 控制平面的数据库句柄。 */
  readonly database: DatabaseSync;
  /** 推送中枢。 */
  readonly push: PushHub;
  /** 遥测面。 */
  readonly telemetry: DeliveryTelemetry;
  /** 推送服务保留时长，单位秒。 */
  readonly ttlSeconds?: number;
  /** 默认投递方式；与中继的推送模式一致。 */
  readonly deliveryMode?: PushMode;
  /** 单次推送的超时，单位毫秒。 */
  readonly timeoutMs?: number;
  /** 去重抑制窗口，单位毫秒。 */
  readonly suppressMs?: number;
  /** 批次扫描间隔，单位毫秒。 */
  readonly sweepIntervalMs?: number;
  /** 当前时刻的毫秒时间戳。 */
  readonly now?: () => number;
  /** 发送实现。 */
  readonly send?: typeof fetch;
  /** 订阅保留期，单位毫秒。 */
  readonly subscriptionTtlMs?: number;
}

/** 一次验证通知的结果。 */
export interface ProbeOutcome {
  /** 验证标识，客户端带着它回报实际接收。 */
  readonly id: string;
  /** 服务端受理与客户端实际接收的结果。 */
  readonly probe: NotificationProbe;
}

/** 通知宿主。 */
export interface NotificationHost extends NotificationSink {
  /** 路由前缀。 */
  readonly prefix: string;
  /** 通知记录与订阅存储。 */
  readonly store: NotificationStore;
  /** 通知投递。 */
  readonly delivery: NotificationDelivery;
  /** 处理一个请求；不是通知中心的路径时返回假。 */
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
  /** 读通知中心的一页。 */
  page(query: Parameters<NotificationStore['list']>[0]): ReturnType<NotificationStore['list']>;
  /** 直接写一条通知记录并按设置投递。 */
  publish(intent: NotificationIntent): DeliveryResult;
  /** 写一条只做记录的原始通知，不按投递节奏下发。 */
  record(input: NotificationInput): NotificationRow;
  /** 读设置。 */
  settings(): StoredNotificationSettings;
  /** 读订阅的对外状态。 */
  subscriptionView(deviceId: string): PushSubscriptionView;
  /** 发送一条验证通知。 */
  probe(deviceId: string): Promise<ProbeOutcome>;
  /** 记录验证通知的客户端实际接收。 */
  probeReceipt(probeId: string, receivedAt: number): NotificationProbe;
  /** 清理过期订阅。 */
  cleanupSubscriptions(now?: number): { expired: number; removed: number };
  /** 开始扫描批次与订阅。 */
  start(): void;
  /** 停止扫描。 */
  stop(): void;
  /** 停止扫描并等待在途推送结束。 */
  close(): Promise<void>;
}

/**
 * 建立通知宿主。
 * @param options - 数据库、推送中枢、遥测与阈值参数。
 * @returns 通知宿主。
 */
export function createNotificationHost(options: NotificationHostOptions): NotificationHost {
  const store = new NotificationStore(options.database, {
    ...DEFAULT_NOTIFICATION_SETTINGS,
    ...(options.deliveryMode === undefined ? {} : { deliveryMode: options.deliveryMode }),
  });
  const now = options.now ?? (() => Date.now());
  const subscriptionTtlMs = options.subscriptionTtlMs ?? SUBSCRIPTION_TTL_MS;
  const delivery = createNotificationDelivery({
    store,
    hub: options.push,
    telemetry: options.telemetry,
    ...(options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.suppressMs === undefined ? {} : { suppressMs: options.suppressMs }),
    ...(options.sweepIntervalMs === undefined ? {} : { sweepIntervalMs: options.sweepIntervalMs }),
    now,
    ...(options.send === undefined ? {} : { send: options.send }),
  });
  let pruneTimer: NodeJS.Timeout | undefined;

  /** 读一台设备最新的一条订阅。 */
  function newestSubscription(deviceId: string): (ReturnType<NotificationStore['subscriptions']>[number]) | undefined {
    return store.subscriptions(deviceId)[0];
  }

  const host: NotificationHost = {
    prefix: NOTIFICATION_ROUTE_PREFIX,
    store,
    delivery,

    handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      return handleNotificationRequest(
        { store, delivery, telemetry: options.telemetry, probe: { send: host.probe, receipt: host.probeReceipt }, now },
        request,
        response,
      );
    },

    page(query): ReturnType<NotificationStore['list']> {
      return store.list(query);
    },

    publish(intent: NotificationIntent): DeliveryResult {
      return delivery.publish(intent);
    },

    withdrawApproval(sessionId: string, callId: string): number {
      return delivery.withdrawApproval(sessionId, callId);
    },

    record(input: NotificationInput): NotificationRow {
      return store.record(input);
    },

    settings(): StoredNotificationSettings {
      return store.settings();
    },

    subscriptionView(deviceId: string): PushSubscriptionView {
      const record = newestSubscription(deviceId);
      if (record === undefined) return { state: 'unsubscribed', permission: 'default', updatedAt: now() };
      return {
        state: record.state,
        permission: record.permission,
        updatedAt: record.updatedAt,
        ...(record.code === undefined ? {} : { code: record.code as PushSubscriptionView['code'] }),
      };
    },

    async probe(deviceId: string): Promise<ProbeOutcome> {
      const subscription = store.activeSubscriptions(deviceId)[0];
      const timestamp = now();
      if (subscription === undefined) {
        const id = store.createProbe('none', `probe-${timestamp}`, timestamp);
        store.acceptProbe(id, 'failed', CHATDSH_ERROR_CODES.pushUnsupported, timestamp);
        return { id, probe: store.probe(id) };
      }
      if (subscription.permission === 'denied') {
        const id = store.createProbe(subscription.id, `probe-${timestamp}`, timestamp);
        store.acceptProbe(id, 'failed', CHATDSH_ERROR_CODES.pushPermissionDenied, timestamp);
        return { id, probe: store.probe(id) };
      }
      const tag = `probe-${subscription.id}`;
      const id = store.createProbe(subscription.id, tag, timestamp);
      const payload = JSON.stringify({ kind: 'notification-probe', id, tag, title: PRODUCT_NAME, createdAt: timestamp });
      const outcome = await delivery.sendRaw(subscription, payload);
      const result: NotificationDeliveryResult = outcome.outcome === 'accepted' ? 'accepted' : 'failed';
      store.acceptProbe(id, result === 'accepted' ? 'accepted' : 'failed', outcome.code, now());
      options.telemetry.counter('chatdsh_push_subscriptions_total', { description: '推送订阅状态变化' })
        .add(1, { action: 'probe', outcome: result });
      return { id, probe: store.probe(id) };
    },

    probeReceipt(probeId: string, receivedAt: number): NotificationProbe {
      return store.receiveProbe(probeId, receivedAt);
    },

    cleanupSubscriptions(timestamp?: number): { expired: number; removed: number } {
      const at = timestamp ?? now();
      const result = store.pruneSubscriptions(at, subscriptionTtlMs);
      if (result.expired > 0 || result.removed > 0) {
        options.telemetry.event?.('chatdsh.gateway.push.subscription.expired', {
          count: result.expired,
          outcome: 'expired',
        });
        options.telemetry.counter('chatdsh_push_subscriptions_total', { description: '推送订阅状态变化' })
          .add(result.expired, { action: 'prune', outcome: 'expired' });
        options.telemetry.counter('chatdsh_push_subscriptions_total', { description: '推送订阅状态变化' })
          .add(result.removed, { action: 'prune', outcome: 'removed' });
      }
      return result;
    },

    start(): void {
      delivery.start();
      if (pruneTimer !== undefined) return;
      pruneTimer = setInterval(() => {
        host.cleanupSubscriptions();
      }, PRUNE_INTERVAL_MS);
      pruneTimer.unref();
    },

    stop(): void {
      delivery.stop();
      if (pruneTimer === undefined) return;
      clearInterval(pruneTimer);
      pruneTimer = undefined;
    },

    async close(): Promise<void> {
      host.stop();
      await delivery.settled();
    },
  };

  options.push.attachNotifications(host);
  return host;
}
