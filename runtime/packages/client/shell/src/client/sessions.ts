/**
 * 会话列表的领域模型与分组。
 *
 * 一条会话来自控制平面的私有读取入口：标题、未读、归属设备、在线状态与工作区显示名都由
 * 服务端给出，界面不再推断。工作区按显示名跨设备合并，展开后每个「设备 + 目录」是一条条目，
 * 条目显示设备与完整路径；同一个显示名对应多个目录时标记为同名工作区，界面因此不会把两个
 * 不同仓库当成一个。
 * @module @chatdsh/client-shell/sessions
 */

/** 会话类型。 */
export type SessionKind = 'work' | 'chat';

/** 一条会话。 */
export interface SessionItem {
  /** 会话标识。 */
  readonly sessionId: string;
  /** 归属设备标识。 */
  readonly deviceId: string;
  /** 设备显示名。 */
  readonly deviceName: string;
  /** 工作目录。 */
  readonly cwd: string;
  /** 工作区显示名：`cwd` 的末段。 */
  readonly workspaceName: string;
  /** 会话类型。 */
  readonly kind: SessionKind;
  /** 会话标题。 */
  readonly title: string;
  /** 最近活动时刻的毫秒时间戳。 */
  readonly updatedAt: number;
  /** 未读消息条数。 */
  readonly unreadMessages: number;
  /** 归属设备当前是否在线。 */
  readonly online: boolean;
}

/**
 * 校验一条读取结果。
 *
 * 字段缺失或类型不符直接拒绝：界面不把陌生形状的响应当成空列表。
 * @param value - 读取结果里的一项。
 * @returns 形状合法时为真。
 */
export function isSessionItem(value: unknown): value is SessionItem {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const strings = ['sessionId', 'deviceId', 'deviceName', 'cwd', 'workspaceName', 'title'] as const;
  for (const key of strings) {
    if (typeof record[key] !== 'string' || record[key] === '') return false;
  }
  if (record['kind'] !== 'work' && record['kind'] !== 'chat') return false;
  if (typeof record['updatedAt'] !== 'number' || !Number.isFinite(record['updatedAt'])) return false;
  if (typeof record['unreadMessages'] !== 'number' || !Number.isInteger(record['unreadMessages'])) return false;
  if (typeof record['online'] !== 'boolean') return false;
  return true;
}

/**
 * 找出同名设备的显示标签。
 *
 * 两台设备可以取同一个显示名；此时把设备标识的前八位接到名称后面，条目头因此可以区分。
 * @param items - 会话列表。
 * @returns 设备标识到显示标签的映射。
 */
export function deviceLabels(items: readonly SessionItem[]): Map<string, string> {
  const names = new Map<string, Set<string>>();
  const deviceNames = new Map<string, string>();
  for (const item of items) {
    const existing = names.get(item.deviceName) ?? new Set<string>();
    existing.add(item.deviceId);
    names.set(item.deviceName, existing);
    deviceNames.set(item.deviceId, item.deviceName);
  }
  const labels = new Map<string, string>();
  for (const [deviceId, name] of deviceNames) {
    const shared = (names.get(name)?.size ?? 0) > 1;
    labels.set(deviceId, shared ? `${name}（${deviceId.slice(0, 8)}）` : name);
  }
  return labels;
}

/** 一个「设备 + 目录」条目。 */
export interface SessionEntry {
  /** 设备标识。 */
  readonly deviceId: string;
  /** 设备显示标签。 */
  readonly deviceLabel: string;
  /** 设备在线状态。 */
  readonly online: boolean;
  /** 工作目录。 */
  readonly cwd: string;
  /** 该目录下的会话，按最近活动倒序。 */
  readonly sessions: readonly SessionItem[];
}

/** 一个工作区节点。 */
export interface WorkspaceGroup {
  /** 工作区显示名。 */
  readonly workspaceName: string;
  /** 该显示名对应的目录不止一个。 */
  readonly ambiguous: boolean;
  /** 该显示名下的全部目录，按字典序。 */
  readonly cwds: readonly string[];
  /** 条目：每台设备上的每个目录一条。 */
  readonly entries: readonly SessionEntry[];
  /** 全部会话的条数。 */
  readonly sessionCount: number;
  /** 全部会话的未读总数。 */
  readonly unread: number;
  /** 组内最近活动时刻。 */
  readonly latest: number;
}

/** 一台设备上的全部会话。 */
export interface DeviceGroup {
  /** 设备标识。 */
  readonly deviceId: string;
  /** 设备显示标签。 */
  readonly deviceLabel: string;
  /** 设备在线状态。 */
  readonly online: boolean;
  /** 目录条目。 */
  readonly entries: readonly SessionEntry[];
  /** 全部会话的条数。 */
  readonly sessionCount: number;
  /** 全部会话的未读总数。 */
  readonly unread: number;
  /** 组内最近活动时刻。 */
  readonly latest: number;
}

/**
 * 把一组会话装进条目。
 * @param items - 同一「设备 + 目录」下的会话。
 * @param labels - 设备显示标签。
 * @returns 条目。
 */
function entryOf(items: readonly SessionItem[], labels: ReadonlyMap<string, string>): SessionEntry {
  const first = items[0];
  if (first === undefined) throw new Error('条目里没有会话');
  return {
    deviceId: first.deviceId,
    deviceLabel: labels.get(first.deviceId) ?? first.deviceName,
    online: first.online,
    cwd: first.cwd,
    sessions: [...items].sort((left, right) => right.updatedAt - left.updatedAt),
  };
}

/**
 * 按设备与目录聚合条目。
 * @param items - 会话列表。
 * @param labels - 设备显示标签。
 * @returns 条目，按设备标签与目录排序。
 */
function entriesOf(items: readonly SessionItem[], labels: ReadonlyMap<string, string>): SessionEntry[] {
  const buckets = new Map<string, SessionItem[]>();
  for (const item of items) {
    const key = `${item.deviceId}\u0000${item.cwd}`;
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [item]);
    else bucket.push(item);
  }
  return [...buckets.values()]
    .map((bucket) => entryOf(bucket, labels))
    .sort((left, right) => {
      if (left.deviceLabel !== right.deviceLabel) return left.deviceLabel < right.deviceLabel ? -1 : 1;
      return left.cwd < right.cwd ? -1 : left.cwd > right.cwd ? 1 : 0;
    });
}

/**
 * 求和未读。
 * @param items - 会话列表。
 * @returns 未读总数。
 */
function unreadOf(items: readonly SessionItem[]): number {
  return items.reduce((total, item) => total + item.unreadMessages, 0);
}

/**
 * 取最近活动时刻。
 * @param items - 会话列表。
 * @returns 毫秒时间戳；空列表为 0。
 */
function latestOf(items: readonly SessionItem[]): number {
  return items.reduce((latest, item) => Math.max(latest, item.updatedAt), 0);
}

/**
 * 按工作区显示名分组。
 *
 * 同一个显示名在不同设备、不同目录下的会话合成一个工作区节点；节点里保留每个目录的真实
 * 位置。显示名对应多个目录时标记 `ambiguous` 并列出全部目录。
 * @param items - 会话列表。
 * @returns 工作区节点，按最近活动倒序。
 */
export function groupByWorkspace(items: readonly SessionItem[]): WorkspaceGroup[] {
  const labels = deviceLabels(items);
  const buckets = new Map<string, SessionItem[]>();
  for (const item of items) {
    const bucket = buckets.get(item.workspaceName);
    if (bucket === undefined) buckets.set(item.workspaceName, [item]);
    else bucket.push(item);
  }
  return [...buckets.entries()]
    .map(([workspaceName, bucket]) => {
      const cwds = [...new Set(bucket.map((item) => item.cwd))].sort();
      return {
        workspaceName,
        ambiguous: cwds.length > 1,
        cwds,
        entries: entriesOf(bucket, labels),
        sessionCount: bucket.length,
        unread: unreadOf(bucket),
        latest: latestOf(bucket),
      };
    })
    .sort((left, right) => {
      if (left.latest !== right.latest) return right.latest - left.latest;
      return left.workspaceName < right.workspaceName ? -1 : left.workspaceName > right.workspaceName ? 1 : 0;
    });
}

/**
 * 按设备分组。
 * @param items - 会话列表。
 * @returns 设备节点，按最近活动倒序。
 */
export function groupByDevice(items: readonly SessionItem[]): DeviceGroup[] {
  const labels = deviceLabels(items);
  const buckets = new Map<string, SessionItem[]>();
  for (const item of items) {
    const bucket = buckets.get(item.deviceId);
    if (bucket === undefined) buckets.set(item.deviceId, [item]);
    else bucket.push(item);
  }
  return [...buckets.entries()]
    .map(([deviceId, bucket]) => ({
      deviceId,
      deviceLabel: labels.get(deviceId) ?? bucket[0]?.deviceName ?? deviceId,
      online: bucket[0]?.online ?? false,
      entries: entriesOf(bucket, labels),
      sessionCount: bucket.length,
      unread: unreadOf(bucket),
      latest: latestOf(bucket),
    }))
    .sort((left, right) => {
      if (left.latest !== right.latest) return right.latest - left.latest;
      return left.deviceLabel < right.deviceLabel ? -1 : left.deviceLabel > right.deviceLabel ? 1 : 0;
    });
}

/**
 * 在列表里找一条会话。
 * @param items - 会话列表。
 * @param sessionId - 会话标识。
 * @param deviceId - 归属设备；给出时要求同时匹配。
 * @returns 找到的会话；没有时返回 `undefined`。
 */
export function findSession(
  items: readonly SessionItem[],
  sessionId: string,
  deviceId?: string
): SessionItem | undefined {
  return items.find(
    (item) => item.sessionId === sessionId && (deviceId === undefined || item.deviceId === deviceId)
  );
}

/**
 * 判断一条会话是否可写。
 *
 * 设备在线才可写；离线时侧栏照常列出，界面改用只读入口。
 * @param item - 会话。
 * @returns 可写时为真。
 */
export function isWritable(item: SessionItem): boolean {
  return item.online;
}
