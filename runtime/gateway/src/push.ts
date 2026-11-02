/**
 * 推送中枢：设备订阅、分级投递与离线补发。
 *
 * 设备用 SSE 长连接订阅（`GET /chatdsh/gateway/events`），中枢维护在线连接。单账号下
 * 「账号的全部在线设备」就是「全部在线设备」，因此连接表只有一份。
 * 分级规则见架构文档的通知一节：`all-at-once` 立即投给全部在线设备；`two-stage` 先投
 * 最近活跃的一台，超过阈值仍未处理再投给全部在线设备。没有在线设备时通知落进离线队列，
 * 设备重连时按顺序补发。通知只带结果类别与会话标识，不带会话内容。
 *
 * 通知模块接入之后，业务事件里的通知类载荷交给通知模块生成记录并按其设置投递，中枢负责
 * 在线广播、最近活跃设备的判定与审批同键撤回的转发。已读同步与撤回事件同样在这里广播。
 * @module @chatdsh/gateway/push
 */

import type { ServerResponse } from 'node:http';
import type { ChatdshTelemetry, TelemetrySpan } from '@chatdsh/core-contracts';
import type { DeviceRecord, PushQueue } from './store.ts';
import { intentOf, type NotificationIntent } from './notifications/intents.ts';
import { encodePushEvent, type PushEvent } from './stream.ts';

/** 通知的分级方式。 */
export type PushMode = 'all-at-once' | 'two-stage';

/** 在线的订阅连接。 */
interface Connection {
  /** 连接实例标识：同一设备的多个连接也能区分，用于记录第一段的投递目标。 */
  readonly id: string;
  readonly deviceId: string;
  readonly platform: string;
  readonly response: ServerResponse;
  readonly since: number;
}

/** 投递结果。 */
export interface DeliveryResult {
  /** 收到推送的在线设备数。 */
  readonly delivered: number;
  /** 是否还有通知在队列里等升级或补发。 */
  readonly queued: boolean;
}

/** 中枢向通知模块转交的两个动作。 */
export interface NotificationSink {
  /** 从业务事件生成通知记录并按设置投递。 */
  publish(intent: NotificationIntent): DeliveryResult;
  /** 审批终结时撤回同键的可撤回通知，返回撤回条数。 */
  withdrawApproval(sessionId: string, callId: string): number;
}

/** 中枢的遥测面；只有计数器时也能工作。 */
export type PushTelemetry = Pick<ChatdshTelemetry, 'counter'>
  & Partial<Pick<ChatdshTelemetry, 'event' | 'startSpan' | 'runSpanSync'>>;

/** 记录一次投递的遥测。 */
function recordDelivery(options: PushHubOptions, delivered: number, queued: boolean, mode: PushMode): void {
  const telemetry = options.telemetry;
  if (telemetry === undefined) return;
  telemetry.counter('chatdsh_push_deliveries_total', { description: '推送投递次数' })
    .add(Math.max(delivered, 0), {
      device_kind: queued ? 'offline' : 'online',
      outcome: delivered > 0 ? 'delivered' : 'queued',
    });
  void mode;
}

/** 推送中枢。 */
export interface PushHub {
  /** 登记一个订阅连接，返回注销函数。 */
  subscribe(deviceId: string, platform: string, response: ServerResponse, origin?: string): () => void;
  /** 投递一条通知，按分级规则选择目标设备。 */
  deliver(payload: string, sessionId?: string): DeliveryResult;
  /** 撤回尚未投递、同一会话同一关联键的审批提醒，返回撤回条数。 */
  withdraw(sessionId: string, callId: string): number;
  /** 当前的在线设备数。 */
  onlineDevices(): number;
  /** 当前的在线设备标识，按连接建立顺序。 */
  deviceIds(): string[];
  /** 最近活跃的在线设备；没有连接时缺省。 */
  activeDevice(): string | undefined;
  /** 立即把一条事件写给在线连接，不进离线队列；返回写入成功的连接数。 */
  broadcast(event: PushEvent, devices?: readonly string[]): number;
  /** 接入通知模块；接入之后通知类载荷交给它处理。 */
  attachNotifications(sink: NotificationSink): void;
  /** 取出离线队列里等待补发的通知，按条标记为已投递。 */
  drain(): string[];
  /** 把到了升级时刻的第一段通知推给全部在线设备，返回处理条数。 */
  escalateDue(now: number): number;
  /** 开始按间隔扫描升级时刻。 */
  start(): void;
  /** 停止扫描。 */
  stop(): void;
}

/** 设备表的写入面。 */
export interface DeviceRegistry {
  touchDevice(record: DeviceRecord): void;
}

/** 中枢构造输入。 */
export interface PushHubOptions {
  readonly queue: PushQueue;
  readonly devices: DeviceRegistry;
  readonly mode: PushMode;
  readonly escalationMs: number;
  /** 扫描升级时刻的间隔；缺省两秒。 */
  readonly sweepIntervalMs?: number;
  /** 遥测面；缺省时只做投递，不记信号。 */
  readonly telemetry?: PushTelemetry;
}

/**
 * 建立推送中枢。
 * @param options - 队列、设备表、分级方式与升级阈值。
 * @returns 推送中枢。
 */
export function createPushHub(options: PushHubOptions): PushHub {
  const { queue, devices, mode, escalationMs, sweepIntervalMs = 2000 } = options;
  const connections = new Set<Connection>();
  let connectionSeq = 0;
  let timer: NodeJS.Timeout | undefined;
  let notifications: NotificationSink | undefined;

  function write(connection: Connection, payload: string): boolean {
    try {
      connection.response.write(`data: ${payload}\n\n`);
      return true;
    } catch {
      return false;
    }
  }

  function escalateNow(now: number): number {
    const due = queue.escalateDue(now);
    if (due.length === 0) return 0;
    let handled = 0;
    for (const item of due) {
      for (const connection of [...connections]) {
        // 第一段已经收到这条通知的连接不再重复投递。
        if (item.deviceId !== undefined && connection.id === item.deviceId) continue;
        if (!write(connection, item.payload)) connections.delete(connection);
      }
      queue.markDelivered([item.id]);
      handled += 1;
    }
    return handled;
  }

  /** 按设备标识取在线连接。 */
  function connectionsOf(deviceId: string): Connection[] {
    return [...connections].filter((connection) => connection.deviceId === deviceId);
  }

  return {
    subscribe(deviceId: string, platform: string, response: ServerResponse, origin = 'sse'): () => void {
      connectionSeq += 1;
      const connection: Connection = { id: `c${connectionSeq}`, deviceId, platform, response, since: Date.now() };
      connections.add(connection);
      devices.touchDevice({ id: deviceId, origin, platform, lastSeenAt: connection.since });
      return () => {
        connections.delete(connection);
      };
    },

    deliver(payload: string, sessionId?: string): DeliveryResult {
      void sessionId;
      const telemetry = options.telemetry;
      const intent = intentOf(payload);
      if (intent !== undefined && notifications !== undefined) {
        const result = notifications.publish(intent);
        telemetry?.counter('chatdsh_push_deliveries_total', { description: '推送投递次数' })
          .add(Math.max(result.delivered, 0), {
            device_kind: result.queued ? 'offline' : 'online',
            outcome: result.delivered > 0 ? 'delivered' : 'queued',
          });
        return result;
      }
      const run = (span?: TelemetrySpan): DeliveryResult => {
        if (connections.size === 0) {
          queue.enqueue(payload);
          recordDelivery(options, 0, true, mode);
          span?.setAttribute('device.kind', 'offline');
          span?.setAttribute('outcome', 'queued');
          return { delivered: 0, queued: true };
        }
        const targets = [...connections];
        if (mode === 'all-at-once' || targets.length === 1) {
          let delivered = 0;
          for (const connection of targets) {
            if (write(connection, payload)) delivered += 1;
            else connections.delete(connection);
          }
          if (delivered === 0) {
            queue.enqueue(payload);
            recordDelivery(options, 0, true, mode);
            span?.setAttribute('device.kind', 'offline');
            span?.setAttribute('outcome', 'queued');
            return { delivered: 0, queued: true };
          }
          recordDelivery(options, delivered, false, mode);
          span?.setAttribute('device.kind', 'online');
          span?.setAttribute('outcome', 'delivered');
          return { delivered, queued: false };
        }

        // 两段式：先投最近活跃的一台，其余等阈值到期再投。
        const mostRecent = targets.reduce((best, current) => current.since > best.since ? current : best);
        const firstDelivered = write(mostRecent, payload);
        if (!firstDelivered) connections.delete(mostRecent);
        const escalateAt = Date.now() + escalationMs;
        // 记下第一段的投递目标（连接实例），升级时跳过它，避免同一台设备收到两次。
        queue.enqueue(payload, { deviceId: mostRecent.id, stage: 1, escalateAt });
        recordDelivery(options, firstDelivered ? 1 : 0, true, mode);
        span?.setAttribute('device.kind', 'online');
        span?.setAttribute('outcome', firstDelivered ? 'first-stage' : 'queued');
        return { delivered: firstDelivered ? 1 : 0, queued: true };
      };

      if (telemetry?.runSpanSync === undefined) return run();
      return telemetry.runSpanSync('chatdsh.gateway.push.deliver', { 'device.kind': 'unknown', outcome: 'pending' }, run);
    },

    withdraw(sessionId: string, callId: string): number {
      const queued = queue.withdraw(sessionId, callId);
      const revoked = notifications === undefined ? 0 : notifications.withdrawApproval(sessionId, callId);
      return queued + revoked;
    },

    onlineDevices(): number {
      return connections.size;
    },

    deviceIds(): string[] {
      const seen: string[] = [];
      for (const connection of connections) {
        if (!seen.includes(connection.deviceId)) seen.push(connection.deviceId);
      }
      return seen;
    },

    activeDevice(): string | undefined {
      let best: Connection | undefined;
      for (const connection of connections) {
        if (best === undefined || connection.since > best.since) best = connection;
      }
      return best?.deviceId;
    },

    broadcast(event: PushEvent, targets?: readonly string[]): number {
      const payload = encodePushEvent(event);
      const pool = targets === undefined
        ? [...connections]
        : targets.flatMap((deviceId) => connectionsOf(deviceId));
      let written = 0;
      for (const connection of pool) {
        if (write(connection, payload)) written += 1;
        else connections.delete(connection);
      }
      return written;
    },

    attachNotifications(sink: NotificationSink): void {
      notifications = sink;
    },

    drain(): string[] {
      const items = queue.pending();
      if (items.length === 0) return [];
      queue.markDelivered(items.map((item) => item.id));
      return items.map((item) => item.payload);
    },

    escalateDue(now: number): number {
      return escalateNow(now);
    },

    start(): void {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        escalateNow(Date.now());
      }, sweepIntervalMs);
      timer.unref();
    },

    stop(): void {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    },
  };
}
