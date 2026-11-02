/**
 * 设备面板的数据入口。
 *
 * 设备属于控制平面，面板按同源相对路径访问设备管理接口。每个响应都按契约字段逐项校验，
 * 形状不符直接失败，界面据此给出「控制平面返回的形状不符合约定」。设备凭据由宿主在页面
 * 里提供，随请求头 `x-chatdsh-device-token` 送出；写操作另带 `x-chatdsh-csrf`。配对响应里
 * 的节点令牌只交给新设备的安全存储，本面板不请求也不读取它。
 * @module @chatdsh/client-account/gateway
 */

import { browserTelemetry } from './telemetry.ts';
import type {
  AccessClient,
  Device,
  DeviceGateway,
  DeviceList,
  DeviceRole,
  LinkCheck,
  PanelTelemetry,
  PairingCode,
  RevokeResult,
} from './types.ts';

/** 设备列表路径。 */
export const DEVICES_PATH = '/chatdsh/gateway/devices';

/** 配对码签发路径。 */
export const PAIRING_PATH = '/chatdsh/gateway/devices/pairing';

/** 撤销路径。 */
export const REVOKE_PATH = '/chatdsh/gateway/devices/revoke';

/** 链路检查路径。 */
export const LINK_CHECK_PATH = '/chatdsh/gateway/devices/link-check';

/** 设备凭据请求头。控制平面按它解析访问客户端或执行节点的身份。 */
export const DEVICE_TOKEN_HEADER = 'x-chatdsh-device-token';

/** 写操作要求的请求头，跨站表单无法携带。 */
export const CSRF_HEADER = 'x-chatdsh-csrf';

/** 一次设备管理调用失败。 */
export class DeviceCallError extends Error {
  /**
   * @param code - 错误码，取自控制平面响应或本入口自己的失败码。
   * @param status - HTTP 状态码；网络失败时为 0。
   * @param retryAfterMs - 限流时的剩余等待时长。
   */
  constructor(readonly code: string, readonly status: number, readonly retryAfterMs?: number) {
    super(`${code}（${String(status)}）`);
    this.name = 'DeviceCallError';
  }
}

/** 宿主提供的浏览器设备凭据。装配访问认证之后由宿主注入。 */
export type DeviceCredentialSource = () => string | undefined;

/** 数据入口的构造依赖。 */
export interface DeviceGatewayOptions {
  /** 发请求的实现；浏览器里是全局 `fetch`。 */
  readonly fetchImpl?: typeof fetch;
  /** 遥测面。 */
  readonly telemetry?: PanelTelemetry;
  /** 设备凭据来源。 */
  readonly credential?: DeviceCredentialSource;
}

/** 一次请求的参数。 */
interface DeviceRequest {
  readonly method?: 'GET' | 'POST';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /** 写操作：补上跨站请求头。 */
  readonly write?: boolean;
}

/** 断言响应体是一个对象。 */
function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DeviceCallError('gateway/invalid-response', 200);
  }
  return value as Record<string, unknown>;
}

/** 读一个必填字符串字段。 */
function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value === '') throw new DeviceCallError('gateway/invalid-response', 200);
  return value;
}

/** 读一个必填布尔字段。 */
function requireBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') throw new DeviceCallError('gateway/invalid-response', 200);
  return value;
}

/** 读一个必填的非负整数字段。 */
function requireCount(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new DeviceCallError('gateway/invalid-response', 200);
  }
  return value;
}

/** 读一个可选的非负整数字段。 */
function optionalCount(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new DeviceCallError('gateway/invalid-response', 200);
  }
  return value;
}

/** 读一个角色取值。 */
function requireRole(record: Record<string, unknown>): DeviceRole {
  const value = record['role'];
  if (value !== 'host' && value !== 'executor' && value !== 'both') {
    throw new DeviceCallError('gateway/invalid-response', 200);
  }
  return value;
}

/** 校验一条执行节点记录。 */
function parseDevice(value: unknown): Device {
  const record = requireRecord(value);
  const capabilities = record['capabilities'];
  if (!Array.isArray(capabilities) || capabilities.some((item) => typeof item !== 'string')) {
    throw new DeviceCallError('gateway/invalid-response', 200);
  }
  const revokedAt = optionalCount(record, 'revokedAt');
  return {
    id: requireString(record, 'id'),
    name: requireString(record, 'name'),
    platform: requireString(record, 'platform'),
    role: requireRole(record),
    capabilities: capabilities as string[],
    createdAt: requireCount(record, 'createdAt'),
    lastSeenAt: requireCount(record, 'lastSeenAt'),
    online: requireBoolean(record, 'online'),
    currentExecutor: requireBoolean(record, 'currentExecutor'),
    ...(revokedAt === undefined ? {} : { revokedAt }),
  };
}

/** 校验一条访问客户端记录。 */
function parseAccessClient(value: unknown): AccessClient {
  const record = requireRecord(value);
  const revokedAt = optionalCount(record, 'revokedAt');
  return {
    id: requireString(record, 'id'),
    name: requireString(record, 'name'),
    platform: requireString(record, 'platform'),
    createdAt: requireCount(record, 'createdAt'),
    lastSeenAt: requireCount(record, 'lastSeenAt'),
    current: requireBoolean(record, 'current'),
    ...(revokedAt === undefined ? {} : { revokedAt }),
  };
}

/**
 * 校验设备列表。
 * @param value - 响应体。
 * @returns 分组列表。
 */
export function parseDeviceList(value: unknown): DeviceList {
  const record = requireRecord(value);
  const nodes = record['nodes'];
  const accessClients = record['accessClients'];
  if (!Array.isArray(nodes) || !Array.isArray(accessClients)) {
    throw new DeviceCallError('gateway/invalid-response', 200);
  }
  return { nodes: nodes.map(parseDevice), accessClients: accessClients.map(parseAccessClient) };
}

/**
 * 校验一次签发的配对码。
 * @param value - 响应体。
 * @returns 配对码与手填载荷。
 */
export function parsePairingCode(value: unknown): PairingCode {
  const record = requireRecord(value);
  const kind = record['kind'];
  if (kind !== 'qr' && kind !== 'manual') throw new DeviceCallError('gateway/invalid-response', 200);
  return {
    kind,
    controlUrl: requireString(record, 'controlUrl'),
    code: requireString(record, 'code'),
    expiresAt: requireCount(record, 'expiresAt'),
    encoded: requireString(record, 'encoded'),
  };
}

/**
 * 校验撤销结果。
 * @param value - 响应体。
 * @returns 撤销结果。
 */
export function parseRevokeResult(value: unknown): RevokeResult {
  const record = requireRecord(value);
  if (record['sessionsPreserved'] !== true) throw new DeviceCallError('gateway/invalid-response', 200);
  return {
    deviceId: requireString(record, 'deviceId'),
    revokedAt: requireCount(record, 'revokedAt'),
    closedLinks: requireCount(record, 'closedLinks'),
    sessionsPreserved: true,
  };
}

/**
 * 校验链路检查结果。
 * @param value - 响应体。
 * @returns 检查结果。
 */
export function parseLinkCheck(value: unknown): LinkCheck {
  const record = requireRecord(value);
  const latency = optionalCount(record, 'latencyMs');
  const code = record['code'];
  if (code !== undefined && (typeof code !== 'string' || code === '')) {
    throw new DeviceCallError('gateway/invalid-response', 200);
  }
  return {
    deviceId: requireString(record, 'deviceId'),
    checkedAt: requireCount(record, 'checkedAt'),
    reachable: requireBoolean(record, 'reachable'),
    ...(latency === undefined ? {} : { latencyMs: latency }),
    ...(code === undefined ? {} : { code }),
  };
}

/** 从失败响应里取错误码与等待时长。 */
async function failureOf(response: Response): Promise<DeviceCallError> {
  const text = await response.text();
  let body: unknown;
  try {
    body = text === '' ? undefined : JSON.parse(text);
  } catch {
    throw new DeviceCallError('request-failed', response.status);
  }
  if (typeof body !== 'object' || body === null) return new DeviceCallError('request-failed', response.status);
  const record = body as Record<string, unknown>;
  const code = typeof record['error'] === 'string' && record['error'] !== '' ? record['error'] : 'request-failed';
  const retryAfterMs = typeof record['retryAfterMs'] === 'number' ? record['retryAfterMs'] : undefined;
  return new DeviceCallError(code, response.status, retryAfterMs);
}

/**
 * 建立真实的设备数据入口。
 * @param options - 依赖。
 * @returns 数据入口。
 */
export function createDeviceGateway(options: DeviceGatewayOptions = {}): DeviceGateway {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const telemetry = options.telemetry ?? browserTelemetry;
  const credential = options.credential;

  /**
   * 发起一次设备管理请求。
   * @param method - 遥测调用名。
   * @param path - 请求路径。
   * @param request - 请求参数。
   * @returns 响应体。
   */
  const send = async (method: string, path: string, request: DeviceRequest = {}): Promise<unknown> =>
    await telemetry.run(method, async () => {
      const token = credential?.();
      const headers: Record<string, string> = { accept: 'application/json', ...request.headers };
      if (token !== undefined) headers[DEVICE_TOKEN_HEADER] = token;
      if (request.write === true) headers[CSRF_HEADER] = '1';
      const init: RequestInit = { headers, credentials: 'same-origin' };
      if (request.method !== undefined) init.method = request.method;
      if (request.body !== undefined) init.body = request.body;
      const response = await fetchImpl(path, init).catch(() => {
        throw new DeviceCallError('gateway/offline', 0);
      });
      if (!response.ok) throw await failureOf(response);
      const text = await response.text();
      return text === '' ? undefined : (JSON.parse(text) as unknown);
    });

  return {
    async list(): Promise<DeviceList> {
      return parseDeviceList(await send('devices/list', DEVICES_PATH));
    },

    async issuePairing(kind: 'qr' | 'manual'): Promise<PairingCode> {
      return parsePairingCode(await send('devices/pairing', `${PAIRING_PATH}?kind=${kind}`));
    },

    async revoke(deviceId: string, reason: 'user' | 'lost' | 'rotate'): Promise<RevokeResult> {
      return parseRevokeResult(await send('devices/revoke', REVOKE_PATH, {
        method: 'POST',
        write: true,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId, reason }),
      }));
    },

    async checkLink(deviceId: string): Promise<LinkCheck> {
      return parseLinkCheck(await send('devices/link-check', `${LINK_CHECK_PATH}?deviceId=${encodeURIComponent(deviceId)}`));
    },

    noteAction(action, outcome): void {
      telemetry.action(action, outcome);
    },
  };
}
