/**
 * 通知投递：两种节奏、阈值、去重与合并抑制。
 *
 * `all-at-once` 立即投给全部在线设备与全部有效订阅；`two-stage` 先把通知挂进按会话聚合的
 * 批次，第一阶段阈值到期后投给最近活跃的设备，第二阶段阈值到期后投给其余设备。批次把同一
 * 窗口内的多条通知合并成一批，去重键在抑制窗口内重复出现时只保留第一条记录。
 *
 * 投递前再次判断通知是否还需要下发：已读、已处理与已撤回的通知不再投递，这条规则同时
 * 保证审批决定之后重连不再补发。
 * @module @chatdsh/gateway/notifications/delivery
 */

import type { ChatdshTelemetry, TelemetryAttributes, TelemetrySpan } from '@chatdsh/core-contracts';
import { CHATDSH_ERROR_CODES } from '@chatdsh/core-contracts';
import type { DeliveryResult } from '../push.ts';
import type { PushEvent, PushEventMode, PushEventNotification } from '../stream.ts';
import type { NotificationIntent } from './intents.ts';
import { contentOf } from './privacy.ts';
import {
  NotificationStore,
  type NotificationRow,
  type ReadResult,
  type SubscriptionRecord,
} from './records.ts';
import { MAX_PAYLOAD_BYTES, sendWebPush, type VapidKeys, type WebPushOutcome } from './web-push.ts';

/** 通知模块向推送中枢要求的在线广播与设备查询。 */
export interface BroadcastTarget {
  /** 立即把一条事件写给在线连接，可按设备过滤；返回写入成功的连接数。 */
  broadcast(event: PushEvent, devices?: readonly string[]): number;
  /** 最近活跃的在线设备。 */
  activeDevice(): string | undefined;
  /** 当前的在线设备标识。 */
  deviceIds(): string[];
}

/** 投递模块的遥测面。 */
export type DeliveryTelemetry = Pick<ChatdshTelemetry, 'counter'>
  & Partial<Pick<ChatdshTelemetry, 'event' | 'startSpan' | 'runSpanSync'>>;

/** 投递模块的构造输入。 */
export interface NotificationDeliveryOptions {
  /** 通知记录存储。 */
  readonly store: NotificationStore;
  /** 在线广播面。 */
  readonly hub: BroadcastTarget;
  /** 遥测面。 */
  readonly telemetry: DeliveryTelemetry;
  /** 推送服务保留时长，单位秒；缺省一小时。 */
  readonly ttlSeconds?: number;
  /** 单次推送的超时，单位毫秒；缺省十秒。 */
  readonly timeoutMs?: number;
  /** 同一去重键的抑制窗口，单位毫秒；缺省三十秒。 */
  readonly suppressMs?: number;
  /** 扫描批次的间隔，单位毫秒；缺省一秒。 */
  readonly sweepIntervalMs?: number;
  /** 当前时刻的毫秒时间戳，用于测试替换。 */
  readonly now?: () => number;
  /** 发送实现；缺省用全局 `fetch`。 */
  readonly send?: typeof fetch;
}

/** 通知投递。 */
export interface NotificationDelivery {
  /** 从通知意图生成记录并按设置投递。 */
  publish(intent: NotificationIntent): DeliveryResult;
  /** 标记已读并广播已读变化。 */
  read(ids: readonly string[], clientId: string, deviceId: string | undefined): ReadResult;
  /** 推进到期的批次，返回处理的批次数。 */
  dispatchDue(now: number): Promise<number>;
  /** 撤回同键的审批通知并广播撤回事件。 */
  withdrawApproval(sessionId: string, callId: string): number;
  /** 开始扫描批次。 */
  start(): void;
  /** 停止扫描。 */
  stop(): void;
  /** 等待所有在途推送结束。 */
  settled(): Promise<void>;
  /** 向一条订阅发送一条原始载荷，返回投递结果；验证通知用。 */
  sendRaw(subscription: SubscriptionRecord, payload: string): Promise<WebPushOutcome>;
  /** 标记业务已处理并广播已处理变化，返回实际写入的条数。 */
  markHandled(ids: readonly string[]): number;
}

/** 把一个种类判定为是否投递。 */
function dispatchable(kind: string, settings: { readonly onApproval: boolean; readonly onTurnEnd: boolean }): boolean {
  if (kind === 'approval' || kind === 'question') return settings.onApproval;
  if (kind === 'run-finished' || kind === 'run-failed') return settings.onTurnEnd;
  return true;
}

/** 状态码的分类，用于有界指标属性。 */
function statusClass(status: number): string {
  return status === 0 ? 'none' : `${Math.floor(status / 100)}xx`;
}

/**
 * 建立通知投递。
 * @param options - 存储、广播面、遥测与阈值参数。
 * @returns 通知投递。
 */
export function createNotificationDelivery(options: NotificationDeliveryOptions): NotificationDelivery {
  const { store, hub, telemetry } = options;
  const ttlSeconds = options.ttlSeconds ?? 3600;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const suppressMs = options.suppressMs ?? 30_000;
  const sweepIntervalMs = options.sweepIntervalMs ?? 1000;
  const now = options.now ?? (() => Date.now());
  const send = options.send ?? fetch;
  const inFlight = new Set<Promise<unknown>>();
  let timer: NodeJS.Timeout | undefined;

  /** 组装一批通知的下发事件。 */
  function eventOf(rows: readonly NotificationRow[], stage: number, mode: PushEventMode): PushEvent {
    const settings = store.settings();
    const items: PushEventNotification[] = rows.map((row) => {
      const content = contentOf(row, settings.privacy, settings.messagePreview);
      return {
        id: row.id,
        kind: row.kind,
        title: content.title,
        summary: content.summary,
        ...(content.preview === undefined ? {} : { preview: content.preview }),
        ...(content.sessionId === undefined ? {} : { sessionId: content.sessionId }),
        ...(content.objectId === undefined ? {} : { objectId: content.objectId }),
        ...(row.deviceId === undefined ? {} : { deviceId: row.deviceId }),
        ...(row.tag === undefined ? {} : { tag: row.tag }),
        createdAt: row.createdAt,
        ...(row.handledAt === undefined ? {} : { handledAt: row.handledAt }),
        revocable: row.revocable,
      };
    });
    return { kind: 'notification', items, count: items.length, stage, mode };
  }

  /** 候选设备：在线连接与有效订阅涉及的全部设备。 */
  function deviceCandidates(): string[] {
    const devices = [...hub.deviceIds()];
    for (const subscription of store.activeSubscriptions()) {
      if (!devices.includes(subscription.deviceId)) devices.push(subscription.deviceId);
    }
    return devices;
  }

  /** 向一条订阅发送推送，并把结果记进订阅状态。 */
  function transmit(subscription: SubscriptionRecord, payload: string, vapid: VapidKeys): Promise<WebPushOutcome> {
    const span = telemetry.startSpan?.('chatdsh.push.send', {
      outcome: 'pending',
      'http.status_code': 0,
    });
    const promise = (async (): Promise<WebPushOutcome> => {
      let outcome: WebPushOutcome;
      try {
        outcome = await sendWebPush({
          target: subscription,
          payload,
          vapid,
          ttlSeconds,
          timeoutMs,
          now: now(),
          send,
        });
      } catch (error) {
        // 网络失败是投递结果的一种，按失败记录，不改变控制流。
        outcome = { status: 0, outcome: 'failed', code: CHATDSH_ERROR_CODES.internalError };
        span?.setAttribute('error.type', error instanceof Error ? error.name : 'Unknown');
        span?.recordException(error);
      }
      span?.setAttribute('http.status_code', outcome.status);
      span?.setAttribute('outcome', outcome.outcome);
      if (outcome.code !== undefined) span?.setAttribute('error.code', outcome.code);
      span?.end();
      telemetry.counter('chatdsh_push_sends_total', { description: 'Web Push 发送结果' })
        .add(1, { outcome: outcome.outcome, status_class: statusClass(outcome.status) });
      if (outcome.outcome === 'accepted') return outcome;
      if (outcome.outcome === 'gone') {
        store.setSubscriptionState(subscription.id, 'gone', CHATDSH_ERROR_CODES.pushEndpointGone, now());
        telemetry.counter('chatdsh_push_subscriptions_total', { description: '推送订阅状态变化' })
          .add(1, { action: 'gone', outcome: 'expired' });
      } else {
        store.setSubscriptionState(subscription.id, subscription.state, outcome.code, now());
      }
      telemetry.event?.('chatdsh.gateway.push.failed', {
        outcome: outcome.outcome,
        'http.status_code': outcome.status,
        'error.type': 'push',
        ...(outcome.code === undefined ? {} : { 'error.code': outcome.code }),
        deviceId: subscription.deviceId,
      });
      return outcome;
    })();
    inFlight.add(promise);
    void promise.finally(() => inFlight.delete(promise));
    return promise;
  }

  /**
   * 把一组通知切成若干条能放进一条推送事件的分组。
   *
   * 推送服务的载荷上限是 4096 字节，批次过大时按编码之后的长度切分，避免一条超限载荷
   * 让整批通知都发不出去。
   * @param rows - 待投递的通知。
   * @param stage - 投递阶段。
   * @param mode - 投递节奏。
   * @returns 依次下发的事件。
   */
  function chunksOf(rows: readonly NotificationRow[], stage: number, mode: PushEventMode): PushEvent[] {
    const events: PushEvent[] = [];
    let rest = [...rows];
    while (rest.length > 0) {
      let take = rest.length;
      let event = eventOf(rest.slice(0, take), stage, mode);
      while (take > 1 && Buffer.byteLength(JSON.stringify(event), 'utf8') > MAX_PAYLOAD_BYTES) {
        take -= 1;
        event = eventOf(rest.slice(0, take), stage, mode);
      }
      events.push(event);
      rest = rest.slice(take);
    }
    return events;
  }

  /**
   * 把一组通知写到指定设备：事件流立即写，推送逐条发出。
   * @param rows - 待投递的通知。
   * @param batch - 阶段、节奏与目标设备。
   * @returns 写入成功的连接数与在途推送。
   */
  function pushTo(
    rows: readonly NotificationRow[],
    batch: { readonly stage: number; readonly mode: PushEventMode; readonly devices: readonly string[] },
  ): { written: number; sends: Promise<WebPushOutcome>[] } {
    const settings = store.settings();
    let written = 0;
    const sends: Promise<WebPushOutcome>[] = [];
    for (const deviceId of batch.devices) {
      const pending = rows.filter((row) => !store.deliveredDevices(row.id).includes(deviceId));
      if (pending.length === 0) continue;
      const subscriptions = store.activeSubscriptions(deviceId)
        .filter(() => !settings.quietWhenFocused || !pending.some((row) => store.focused(deviceId, row.sessionId)));
      const vapid = subscriptions.length === 0 ? undefined : store.vapidKeys();
      for (const event of chunksOf(pending, batch.stage, batch.mode)) {
        written += hub.broadcast(event, [deviceId]);
        const payload = JSON.stringify(event);
        for (const subscription of subscriptions) sends.push(transmit(subscription, payload, vapid as VapidKeys));
      }
      for (const row of pending) store.markDelivered(row.id, deviceId, batch.stage, now());
    }
    return { written, sends };
  }

  /** 向一批设备投递一组通知，并等待推送结束。 */
  async function dispatch(
    rows: readonly NotificationRow[],
    batch: { readonly stage: number; readonly mode: PushEventMode; readonly devices?: readonly string[] },
  ): Promise<number> {
    const span = telemetry.startSpan?.('chatdsh.push.dispatch', {
      stage: batch.stage,
      mode: batch.mode,
      count: rows.length,
      outcome: 'pending',
    });
    const open = rows.filter((row) => store.pendingDelivery(row.id));
    if (open.length === 0) {
      span?.setAttribute('outcome', 'suppressed');
      span?.end();
      return 0;
    }
    const result = pushTo(open, { stage: batch.stage, mode: batch.mode, devices: batch.devices ?? deviceCandidates() });
    await Promise.all(result.sends);
    span?.setAttribute('outcome', result.written > 0 ? 'delivered' : 'stored');
    span?.end();
    return result.written;
  }

  /** 按设置安排一次投递。 */
  function schedule(row: NotificationRow, span?: TelemetrySpan): DeliveryResult {
    const settings = store.settings();
    if (!dispatchable(row.kind, settings)) {
      span?.setAttribute('outcome', 'muted');
      return { delivered: 0, queued: false };
    }
    if (settings.deliveryMode === 'all-at-once') {
      const dispatchSpan = telemetry.startSpan?.('chatdsh.push.dispatch', {
        stage: 0,
        mode: 'all-at-once',
        count: 1,
        outcome: 'pending',
      });
      const result = pushTo([row], { stage: 0, mode: 'all-at-once', devices: deviceCandidates() });
      for (const sending of result.sends) {
        inFlight.add(sending);
        void sending.finally(() => inFlight.delete(sending));
      }
      dispatchSpan?.setAttribute('outcome', result.written > 0 ? 'delivered' : 'stored');
      dispatchSpan?.end();
      span?.setAttribute('outcome', 'dispatched');
      return { delivered: result.written, queued: false };
    }
    const scope = row.sessionId ?? 'all';
    store.attachToBatch(scope, row.id, now() + settings.firstStageSeconds * 1000, now());
    span?.setAttribute('outcome', 'batched');
    return { delivered: 0, queued: true };
  }

  return {
    publish(intent: NotificationIntent): DeliveryResult {
      const run = (span?: TelemetrySpan): DeliveryResult => {
        const timestamp = now();
        // 去重只对带稳定关联对象的通知生效：同一审批或同一系统通知重复上报只留一条。
        const identifiable = intent.objectId !== undefined || intent.tag !== undefined;
        const existing = identifiable ? store.latestByDedupe(intent.dedupeKey, timestamp - suppressMs) : undefined;
        if (existing !== undefined && existing.revokedAt === undefined) {
          telemetry.counter('chatdsh_gateway_notifications_total', { description: '通知记录写入与撤回' })
            .add(1, { action: 'collapsed', outcome: 'suppressed' });
          span?.setAttribute('outcome', 'collapsed');
          return { delivered: 0, queued: false };
        }
        const row = store.record({ ...intent, createdAt: timestamp });
        telemetry.counter('chatdsh_gateway_notifications_total', { description: '通知记录写入与撤回' })
          .add(1, { action: 'recorded', outcome: 'ok' });
        span?.setAttribute('kind', row.kind);
        if (row.sessionId !== undefined) span?.setAttribute('session.id', row.sessionId);
        const result = schedule(row, span);
        span?.setAttribute('outcome', result.queued ? 'queued' : 'dispatched');
        return result;
      };
      const attributes: TelemetryAttributes = { kind: intent.kind, outcome: 'pending' };
      if (telemetry.runSpanSync === undefined) return run();
      return telemetry.runSpanSync('chatdsh.gateway.notification.record', attributes, run);
    },

    read(ids: readonly string[], clientId: string, deviceId: string | undefined): ReadResult {
      const timestamp = now();
      const result = store.markRead(ids, clientId, deviceId, timestamp);
      if (result.marked > 0) {
        hub.broadcast({
          kind: 'notification-read',
          ids,
          clientId,
          ...(deviceId === undefined ? {} : { deviceId }),
          readAt: timestamp,
          unread: store.countUnread({}),
        });
      }
      return result;
    },

    async dispatchDue(timestamp: number): Promise<number> {
      const batches = store.dueBatches(timestamp);
      let handled = 0;
      for (const batch of batches) {
        const rows: NotificationRow[] = [];
        for (const id of batch.notificationIds) {
          const row = store.byId(id);
          if (row !== undefined) rows.push(row);
        }
        const settings = store.settings();
        if (batch.stage === 1) {
          const active = hub.activeDevice();
          await dispatch(rows, { stage: 1, mode: 'two-stage', devices: active === undefined ? [] : [active] });
          store.advanceBatch(batch.scope, 2, timestamp + settings.secondStageSeconds * 1000);
        } else {
          await dispatch(rows, { stage: 2, mode: 'two-stage' });
          store.closeBatch(batch.scope);
        }
        handled += 1;
      }
      return handled;
    },

    withdrawApproval(sessionId: string, callId: string): number {
      const timestamp = now();
      const withdrawn = store.withdrawApproval({ sessionId, callId, now: timestamp });
      if (withdrawn.ids.length === 0) return 0;
      hub.broadcast({
        kind: 'notification-withdraw',
        ids: withdrawn.ids,
        tags: withdrawn.tags,
        sessionId,
        objectId: callId,
        at: timestamp,
      });
      telemetry.counter('chatdsh_gateway_notifications_total', { description: '通知记录写入与撤回' })
        .add(withdrawn.ids.length, { action: 'withdrawn', outcome: 'ok' });
      telemetry.event?.('chatdsh.gateway.push.withdrawn', {
        count: withdrawn.ids.length,
        'session.id': sessionId,
      });
      return withdrawn.ids.length;
    },

    start(): void {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        void this.dispatchDue(now());
      }, sweepIntervalMs);
      timer.unref();
    },

    stop(): void {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    },

    async settled(): Promise<void> {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },

    sendRaw(subscription: SubscriptionRecord, payload: string): Promise<WebPushOutcome> {
      return transmit(subscription, payload, store.vapidKeys());
    },

    markHandled(ids: readonly string[]): number {
      const timestamp = now();
      const marked = store.markHandled(ids, timestamp);
      if (marked === 0) return 0;
      hub.broadcast({ kind: 'notification-handled', ids, handledAt: timestamp });
      telemetry.counter('chatdsh_gateway_notifications_total', { description: '通知记录写入与撤回' })
        .add(marked, { action: 'handled', outcome: 'ok' });
      return marked;
    },
  };
}
