/**
 * 设备凭据解析：把一次请求解析成执行节点或访问客户端。
 *
 * 凭据只认请求里携带的令牌原值（`Authorization: Bearer` 或 `x-chatdsh-device-token`），
 * 解析时先对令牌取 SHA-256 摘要再查存储。设备标识头只用于展示当前设备，不能单独通过
 * 认证。
 * @module @chatdsh/gateway/devices/credential
 */

import type { IncomingMessage } from 'node:http';
import { authenticateMobileDevice, deviceTokenHash, mobileTokenOf } from '../mobile-http.ts';
import type { GatewayStore } from '../store.ts';

/** 凭据类别：执行节点与控制其的访问客户端。 */
export type DevicePrincipalKind = 'node' | 'access';

/** 通过认证的设备。 */
export interface DevicePrincipal {
  readonly kind: DevicePrincipalKind;
  readonly id: string;
  readonly name: string;
  readonly platform: string;
}

/** 凭据拒绝的稳定错误码。 */
export type DeviceCredentialFailure = 'device-token-required' | 'device-token-invalid' | 'device-token-revoked';

/** 一次凭据解析的结果。 */
export type DeviceCredentialResult =
  | { readonly ok: true; readonly principal: DevicePrincipal }
  | { readonly ok: false; readonly code: DeviceCredentialFailure };

/** 凭据解析的输入。 */
export interface DeviceCredentialOptions {
  readonly store: GatewayStore;
  /** 存储之外的撤销判定，见 {@link MobileDeviceAuthOptions.isRevoked}。 */
  readonly isRevoked: (deviceId: string) => boolean;
}

/**
 * 用请求里的令牌解析设备。
 *
 * 执行节点令牌与手机设备令牌共用一个校验入口：先按节点令牌查，再按手机设备令牌查。
 * 任何只带设备标识头的请求都在第一步被拒绝。
 * @param request - 入站请求。
 * @param options - 存储与撤销判定。
 */
export function resolveDeviceCredential(
  request: IncomingMessage,
  options: DeviceCredentialOptions
): DeviceCredentialResult {
  const token = mobileTokenOf(request);
  if (token === '') return { ok: false, code: 'device-token-required' };
  const node = options.store.nodeByTokenHash(deviceTokenHash(token));
  if (node !== undefined) {
    if (options.isRevoked(node.id)) return { ok: false, code: 'device-token-revoked' };
    return { ok: true, principal: { kind: 'node', id: node.id, name: node.name, platform: node.platform } };
  }
  const access = authenticateMobileDevice(request, options.store, { isRevoked: options.isRevoked });
  if (access.record === undefined) {
    return { ok: false, code: access.error ?? 'device-token-invalid' };
  }
  return {
    ok: true,
    principal: {
      kind: 'access',
      id: access.record.id,
      name: access.record.name,
      platform: access.record.platform,
    },
  };
}
