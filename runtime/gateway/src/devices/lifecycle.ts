/**
 * 设备生命周期：配对、分组列表、撤销与链路检查。
 *
 * 执行节点与访问客户端是同一张设备面上的两类：节点拨出长连接承载执行，访问客户端从
 * 浏览器或手机接入控制平面。配对码换节点令牌之后，令牌只保存摘要；撤销把该设备名下的
 * HTTP 请求、WebSocket 连接与 SSE 流立即关闭，历史会话与副本记录保持不动。链路检查沿
 * 节点的长连接发一次最小请求，用往返耗时给出在线与延迟结论。
 * @module @chatdsh/gateway/devices/lifecycle
 */

import { randomBytes, randomUUID } from 'node:crypto';
import {
  deviceLinkCheckSchema,
  deviceListSchema,
  deviceRevokeResultSchema,
  deviceSchema,
  accessClientSchema,
  pairingCodeSchema,
  pairingResultSchema,
  type ChatdshErrorCode,
  type ChatdshTelemetry,
  type Device,
  type DeviceLinkCheck,
  type DeviceList,
  type DeviceRevokeRequest,
  type DeviceRevokeResult,
  type PairingCode,
  type PairingRequest,
  type PairingResult,
} from '@chatdsh/core-contracts';
import type { GatewayStore } from '../store.ts';
import { deviceTokenHash } from '../mobile-http.ts';
import { DeviceLinkError, type DeviceLinkHub, type DeviceLinkErrorCode } from '../device-link.ts';
import { resolveDeviceCredential, type DeviceCredentialResult, type DevicePrincipal } from './credential.ts';
import type { PairingRejectionCode, PairingService } from './pairing.ts';
import type { DeviceTransportRegistry } from './transports.ts';

/** 链路检查默认超时，单位毫秒。 */
export const LINK_CHECK_TIMEOUT_MS = 10_000;

/** 链路检查沿节点连接请求的路径。 */
export const LINK_CHECK_PATH = '/healthz';

/** 拒绝的类别，写入 span 与事件的 `error.type`。 */
export type DeviceErrorType = 'request' | 'auth' | 'config' | 'link' | 'internal';

/** 设备生命周期里的业务拒绝。路由按 `status` 回状态码，按 `code` 回错误码。 */
export class DeviceError extends Error {
  constructor(
    readonly status: number,
    readonly code: ChatdshErrorCode,
    readonly type: DeviceErrorType,
    readonly retryAfterMs?: number
  ) {
    super(code);
    this.name = 'DeviceError';
  }
}

/** 一次配对的结果：契约字段加设备本身。 */
export interface PairingOutcome {
  readonly result: PairingResult;
  readonly device: Device;
}

/** 设备生命周期的构造输入。 */
export interface DeviceLifecycleOptions {
  readonly store: GatewayStore;
  readonly telemetry: ChatdshTelemetry;
  readonly deviceLink: DeviceLinkHub;
  readonly transports: DeviceTransportRegistry;
  readonly pairing: PairingService;
  /** 控制平面对外地址；配对请求里的目标地址必须与它一致。 */
  readonly controlUrl: string;
  /** 控制平面所在宿主节点的设备标识，用于访问客户端请求时的当前执行设备标记。 */
  readonly currentExecutorId?: string;
  /** 链路检查超时，缺省 {@link LINK_CHECK_TIMEOUT_MS}。 */
  readonly linkCheckTimeoutMs?: number;
}

/** 撤销时关闭的通道数量，按种类给出。 */
export interface RevokeCloseCounts {
  readonly closed: number;
  readonly http: number;
  readonly websocket: number;
  readonly sse: number;
}

/** 撤销结果与关闭统计。 */
export interface RevokeOutcome {
  readonly result: DeviceRevokeResult;
  readonly closed: RevokeCloseCounts;
}

/** 链路上的撤销码到跨组件错误码的收敛。 */
function unreachableCodeOf(code: DeviceLinkErrorCode): ChatdshErrorCode {
  if (code === 'device-revoked') return 'device-token-revoked';
  if (code === 'device-path-invalid' || code === 'device-channel-limit' || code === 'device-channel-reset'
    || code === 'device-channel-cancelled' || code === 'device-buffer-exceeded' || code === 'device-upgrade-rejected') {
    return 'internal-error';
  }
  return 'device-offline';
}

/** 配对拒绝码对应的状态码与类别。 */
function pairingErrorOf(code: PairingRejectionCode, retryAfterMs?: number): DeviceError {
  if (code === 'pairing-code-invalid') return new DeviceError(401, 'pairing-code-invalid', 'auth');
  if (code === 'pairing-code-expired') return new DeviceError(403, 'pairing-code-expired', 'auth');
  return new DeviceError(429, 'pairing-rate-limited', 'auth', retryAfterMs);
}

/** 设备生命周期。 */
export class DeviceLifecycle {
  private readonly store: GatewayStore;
  private readonly telemetryRef: ChatdshTelemetry;
  private readonly deviceLink: DeviceLinkHub;
  private readonly transports: DeviceTransportRegistry;
  private readonly pairing: PairingService;
  private readonly controlUrl: string;
  private readonly currentExecutorId: string | undefined;
  private readonly linkCheckTimeoutMs: number;
  private readonly nodeRevokedAt = new Map<string, number>();

  constructor(options: DeviceLifecycleOptions) {
    this.store = options.store;
    this.telemetryRef = options.telemetry;
    this.deviceLink = options.deviceLink;
    this.transports = options.transports;
    this.pairing = options.pairing;
    this.controlUrl = options.controlUrl;
    this.currentExecutorId = options.currentExecutorId;
    this.linkCheckTimeoutMs = options.linkCheckTimeoutMs ?? LINK_CHECK_TIMEOUT_MS;
  }

  /** 配对码登记；签发路由与手机通道共用同一个实例。 */
  get pairingCodes(): PairingService {
    return this.pairing;
  }

  /** 设备是否已被撤销：执行节点看长连接中枢的撤销记录，访问客户端看存储里的吊销标记。 */
  isRevoked(deviceId: string): boolean {
    if (this.deviceLink.isRevoked(deviceId)) return true;
    return this.store.listMobileDevices().some((record) => record.id === deviceId && record.revokedAt !== undefined);
  }

  /** 解析请求里的设备凭据。 */
  authenticate(request: Parameters<typeof resolveDeviceCredential>[0]): DeviceCredentialResult {
    return resolveDeviceCredential(request, { store: this.store, isRevoked: (id) => this.isRevoked(id) });
  }

  /** 签发一次性配对码。 */
  issuePairingCode(kind: 'qr' | 'manual'): PairingCode {
    return this.telemetryRef.runSpanSync('chatdsh.gateway.mobile.pairing', {}, (span) => {
      const issued = this.pairing.issue({ controlUrl: this.controlUrl, kind });
      span.setAttribute('outcome', 'issued');
      return pairingCodeSchema.parse({
        kind: issued.kind,
        controlUrl: issued.controlUrl,
        code: issued.code,
        expiresAt: issued.expiresAt,
      });
    });
  }

  /**
   * 用一次性配对码登记一台执行节点。
   * @param request - 已通过结构校验的配对请求。
   * @param source - 来源地址，用于失败尝试限流。
   */
  pair(request: PairingRequest, source: string): PairingOutcome {
    return this.telemetryRef.runSpanSync('chatdsh.gateway.device.pair', { platform: request.platform }, (span) => {
      const fail = (error: DeviceError): never => {
        span.setAttribute('outcome', 'rejected');
        span.setAttribute('error.type', error.type);
        span.setAttribute('error.code', error.code);
        this.telemetryRef.event('chatdsh.gateway.device.rejected', {
          action: 'pair',
          outcome: 'rejected',
          'error.type': error.type,
          'error.code': error.code,
        });
        this.telemetryRef.counter('chatdsh_gateway_device_pairs_total', { description: '节点配对次数' })
          .add(1, { outcome: 'rejected' });
        throw error;
      };
      if (sameControlUrl(request.controlUrl, this.controlUrl) === false) {
        fail(new DeviceError(400, 'origin-rejected', 'request'));
      }
      const consumed = this.pairing.consume(request.code, source);
      if (consumed.ok === false) fail(pairingErrorOf(consumed.code, consumed.retryAfterMs));
      const token = randomBytes(32).toString('base64url');
      const record = this.store.registerNode({
        id: randomUUID(),
        name: request.name,
        platform: request.platform,
        role: request.role,
        capabilities: [],
        tokenHash: deviceTokenHash(token),
      });
      const device = deviceSchema.parse({
        id: record.id,
        name: record.name,
        platform: record.platform,
        role: record.role,
        capabilities: [...record.capabilities],
        createdAt: record.createdAt,
        lastSeenAt: record.lastSeenAt,
        online: this.deviceLink.online(record.id),
        currentExecutor: record.id === this.currentExecutorId,
      });
      span.setAttribute('outcome', 'paired');
      this.telemetryRef.counter('chatdsh_gateway_device_pairs_total', { description: '节点配对次数' })
        .add(1, { outcome: 'ok' });
      const result = pairingResultSchema.parse({
        deviceId: record.id,
        role: record.role,
        pairedAt: record.createdAt,
        nodeToken: token,
      });
      return { result, device };
    });
  }

  /** 分组列出访问客户端与执行节点，带当前标记。 */
  listDevices(principal: DevicePrincipal): DeviceList {
    return this.telemetryRef.runSpanSync('chatdsh.gateway.mobile.devices', { action: 'list' }, (span) => {
      const failed = (error: unknown): never => {
        span.setAttribute('outcome', 'rejected');
        span.setAttribute('error.type', 'internal');
        span.setAttribute('error.code', 'internal-error');
        this.telemetryRef.event('chatdsh.gateway.mobile.rejected', {
          action: 'list',
          outcome: 'rejected',
          'error.type': 'internal',
          'error.code': 'internal-error',
        });
        this.telemetryRef.counter('chatdsh_mobile_devices_total', { description: '设备管理操作' })
          .add(1, { action: 'list', outcome: 'rejected' });
        throw error;
      };
      try {
        const nodes = this.store.listNodes().map((record) => deviceSchema.parse({
          id: record.id,
          name: record.name,
          platform: record.platform,
          role: record.role,
          capabilities: [...record.capabilities],
          createdAt: record.createdAt,
          lastSeenAt: record.lastSeenAt,
          online: this.deviceLink.online(record.id),
          currentExecutor: record.id === (principal.kind === 'node' ? principal.id : this.currentExecutorId),
          ...(this.nodeRevokedAt.has(record.id) ? { revokedAt: this.nodeRevokedAt.get(record.id) } : {}),
        }));
        const accessClients = this.store.listMobileDevices().map((record) => accessClientSchema.parse({
          id: record.id,
          name: record.name,
          platform: record.platform,
          createdAt: record.createdAt,
          lastSeenAt: record.lastSeenAt,
          current: principal.kind === 'access' && record.id === principal.id,
          ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }),
        }));
        span.setAttribute('outcome', 'ok');
        this.telemetryRef.counter('chatdsh_mobile_devices_total', { description: '设备管理操作' })
          .add(1, { action: 'list', outcome: 'ok' });
        return deviceListSchema.parse({ accessClients, nodes });
      } catch (error) {
        return failed(error);
      }
    });
  }

  /**
   * 撤销一台设备：立即关闭长连接、WebSocket、SSE 与在途 HTTP 请求，保留会话与副本。
   * @param request - 设备标识与撤销原因。
   */
  revoke(request: DeviceRevokeRequest): RevokeOutcome {
    return this.telemetryRef.runSpanSync('chatdsh.gateway.mobile.devices', { action: 'revoke' }, (span) => {
      const fail = (error: DeviceError): never => {
        span.setAttribute('outcome', 'rejected');
        span.setAttribute('error.type', error.type);
        span.setAttribute('error.code', error.code);
        this.telemetryRef.event('chatdsh.gateway.mobile.rejected', {
          action: 'revoke',
          outcome: 'rejected',
          'error.type': error.type,
          'error.code': error.code,
        });
        this.telemetryRef.counter('chatdsh_mobile_devices_total', { description: '设备管理操作' })
          .add(1, { action: 'revoke', outcome: 'rejected' });
        throw error;
      };
      const node = this.store.nodeById(request.deviceId);
      const access = this.store.listMobileDevices().find((record) => record.id === request.deviceId);
      if (node === undefined && access === undefined) {
        fail(new DeviceError(404, 'device-unknown', 'request'));
      }
      if (node !== undefined && this.deviceLink.isRevoked(node.id)) {
        fail(new DeviceError(409, 'already-handled', 'request'));
      }
      if (access !== undefined && access.revokedAt !== undefined) {
        fail(new DeviceError(409, 'already-handled', 'request'));
      }
      const revokedAt = Date.now();
      let linkClosed = 0;
      if (node !== undefined) {
        this.nodeRevokedAt.set(node.id, revokedAt);
        if (this.deviceLink.online(node.id)) linkClosed = 1;
        this.deviceLink.revoke(node.id);
      }
      if (access !== undefined && !this.store.revokeMobileDevice(access.id)) {
        fail(new DeviceError(409, 'already-handled', 'request'));
      }
      const closed = this.transports.closeAll(request.deviceId);
      span.setAttribute('outcome', 'revoked');
      this.telemetryRef.counter('chatdsh_mobile_devices_total', { description: '设备管理操作' })
        .add(1, { action: 'revoke', outcome: 'revoked' });
      const result = deviceRevokeResultSchema.parse({
        deviceId: request.deviceId,
        revokedAt,
        closedLinks: linkClosed + closed.closed,
        sessionsPreserved: true,
      });
      return { result, closed };
    });
  }

  /**
   * 链路检查：在线状态、沿连接的最小请求往返与不可达原因。
   * @param deviceId - 目标执行节点。
   */
  async checkLink(deviceId: string): Promise<DeviceLinkCheck> {
    return this.telemetryRef.runSpan('chatdsh.gateway.device.request',
      { deviceId, 'http.method': 'GET' },
      async (span) => {
        const reject = (status: number, code: ChatdshErrorCode, type: DeviceErrorType): never => {
          span.setAttribute('outcome', 'rejected');
          span.setAttribute('error.type', type);
          span.setAttribute('error.code', code);
          this.telemetryRef.event('chatdsh.gateway.device.rejected', {
            action: 'link-check',
            outcome: 'rejected',
            'error.type': type,
            'error.code': code,
          });
          this.telemetryRef.counter('chatdsh_gateway_device_requests_total', { description: '沿设备连接转发的请求数' })
            .add(1, { outcome: 'link-rejected' });
          throw new DeviceError(status, code, type);
        };
        const node = this.store.nodeById(deviceId);
        if (node === undefined) {
          const access = this.store.listMobileDevices().some((record) => record.id === deviceId);
          if (access) reject(400, 'device-role-mismatch', 'request');
          reject(404, 'device-unknown', 'request');
        }
        if (this.deviceLink.isRevoked(deviceId)) {
          span.setAttribute('outcome', 'rejected');
          this.telemetryRef.event('chatdsh.gateway.device.rejected', {
            action: 'link-check',
            outcome: 'rejected',
            'error.type': 'link',
            'error.code': 'device-token-revoked',
          });
          this.telemetryRef.counter('chatdsh_gateway_device_requests_total', { description: '沿设备连接转发的请求数' })
            .add(1, { outcome: 'link-revoked' });
          return deviceLinkCheckSchema.parse({
            deviceId,
            checkedAt: Date.now(),
            reachable: false,
            code: 'device-token-revoked',
          });
        }
        if (!this.deviceLink.online(deviceId)) {
          span.setAttribute('outcome', 'offline');
          this.telemetryRef.event('chatdsh.gateway.device.rejected', {
            action: 'link-check',
            outcome: 'rejected',
            'error.type': 'link',
            'error.code': 'device-offline',
          });
          this.telemetryRef.counter('chatdsh_gateway_device_requests_total', { description: '沿设备连接转发的请求数' })
            .add(1, { outcome: 'link-offline' });
          return deviceLinkCheckSchema.parse({ deviceId, checkedAt: Date.now(), reachable: false, code: 'device-offline' });
        }
        const startedAt = Date.now();
        try {
          const reply = await this.deviceLink.sendRequest(deviceId, {
            method: 'GET',
            path: LINK_CHECK_PATH,
            headers: {},
          }, this.linkCheckTimeoutMs);
          const latencyMs = Date.now() - startedAt;
          span.setAttribute('outcome', 'ok');
          span.setAttribute('http.status_code', reply.status);
          this.telemetryRef.counter('chatdsh_gateway_device_requests_total', { description: '沿设备连接转发的请求数' })
            .add(1, { outcome: 'link-ok' });
          return deviceLinkCheckSchema.parse({ deviceId, checkedAt: Date.now(), reachable: true, latencyMs });
        } catch (error) {
          const linkCode = error instanceof DeviceLinkError ? error.code : undefined;
          const code = linkCode === undefined ? 'internal-error' : unreachableCodeOf(linkCode);
          span.setAttribute('outcome', 'unreachable');
          span.setAttribute('error.type', 'link');
          span.setAttribute('error.code', code);
          this.telemetryRef.event('chatdsh.gateway.device.rejected', {
            action: 'link-check',
            outcome: 'rejected',
            'error.type': 'link',
            'error.code': code,
          });
          this.telemetryRef.counter('chatdsh_gateway_device_requests_total', { description: '沿设备连接转发的请求数' })
            .add(1, { outcome: 'link-unreachable' });
          return deviceLinkCheckSchema.parse({
            deviceId,
            checkedAt: Date.now(),
            reachable: false,
            code,
          });
        }
      });
  }
}

/** 规范化控制平面地址，忽略协议尾部的差异。 */
function normalizeControlUrl(raw: string): string {
  const parsed = new URL(raw);
  const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
  return `${parsed.protocol}//${parsed.host}${path}`;
}

/** 配对请求声明的控制平面地址必须与配置一致。 */
function sameControlUrl(given: string, expected: string): boolean {
  try {
    return normalizeControlUrl(given) === normalizeControlUrl(expected);
  } catch {
    return false;
  }
}
