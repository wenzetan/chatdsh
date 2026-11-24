/**
 * 中继与宿主端点的请求封装。
 *
 * 中继地址由调用方按设置给出；宿主端点始终走当前文档所在运行时。每个请求都套一个
 * `chatdsh.client.remote.call` span，失败时由遥测面补错误事件与计数。
 * @module @chatdsh/client-remote/api
 */

import { endpointOf, relayMode, type RelayMode } from './control-url.ts';
import type { DevicesPayload, ReplicaPayload, SessionsPayload } from './model.ts';
import type { RemoteTelemetry, TelemetryCarrier } from './telemetry.ts';

/** 请求失败：保留 HTTP 状态与中继给出的错误码。 */
export class RemoteHttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`${status} ${code}`);
    this.name = 'RemoteHttpError';
  }
}

/** 配对响应。 */
export interface PairPayload {
  readonly deviceId: string;
  readonly token: string;
}

/** 本机身份响应。 */
export interface IdentityPayload {
  readonly deviceId: string;
  readonly controlUrl?: string;
}

/** 遥测状态响应里本插件读取的字段。 */
export interface TelemetryStatusPayload {
  readonly enabled?: unknown;
  readonly reason?: unknown;
}

/** 远程取数端点。 */
export type RelayEndpoint = 'devices' | 'sessions' | 'replica' | 'pair';

/** 按通道模式生成请求的输入。 */
export interface RelayRequestOptions {
  /** 端点。 */
  readonly endpoint: RelayEndpoint;
  /** 归一化后的中继地址。 */
  readonly controlUrl: string;
  /** 当前页面所属宿主的路径前缀。 */
  readonly hostBase: string;
  /** 当前页面的来源。 */
  readonly origin: string;
  /** 会话标识；`replica` 端点必填。 */
  readonly sessionId?: string;
  /** 请求体；`pair` 端点使用。 */
  readonly body?: string;
  /** 当前请求的 W3C 链路上下文。 */
  readonly traceparent?: string;
}

/** 一次远程请求的地址、方法与请求头。 */
export interface RelayRequest {
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

const GATEWAY_PATHS: Readonly<Record<RelayEndpoint, string>> = {
  devices: '/chatdsh/gateway/devices',
  sessions: '/chatdsh/gateway/sessions',
  replica: '/chatdsh/gateway/replica',
  pair: '/chatdsh/gateway/devices/pair',
};

const RELAY_PATHS: Readonly<Record<RelayEndpoint, string>> = {
  devices: '/chatdsh/device/relay/devices',
  sessions: '/chatdsh/device/relay/sessions',
  replica: '/chatdsh/device/relay/replica',
  pair: '/chatdsh/device/relay/pair',
};

/**
 * 按取数通道模式生成一次远程请求。
 * @param options - 端点、地址读取结果与请求体。
 * @returns 可直接交给 `fetch` 的请求描述。
 */
export function relayRequestOf(options: RelayRequestOptions): RelayRequest {
  const mode: RelayMode = relayMode(options.controlUrl, options.origin);
  const method: 'GET' | 'POST' = options.endpoint === 'pair' ? 'POST' : 'GET';
  const query = options.endpoint === 'replica'
    ? `?sessionId=${encodeURIComponent(options.sessionId ?? '')}`
    : '';
  let url: string;
  if (mode === 'same-origin') {
    url = `${GATEWAY_PATHS[options.endpoint]}${query}`;
  } else if (mode === 'direct') {
    url = endpointOf(options.controlUrl, `${GATEWAY_PATHS[options.endpoint]}${query}`);
  } else {
    url = endpointOf(options.hostBase, `${RELAY_PATHS[options.endpoint]}${query}`);
  }
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.traceparent !== undefined && options.traceparent !== '') {
    headers.traceparent = options.traceparent;
  }
  if (method === 'POST') headers['content-type'] = 'application/json';
  if (mode === 'proxy') {
    headers['x-chatdsh-control-url'] = options.controlUrl;
    if (options.endpoint === 'pair') headers['x-chatdsh-csrf'] = '1';
  }
  return {
    url,
    method,
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  };
}

/** 中继与宿主端点的请求面。 */
export class RemoteGateway {
  constructor(
    private readonly controlUrl: () => string,
    private readonly hostBase: () => string,
    private readonly origin: () => string,
    private readonly telemetry: RemoteTelemetry,
  ) {}

  /** 列出中继登记的设备。 */
  devices(): Promise<DevicesPayload> {
    return this.telemetry.call('devices.list', (carrier) => this.execute<DevicesPayload>(relayRequestOf({
      endpoint: 'devices',
      controlUrl: this.controlUrl(),
      hostBase: this.hostBase(),
      origin: this.origin(),
      traceparent: carrier.traceparent,
    })));
  }

  /** 列出按设备分组的会话。 */
  sessions(): Promise<SessionsPayload> {
    return this.telemetry.call('sessions.list', (carrier) => this.execute<SessionsPayload>(relayRequestOf({
      endpoint: 'sessions',
      controlUrl: this.controlUrl(),
      hostBase: this.hostBase(),
      origin: this.origin(),
      traceparent: carrier.traceparent,
    })));
  }

  /**
   * 读取一个会话的只读副本。
   * @param sessionId - 会话标识。
   */
  replica(sessionId: string): Promise<ReplicaPayload> {
    return this.telemetry.call('replica.read', (carrier) => this.execute<ReplicaPayload>(relayRequestOf({
      endpoint: 'replica',
      controlUrl: this.controlUrl(),
      hostBase: this.hostBase(),
      origin: this.origin(),
      sessionId,
      traceparent: carrier.traceparent,
    })));
  }

  /**
   * 用一次性配对码登记一台执行节点。
   * @param code - 一次性配对码。
   * @param name - 设备显示名。
   * @param platform - 设备平台。
   */
  pair(code: string, name: string, platform: string): Promise<PairPayload> {
    const body = JSON.stringify({ code, name, platform, role: 'both', capabilities: ['http', 'websocket'] });
    return this.telemetry.call('device.pair', (carrier) => this.execute<PairPayload>(relayRequestOf({
      endpoint: 'pair',
      controlUrl: this.controlUrl(),
      hostBase: this.hostBase(),
      origin: this.origin(),
      body,
      traceparent: carrier.traceparent,
    })));
  }

  /** 读取当前运行时的设备标识。 */
  identity(): Promise<IdentityPayload> {
    return this.telemetry.call('device.identity', (carrier) => this.get<IdentityPayload>(this.hostUrl('/chatdsh/device/identity'), carrier));
  }

  /** 读取当前运行时的遥测开关状态。 */
  telemetryStatus(): Promise<TelemetryStatusPayload> {
    return this.telemetry.call('telemetry.status', (carrier) => this.get<TelemetryStatusPayload>(this.hostUrl('/chatdsh/telemetry/status'), carrier));
  }

  private hostUrl(path: string): string {
    const base = this.hostBase();
    return base === '' ? path : `${base}${path}`;
  }

  private async execute<T>(request: RelayRequest): Promise<T> {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body }),
      signal: AbortSignal.timeout(8000),
    });
    return this.read<T>(response);
  }

  private async get<T>(url: string, carrier: TelemetryCarrier): Promise<T> {
    return this.read<T>(await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json', traceparent: carrier.traceparent },
      signal: AbortSignal.timeout(8000),
    }));
  }

  private async read<T>(response: Response): Promise<T> {
    const text = await response.text();
    let body: unknown;
    if (text.trim() !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        throw new RemoteHttpError(response.status, 'invalid-json');
      }
    }
    if (!response.ok) {
      const code = typeof body === 'object' && body !== null
        && typeof (body as { readonly error?: unknown }).error === 'string'
        ? (body as { readonly error: string }).error
        : `http-${response.status}`;
      throw new RemoteHttpError(response.status, code);
    }
    if (body === undefined) throw new RemoteHttpError(response.status, 'empty-response');
    return body as T;
  }
}
