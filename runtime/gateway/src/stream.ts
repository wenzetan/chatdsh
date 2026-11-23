/**
 * 控制平面 SSE 通知事件编码。
 *
 * 通知下发走 SSE 长连接，事件形状与编码在本文件统一声明，推送中枢与通知模块共用。
 * @module @chatdsh/gateway/stream
 */

import type { ServerResponse } from 'node:http';

/** 通知投递节奏的取值，与通知设置里的枚举一致。 */
export type PushEventMode = 'all-at-once' | 'two-stage';

/**
 * 推送事件里的一条通知。
 *
 * 字段按隐私级别裁剪之后才出现在这里：摘要只在摘要级别出现，命令与消息原文只在预览
 * 级别出现。这里的取值就是客户端与系统通知能看到的内容。
 */
export interface PushEventNotification {
  /** 通知标识。 */
  readonly id: string;
  /** 通知种类。 */
  readonly kind: string;
  /** 展示标题。 */
  readonly title: string;
  /** 摘要；隐私级别为仅类型时缺省。 */
  readonly summary?: string;
  /** 命令或消息原文；只有预览级别且开启消息预览时才有值。 */
  readonly preview?: string;
  /** 关联设备。 */
  readonly deviceId?: string;
  /** 关联会话；隐私级别为仅类型时缺省。 */
  readonly sessionId?: string;
  /** 关联对象的稳定标识。 */
  readonly objectId?: string;
  /** 系统通知使用的稳定 tag。 */
  readonly tag?: string;
  /** 事件发生时刻的毫秒时间戳。 */
  readonly createdAt: number;
  /** 已读时刻；未读时缺省。 */
  readonly readAt?: number;
  /** 已处理时刻；未处理时缺省。 */
  readonly handledAt?: number;
  /** 是否可撤回。 */
  readonly revocable: boolean;
}

/** 控制平面通过事件流下发的事件。 */
export type PushEvent =
  | {
    /** 一批通知。 */
    readonly kind: 'notification';
    /** 这一批的通知，顺序与通知中心一致。 */
    readonly items: readonly PushEventNotification[];
    /** 这一批的条数，与 `items` 等长。 */
    readonly count: number;
    /** 投递阶段：0 为实时，1 为第一阶段，2 为第二阶段。 */
    readonly stage: number;
    /** 生成这一批时生效的投递节奏。 */
    readonly mode: PushEventMode;
  }
  | {
    /** 已读状态变化，供其他客户端同步未读数。 */
    readonly kind: 'notification-read';
    /** 本次标记的通知标识。 */
    readonly ids: readonly string[];
    /** 标记已读的访问客户端。 */
    readonly clientId: string;
    /** 标记已读的访问客户端所在设备。 */
    readonly deviceId?: string;
    /** 标记时刻的毫秒时间戳。 */
    readonly readAt: number;
    /** 标记之后的未读条数。 */
    readonly unread: number;
  }
  | {
    /** 业务已处理，与已读分开记录。 */
    readonly kind: 'notification-handled';
    /** 本次标记为已处理的通知标识。 */
    readonly ids: readonly string[];
    /** 处理时刻的毫秒时间戳。 */
    readonly handledAt: number;
  }
  | {
    /** 撤回通知：审批决定之后待投递的与已展示的系统通知都要关闭。 */
    readonly kind: 'notification-withdraw';
    /** 被撤回的通知标识。 */
    readonly ids: readonly string[];
    /** 被撤回通知的稳定 tag，客户端按它关闭已展示的系统通知。 */
    readonly tags: readonly string[];
    /** 关联会话。 */
    readonly sessionId?: string;
    /** 关联对象的稳定标识，审批场景里是工具调用标识。 */
    readonly objectId?: string;
    /** 撤回时刻的毫秒时间戳。 */
    readonly at: number;
  };

/**
 * 把推送事件编码成 SSE 数据部分。
 * @param event - 要下发的事件。
 * @returns 可直接写在 `data: ` 之后的 JSON。
 */
export function encodePushEvent(event: PushEvent): string {
  return JSON.stringify(event);
}

/**
 * 写一帧推送事件。
 *
 * 连接已经断开时返回假，调用方据此把连接从在线表里摘除。
 * @param response - 订阅连接的响应。
 * @param event - 要下发的事件。
 * @returns 写入成功为真。
 */
export function writePushEvent(response: ServerResponse, event: PushEvent): boolean {
  try {
    response.write(`data: ${encodePushEvent(event)}\n\n`);
    return true;
  } catch {
    return false;
  }
}
