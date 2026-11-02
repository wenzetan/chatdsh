/**
 * 设备面板的数据形状。
 *
 * 字段与 `@chatdsh/core-contracts` 的设备契约逐一对应：执行节点带角色、能力与当前执行设备
 * 标记，访问客户端带当前客户端标记，两类都有建立时刻、最近活动与撤销时刻。控制平面只
 * 返回这些字段，节点令牌与它的摘要不出现在任何响应里。
 * @module @chatdsh/client-account/types
 */

/** 执行节点在设备之间承担的位置。 */
export type DeviceRole = 'host' | 'executor' | 'both';

/** 一台已登记的执行节点。 */
export interface Device {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly role: DeviceRole;
  readonly capabilities: readonly string[];
  /** 配对时刻的毫秒时间戳。 */
  readonly createdAt: number;
  /** 最近活动时刻的毫秒时间戳。 */
  readonly lastSeenAt: number;
  readonly online: boolean;
  readonly currentExecutor: boolean;
  /** 已撤销时为撤销时刻。 */
  readonly revokedAt?: number;
}

/** 一台已登记的访问客户端。 */
export interface AccessClient {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly current: boolean;
  readonly revokedAt?: number;
}

/** 设备列表：执行节点与访问客户端分组。 */
export interface DeviceList {
  readonly accessClients: readonly AccessClient[];
  readonly nodes: readonly Device[];
}

/** 一次签发的配对码。 */
export interface PairingCode {
  readonly kind: 'qr' | 'manual';
  /** 控制平面地址，取自控制平面返回值，供新设备核对目标。 */
  readonly controlUrl: string;
  /** 一次性配对码。 */
  readonly code: string;
  readonly expiresAt: number;
  /** 手填载荷：新设备粘贴这份内容即可同时带入地址与配对码。 */
  readonly encoded: string;
}

/** 撤销结果。 */
export interface RevokeResult {
  readonly deviceId: string;
  readonly revokedAt: number;
  /** 撤销时关闭的通道数量。 */
  readonly closedLinks: number;
  /** 历史会话与副本保留。 */
  readonly sessionsPreserved: true;
}

/** 链路检查结果。 */
export interface LinkCheck {
  readonly deviceId: string;
  readonly checkedAt: number;
  readonly reachable: boolean;
  /** 可达时的往返耗时，单位毫秒。 */
  readonly latencyMs?: number;
  /** 不可达原因码。 */
  readonly code?: string;
}

/** 一次读取的三种状态。 */
export type Loadable<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly value: T }
  | { readonly status: 'failed'; readonly error: unknown };

/** 设备面板的界面动作，用于 `chatdsh.client.ui.action` 的 `action` 属性。 */
export type DeviceUiAction = 'device-list' | 'device-pairing-issue' | 'device-link-check' | 'device-revoke';

/** 动作结果。 */
export type ActionOutcome = 'ok' | 'failed';

/** 浏览器侧遥测面。 */
export interface PanelTelemetry {
  /**
   * 包一次远端调用，记录耗时与结果。
   * @param method - 调用名，例如 `devices/list`。
   * @param work - 实际请求。
   * @returns 请求结果。
   */
  run<T>(method: string, work: () => Promise<T>): Promise<T>;
  /**
   * 记录一次界面动作。
   * @param action - 动作名。
   * @param outcome - 动作结果。
   */
  action(action: DeviceUiAction, outcome: ActionOutcome): void;
  /**
   * 记录一次失败。
   * @param error - 失败对象。
   */
  failure(error: unknown): void;
}

/** 设备面板的数据入口。 */
export interface DeviceGateway {
  /** 读取分组的设备列表。 */
  list(): Promise<DeviceList>;
  /**
   * 签发一次性配对码。
   * @param kind - 展示形式。
   */
  issuePairing(kind: 'qr' | 'manual'): Promise<PairingCode>;
  /**
   * 撤销一台设备。
   * @param deviceId - 设备标识。
   * @param reason - 撤销原因。
   */
  revoke(deviceId: string, reason: 'user' | 'lost' | 'rotate'): Promise<RevokeResult>;
  /**
   * 沿执行节点的连接做一次链路检查。
   * @param deviceId - 目标执行节点。
   */
  checkLink(deviceId: string): Promise<LinkCheck>;
  /**
   * 记录一次界面动作。
   * @param action - 动作名。
   * @param outcome - 动作结果。
   */
  noteAction(action: DeviceUiAction, outcome: ActionOutcome): void;
}
