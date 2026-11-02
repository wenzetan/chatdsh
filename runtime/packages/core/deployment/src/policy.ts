/**
 * 监听计划的安全条件。
 *
 * 启动前把绑定地址、传输安全条件、精确来源与代理信任配置一起校验：通配地址与公网地址直接
 * 拒绝，非回环监听必须带双向 TLS，回环上的明文监听必须显式声明为开发配置。校验通过的计划
 * 交给监听模块使用，校验与启动放在同一个 span 里。
 * @module @chatdsh/core-deployment/policy
 */

import { BlockList, isIP } from 'node:net';
import type { ChatdshTelemetry } from '@chatdsh/core-contracts';
import { assertBindable, type AddressClassification } from './address.ts';
import { DeploymentError } from './errors.ts';
import { emitRejection } from './telemetry.ts';
import type { TlsPaths } from './tls.ts';

/** 监听计划。 */
export interface ListenerPlan {
  /** 监听地址；只接受回环或本机私有网卡上的字面量。 */
  readonly host: string;
  /** 监听端口；0 表示由操作系统分配。 */
  readonly port: number;
  /** 监听归属：控制平面或运行时。 */
  readonly scope: 'gateway' | 'runtime';
  /** 传输安全材料；非回环监听必需，且要求双向 TLS。 */
  readonly tls?: TlsPaths;
  /** 是否显式声明为开发配置；回环上的明文监听需要它。 */
  readonly development?: boolean;
  /** 精确来源，协议、主机与端口逐字相同。 */
  readonly allowedOrigins: readonly string[];
  /** 允许的 Host 值，主机与端口逐字相同。 */
  readonly allowedHosts: readonly string[];
  /** 可信代理来源，IP 或 CIDR。 */
  readonly trustedProxies: readonly string[];
  /** 可信来源地址段；配置后身份头只在来源落在这个范围内才可信。 */
  readonly trustedClientRanges?: readonly string[];
  /** 需要校验并剥离的身份头；缺省取传输层注入的那一组。 */
  readonly identityHeaders?: readonly string[];
  /** 代理链的最大跳数，缺省 4。 */
  readonly proxyDepth?: number;
}

/** 传输形态。 */
export type TransportMode = 'mtls' | 'tls' | 'plaintext';

/** 校验通过的计划。 */
export interface ValidatedListenerPlan extends ListenerPlan {
  /** 绑定地址的分类结果。 */
  readonly address: AddressClassification;
  /** 传输形态。 */
  readonly mode: TransportMode;
  /** 是否使用 TLS 监听。 */
  readonly secureTransport: boolean;
  /** 可信代理判定表。 */
  readonly proxyBlock: BlockList;
  /** 可信来源判定表；没有配置时为空表。 */
  readonly clientBlock: BlockList;
  /** 归一化后的身份头名字。 */
  readonly identityHeaderNames: readonly string[];
  /** 代理链最大跳数。 */
  readonly proxyDepth: number;
}

/** 默认校验的身份头：传输层注入的用户身份与转发来源。 */
export const DEFAULT_IDENTITY_HEADERS = [
  'tailscale-headers-info',
  'tailscale-user-login',
  'tailscale-user-name',
  'tailscale-user-profile-pic',
  'x-forwarded-user',
  'x-authenticated-user',
  'x-chatdsh-identity',
] as const;

/** 允许的 HTTP 方法里需要精确来源的方法。 */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** 是否是写方法。 */
export function isWriteMethod(method: string): boolean {
  return WRITE_METHODS.has(method.toUpperCase());
}

/** 归一化对端地址：IPv4 映射写法还原成 IPv4。 */
export function normalizeRemote(address: string): string {
  const trimmed = address.trim();
  const mapped = trimmed.toLowerCase().startsWith('::ffff:') ? trimmed.slice(7) : undefined;
  return mapped !== undefined && isIP(mapped) === 4 ? mapped : trimmed;
}

/**
 * 把 IP 或 CIDR 写法加入判定表。
 * @param block - 判定表。
 * @param value - 配置值。
 * @param errorCode - 写法非法时的错误码。
 */
export function addAddressSpec(block: BlockList, value: string, errorCode: string): void {
  const spec = value.trim();
  const slashAt = spec.indexOf('/');
  if (slashAt === -1) {
    const family = isIP(spec);
    if (family === 0) throw new DeploymentError(errorCode, 'proxy', 500, `地址写法无法解析：${value}`);
    block.addAddress(spec, family === 4 ? 'ipv4' : 'ipv6');
    return;
  }
  const network = spec.slice(0, slashAt);
  const prefixText = spec.slice(slashAt + 1);
  const family = isIP(network);
  if (family === 0 || !/^\d{1,3}$/.test(prefixText)) {
    throw new DeploymentError(errorCode, 'proxy', 500, `地址段写法无法解析：${value}`);
  }
  const prefix = Number.parseInt(prefixText, 10);
  const limit = family === 4 ? 32 : 128;
  if (prefix > limit) throw new DeploymentError(errorCode, 'proxy', 500, `地址段前缀超出范围：${value}`);
  block.addSubnet(network, prefix, family === 4 ? 'ipv4' : 'ipv6');
}

/** 判定一个地址是否落在判定表里。 */
export function blockContains(block: BlockList, address: string): boolean {
  const normalized = normalizeRemote(address);
  const family = isIP(normalized);
  if (family === 0) return false;
  return block.check(normalized, family === 4 ? 'ipv4' : 'ipv6');
}

/** 校验一个精确来源的写法。 */
function assertExactOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new DeploymentError('origin-config-invalid', 'origin', 500, `来源写法无法解析：${origin}`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username !== '' || url.password !== '') {
    throw new DeploymentError('origin-config-invalid', 'origin', 500, `来源必须是精确 origin：${origin}`);
  }
  return url.origin;
}

/** 校验一个允许的 Host 写法。 */
function assertHostSpec(host: string): string {
  const value = host.trim().toLowerCase();
  if (value === '' || value.includes('/') || value.includes('://') || value.includes('@')) {
    throw new DeploymentError('host-config-invalid', 'host', 500, `Host 写法无法解析：${host}`);
  }
  const bracketAt = value.lastIndexOf(']');
  const colonAt = value.indexOf(':', bracketAt === -1 ? 0 : bracketAt + 1);
  const hostPart = colonAt === -1 ? value : value.slice(0, colonAt);
  const portPart = colonAt === -1 ? '' : value.slice(colonAt + 1);
  const bare = hostPart.startsWith('[') && hostPart.endsWith(']') ? hostPart.slice(1, -1) : hostPart;
  if (bare === '') throw new DeploymentError('host-config-invalid', 'host', 500, `Host 缺少主机部分：${host}`);
  if (portPart !== '' && (!/^\d{1,5}$/.test(portPart) || Number.parseInt(portPart, 10) > 65535)) {
    throw new DeploymentError('host-config-invalid', 'host', 500, `Host 端口无法解析：${host}`);
  }
  return value;
}

/** 校验一个头名。 */
function assertHeaderName(name: string): string {
  const value = name.trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(value)) {
    throw new DeploymentError('identity-config-invalid', 'identity', 500, `身份头名字无法解析：${name}`);
  }
  return value;
}

/**
 * 校验监听计划。
 * @param plan - 配置给出的计划。
 * @returns 校验通过的计划，附带地址分类与判定表。
 * @throws DeploymentError 绑定地址、传输安全条件或来源配置不成立。
 */
export async function validateListenerPlan(plan: ListenerPlan): Promise<ValidatedListenerPlan> {
  if (!Number.isInteger(plan.port) || plan.port < 0 || plan.port > 65535) {
    throw new DeploymentError('bind-port-invalid', 'bind', 500, `监听端口超出范围：${plan.port}`);
  }
  const address = await assertBindable(plan.host, plan.scope);
  const secureTransport = plan.tls !== undefined;
  const mode: TransportMode = plan.tls === undefined ? 'plaintext' : plan.tls.mutual ? 'mtls' : 'tls';

  if (plan.scope === 'gateway') {
    if (address.kind !== 'loopback' && plan.tls === undefined) {
      throw new DeploymentError('bind-tls-required', 'bind', 500, '非回环监听必须配置 TLS');
    }
    if (address.kind !== 'loopback' && plan.tls !== undefined && !plan.tls.mutual) {
      throw new DeploymentError('bind-mutual-tls-required', 'bind', 500, '非回环监听必须校验客户端证书');
    }
    if (address.kind === 'loopback' && plan.tls === undefined && plan.development !== true) {
      throw new DeploymentError(
        'bind-plaintext-forbidden',
        'bind',
        500,
        '明文监听只允许在显式开发配置下使用'
      );
    }
  }

  if (plan.allowedOrigins.length === 0) {
    throw new DeploymentError('origin-config-missing', 'origin', 500, '必须配置至少一个精确来源');
  }
  const origins = plan.allowedOrigins.map((origin) => assertExactOrigin(origin));
  if (secureTransport && origins.some((origin) => !origin.startsWith('https://'))) {
    throw new DeploymentError('origin-scheme-mismatch', 'origin', 500, 'TLS 监听只接受 https 来源');
  }
  if (plan.allowedHosts.length === 0) {
    throw new DeploymentError('host-config-missing', 'host', 500, '必须配置至少一个允许的 Host');
  }
  const hosts = plan.allowedHosts.map((host) => assertHostSpec(host));
  const hostKeys = new Set(hosts);
  for (const origin of origins) {
    const host = new URL(origin).host.toLowerCase();
    if (!hostKeys.has(host)) {
      throw new DeploymentError('origin-host-unlisted', 'origin', 500, `来源的主机不在允许列表：${host}`);
    }
  }

  const proxyBlock = new BlockList();
  for (const entry of plan.trustedProxies) addAddressSpec(proxyBlock, entry, 'proxy-config-invalid');
  const clientBlock = new BlockList();
  for (const entry of plan.trustedClientRanges ?? []) addAddressSpec(clientBlock, entry, 'proxy-config-invalid');

  const identityHeaderNames = (plan.identityHeaders ?? DEFAULT_IDENTITY_HEADERS).map((name) => assertHeaderName(name));
  const proxyDepth = plan.proxyDepth ?? 4;
  if (!Number.isInteger(proxyDepth) || proxyDepth < 1 || proxyDepth > 16) {
    throw new DeploymentError('proxy-config-invalid', 'proxy', 500, `代理链跳数超出范围：${proxyDepth}`);
  }

  return {
    ...plan,
    allowedOrigins: origins,
    allowedHosts: hosts,
    address,
    mode,
    secureTransport,
    proxyBlock,
    clientBlock,
    identityHeaderNames,
    proxyDepth,
  };
}

/** 监听启动的输入。 */
export interface ListenerStartOptions<T> {
  /** 计划。 */
  readonly plan: ListenerPlan;
  /** 遥测客户端。 */
  readonly telemetry: ChatdshTelemetry;
  /** 校验通过后真正建立监听的步骤。 */
  readonly listen: (validated: ValidatedListenerPlan) => Promise<T>;
}

/**
 * 校验计划并建立监听，两步共用一个 span。
 * @param options - 计划、遥测与监听步骤。
 * @returns 校验通过的计划与监听步骤的结果。
 * @throws DeploymentError 校验不通过，或监听步骤抛出的错误。
 */
export async function startListener<T>(
  options: ListenerStartOptions<T>
): Promise<{ readonly plan: ValidatedListenerPlan; readonly result: T }> {
  const { plan, telemetry } = options;
  const mode: TransportMode = plan.tls === undefined ? 'plaintext' : plan.tls.mutual ? 'mtls' : 'tls';
  return telemetry.runSpan(
    'chatdsh.gateway.deploy.listener.start',
    { mode, outcome: 'starting' },
    async (span) => {
      const reject: (error: DeploymentError) => never = (error) => {
        emitRejection(telemetry, {
          action: 'listener-start',
          errorType: error.errorType,
          errorCode: error.code,
          span,
          mode,
        });
        telemetry
          .counter('chatdsh_gateway_deploy_listener_starts_total', { description: '监听启动检查结果' })
          .add(1, { kind: 'listener', mode, outcome: 'rejected' });
        throw error;
      };
      let validated: ValidatedListenerPlan;
      try {
        validated = await validateListenerPlan(plan);
      } catch (error) {
        reject(
          error instanceof DeploymentError
            ? error
            : new DeploymentError('bind-config-invalid', 'bind', 500, '监听计划校验失败')
        );
      }
      span.setAttribute('kind', validated.address.kind ?? 'unknown');
      span.setAttribute('mode', validated.mode);
      const result = await options.listen(validated);
      span.setAttribute('outcome', 'ok');
      telemetry
        .counter('chatdsh_gateway_deploy_listener_starts_total', { description: '监听启动检查结果' })
        .add(1, { kind: validated.address.kind ?? 'unknown', mode: validated.mode, outcome: 'ok' });
      return { plan: validated, result };
    }
  );
}
