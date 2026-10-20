/**
 * 推送中枢：设备订阅、分级投递与离线补发。
 *
 * 设备用 SSE 长连接订阅（`GET /chatdsh/gateway/events`），中枢按账号维护在线连接。
 * 分级规则见架构文档的通知一节：`all-at-once` 立即投给全部在线设备；`two-stage` 先投
 * 最近活跃的一台，超过阈值仍未处理再投给全部在线设备。没有在线设备时通知落进离线队列，
 * 设备重连时按顺序补发。通知只带结果类别与会话标识，不带会话内容。
 * @module @chatdsh/gateway/push
 */

import type { ServerResponse } from 'node:http';
import type { DeviceRecord, PushQueue } from './store.ts';

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
  subscribe(accountId: string, deviceId: string, platform: string, response: ServerResponse): () => void;
  /** 向账号投递一条通知，按分级规则选择目标设备。 */
  deliver(accountId: string, payload: string, sessionId?: string): DeliveryResult;
  /** 账号当前的在线设备数。 */
  onlineDevices(accountId: string): number;
  /** 取出离线队列里等待补发的通知，按条标记为已投递。 */
  drain(accountId: string): string[];
  /** 把到了升级时刻的第一段通知推给全部在线设备，返回处理条数。 */
  escalateDue(now: number): number;
}

/** 设备表的读写面。 */
export interface DeviceRegistry {
  touchDevice(record: DeviceRecord): void;
  listDevices(accountId: string): DeviceRecord[];
}

/** 中枢构造输入。 */
export interface PushHubOptions {
  readonly queue: PushQueue;
  readonly devices: DeviceRegistry;
  readonly mode: PushMode;
  readonly escalationMs: number;
  /** 遥测面；缺省时只做投递，不记信号。 */
  readonly telemetry?: {
    counter(name: string, options: { description: string }): { add(value: number, attributes?: Record<string, unknown>): void };
  };
}

/**
 * 建立推送中枢。
 * @param options - 队列、设备表、分级方式与升级阈值。
 * @returns 推送中枢。
 */
export function createPushHub(options: PushHubOptions): PushHub {
  const { queue, devices, mode, escalationMs } = options;
  const connections = new Map<string, Set<Connection>>();
  let connectionSeq = 0;

  function online(accountId: string): Set<Connection> | undefined {
    return connections.get(accountId);
  }

  function write(connection: Connection, payload: string): boolean {
    try {
      connection.response.write(`data: ${payload}\n\n`);
      return true;
    } catch {
      return false;
    }
  }

  return {
    subscribe(accountId: string, deviceId: string, platform: string, response: ServerResponse): () => void {
      connectionSeq += 1;
      const connection: Connection = { id: `c${connectionSeq}`, deviceId, platform, response, since: Date.now() };
      const set = online(accountId) ?? new Set<Connection>();
      set.add(connection);
      connections.set(accountId, set);
      devices.touchDevice({ id: deviceId, accountId, origin: 'sse', platform, lastSeenAt: connection.since });
      return () => {
        set.delete(connection);
        if (set.size === 0) connections.delete(accountId);
      };
    },

    deliver(accountId: string, payload: string, sessionId?: string): DeliveryResult {
      void sessionId;
      const set = online(accountId);
      if (set === undefined || set.size === 0) {
        queue.enqueue(accountId, payload);
        recordDelivery(options, 0, true, mode);
        return { delivered: 0, queued: true };
      }
      const targets = [...set];
      if (mode === 'all-at-once' || targets.length === 1) {
        let delivered = 0;
        for (const connection of targets) {
          if (write(connection, payload)) delivered += 1;
          else set.delete(connection);
        }
        if (delivered === 0) {
          queue.enqueue(accountId, payload);
          recordDelivery(options, 0, true, mode);
          return { delivered: 0, queued: true };
        }
        recordDelivery(options, delivered, false, mode);
        return { delivered, queued: false };
      }

      // 两段式：先投最近活跃的一台，其余等阈值到期再投。
      const mostRecent = targets.reduce((best, current) => current.since > best.since ? current : best);
      const firstDelivered = write(mostRecent, payload);
      if (!firstDelivered) set.delete(mostRecent);
      const escalateAt = Date.now() + escalationMs;
      // 记下第一段的投递目标（连接实例），升级时跳过它，避免同一台设备收到两次。
      queue.enqueue(accountId, payload, { deviceId: mostRecent.id, stage: 1, escalateAt });
      recordDelivery(options, firstDelivered ? 1 : 0, true, mode);
      return { delivered: firstDelivered ? 1 : 0, queued: true };
    },

    onlineDevices(accountId: string): number {
      return online(accountId)?.size ?? 0;
    },

    drain(accountId: string): string[] {
      const items = queue.pending(accountId);
      if (items.length === 0) return [];
      queue.markDelivered(items.map((item) => item.id));
      return items.map((item) => item.payload);
    },

    escalateDue(now: number): number {
      const due = queue.escalateDue(now);
      if (due.length === 0) return 0;
      let handled = 0;
      for (const item of due) {
        const set = online(item.accountId);
        if (set !== undefined) {
          for (const connection of [...set]) {
            // 第一段已经收到这条通知的连接不再重复投递。
            if (item.deviceId !== undefined && connection.id === item.deviceId) continue;
            if (!write(connection, item.payload)) set.delete(connection);
          }
        }
        queue.markDelivered([item.id]);
        handled += 1;
      }
      return handled;
    },
  };
}
