/**
 * 设备、会话与只读副本的纯数据转换。
 *
 * 这一层不访问网络与浏览器全局对象：中继响应先按这里的类型收窄，再交给界面渲染。
 * @module @chatdsh/client-remote/model
 */

/** 中继设备列表里的一台设备。 */
export interface DevicePayload {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly online: boolean;
  readonly lastSeenAt: number;
  readonly role?: string;
  readonly capabilities?: readonly string[];
}

/** 中继设备列表的响应。 */
export interface DevicesPayload {
  readonly devices: readonly DevicePayload[];
}

/** 聚合会话列表里的一条会话。 */
export interface SessionPayload {
  readonly sessionId: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly cwd: string;
  readonly workspaceName: string;
  readonly kind: 'work' | 'chat';
}

/** 聚合会话列表里的一台设备。 */
export interface DeviceSessionsPayload {
  readonly deviceId: string;
  readonly name: string;
  readonly platform: string;
  readonly online: boolean;
  readonly lastSeenAt: number;
  readonly sessions: readonly SessionPayload[];
}

/** 聚合会话列表的响应。 */
export interface SessionsPayload {
  readonly devices: readonly DeviceSessionsPayload[];
}

/** 界面使用的设备行。 */
export interface OverviewDevice {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly online: boolean;
  readonly lastSeenAt: number;
  readonly sessionCount: number;
}

/** 界面使用的会话行。 */
export interface OverviewSession extends SessionPayload {
  readonly deviceId: string;
  readonly deviceName: string;
  readonly devicePlatform: string;
  readonly online: boolean;
}

/** 合并后的设备与会话。 */
export interface Overview {
  readonly devices: readonly OverviewDevice[];
  readonly sessions: readonly OverviewSession[];
}

/**
 * 合并设备列表与按设备分组的会话列表。
 * @param devices - 中继设备列表。
 * @param groups - 中继聚合会话列表。
 * @returns 在线设备在前、按最近活动倒序的设备行，以及按最近活动倒序的会话行。
 */
export function buildOverview(
  devices: readonly DevicePayload[],
  groups: readonly DeviceSessionsPayload[],
): Overview {
  const deviceRows = new Map<string, OverviewDevice>();
  for (const device of devices) {
    deviceRows.set(device.id, {
      id: device.id,
      name: device.name,
      platform: device.platform,
      online: device.online,
      lastSeenAt: device.lastSeenAt,
      sessionCount: 0,
    });
  }

  const sessions = new Map<string, OverviewSession>();
  for (const group of groups) {
    const known = deviceRows.get(group.deviceId);
    if (known === undefined) {
      deviceRows.set(group.deviceId, {
        id: group.deviceId,
        name: group.name,
        platform: group.platform,
        online: group.online,
        lastSeenAt: group.lastSeenAt,
        sessionCount: 0,
      });
    }
    const device = deviceRows.get(group.deviceId);
    if (device === undefined) throw new Error(`设备 ${group.deviceId} 在合并时消失`);
    for (const session of group.sessions) {
      const row: OverviewSession = {
        ...session,
        deviceId: group.deviceId,
        deviceName: device.name,
        devicePlatform: device.platform,
        online: device.online,
      };
      const existing = sessions.get(session.sessionId);
      if (existing === undefined || existing.updatedAt < row.updatedAt) sessions.set(session.sessionId, row);
    }
  }

  const sessionRows = [...sessions.values()];
  const counts = new Map<string, number>();
  for (const session of sessionRows) {
    counts.set(session.deviceId, (counts.get(session.deviceId) ?? 0) + 1);
  }

  const deviceList = [...deviceRows.values()].map((device) => ({
    ...device,
    sessionCount: counts.get(device.id) ?? 0,
  }));
  deviceList.sort((left, right) => {
    if (left.online !== right.online) return left.online ? -1 : 1;
    if (left.lastSeenAt !== right.lastSeenAt) return right.lastSeenAt - left.lastSeenAt;
    return left.name.localeCompare(right.name);
  });
  sessionRows.sort((left, right) => {
    if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt;
    return left.sessionId.localeCompare(right.sessionId);
  });

  return { devices: deviceList, sessions: sessionRows };
}

/** 中继副本里的一条事件。 */
export interface ReplicaEvent {
  readonly seq: number;
  readonly kind: string;
  readonly time: number;
  readonly bytes?: number;
  readonly payload?: unknown;
}

/** 中继副本响应。 */
export interface ReplicaPayload {
  readonly sessionId: string;
  readonly watermark: number | null;
  readonly events: readonly ReplicaEvent[];
}

/** 只读副本里的一条视图记录。 */
export interface ReplicaItem {
  readonly seq: number;
  readonly kind:
    | 'turn'
    | 'user'
    | 'assistant'
    | 'tool-call'
    | 'tool-result'
    | 'approval-asked'
    | 'approval-decided';
  readonly time: number;
  readonly title: string;
  readonly text: string;
  readonly detail: string;
  readonly failed: boolean;
}

/** 取事件信封里的数据字段。 */
function dataOf(event: ReplicaEvent): Readonly<Record<string, unknown>> {
  const payload = event.payload;
  if (typeof payload !== 'object' || payload === null) return {};
  const data = (payload as { readonly data?: unknown }).data;
  return typeof data === 'object' && data !== null ? (data as Readonly<Record<string, unknown>>) : {};
}

/** 取消息内容里的文本块。 */
function textOfContent(value: unknown): string {
  if (!Array.isArray(value)) return '';
  const parts: string[] = [];
  for (const block of value) {
    if (typeof block !== 'object' || block === null) continue;
    const record = block as { readonly type?: unknown; readonly text?: unknown };
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text);
  }
  return parts.join('\n');
}

/** 取一条记录里的字符串字段。 */
function stringField(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

/** 取消息对象里的内容。 */
function messageContent(record: Readonly<Record<string, unknown>>): unknown {
  const message = record.message;
  if (typeof message !== 'object' || message === null) return undefined;
  return (message as { readonly content?: unknown }).content;
}

/**
 * 把副本事件转换成只读对话视图。
 * @param events - 按序号升序的副本事件。
 * @returns 可渲染的记录；未识别的记录不进入视图。
 */
export function buildReplicaView(events: readonly ReplicaEvent[]): readonly ReplicaItem[] {
  const items: ReplicaItem[] = [];
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    const data = dataOf(event);
    if (event.kind === 'turn/start') {
      const turn = typeof data.turn === 'number' ? String(data.turn) : '';
      items.push({ seq: event.seq, kind: 'turn', time: event.time, title: turn, text: '', detail: '', failed: false });
      continue;
    }
    if (event.kind === 'user/message') {
      items.push({
        seq: event.seq,
        kind: 'user',
        time: event.time,
        title: '',
        text: textOfContent(data.content),
        detail: '',
        failed: false,
      });
      continue;
    }
    if (event.kind === 'assistant/message') {
      items.push({
        seq: event.seq,
        kind: 'assistant',
        time: event.time,
        title: '',
        text: textOfContent(messageContent(data)),
        detail: '',
        failed: false,
      });
      continue;
    }
    if (event.kind === 'tool/call') {
      items.push({
        seq: event.seq,
        kind: 'tool-call',
        time: event.time,
        title: stringField(data, 'name'),
        text: stringField(data, 'arguments'),
        detail: stringField(data, 'callId'),
        failed: false,
      });
      continue;
    }
    if (event.kind === 'tool/result') {
      const message = data.message;
      const failed = (typeof message === 'object' && message !== null
        && (message as { readonly isError?: unknown }).isError === true)
        || data.error !== undefined;
      items.push({
        seq: event.seq,
        kind: 'tool-result',
        time: event.time,
        title: '',
        text: textOfContent(messageContent(data)),
        detail: '',
        failed,
      });
      continue;
    }
    if (event.kind === 'approval/asked') {
      items.push({
        seq: event.seq,
        kind: 'approval-asked',
        time: event.time,
        title: stringField(data, 'toolName'),
        text: stringField(data, 'reason'),
        detail: stringField(data, 'callId'),
        failed: false,
      });
      continue;
    }
    if (event.kind === 'approval/decided') {
      items.push({
        seq: event.seq,
        kind: 'approval-decided',
        time: event.time,
        title: stringField(data, 'outcome'),
        text: '',
        detail: '',
        failed: stringField(data, 'outcome') === 'rejected',
      });
    }
  }
  return items;
}

/**
 * 找出副本里最后一个已经结束的回合。
 * @param events - 副本事件。
 * @returns 回合编号；没有完整回合时返回 0。
 */
export function completeTurnOf(events: readonly ReplicaEvent[]): number {
  let complete = 0;
  for (const event of events) {
    if (event.kind !== 'turn/end') continue;
    const turn = dataOf(event).turn;
    if (typeof turn === 'number' && Number.isInteger(turn) && turn > complete) complete = turn;
  }
  return complete;
}

/** 分叉输入的记录形状，与宿主导入服务一致。 */
export interface ForkRecord {
  readonly seq: number;
  readonly kind: string;
  readonly time: number;
  readonly payload?: unknown;
}

/**
 * 把副本事件整理成分叉输入。
 * @param events - 副本事件。
 * @returns 记录列表；缺失完整信封的事件保留 `undefined`，由宿主导入服务就地报错。
 */
export function forkRecordsOf(events: readonly ReplicaEvent[]): readonly ForkRecord[] {
  return events.map((event) => ({
    seq: event.seq,
    kind: event.kind,
    time: event.time,
    ...(event.payload === undefined ? {} : { payload: event.payload }),
  }));
}
