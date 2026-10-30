/**
 * 聚合会话列表：按设备分组的会话清单，左栏用它渲染。
 *
 * 数据来自会话归属表与控制平面的副本存储，不查询设备：设备全部离线时左栏照常列出会话，
 * 只标记设备离线。标题取副本里最新的 `session/title` 事件，副本里没有标题事件时用 `cwd`
 * 的末段。
 * @module @chatdsh/gateway/sessions
 */

import type { GatewayStore, ReplicaStore } from './store.ts';

/** 左栏里的一条会话。 */
export interface SessionSummary {
  readonly sessionId: string;
  readonly title: string;
  /** 最近一次活动的时间：副本里最新事件的时间，没有副本时取归属的创建时间。 */
  readonly updatedAt: number;
  readonly cwd: string;
  /** 工作区显示名，取 `cwd` 的末段；左栏按它跨设备合并同一个仓库的多份检出。 */
  readonly workspaceName: string;
  readonly kind: 'work' | 'chat';
}

/** 左栏里的一台设备与它名下的会话。 */
export interface DeviceSessions {
  readonly deviceId: string;
  readonly name: string;
  readonly platform: string;
  /** 长连接在线状态；离线只影响标记，不影响列表。 */
  readonly online: boolean;
  readonly lastSeenAt: number;
  readonly sessions: readonly SessionSummary[];
}

/** 聚合结果。 */
export interface SessionsSnapshot {
  readonly devices: readonly DeviceSessions[];
}

/** 聚合输入。 */
export interface AggregateSessionsOptions {
  readonly store: GatewayStore;
  readonly replica: ReplicaStore;
  /** 在线判定，由设备长连接表给出。 */
  readonly online: (deviceId: string) => boolean;
}

/**
 * 取 `cwd` 的末段作为标题兜底。
 * @param cwd - 会话头里的工作目录。
 * @returns 末段目录名；路径为空时返回空字符串。
 */
function cwdTail(cwd: string): string {
  const segments = cwd.split(/[\\/]/).filter((segment) => segment !== '');
  return segments.length === 0 ? '' : (segments[segments.length - 1] ?? '');
}

/**
 * 聚合按设备分组的会话列表。
 * @param options - 存储、副本与在线判定。
 * @returns 设备与其会话，设备按最近活动倒序，会话按最近活动倒序。
 */
export function aggregateSessions(options: AggregateSessionsOptions): SessionsSnapshot {
  const { store, replica, online } = options;
  const nodes = store.listNodes();
  const summaries = replica.summaries();
  const groups = new Map<string, { deviceId: string; name: string; platform: string; lastSeenAt: number; sessions: SessionSummary[] }>();

  for (const node of nodes) {
    groups.set(node.id, {
      deviceId: node.id,
      name: node.name,
      platform: node.platform,
      lastSeenAt: node.lastSeenAt,
      sessions: [],
    });
  }

  for (const owned of store.listSessions()) {
    const summary = summaries.get(owned.sessionId);
    const group = groups.get(owned.deviceId) ?? {
      deviceId: owned.deviceId,
      name: owned.deviceId,
      platform: 'unknown',
      lastSeenAt: 0,
      sessions: [],
    };
    groups.set(owned.deviceId, group);
    group.sessions.push({
      sessionId: owned.sessionId,
      title: (summary?.title ?? cwdTail(owned.cwd)) || owned.sessionId,
      updatedAt: summary?.updatedAt ?? owned.createdAt,
      cwd: owned.cwd,
      workspaceName: cwdTail(owned.cwd) || owned.sessionId,
      kind: owned.kind,
    });
  }

  const devices = [...groups.values()].map((group) => ({
    deviceId: group.deviceId,
    name: group.name,
    platform: group.platform,
    online: online(group.deviceId),
    lastSeenAt: group.lastSeenAt,
    sessions: [...group.sessions].sort((left, right) => right.updatedAt - left.updatedAt),
  }));
  devices.sort((left, right) => right.lastSeenAt - left.lastSeenAt);

  return { devices };
}
