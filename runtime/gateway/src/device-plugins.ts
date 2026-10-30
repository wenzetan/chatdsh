/**
 * 按设备取插件清单：沿设备长连接调该设备运行时的插件管理服务。
 *
 * DSH 侧的插件管理服务是 `dsh-plugin-manager`，它把一元 Remote 端点登记成
 * `/api/<命名空间>/<方法>`。实测确认的端点名：
 *
 * - `pluginManager/listBundles`：组合包列表，每项带它补丁层插入的行与覆盖的行；
 * - `pluginManager/listPlugins`：插件行列表，即装载树里的条目与它当前的生命周期阶段。
 *
 * 两个端点都在 `/api/` 前缀下，要求运行时的界面凭据；设备长连接替本设备的界面补发这份
 * 凭据（没有自带凭据的请求），因此控制平面这边只按远端调用协议发一次请求。
 * @module @chatdsh/gateway/device-plugins
 */

import { randomUUID } from 'node:crypto';
import type { TelemetryCarrier } from '@chatdsh/core-contracts';
import type { DeviceLinkHub } from './device-link.ts';

/** 组合包列表的 Remote 端点名。 */
export const BUNDLES_ENDPOINT = 'pluginManager/listBundles';

/** 插件行列表的 Remote 端点名。 */
export const PLUGINS_ENDPOINT = 'pluginManager/listPlugins';

/** 取插件清单的超时；插件管理读的是本机包目录，比普通转发宽。 */
export const DEVICE_PLUGINS_TIMEOUT_MS = 30_000;

/** 远端调用失败的取值。 */
export type DevicePluginsErrorCode =
  | 'device-remote-failed'
  | 'device-remote-rejected'
  | 'device-remote-invalid';

/** 远端调用失败。调用方按 `code` 决定回给客户端的状态码。 */
export class DevicePluginsError extends Error {
  /** 失败取值。 */
  readonly code: DevicePluginsErrorCode;
  /** 设备运行时回的状态码；响应体解析失败时为空。 */
  readonly upstreamStatus: number | undefined;

  constructor(code: DevicePluginsErrorCode, upstreamStatus?: number) {
    super(code);
    this.name = 'DevicePluginsError';
    this.code = code;
    this.upstreamStatus = upstreamStatus;
  }
}

/** 一台设备的插件清单。 */
export interface DevicePluginsSnapshot {
  readonly deviceId: string;
  /** 组合包：包名、可用性、启用状态，以及补丁层插入与覆盖的行。 */
  readonly bundles: readonly unknown[];
  /** 插件行：装载树条目与生命周期阶段。 */
  readonly plugins: readonly unknown[];
}

/** 取清单的输入。 */
export interface FetchDevicePluginsOptions {
  readonly deviceLink: DeviceLinkHub;
  readonly deviceId: string;
  readonly timeoutMs?: number;
  /** 跨边界传播的追踪头；设备侧带着它调本机运行时，请求因此串在同一条调用链上。 */
  readonly traceHeaders?: TelemetryCarrier;
}

/**
 * 调一次设备运行时上的一元 Remote 端点。
 * @param options - 设备连接、设备标识、端点名与超时。
 * @returns 端点返回的值。
 */
async function callRemote(options: FetchDevicePluginsOptions & { readonly endpoint: string }): Promise<unknown> {
  const rpcId = randomUUID();
  const body = Buffer.from(JSON.stringify({
    type: 'client-request',
    rpcId,
    method: options.endpoint,
    payload: { args: {} },
  }), 'utf8');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  for (const [key, value] of Object.entries(options.traceHeaders ?? {})) {
    if (value !== undefined && value !== '') headers[key] = value;
  }
  const reply = await options.deviceLink.sendRequest(options.deviceId, {
    method: 'POST',
    path: `/api/${options.endpoint}`,
    headers,
    body,
  }, options.timeoutMs ?? DEVICE_PLUGINS_TIMEOUT_MS);
  if (reply.status !== 200) throw new DevicePluginsError('device-remote-failed', reply.status);
  const envelope = JSON.parse(reply.body.toString('utf8')) as {
    result?: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } };
  };
  const result = envelope.result;
  if (result === undefined) throw new DevicePluginsError('device-remote-invalid', reply.status);
  if (result.ok !== true) throw new DevicePluginsError('device-remote-rejected', reply.status);
  return result.value;
}

/**
 * 取一台设备的组合包与插件行。
 *
 * 设备离线时由调用方先行判断，这里假定连接在线；长连接中途断开按 `DeviceLinkError`
 * 原样抛出，调用方按它给出的错误码回状态码。
 * @param options - 设备连接、设备标识与超时。
 * @returns 组合包与插件行，内容取自设备运行时的响应。
 */
export async function fetchDevicePlugins(options: FetchDevicePluginsOptions): Promise<DevicePluginsSnapshot> {
  const bundles = await callRemote({ ...options, endpoint: BUNDLES_ENDPOINT });
  const plugins = await callRemote({ ...options, endpoint: PLUGINS_ENDPOINT });
  if (!Array.isArray(bundles) || !Array.isArray(plugins)) {
    throw new DevicePluginsError('device-remote-invalid');
  }
  return { deviceId: options.deviceId, bundles, plugins };
}
