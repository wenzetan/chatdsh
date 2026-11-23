/**
 * 中继与宿主端点的请求封装。
 *
 * 中继地址由调用方按设置给出；宿主端点始终走当前文档所在运行时。每个请求都套一个
 * `chatdsh.client.remote.call` span，失败时由遥测面补错误事件与计数。
 * @module @chatdsh/client-remote/api
 */

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
}

/** 遥测状态响应里本插件读取的字段。 */
export interface TelemetryStatusPayload {
  readonly enabled?: unknown;
  readonly reason?: unknown;
}

/** 中继与宿主端点的请求面。 */
export class RemoteGateway {
  constructor(
    private readonly relayBase: () => string,
    private readonly hostBase: () => string,
    private readonly telemetry: RemoteTelemetry,
  ) {}

  /** 列出中继登记的设备。 */
  devices(): Promise<DevicesPayload> {
    return this.telemetry.call('devices.list', (carrier) => this.get<DevicesPayload>(this.relayUrl('/chatdsh/gateway/devices'), carrier));
  }

  /** 列出按设备分组的会话。 */
  sessions(): Promise<SessionsPayload> {
    return this.telemetry.call('sessions.list', (carrier) => this.get<SessionsPayload>(this.relayUrl('/chatdsh/gateway/sessions'), carrier));
  }

  /**
   * 读取一个会话的只读副本。
   * @param sessionId - 会话标识。
   */
  replica(sessionId: string): Promise<ReplicaPayload> {
    const path = `/chatdsh/gateway/replica?sessionId=${encodeURIComponent(sessionId)}`;
    return this.telemetry.call('replica.read', (carrier) => this.get<ReplicaPayload>(this.relayUrl(path), carrier));
  }

  /**
   * 用一次性配对码登记一台执行节点。
   * @param code - 一次性配对码。
   * @param name - 设备显示名。
   * @param platform - 设备平台。
   */
  pair(code: string, name: string, platform: string): Promise<PairPayload> {
    const body = JSON.stringify({ code, name, platform, role: 'both', capabilities: ['http', 'websocket'] });
    return this.telemetry.call('device.pair', (carrier) => this.send<PairPayload>(this.relayUrl('/chatdsh/gateway/devices/pair'), body, carrier));
  }

  /** 读取当前运行时的设备标识。 */
  identity(): Promise<IdentityPayload> {
    return this.telemetry.call('device.identity', (carrier) => this.get<IdentityPayload>(this.hostUrl('/chatdsh/device/identity'), carrier));
  }

  /** 读取当前运行时的遥测开关状态。 */
  telemetryStatus(): Promise<TelemetryStatusPayload> {
    return this.telemetry.call('telemetry.status', (carrier) => this.get<TelemetryStatusPayload>(this.hostUrl('/chatdsh/telemetry/status'), carrier));
  }

  private relayUrl(path: string): string {
    const base = this.relayBase();
    return base === '' ? path : `${base}${path}`;
  }

  private hostUrl(path: string): string {
    const base = this.hostBase();
    return base === '' ? path : `${base}${path}`;
  }

  private async get<T>(url: string, carrier: TelemetryCarrier): Promise<T> {
    return this.read<T>(await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json', traceparent: carrier.traceparent },
      signal: AbortSignal.timeout(8000),
    }));
  }

  private async send<T>(url: string, body: string, carrier: TelemetryCarrier): Promise<T> {
    return this.read<T>(await fetch(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', traceparent: carrier.traceparent },
      body,
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
