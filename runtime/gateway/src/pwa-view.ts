/**
 * 中继 PWA 的只读副本视图与审批角标纯函数。
 *
 * 副本事件的 `payload` 可能是完整事件信封（`type`／`seq`／`time`／`data`），也可能是
 * 历史副本里的裸事件数据；两种形状在这里统一解包。这里只从真实字段取文本、工具名与
 * 审批结果，不把原始 JSON 当正文。视图模型与角标状态都可以直接序列化进内联页面脚本，
 * 单元测试与浏览器运行的是同一份实现。
 * @module @chatdsh/gateway/pwa-view
 */

/** 一条副本事件；与 `ReplicaEventInput` 的读取形状一致。 */
export interface ReplicaEventLike {
  readonly seq?: number;
  readonly kind: string;
  readonly time?: number;
  readonly payload?: unknown;
}

/** 时间线里的一个事件。 */
export interface ReplicaTimelineItem {
  readonly seq: number;
  readonly kind: string;
  readonly time: number;
  readonly role: 'user' | 'assistant' | 'tool' | 'approval' | 'unknown';
  readonly title: string;
  readonly body: string;
  readonly bodyTruncated: boolean;
  readonly meta: string;
  readonly status?: 'pending' | 'decided' | 'error';
  readonly collapsed: boolean;
  readonly raw: string;
}

/** 一次副本渲染的完整视图模型。 */
export interface ReplicaTimeline {
  readonly items: readonly ReplicaTimelineItem[];
  readonly counts: {
    readonly total: number;
    readonly user: number;
    readonly assistant: number;
    readonly tool: number;
    readonly approval: number;
    readonly unknown: number;
  };
  readonly empty: boolean;
}

/** 审批角标的一条记录。 */
export interface ApprovalBadgeEntry {
  readonly key: string;
  readonly sessionId: string;
  readonly callId?: string;
  readonly toolName?: string;
  readonly deviceId?: string;
  readonly notificationIds: readonly string[];
  readonly at: number;
}

/** 审批角标状态。 */
export interface ApprovalBadgeState {
  readonly entries: Readonly<Record<string, ApprovalBadgeEntry>>;
  readonly notifications: Readonly<Record<string, string>>;
}

/** 空的审批角标状态。 */
export const EMPTY_APPROVAL_BADGES: ApprovalBadgeState = { entries: {}, notifications: {} };

/**
 * 把副本事件转成只读时间线。
 * @param events - 按序号升序的副本事件。
 * @returns 视图模型；空列表给出 `empty: true`。
 */
export function buildReplicaTimeline(events: readonly ReplicaEventLike[]): ReplicaTimeline {
  const TOOL_TEXT_LIMIT = 1200;
  const MESSAGE_TEXT_LIMIT = 4000;
  const RAW_LIMIT = 64 * 1024;

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  function truncate(value: string, limit: number): { text: string; truncated: boolean } {
    if (value.length <= limit) return { text: value, truncated: false };
    return { text: value.slice(0, limit), truncated: true };
  }

  function timeText(value: number): string {
    const date = new Date(value);
    function pad(part: number): string {
      return String(part).padStart(2, '0');
    }
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function textOfContent(content: unknown): { text: string; extras: string[] } {
    const parts: string[] = [];
    const extras: string[] = [];
    if (typeof content === 'string') return { text: content, extras };
    if (!Array.isArray(content)) return { text: '', extras };
    for (const block of content) {
      if (!isRecord(block)) continue;
      const type = block.type;
      if (type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
        continue;
      }
      if (type === 'reasoning') {
        extras.push('推理内容已省略');
        continue;
      }
      if (type === 'image') {
        extras.push('图片');
        continue;
      }
      if (type === 'file') {
        extras.push('文件附件');
        continue;
      }
      if (type === 'tool-call') {
        const name = typeof block.name === 'string' ? block.name : '未命名工具';
        extras.push(`工具调用：${name}`);
        continue;
      }
      if (type === 'tool-addition') {
        extras.push('工具新增');
        continue;
      }
      if (type === 'tool-removal') {
        extras.push('工具移除');
        continue;
      }
      if (typeof type === 'string') extras.push(`内容块：${type}`);
    }
    return { text: parts.join('\n'), extras };
  }

  function messageTextOf(value: unknown): { text: string; extras: string[]; source: string } {
    if (!isRecord(value)) return { text: '', extras: [], source: '' };
    const content = textOfContent(value.content);
    const source = isRecord(value.source) && typeof value.source.kind === 'string' ? value.source.kind : '';
    return { text: content.text, extras: content.extras, source };
  }

  function outcomeText(value: unknown): string {
    if (value === 'allowed-once') return '已允许一次';
    if (value === 'rejected') return '已拒绝';
    if (value === 'cancelled') return '已取消';
    if (value === 'unavailable') return '无人应答';
    return typeof value === 'string' && value !== '' ? value : '结果未知';
  }

  function payloadOf(event: ReplicaEventLike): Record<string, unknown> {
    const payload = event.payload;
    if (typeof payload !== 'object' || payload === null) return {};
    const record = payload as { type?: unknown; data?: unknown };
    if (typeof record.type === 'string' && Object.hasOwn(record, 'data')) {
      return typeof record.data === 'object' && record.data !== null
        ? record.data as Record<string, unknown>
        : {};
    }
    return record as Record<string, unknown>;
  }

  function metaOf(parts: readonly (string | undefined)[]): string {
    return parts.filter((part): part is string => part !== undefined && part !== '').join(' · ');
  }

  function rawOf(event: ReplicaEventLike): string {
    return truncate(JSON.stringify(event, null, 2) ?? 'null', RAW_LIMIT).text;
  }

  const asked = new Map<string, { toolName: string; callId: string }>();
  const decidedOutcomes = new Map<string, string>();
  for (const event of events) {
    const data = payloadOf(event);
    if (event.kind === 'approval/asked') {
      const id = typeof data.id === 'string' ? data.id : '';
      if (id === '') continue;
      asked.set(id, {
        toolName: typeof data.toolName === 'string' ? data.toolName : '',
        callId: typeof data.callId === 'string' ? data.callId : '',
      });
      continue;
    }
    if (event.kind === 'approval/decided') {
      const id = typeof data.id === 'string' ? data.id : '';
      if (id !== '') decidedOutcomes.set(id, outcomeText(data.outcome));
    }
  }

  const items: ReplicaTimelineItem[] = [];
  const counts = { total: 0, user: 0, assistant: 0, tool: 0, approval: 0, unknown: 0 };

  for (const event of events) {
    const seq = typeof event.seq === 'number' ? event.seq : items.length;
    const time = typeof event.time === 'number' ? event.time : 0;
    const data = payloadOf(event);
    let item: ReplicaTimelineItem | undefined;

    if (event.kind === 'user/message') {
      const message = messageTextOf(data);
      const body = truncate(message.text, MESSAGE_TEXT_LIMIT);
      item = {
        seq,
        kind: event.kind,
        time,
        role: 'user',
        title: '你',
        body: body.text === '' ? '（空消息）' : body.text,
        bodyTruncated: body.truncated,
        meta: metaOf([message.source === 'user' ? undefined : message.source, ...message.extras]),
        collapsed: false,
        raw: rawOf(event),
      };
    } else if (event.kind === 'assistant/message') {
      const message = messageTextOf(data.message);
      const body = truncate(message.text, MESSAGE_TEXT_LIMIT);
      const interrupted = data.interrupted === true;
      const usage = isRecord(data.usage) ? data.usage : undefined;
      const model = isRecord(data.message) && isRecord(data.message.source)
        ? metaOf([typeof data.message.source.provider === 'string' ? data.message.source.provider : undefined, typeof data.message.source.model === 'string' ? data.message.source.model : undefined])
        : '';
      item = {
        seq,
        kind: event.kind,
        time,
        role: 'assistant',
        title: '助手',
        body: body.text === '' ? '（空消息）' : body.text,
        bodyTruncated: body.truncated,
        meta: metaOf([
          model,
          interrupted ? '已中断' : undefined,
          usage === undefined ? undefined : `输入 ${String(usage.inputTokens ?? usage.input ?? '?')} / 输出 ${String(usage.outputTokens ?? usage.output ?? '?')}`,
          ...message.extras,
        ]),
        ...(interrupted ? { status: 'error' as const } : {}),
        collapsed: false,
        raw: rawOf(event),
      };
    } else if (event.kind === 'tool/call') {
      const name = typeof data.name === 'string' && data.name !== '' ? data.name : '未命名工具';
      const callId = typeof data.callId === 'string' ? data.callId : '';
      const argumentsText = typeof data.arguments === 'string'
        ? data.arguments
        : JSON.stringify(data.arguments) ?? '';
      const body = truncate(argumentsText, TOOL_TEXT_LIMIT);
      item = {
        seq,
        kind: event.kind,
        time,
        role: 'tool',
        title: `工具调用 · ${name}`,
        body: body.text === '' ? '（无参数）' : body.text,
        bodyTruncated: body.truncated,
        meta: metaOf([callId === '' ? undefined : `调用 ${callId}`, typeof data.turn === 'number' ? `回合 ${data.turn}` : undefined, typeof data.step === 'number' ? `步骤 ${data.step}` : undefined]),
        collapsed: false,
        raw: rawOf(event),
      };
    } else if (event.kind === 'tool/result') {
      const message = messageTextOf(data.message);
      const error = isRecord(data.error) ? data.error : undefined;
      const callId = isRecord(data.message) && typeof data.message.toolCallId === 'string'
        ? data.message.toolCallId
        : (isRecord(data.message) && isRecord(data.message.source) && typeof data.message.source.callId === 'string' ? data.message.source.callId : '');
      const failed = (isRecord(data.message) && data.message.isError === true) || error !== undefined;
      const errorText = error === undefined
        ? ''
        : `错误：${typeof error.name === 'string' ? error.name : '未知'}（${typeof error.code === 'string' ? error.code : 'unknown'}）${typeof error.reason === 'string' ? error.reason : ''}`;
      const body = truncate([message.text, errorText].filter((part) => part !== '').join('\n'), TOOL_TEXT_LIMIT);
      item = {
        seq,
        kind: event.kind,
        time,
        role: 'tool',
        title: failed ? '工具结果 · 失败' : '工具结果',
        body: body.text === '' ? '（无文本结果）' : body.text,
        bodyTruncated: body.truncated,
        meta: metaOf([callId === '' ? undefined : `调用 ${callId}`, ...message.extras]),
        ...(failed ? { status: 'error' as const } : {}),
        collapsed: false,
        raw: rawOf(event),
      };
    } else if (event.kind === 'approval/asked') {
      const toolName = typeof data.toolName === 'string' && data.toolName !== '' ? data.toolName : '未知工具';
      const callId = typeof data.callId === 'string' ? data.callId : '';
      const reason = typeof data.reason === 'string' ? data.reason : '';
      const requestId = typeof data.id === 'string' ? data.id : '';
      const decision = requestId === '' ? undefined : decidedOutcomes.get(requestId);
      item = {
        seq,
        kind: event.kind,
        time,
        role: 'approval',
        title: `审批请求 · ${toolName}`,
        body: reason === '' ? '等待审批决定' : reason,
        bodyTruncated: false,
        meta: metaOf([
          callId === '' ? undefined : `调用 ${callId}`,
          requestId === '' ? undefined : `请求 ${requestId}`,
          decision === undefined ? undefined : `结果 ${decision}`,
        ]),
        status: decision === undefined ? 'pending' : 'decided',
        collapsed: false,
        raw: rawOf(event),
      };
    } else if (event.kind === 'approval/decided') {
      const id = typeof data.id === 'string' ? data.id : '';
      const related = id === '' ? undefined : asked.get(id);
      item = {
        seq,
        kind: event.kind,
        time,
        role: 'approval',
        title: `审批结果 · ${outcomeText(data.outcome)}`,
        body: related === undefined ? '关联请求不在当前副本里' : `工具 ${related.toolName === '' ? '未知' : related.toolName}`,
        bodyTruncated: false,
        meta: metaOf([related?.callId === undefined || related.callId === '' ? undefined : `调用 ${related.callId}`, id === '' ? undefined : `请求 ${id}`]),
        status: 'decided',
        collapsed: false,
        raw: rawOf(event),
      };
    } else {
      item = {
        seq,
        kind: event.kind,
        time,
        role: 'unknown',
        title: `其他事件（${event.kind}）`,
        body: '',
        bodyTruncated: false,
        meta: timeText(time),
        collapsed: true,
        raw: rawOf(event),
      };
    }

    items.push(item);
    counts.total += 1;
    if (item.role === 'unknown') counts.unknown += 1;
    else counts[item.role] += 1;
  }

  return { items, counts, empty: items.length === 0 };
}

/**
 * 把一条 SSE 事件并入审批角标状态。
 * @param state - 当前状态。
 * @param event - SSE 数据解析后的对象。
 * @returns 新状态；事件不影响角标时原样返回。
 */
export function reduceApprovalBadge(state: ApprovalBadgeState, event: unknown): ApprovalBadgeState {
  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  function textOf(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }

  function idsOf(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string' && item !== '');
  }

  function entryKey(sessionId: string, callId: string, fallback: string): string {
    return `${sessionId}\u0000${callId === '' ? fallback : callId}`;
  }

  function addEntry(
    entries: Record<string, ApprovalBadgeEntry>,
    notifications: Record<string, string>,
    sessionId: string,
    callId: string,
    toolName: string,
    deviceId: string,
    notificationId: string,
    at: number,
  ): void {
    if (sessionId === '') return;
    const key = entryKey(sessionId, callId, notificationId);
    const previous = entries[key];
    const ids = previous === undefined ? [] : [...previous.notificationIds];
    if (notificationId !== '' && !ids.includes(notificationId)) ids.push(notificationId);
    entries[key] = {
      key,
      sessionId,
      ...(callId === '' ? {} : { callId }),
      ...(toolName === '' ? {} : { toolName }),
      ...(deviceId === '' ? {} : { deviceId }),
      notificationIds: ids,
      at: Number.isFinite(at) ? at : Date.now(),
    };
    if (notificationId !== '') notifications[notificationId] = key;
  }

  function removeIds(
    entries: Record<string, ApprovalBadgeEntry>,
    notifications: Record<string, string>,
    ids: readonly string[],
  ): void {
    if (ids.length === 0) return;
    const removedKeys = new Set<string>();
    for (const id of ids) {
      const key = notifications[id];
      if (key === undefined) continue;
      removedKeys.add(key);
      delete notifications[id];
    }
    for (const [key, entry] of Object.entries(entries)) {
      if (!removedKeys.has(key) && !entry.notificationIds.some((id) => ids.includes(id))) continue;
      delete entries[key];
      for (const id of entry.notificationIds) delete notifications[id];
    }
  }

  function removeMatching(
    entries: Record<string, ApprovalBadgeEntry>,
    notifications: Record<string, string>,
    sessionId: string,
    callId: string,
    tags: readonly string[],
  ): void {
    for (const [key, entry] of Object.entries(entries)) {
      const sameSession = sessionId !== '' && entry.sessionId === sessionId;
      const sameCall = callId !== '' && entry.callId === callId;
      const tagHit = entry.callId !== undefined && tags.includes(`approval-${entry.callId}`);
      if (!sameSession && !sameCall && !tagHit) continue;
      delete entries[key];
      for (const id of entry.notificationIds) delete notifications[id];
    }
  }

  if (!isRecord(event)) return state;
  const kind = textOf(event.kind);
  const entries: Record<string, ApprovalBadgeEntry> = { ...state.entries };
  const notifications: Record<string, string> = { ...state.notifications };
  let changed = false;

  if (kind === 'notification') {
    const items = Array.isArray(event.items) ? event.items : [];
    for (const item of items) {
      if (!isRecord(item) || item.kind !== 'approval') continue;
      const sessionId = textOf(item.sessionId);
      if (sessionId === '') continue;
      addEntry(
        entries,
        notifications,
        sessionId,
        textOf(item.objectId),
        '',
        textOf(item.deviceId),
        textOf(item.id),
        typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
      );
      changed = true;
    }
  } else if (kind === 'notification-withdraw') {
    const before = Object.keys(entries).length;
    removeIds(entries, notifications, idsOf(event.ids));
    removeMatching(entries, notifications, textOf(event.sessionId), textOf(event.objectId), idsOf(event.tags));
    changed = Object.keys(entries).length !== before;
  } else if (kind === 'notification-handled' || kind === 'notification-read') {
    const before = Object.keys(entries).length;
    removeIds(entries, notifications, idsOf(event.ids));
    changed = Object.keys(entries).length !== before;
  } else if (kind === 'approval') {
    const sessionId = textOf(event.sessionId);
    if (sessionId !== '') {
      addEntry(
        entries,
        notifications,
        sessionId,
        textOf(event.callId),
        textOf(event.toolName),
        textOf(event.deviceId),
        '',
        typeof event.at === 'number' ? event.at : Date.now(),
      );
      changed = true;
    }
  } else if (kind === 'approval/decided') {
    const sessionId = textOf(event.sessionId);
    const callId = textOf(event.callId);
    const before = Object.keys(entries).length;
    removeMatching(entries, notifications, sessionId, callId, []);
    changed = Object.keys(entries).length !== before;
  }

  return changed ? { entries, notifications } : state;
}

/** 一个会话的待审批条数。 */
export function approvalCountOf(state: ApprovalBadgeState, sessionId: string): number {
  let count = 0;
  for (const entry of Object.values(state.entries)) {
    if (entry.sessionId === sessionId) count += 1;
  }
  return count;
}

/** 全部会话的待审批条数。 */
export function approvalTotalOf(state: ApprovalBadgeState): number {
  return Object.keys(state.entries).length;
}

/** 一个会话的待审批通知标识。 */
export function approvalNotificationIdsOf(state: ApprovalBadgeState, sessionId: string): string[] {
  const ids: string[] = [];
  for (const entry of Object.values(state.entries)) {
    if (entry.sessionId !== sessionId) continue;
    for (const id of entry.notificationIds) {
      if (!ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}
