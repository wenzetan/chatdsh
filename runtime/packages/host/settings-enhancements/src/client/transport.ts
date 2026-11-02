/**
 * 浏览器侧的数据传输。
 *
 * Remote 调用走宿主界面的 `/api/<命名空间>/<方法>` 端点：请求体是客户端请求信封，应答体
 * 是服务端应答信封，失败带上稳定错误码。设置同步的表单与作用范围表走同一台宿主的
 * `/chatdsh/device/settings/*` 路径。两条路径都同源，凭据由浏览器随请求带上。
 * @module @chatdsh/host-settings-enhancements/transport
 */

import { SettingsCallError, type RemoteCaller, type RemoteArgs } from './types.ts';

/** Remote 端点的前缀。 */
export const API_PREFIX = '/api/';

/** 设置表单路径。 */
export const SETTINGS_FORM_PATH = '/chatdsh/device/settings/form';

/** 最新版本路径。 */
export const SETTINGS_LATEST_PATH = '/chatdsh/device/settings/latest';

/** 作用范围路径。 */
export const SETTINGS_SCOPES_PATH = '/chatdsh/device/settings/scopes';

/** 同步状态路径。 */
export const SETTINGS_SYNC_PATH = '/chatdsh/device/settings/sync';

/** 构造调用器所需的依赖。 */
export interface CallerOptions {
  /** 发请求的实现；浏览器里是全局 `fetch`。 */
  readonly fetchImpl?: typeof fetch;
  /** 端点前缀。 */
  readonly prefix?: string;
}

/** 应答信封。 */
interface ResponseEnvelope {
  readonly type?: string;
  readonly rpcId?: string;
  readonly result?: {
    readonly ok?: boolean;
    readonly value?: unknown;
    readonly error?: { readonly code?: string; readonly message?: string; readonly details?: unknown };
  };
}

/**
 * 建立同源 Remote 调用器。
 * @param options - 依赖覆盖。
 * @returns 调用器。
 */
export function createHttpCaller(options: CallerOptions = {}): RemoteCaller {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const prefix = options.prefix ?? API_PREFIX;
  let sequence = 0;
  return {
    async call<T>(endpoint: string, args: RemoteArgs): Promise<T> {
      sequence += 1;
      const response = await fetchImpl(`${prefix}${endpoint}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: `chatdsh-settings-${String(sequence)}`,
          method: endpoint,
          payload: { args },
        }),
      });
      if (!response.ok) {
        throw new SettingsCallError('gateway/unreachable', `设置接口返回 ${String(response.status)}`);
      }
      const body = (await response.json()) as ResponseEnvelope;
      const result = body.result;
      if (result === undefined) throw new SettingsCallError('gateway/internal', '设置接口的应答缺少结果字段');
      if (result.ok !== true) {
        throw new SettingsCallError(
          result.error?.code ?? 'gateway/internal',
          result.error?.message ?? '设置调用失败',
          result.error?.details,
        );
      }
      return result.value as T;
    },
  };
}

/**
 * 读一个同源 JSON 端点。
 * @param path - 路径。
 * @param fetchImpl - 发请求的实现。
 * @returns 解析后的应答体。
 */
export async function readJson(path: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<unknown> {
  const response = await fetchImpl(path, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  if (!response.ok) throw new SettingsCallError('gateway/unreachable', `接口 ${path} 返回 ${String(response.status)}`);
  return await response.json() as unknown;
}
