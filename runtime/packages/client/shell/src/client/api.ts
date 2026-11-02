/**
 * 外壳访问真实入口的封装。
 *
 * 三个来源：控制平面的私有客户端读取入口（分页会话摘要）、控制平面的设备、本机与归属端点、
 * 以及经 `/d/<deviceId>/` 前缀转发到目标设备运行时的 Remote 一元调用。所有失败都收敛成
 * `ShellApiError`，界面按错误码给出可理解的原因；响应形状不符直接拒绝。
 *
 * 每次调用产生一个 `chatdsh.client.remote.call` span，失败分支带 `outcome=failed`。
 * @module @chatdsh/client-shell/api
 */

import { isSessionPage, type SessionPage } from './pages.ts';
import { isReplicaEvent, type ReplicaEvent } from './estimate.ts';
import type { ShellTelemetry } from './telemetry.ts';

/** 私有客户端读取入口。 */
const CLIENT_SESSIONS_PATH = '/chatdsh/client/sessions';

/** 设备列表端点。 */
const DEVICES_PATH = '/chatdsh/gateway/devices';

/** 本机运行时端点。 */
const LOCAL_PATH = '/chatdsh/gateway/local';

/** 归属写入端点。 */
const OWNERSHIP_PATH = '/chatdsh/gateway/ownership';

/** 导入端点，供「在本机继续」使用。 */
const IMPORT_PATH = '/chatdsh/gateway/import';

/** 副本读取端点。 */
const REPLICA_PATH = '/chatdsh/gateway/replica';

/** 运行时的一元 Remote 通道。 */
const API_CHANNEL = '/api';

/** 一台设备。 */
export interface DeviceInfo {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly role: string;
  readonly online: boolean;
  readonly lastSeenAt: number;
}

/** 本机运行时的可用性。 */
export interface LocalRuntime {
  readonly available: boolean;
  readonly deviceId: string;
  readonly reason?: string;
}

/** 目录列举里的一行。 */
export interface DirectoryRow {
  readonly name: string;
  readonly path: string;
  readonly hidden: boolean;
}

/** 目录列举结果。 */
export interface DirectoryListing {
  readonly path: string;
  readonly home: string;
  readonly crumbs: readonly DirectoryRow[];
  readonly entries: readonly DirectoryRow[];
  readonly truncated: boolean;
}

/** 会话列表的读取参数。 */
export interface ListSessionsInput {
  readonly limit: number;
  readonly cursor?: string;
  readonly query: string;
  readonly deviceId?: string;
}

/** 本机继续的提交参数。 */
export interface ImportSessionInput {
  readonly sourceSessionId: string;
  readonly deviceId: string;
  readonly cwd: string;
}

/** 本机继续的结果。 */
export interface ImportResult {
  readonly sessionId: string;
  readonly parentSession: string;
  readonly imported: number;
}

/** 一次可理解的失败。 */
export class ShellApiError extends Error {
  /**
   * @param code - 错误码，取自响应信封。
   * @param status - HTTP 状态码；一元调用失败时为 200。
   */
  constructor(readonly code: string, readonly status: number) {
    super(`${code}（${String(status)}）`);
    this.name = 'ShellApiError';
  }
}

/** 创建会话的提交参数。 */
export interface CreateSessionInput {
  readonly deviceId: string;
  readonly cwd: string;
  /** 可选标题；给出时创建后改名。 */
  readonly title?: string;
}

/** 归属登记的参数。 */
export interface OwnershipInput {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly cwd: string;
}

/** 创建会话的结果。 */
export interface CreateSessionResult {
  readonly sessionId: string;
  /** 会话已经建立但标题没有设上时的说明。 */
  readonly titleWarning?: string;
  /** 会话已经建立但归属没有登记上时的说明；界面据此提供重试入口。 */
  readonly ownershipWarning?: string;
}

/** 外壳使用的入口集合。 */
export interface ShellApi {
  /** 读一页会话摘要。 */
  listSessions(input: ListSessionsInput): Promise<SessionPage>;
  /** 读设备列表。 */
  listDevices(): Promise<DeviceInfo[]>;
  /** 读本机运行时的可用性。 */
  localRuntime(): Promise<LocalRuntime>;
  /** 列举目录：给出设备标识时经设备转发，否则走默认运行时。 */
  listDirectory(deviceId: string | undefined, path?: string): Promise<DirectoryListing>;
  /** 在设备上创建会话并登记归属。 */
  createSession(input: CreateSessionInput): Promise<CreateSessionResult>;
  /** 重新登记一条已创建会话的归属。 */
  registerOwnership(input: OwnershipInput): Promise<void>;
  /** 在本机继续：导入源会话的历史并建立带血缘的新会话。 */
  importSession(input: ImportSessionInput): Promise<ImportResult>;
  /** 读一个会话的副本事件。 */
  readReplica(sessionId: string): Promise<ReplicaEvent[]>;
}

/** 构造入口集合所需的依赖。 */
export interface ShellApiOptions {
  /** 发请求的实现；浏览器里是全局 `fetch`。 */
  readonly fetchImpl: typeof fetch;
  /** 生成请求标识的实现。 */
  readonly newRequestId: () => string;
  /** 遥测。 */
  readonly telemetry: ShellTelemetry;
}

/**
 * 从响应体里取错误码。
 * @param body - 已解析的响应体。
 * @returns 错误码；没有时返回 `undefined`。
 */
function errorCodeOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const record = body as Record<string, unknown>;
  const error = record['error'];
  if (typeof error === 'string' && error !== '') return error;
  if (typeof error === 'object' && error !== null) {
    const code = (error as Record<string, unknown>)['code'];
    if (typeof code === 'string' && code !== '') return code;
  }
  return undefined;
}

/**
 * 读响应体为 JSON。
 * @param response - 响应。
 * @returns 解析结果；空响应为 `undefined`。
 */
async function jsonOf(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return undefined;
  return JSON.parse(text) as unknown;
}

/**
 * 建一个失败。
 * @param response - 响应。
 * @returns 失败对象。
 */
async function failureOf(response: Response): Promise<ShellApiError> {
  let body: unknown;
  try {
    body = await jsonOf(response);
  } catch {
    body = undefined;
  }
  return new ShellApiError(errorCodeOf(body) ?? 'request-failed', response.status);
}

/**
 * 建立真实的入口集合。
 * @param options - 依赖。
 * @returns 入口集合。
 */
export function createShellApi(options: ShellApiOptions): ShellApi {
  const { fetchImpl, newRequestId, telemetry } = options;

  /**
   * 发起一次 Json 请求并校验形状。
   * @param method - 遥测方法名。
   * @param path - 请求路径。
   * @param init - 请求参数。
   * @returns 响应体。
   */
  const request = async (method: string, path: string, init?: RequestInit): Promise<unknown> =>
    await telemetry.remote(method, async () => {
      const response = await fetchImpl(path, {
        ...init,
        headers: { accept: 'application/json', ...(init?.headers ?? {}) },
      });
      if (!response.ok) throw await failureOf(response);
      return await jsonOf(response);
    });

  /**
   * 发起一次设备运行时的一元调用。
   * @param method - 遥测方法名。
   * @param deviceId - 目标设备；省略时走默认运行时。
   * @param endpoint - Remote 端点，例如 `session/create`。
   * @param args - 该端点的第一个参数。
   * @returns 调用结果。
   */
  const rpc = async (
    method: string,
    deviceId: string | undefined,
    endpoint: string,
    args: unknown
  ): Promise<unknown> =>
    await telemetry.remote(method, async () => {
      const rpcId = newRequestId();
      const prefix = deviceId === undefined ? '' : `/d/${encodeURIComponent(deviceId)}`;
      const response = await fetchImpl(`${prefix}${API_CHANNEL}/${endpoint}`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
      });
      if (!response.ok) throw await failureOf(response);
      const envelope = (await jsonOf(response)) as
        | { readonly type?: unknown; readonly rpcId?: unknown; readonly result?: unknown }
        | undefined;
      if (typeof envelope !== 'object' || envelope === null) throw new ShellApiError('request-failed', response.status);
      if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId) {
        throw new ShellApiError('request-failed', response.status);
      }
      const result = envelope.result as Record<string, unknown> | undefined;
      if (typeof result !== 'object' || result === null) throw new ShellApiError('request-failed', response.status);
      if (result['ok'] !== true) {
        const error = result['error'] as Record<string, unknown> | undefined;
        const code = typeof error?.['code'] === 'string' ? (error['code'] as string) : 'request-failed';
        throw new ShellApiError(code, response.status);
      }
      return result['value'];
    });

  /**
   * 登记会话归属：控制平面把会话记到设备名下。
   * @param input - 归属信息。
   */
  const registerOwnership = async (input: OwnershipInput): Promise<void> => {
    const body = await request('gateway/ownership.write', OWNERSHIP_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: input.sessionId, deviceId: input.deviceId, cwd: input.cwd, kind: 'work' }),
    });
    if (body === undefined) throw new ShellApiError('request-failed', 200);
  };

  return {
    async listSessions(input: ListSessionsInput): Promise<SessionPage> {
      const search = new URLSearchParams({ limit: String(input.limit), q: input.query });
      if (input.deviceId !== undefined) search.set('deviceId', input.deviceId);
      if (input.cursor !== undefined) search.set('cursor', input.cursor);
      const body = await request('client/sessions.list', `${CLIENT_SESSIONS_PATH}?${search.toString()}`);
      if (!isSessionPage(body)) throw new ShellApiError('request-invalid', 200);
      return body;
    },

    async listDevices(): Promise<DeviceInfo[]> {
      const body = await request('gateway/devices.list', DEVICES_PATH);
      const devices = (body as { readonly devices?: unknown } | undefined)?.devices;
      if (!Array.isArray(devices)) throw new ShellApiError('request-invalid', 200);
      return devices.map((entry) => {
        const record = entry as Record<string, unknown>;
        if (
          typeof record['id'] !== 'string' ||
          typeof record['name'] !== 'string' ||
          typeof record['online'] !== 'boolean'
        ) {
          throw new ShellApiError('request-invalid', 200);
        }
        return {
          id: record['id'],
          name: record['name'],
          platform: typeof record['platform'] === 'string' ? record['platform'] : 'unknown',
          role: typeof record['role'] === 'string' ? record['role'] : 'unknown',
          online: record['online'],
          lastSeenAt: typeof record['lastSeenAt'] === 'number' ? record['lastSeenAt'] : 0,
        };
      });
    },

    async localRuntime(): Promise<LocalRuntime> {
      const body = await request('gateway/local.read', LOCAL_PATH);
      const record = (body ?? {}) as Record<string, unknown>;
      if (typeof record['available'] !== 'boolean' || typeof record['deviceId'] !== 'string') {
        throw new ShellApiError('request-invalid', 200);
      }
      return {
        available: record['available'],
        deviceId: record['deviceId'],
        ...(typeof record['reason'] === 'string' ? { reason: record['reason'] } : {}),
      };
    },

    async listDirectory(deviceId: string | undefined, path?: string): Promise<DirectoryListing> {
      const value = await rpc('directoryPicker/list', deviceId, 'directoryPicker/list', path);
      const record = (value ?? {}) as Record<string, unknown>;
      const crumbs = record['crumbs'];
      const entries = record['entries'];
      if (typeof record['path'] !== 'string' || typeof record['home'] !== 'string') {
        throw new ShellApiError('request-invalid', 200);
      }
      if (!Array.isArray(crumbs) || !Array.isArray(entries)) throw new ShellApiError('request-invalid', 200);
      const rows = (input: readonly unknown[]): DirectoryRow[] =>
        input.map((entry) => {
          const row = entry as Record<string, unknown>;
          if (typeof row['name'] !== 'string' || typeof row['path'] !== 'string') {
            throw new ShellApiError('request-invalid', 200);
          }
          return { name: row['name'], path: row['path'], hidden: row['hidden'] === true };
        });
      return {
        path: record['path'],
        home: record['home'],
        crumbs: rows(crumbs),
        entries: rows(entries),
        truncated: record['truncated'] === true,
      };
    },

    async createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
      const value = await rpc('session/create', input.deviceId, 'session/create', { request: { cwd: input.cwd } });
      const sessionId = (value as { readonly sessionId?: unknown } | undefined)?.sessionId;
      if (typeof sessionId !== 'string' || sessionId === '') throw new ShellApiError('request-invalid', 200);
      let ownershipWarning: string | undefined;
      try {
        await registerOwnership({ sessionId, deviceId: input.deviceId, cwd: input.cwd });
      } catch (error) {
        // 会话已经建出来：把编号交回界面，由用户显式重试归属，禁止再建一条。
        ownershipWarning = `会话已创建，但归属登记失败：${describeFailure(error, '登记会话归属')}`;
      }
      if (ownershipWarning !== undefined) return { sessionId, ownershipWarning };
      if (input.title === undefined || input.title === '') return { sessionId };
      try {
        await rpc('session/rename', input.deviceId, 'session/rename', {
          request: { sessionId, title: input.title },
        });
        return { sessionId };
      } catch (error) {
        return { sessionId, titleWarning: `会话已创建，但标题没有设上：${describeFailure(error, '设置标题')}` };
      }
    },

    async registerOwnership(input: OwnershipInput): Promise<void> {
      await registerOwnership(input);
    },

    async importSession(input: ImportSessionInput): Promise<ImportResult> {
      const body = await request('gateway/import', IMPORT_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourceSessionId: input.sourceSessionId, deviceId: input.deviceId, cwd: input.cwd }),
      });
      const record = (body ?? {}) as Record<string, unknown>;
      if (typeof record['sessionId'] !== 'string' || typeof record['parentSession'] !== 'string') {
        throw new ShellApiError('request-invalid', 200);
      }
      return {
        sessionId: record['sessionId'],
        parentSession: record['parentSession'],
        imported: typeof record['imported'] === 'number' ? record['imported'] : 0,
      };
    },

    async readReplica(sessionId: string): Promise<ReplicaEvent[]> {
      const body = await request(
        'gateway/replica.read',
        `${REPLICA_PATH}?sessionId=${encodeURIComponent(sessionId)}`
      );
      const events = (body as { readonly events?: unknown } | undefined)?.events;
      if (!Array.isArray(events) || !events.every(isReplicaEvent)) throw new ShellApiError('request-invalid', 200);
      return events;
    },
  };
}

/**
 * 把一次失败转成给用户的原因。
 *
 * 原因只描述动作与结果，不回显路径、令牌或响应原文。
 * @param error - 失败。
 * @param action - 正在执行的动作名称。
 * @returns 可读原因。
 */
export function describeFailure(error: unknown, action: string): string {
  if (error instanceof ShellApiError) {
    switch (error.code) {
      case 'device-offline':
        return `${action}失败：目标设备离线`;
      case 'device-unknown':
        return `${action}失败：目标设备不存在`;
      case 'auth-required':
      case 'access-session-revoked':
        return `${action}失败：访问会话已失效，请重新登录`;
      case 'object-not-found':
      case 'device-not-found':
        return `${action}失败：对象不存在`;
      case 'permission-denied':
        return `${action}失败：当前访问会话没有该权限`;
      case 'replica-unavailable':
        return `${action}失败：该会话没有可读副本`;
      case 'attachment-needs-source-device':
        return `${action}失败：附件需要源设备`;
      default:
        return `${action}失败：${error.code}`;
    }
  }
  if (error instanceof TypeError) return `${action}失败：控制平面不可达`;
  return `${action}失败：${error instanceof Error ? error.message : String(error)}`;
}
