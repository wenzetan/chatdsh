/**
 * 分享面板的数据入口。
 *
 * 面板按同源相对路径访问控制平面的真实接口：会话聚合、副本读取、分享预览、分享记录、
 * 建立与撤销、公开页探测与会话导入。返回值在这里逐项核对形状，形状不符按失败抛出并带上
 * 错误码，界面据码给出说明，不把残缺数据渲染成成功。
 * @module @chatdsh/client-share/gateway
 */

import type {
  ContentScope,
  DeviceSessions,
  ImportResult,
  PanelTelemetry,
  ReplicaEvent,
  ReplicaSnapshot,
  SessionSummary,
  SessionsSnapshot,
  ShareAction,
  ShareCreatedView,
  ShareExclusion,
  ShareGateway,
  ShareList,
  SharePreview,
  SharePreviewAttachment,
  ShareRange,
  ShareRecordView,
  ShareRevoked,
  ShareStatus,
  ShareSelection,
  SnapshotProbe,
} from './types.ts';
import { SHARE_EXCLUSIONS } from './types.ts';

/** 分享记录列表的路径。 */
export const SHARES_PATH = '/chatdsh/gateway/shares';

/** 建立与撤销分享的路径。 */
export const SHARE_PATH = '/chatdsh/gateway/share';

/** 预览路径。 */
export const PREVIEW_PATH = '/chatdsh/gateway/share/preview';

/** 会话聚合路径。 */
export const SESSIONS_PATH = '/chatdsh/gateway/sessions';

/** 副本读取路径。 */
export const REPLICA_PATH = '/chatdsh/gateway/replica';

/** 导入路径。 */
export const IMPORT_PATH = '/chatdsh/gateway/import';

/** 写操作要求的请求头，跨站表单无法携带。 */
export const CSRF_HEADER = 'x-chatdsh-csrf';

/** 一次调用失败。 */
export class ShareCallError extends Error {
  /**
   * @param code - 错误码，取自返回体或本端的失败分类。
   * @param message - 面向用户的说明。
   * @param status - HTTP 状态码；没有拿到应答时为 0。
   * @param reason - 控制平面给出的具体条件，可以缺省。
   */
  constructor(readonly code: string, message: string, readonly status = 0, readonly reason?: string) {
    super(message);
    this.name = 'ShareCallError';
  }
}

/** 断言一个对象。 */
function requireRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ShareCallError('gateway/internal', `${what}的返回形状不符合约定`);
  }
  return value as Record<string, unknown>;
}

/** 断言一个字符串。 */
function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new ShareCallError('gateway/internal', `${what}的返回形状不符合约定`);
  }
  return value;
}

/** 断言一个有限数值。 */
function requireNumber(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ShareCallError('gateway/internal', `${what}的返回形状不符合约定`);
  }
  return value;
}

/** 断言一个数组。 */
function requireArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new ShareCallError('gateway/internal', `${what}的返回形状不符合约定`);
  return value;
}

/** 读一个分享状态。 */
function statusOfValue(value: unknown, what: string): ShareStatus {
  if (value === 'active' || value === 'revoked' || value === 'expired') return value;
  throw new ShareCallError('gateway/internal', `${what}的状态不符合约定`);
}

/** 读内容范围。 */
function scopeOf(value: unknown, what: string): ContentScope {
  const record = requireRecord(value, what);
  if (typeof record['attachmentsComplete'] !== 'boolean') {
    throw new ShareCallError('gateway/internal', `${what}缺少附件副本结论`);
  }
  return {
    turnFrom: requireNumber(record['turnFrom'], what),
    turnTo: requireNumber(record['turnTo'], what),
    eventCount: requireNumber(record['eventCount'], what),
    charCount: requireNumber(record['charCount'], what),
    compressed: record['compressed'] === true,
    attachmentsComplete: record['attachmentsComplete'],
  };
}

/** 读一个排除项。 */
function exclusionOf(value: unknown): ShareExclusion {
  const known: readonly string[] = SHARE_EXCLUSIONS;
  if (typeof value !== 'string' || !known.includes(value)) {
    throw new ShareCallError('gateway/internal', '排除项的取值不在约定之内');
  }
  return value as ShareExclusion;
}

/** 读一条会话。 */
function sessionOf(value: unknown): SessionSummary {
  const record = requireRecord(value, '会话条目');
  const kind = record['kind'];
  if (kind !== 'work' && kind !== 'chat') throw new ShareCallError('gateway/internal', '会话条目的类型不符合约定');
  return {
    sessionId: requireString(record['sessionId'], '会话条目'),
    title: requireString(record['title'], '会话条目'),
    updatedAt: requireNumber(record['updatedAt'], '会话条目'),
    cwd: requireString(record['cwd'], '会话条目'),
    workspaceName: requireString(record['workspaceName'], '会话条目'),
    kind,
  };
}

/** 读一台设备与它名下的会话。 */
function deviceOf(value: unknown): DeviceSessions {
  const record = requireRecord(value, '设备条目');
  return {
    deviceId: requireString(record['deviceId'], '设备条目'),
    name: requireString(record['name'], '设备条目'),
    platform: requireString(record['platform'], '设备条目'),
    online: record['online'] === true,
    lastSeenAt: requireNumber(record['lastSeenAt'], '设备条目'),
    sessions: requireArray(record['sessions'], '设备条目的会话列表').map(sessionOf),
  };
}

/** 读一条副本事件。 */
function eventOf(value: unknown): ReplicaEvent {
  const record = requireRecord(value, '副本事件');
  return {
    seq: requireNumber(record['seq'], '副本事件'),
    kind: requireString(record['kind'], '副本事件'),
    time: requireNumber(record['time'], '副本事件'),
    ...(typeof record['bytes'] === 'number' ? { bytes: record['bytes'] } : {}),
    ...(record['payload'] === undefined ? {} : { payload: record['payload'] }),
  };
}

/** 读一条分享记录。 */
function recordOf(value: unknown): ShareRecordView {
  const record = requireRecord(value, '分享记录');
  const expiresAt = record['expiresAt'];
  const revokedAt = record['revokedAt'];
  const path = record['path'];
  return {
    shareId: requireString(record['shareId'], '分享记录'),
    sourceSessionId: requireString(record['sourceSessionId'], '分享记录'),
    title: requireString(record['title'], '分享记录'),
    scope: scopeOf(record['scope'], '分享记录'),
    status: statusOfValue(record['status'], '分享记录'),
    createdAt: requireNumber(record['createdAt'], '分享记录'),
    visits: requireNumber(record['visits'], '分享记录'),
    bytes: requireNumber(record['bytes'], '分享记录'),
    ...(typeof expiresAt === 'number' ? { expiresAt } : {}),
    ...(typeof revokedAt === 'number' ? { revokedAt } : {}),
    ...(typeof path === 'string' && path !== '' ? { path } : {}),
  };
}

/** 读预览响应里的一份附件。 */
function previewAttachmentOf(value: unknown): SharePreviewAttachment {
  const record = requireRecord(value, '预览附件');
  return {
    id: requireString(record['id'], '预览附件'),
    filename: requireString(record['filename'], '预览附件'),
    downloadable: record['downloadable'] === true,
  };
}

/** 读预览响应。 */
function previewOf(value: unknown): SharePreview {
  const record = requireRecord(value, '预览结果');
  const redactions = requireRecord(record['redactions'], '预览结果的脱敏计数');
  return {
    title: requireString(record['title'], '预览结果'),
    scope: scopeOf(record['scope'], '预览结果'),
    turns: requireArray(record['turns'], '预览结果的回合清单').map((turn) => requireNumber(turn, '预览结果的回合清单')),
    messageCount: requireNumber(record['messageCount'], '预览结果'),
    attachments: requireArray(record['attachments'], '预览结果的附件清单').map(previewAttachmentOf),
    excluded: requireArray(record['excluded'], '预览结果的排除项').map(exclusionOf),
    redactions: {
      paths: requireNumber(redactions['paths'], '预览结果的脱敏计数'),
      credentials: requireNumber(redactions['credentials'], '预览结果的脱敏计数'),
    },
  };
}

/** 读建立分享的结果。 */
function createdOf(value: unknown): ShareCreatedView {
  const record = requireRecord(value, '建立分享结果');
  const expiresAt = record['expiresAt'];
  return {
    shareId: requireString(record['shareId'], '建立分享结果'),
    path: requireString(record['path'], '建立分享结果'),
    sourceSessionId: requireString(record['sourceSessionId'], '建立分享结果'),
    title: requireString(record['title'], '建立分享结果'),
    scope: scopeOf(record['scope'], '建立分享结果'),
    status: statusOfValue(record['status'], '建立分享结果'),
    createdAt: requireNumber(record['createdAt'], '建立分享结果'),
    bytes: requireNumber(record['bytes'], '建立分享结果'),
    attachments: requireArray(record['attachments'], '建立分享结果的附件清单').map((item) => {
      const attachment = requireRecord(item, '建立分享结果的附件');
      return {
        id: requireString(attachment['id'], '建立分享结果的附件'),
        filename: requireString(attachment['filename'], '建立分享结果的附件'),
        size: requireNumber(attachment['size'], '建立分享结果的附件'),
      };
    }),
    ...(typeof expiresAt === 'number' ? { expiresAt } : {}),
  };
}

/** 把选择与范围拼成请求体。 */
function requestBodyOf(input: { sessionId: string; range: ShareRange } & ShareSelection): Record<string, unknown> {
  const scope: Record<string, unknown> = {
    includeUserText: input.includeUserText,
    includeAssistantText: input.includeAssistantText,
    attachmentIds: [...input.attachmentIds],
  };
  return {
    sessionId: input.sessionId,
    range: input.range,
    scope,
  };
}

/** 构造数据入口所需的依赖。 */
export interface ShareGatewayOptions {
  /** 同源请求的基地址；缺省用当前页面地址。 */
  readonly origin?: string;
  /** 浏览器侧遥测。 */
  readonly telemetry: PanelTelemetry;
  /** `fetch` 实现；缺省用全局实现。 */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * 构造分享面板的数据入口。
 * @param options - 遥测与可选的基地址。
 * @returns 数据入口。
 */
export function createShareGateway(options: ShareGatewayOptions): ShareGateway {
  const origin = options.origin ?? (typeof location === 'undefined' ? 'http://127.0.0.1' : location.origin);
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const telemetry = options.telemetry;

  /**
   * 发一次请求，拿到状态码与解析后的返回体。
   * @param path - 相对路径。
   * @param init - 请求参数。
   * @returns 状态码与返回体。
   */
  const exchange = async (path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> => {
    let response: Response;
    try {
      response = await doFetch(new URL(path, origin), init);
    } catch (error) {
      throw new ShareCallError('control-plane-unreachable', `控制平面不可达，请恢复连接后重试：${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status === 204) return { status: response.status, body: undefined };
    const text = await response.text();
    let body: unknown;
    try {
      body = text === '' ? undefined : JSON.parse(text);
    } catch {
      throw new ShareCallError('gateway/internal', `控制平面返回的不是 JSON（${String(response.status)}）`, response.status);
    }
    return { status: response.status, body };
  };

  /**
   * 发一次请求，非 2xx 按失败抛出。
   * @param path - 相对路径。
   * @param init - 请求参数。
   * @returns 解析后的返回体。
   */
  const call = async (path: string, init?: RequestInit): Promise<unknown> => {
    const answer = await exchange(path, init);
    if (answer.status >= 200 && answer.status < 300) return answer.body;
    const envelope = typeof answer.body === 'object' && answer.body !== null ? (answer.body as { error?: unknown; reason?: unknown }) : {};
    const code = typeof envelope.error === 'string' ? envelope.error : 'gateway/internal';
    const reason = typeof envelope.reason === 'string' ? envelope.reason : undefined;
    throw new ShareCallError(code, describeFailure(code, answer.status, reason), answer.status, reason);
  };

  /** 发一个写请求。 */
  const write = async (path: string, payload: unknown): Promise<unknown> => call(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' },
    body: JSON.stringify(payload),
  });

  return {
    async sessions(): Promise<SessionsSnapshot> {
      const body = requireRecord(await call(SESSIONS_PATH), '会话聚合');
      return { devices: requireArray(body['devices'], '会话聚合的设备列表').map(deviceOf) };
    },

    async replica(sessionId: string, upToSeq?: number): Promise<ReplicaSnapshot> {
      const query = new URLSearchParams({ sessionId });
      if (upToSeq !== undefined) query.set('upToSeq', String(upToSeq));
      const body = requireRecord(await call(`${REPLICA_PATH}?${query.toString()}`), '副本读取结果');
      const watermark = body['watermark'];
      return {
        sessionId: requireString(body['sessionId'], '副本读取结果'),
        watermark: typeof watermark === 'number' ? watermark : null,
        events: requireArray(body['events'], '副本读取结果的事件列表').map(eventOf),
      };
    },

    async shares(): Promise<ShareList> {
      const body = requireRecord(await call(SHARES_PATH), '分享记录列表');
      return {
        shares: requireArray(body['shares'], '分享记录列表').map(recordOf),
        totalBytes: requireNumber(body['totalBytes'], '分享记录列表'),
      };
    },

    async preview(input): Promise<SharePreview> {
      return previewOf(await write(PREVIEW_PATH, requestBodyOf(input)));
    },

    async create(input): Promise<ShareCreatedView> {
      return createdOf(await write(SHARE_PATH, {
        ...requestBodyOf(input),
        ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
      }));
    },

    async revoke(shareId: string): Promise<ShareRevoked> {
      const answer = await exchange(`${SHARE_PATH}?token=${encodeURIComponent(shareId)}`, {
        method: 'DELETE',
        headers: { [CSRF_HEADER]: '1' },
      });
      const body = answer.body;
      if (answer.status === 404) {
        // 控制平面对「没有可撤销的记录」返回 404 与 revoked:false；这条结论是撤销结果，不是失败。
        if (typeof body === 'object' && body !== null && (body as { revoked?: unknown }).revoked === false) return { revoked: false };
        throw new ShareCallError('share-unavailable', describeFailure('share-unavailable', 404), 404);
      }
      const record = requireRecord(body, '撤销分享结果');
      if (record['revoked'] !== true) {
        throw new ShareCallError('gateway/internal', '撤销分享结果的返回形状不符合约定');
      }
      const revokedAt = record['revokedAt'];
      const status = record['status'];
      return {
        revoked: true,
        ...(typeof revokedAt === 'number' ? { revokedAt } : {}),
        ...(status === 'active' || status === 'revoked' || status === 'expired' ? { status } : {}),
      };
    },

    async probe(shareId: string): Promise<SnapshotProbe> {
      const url = new URL(`/s/${encodeURIComponent(shareId)}`, origin);
      let response: Response;
      try {
        response = await doFetch(url, { headers: { accept: 'text/html' } });
      } catch {
        return { reachable: false, status: 0, reason: 'stream-not-ready' };
      }
      if (response.ok) return { reachable: true, status: response.status, reason: 'active' };
      if (response.status === 410) return { reachable: true, status: 410, reason: 'unavailable' };
      if (response.status === 404) return { reachable: true, status: 404, reason: 'unknown' };
      return { reachable: false, status: response.status, reason: 'stream-not-ready' };
    },

    async importSession(input: { sourceSessionId: string; deviceId?: string; cwd?: string }): Promise<ImportResult> {
      const body = requireRecord(await write(IMPORT_PATH, {
        sourceSessionId: input.sourceSessionId,
        ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      }), '导入结果');
      const watermark = body['watermark'];
      return {
        sessionId: requireString(body['sessionId'], '导入结果'),
        parentSession: requireString(body['parentSession'], '导入结果'),
        watermark: typeof watermark === 'number' ? watermark : null,
        imported: requireNumber(body['imported'], '导入结果'),
      };
    },

    noteAction(action: ShareAction, outcome): void {
      telemetry.action(action, outcome);
    },
  };
}

/** 请求不合法时按原因给出的说明。 */
const REASON_TEXT: Readonly<Record<string, string>> = {
  'turn-unknown': '所选回合不在这个会话里，请重新读取回合列表',
  'turn-invalid': '回合编号不合法',
  'turn-from-invalid': '起始回合编号不合法',
  'turn-to-invalid': '结束回合编号不合法',
  'range-order': '结束回合不能早于起始回合',
  'turns-empty': '请至少选择一个回合',
  'turns-too-many': '一次最多选择 512 个回合',
  'range-empty': '这个回合区间里没有内容',
  'bound-empty': '所选上界之前没有完整回合',
  empty: '这个范围里没有可公开的回合',
  'attachment-id': '附件标识不合法，请重新读取附件清单',
  'attachment-missing': '所选附件在源设备上已经不存在，取消勾选后重试',
  'attachment-empty': '所选附件没有内容文件',
  'attachment-too-large': '附件超过单份 64 MB 的上限',
  'attachments-too-many': '一次最多选择 100 个附件',
  'attachments-shape': '附件选择必须是数组',
  'text-selection': '至少要公开用户消息或助手消息中的一种',
  'session-id': '会话标识不合法',
  'body-json': '请求体无法解析为 JSON',
  'body-empty': '请求体为空',
  'body-shape': '请求体不是对象',
  'body-too-large': '请求体超过上限',
  'ttl-invalid': '有效期不合法',
  'scope-shape': '分享范围必须是对象',
  'replica-missing': '源会话没有可读副本，无法生成分享',
  'package-corrupt': '分享包里的附件摘要与记录不一致',
  'write-unconfirmed': '写入结果尚未确认，请重新读取记录',
  'operation-digest': '同一操作标识携带了不同的请求摘要',
  'package-missing': '分享包里的附件副本已缺失',
};

/**
 * 把错误码翻译成界面说明。
 * @param code - 错误码。
 * @param status - HTTP 状态码。
 * @param reason - 控制平面给出的具体条件。
 * @returns 说明文字。
 */
export function describeFailure(code: string, status = 0, reason?: string): string {
  if (code === 'request-invalid' && reason !== undefined) {
    const text = REASON_TEXT[reason];
    if (text !== undefined) return `请求内容不合法：${text}。`;
  }
  switch (code) {
    case 'share-unavailable':
      return status === 410 ? '这条分享已经撤销或过期，链接立即失效。' : '这条链接不存在，控制平面不透露它曾经指向哪个会话。';
    case 'session-not-found':
      return '源会话没有可读副本，无法生成分享。请确认源设备已经同步过这条会话。';
    case 'auth-required':
      return '当前页面没有通过访问校验，请先登录控制平面再操作分享。';
    case 'permission-denied':
      return '当前设备没有这项分享操作的权限。';
    case 'attachment-missing':
      return '所选附件在源设备上已经不存在，取消勾选后重试。';
    case 'payload-too-large':
      return '请求体或附件超过上限，请减少内容范围后重试。';
    case 'object-not-found':
      return '控制平面没有这条分享记录，链接不产生任何可读内容。';
    case 'replica-unavailable':
      return '源会话没有可读副本，无法导入。请确认源设备已经同步过这条会话。';
    case 'invalid-payload':
      return '请求内容不合法：缺少会话标识或参数类型不对。';
    case 'invalid-json':
      return '请求体不是合法 JSON。';
    case 'control-plane-unreachable':
      return '控制平面不可达，请恢复连接后重试。';
    case 'not-found':
      return '控制平面没有这条记录的接口，当前形态不支持分享。';
    case 'internal-error':
      return '控制平面在处理这次分享请求时失败，请稍后重试。';
    default:
      return status === 0 ? `请求失败（${code}）` : `请求失败（${code}，HTTP ${String(status)}）`;
  }
}
