/**
 * 桌面控制面板的同源数据入口。
 *
 * 每个方法对应宿主的一条路径，写操作带上 `x-chatdsh-csrf` 请求头。失败一律抛出
 * `ControlCallError`，代码与宿主返回的一致，界面据此给出具体说明。
 * @module @chatdsh/client-desktop-control/gateway
 */

import {
  ERROR_LABELS,
  type AuditEntry,
  type ConfirmResult,
  type ControlGateway,
  type ControlState,
  type PendingView,
  type PermitView,
  type PermissionState,
  type RequestInput,
} from './types.ts';

/** 路由前缀。 */
export const CONTROL_PREFIX = '/chatdsh/desktop-control';

/** 写操作要求的来源校验头。 */
export const CSRF_HEADER = 'x-chatdsh-csrf';

/** 一次调用失败。 */
export class ControlCallError extends Error {
  /** 失败代码。 */
  readonly code: string;

  /**
   * @param code - 失败代码。
   * @param detail - 说明。
   */
  constructor(code: string, detail?: string) {
    super(detail ?? ERROR_LABELS[code] ?? '桌面控制没有完成这次请求');
    this.name = 'ControlCallError';
    this.code = code;
  }
}

/** 数据入口的依赖。 */
export interface ControlGatewayOptions {
  /** 路由前缀。 */
  readonly prefix?: string;
  /** 发请求的实现。 */
  readonly fetchImpl?: typeof fetch;
}

/**
 * 建立数据入口。
 * @param options - 前缀与请求实现。
 * @returns 数据入口。
 */
export function createControlGateway(options: ControlGatewayOptions = {}): ControlGateway {
  const prefix = options.prefix ?? CONTROL_PREFIX;
  const request = options.fetchImpl ?? fetch;

  /** 发出一次请求并解析结果。 */
  async function call<T>(path: string, init?: { readonly method: 'GET' | 'POST'; readonly body?: unknown }): Promise<T> {
    const method = init?.method ?? 'GET';
    const response = await request(`${prefix}${path}`, {
      method,
      headers: method === 'POST'
        ? { 'content-type': 'application/json', [CSRF_HEADER]: '1' }
        : undefined,
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await response.text();
    const payload = text === '' ? {} : JSON.parse(text) as Record<string, unknown>;
    if (!response.ok) {
      const code = typeof payload.error === 'string' ? payload.error : 'control-failed';
      const detail = typeof payload.detail === 'string' ? payload.detail : ERROR_LABELS[code];
      throw new ControlCallError(code, detail);
    }
    return payload as T;
  }

  return {
    async state(): Promise<ControlState> {
      const payload = await call<{ state: ControlState }>('/state');
      return payload.state;
    },
    async request(input: RequestInput): Promise<PendingView> {
      const payload = await call<{ pending: PendingView }>('/request', { method: 'POST', body: input });
      return payload.pending;
    },
    async confirm(input): Promise<{ result: ConfirmResult; state: ControlState }> {
      return call<{ result: ConfirmResult; state: ControlState }>('/confirm', { method: 'POST', body: input });
    },
    async checkPermissions(): Promise<{ permissions: PermissionState; state: ControlState }> {
      return call<{ permissions: PermissionState; state: ControlState }>('/check-permissions', { method: 'POST', body: {} });
    },
    async action(input): Promise<PermitView> {
      const payload = await call<{ permit: PermitView }>('/action', { method: 'POST', body: input });
      return payload.permit;
    },
    async endAction(input): Promise<ControlState> {
      const payload = await call<{ state: ControlState }>('/action/end', { method: 'POST', body: input });
      return payload.state;
    },
    async pause(paused: boolean): Promise<ControlState> {
      const payload = await call<{ state: ControlState }>('/pause', { method: 'POST', body: { paused } });
      return payload.state;
    },
    async interrupt(reason: string): Promise<ControlState> {
      const payload = await call<{ state: ControlState }>('/interrupt', { method: 'POST', body: { reason } });
      return payload.state;
    },
    async audit(limit?: number): Promise<readonly AuditEntry[]> {
      const query = limit === undefined ? '' : `?limit=${limit}`;
      const payload = await call<{ entries: AuditEntry[] }>(`/audit${query}`);
      return payload.entries;
    },
  };
}
