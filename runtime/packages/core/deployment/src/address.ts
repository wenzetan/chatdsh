/**
 * 监听地址的分类与本机核对。
 *
 * 绑定值先按字面量分类：通配地址一律拒绝，回环地址只服务本机，其余地址必须真的出现在本机
 * 地址表里，并且不能落在公网地址段。判定用真实的系统地址表与域名解析结果，配置里写错的
 * 地址在启动前就报出具体值。
 * @module @chatdsh/core-deployment/address
 */

import { lookup } from 'node:dns/promises';
import { networkInterfaces } from 'node:os';
import { DeploymentError } from './errors.ts';

/** 地址分类。 */
export type AddressKind = 'loopback' | 'private' | 'link-local' | 'public';

/** 一次分类的结果。 */
export interface AddressClassification {
  /** 分类结果；写法无法解析时为 `undefined`。 */
  readonly kind?: AddressKind;
  /** 规范化后的地址字面量，去掉方括号与区域标识。 */
  readonly address: string;
}

/** 通配字面量：任何一种写法都表示监听全部网卡。 */
const WILDCARDS = new Set(['', '0.0.0.0', '::', '[::]', '*', '::0', '0:0:0:0:0:0:0:0']);

/** IPv4 的点分十进制解析；写法非法时返回 `undefined`。 */
function parseIpv4(value: string): number[] | undefined {
  const parts = value.split('.');
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (part === '' || !/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number.parseInt(part, 10);
    if (octet > 255) return undefined;
    // 带前导零的写法按非法处理，避免八进制与十进制两套解读。
    if (part.length > 1 && part.startsWith('0')) return undefined;
    octets.push(octet);
  }
  return octets;
}

/** 去掉方括号与 `%区域` 后缀。 */
function normalize(address: string): string {
  const trimmed = address.trim();
  const unbracketed = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  const zoneAt = unbracketed.indexOf('%');
  return zoneAt === -1 ? unbracketed : unbracketed.slice(0, zoneAt);
}

/** IPv6 的形状检查：冒号分段、十六进制，允许尾部的 IPv4 写法。 */
function looksLikeIpv6(value: string): boolean {
  if (!value.includes(':')) return false;
  const [head] = value.split('::');
  const groups = (head ?? '').split(':').filter((part) => part !== '');
  if (groups.length > 8) return false;
  return groups.every((part) => /^[0-9a-fA-F]{1,4}$/.test(part) || parseIpv4(part) !== undefined);
}

/** IPv4 分类。 */
function classifyIpv4(octets: number[]): AddressKind {
  const [first = 0, second = 0] = octets;
  if (first === 127) return 'loopback';
  if (first === 10) return 'private';
  if (first === 172 && second >= 16 && second <= 31) return 'private';
  if (first === 192 && second === 168) return 'private';
  // 运营商级 NAT 地址段与链路本地地址都不属于公网可路由地址。
  if (first === 100 && second >= 64 && second <= 127) return 'private';
  if (first === 169 && second === 254) return 'link-local';
  return 'public';
}

/** IPv6 分类。 */
function classifyIpv6(value: string): AddressKind {
  const lower = value.toLowerCase();
  if (lower === '::1') return 'loopback';
  if (/^fe[89ab]/.test(lower)) return 'link-local';
  const first = lower.split(':').filter((part) => part !== '')[0] ?? '';
  if (/^f[cd]/.test(first)) return 'private';
  return 'public';
}

/**
 * 按字面量分类一个地址。
 * @param raw - 配置里的地址，允许带方括号与区域标识。
 * @returns 分类结果；域名与无法解析的写法只有地址字段。
 */
export function classifyAddress(raw: string): AddressClassification {
  const address = normalize(raw);
  if (isWildcard(raw)) return { address };
  const octets = parseIpv4(address);
  if (octets !== undefined) return { address, kind: classifyIpv4(octets) };
  if (address === 'localhost') return { address, kind: 'loopback' };
  if (looksLikeIpv6(address)) return { address, kind: classifyIpv6(address) };
  return { address };
}

/** 是否通配字面量。 */
export function isWildcard(raw: string): boolean {
  const address = normalize(raw);
  return WILDCARDS.has(address) || WILDCARDS.has(raw.trim());
}

/** 本机地址表里的全部地址，去掉方括号与区域标识。 */
function localAddresses(): Set<string> {
  const addresses = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) addresses.add(normalize(entry.address));
  }
  return addresses;
}

/** 地址是否出现在本机地址表里。 */
function isLocalAddress(address: string): boolean {
  const table = localAddresses();
  if (table.has(address)) return true;
  // IPv4 映射的 IPv6 写法与同一张网卡上的 IPv4 地址等价。
  const mapped = address.toLowerCase().startsWith('::ffff:') ? address.slice(7) : undefined;
  return mapped !== undefined && table.has(mapped);
}

/** 是否是域名写法：点分标签，不含冒号，也不是 IPv4 字面量。 */
function isHostname(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === '') return false;
  if (parseIpv4(trimmed) !== undefined) return false;
  if (trimmed.includes(':')) return false;
  return trimmed
    .split('.')
    .every(
      (label) =>
        label !== '' &&
        /^[a-zA-Z0-9-]+$/.test(label) &&
        !label.startsWith('-') &&
        !label.endsWith('-')
    );
}

/**
 * 核对一个监听地址是否允许绑定。
 * @param host - 配置里的监听地址。
 * @param scope - 监听归属：控制平面或运行时。
 * @returns 分类结果，同时给出规范化后的地址。
 * @throws DeploymentError 通配地址、公网地址、不在本机地址表的地址，或运行时的非回环地址。
 */
export async function assertBindable(host: string, scope: 'gateway' | 'runtime'): Promise<AddressClassification> {
  if (isWildcard(host)) {
    throw new DeploymentError(
      'bind-wildcard-forbidden',
      'bind',
      500,
      `监听地址不允许通配：${host === '' ? '(空)' : host}`
    );
  }
  const classification = classifyAddress(host);
  let kind = classification.kind;
  let address = classification.address;
  if (kind === undefined) {
    if (!isHostname(host)) {
      throw new DeploymentError('bind-address-invalid', 'bind', 500, `监听地址写法无法解析：${host}`);
    }
    let resolved = '';
    try {
      resolved = (await lookup(host, { all: true })).find((entry) => entry !== undefined)?.address ?? '';
    } catch {
      throw new DeploymentError('bind-hostname-unresolvable', 'bind', 500, `监听域名无法解析：${host}`);
    }
    if (resolved === '') {
      throw new DeploymentError('bind-hostname-unresolvable', 'bind', 500, `监听域名没有解析出地址：${host}`);
    }
    const resolvedKind = classifyAddress(resolved).kind;
    if (resolvedKind === undefined) {
      throw new DeploymentError('bind-address-invalid', 'bind', 500, `监听域名解析出无法解析的地址：${resolved}`);
    }
    kind = resolvedKind;
    address = resolved;
  }
  if (kind === 'public') {
    throw new DeploymentError('bind-public-address-forbidden', 'bind', 500, `监听地址命中公网地址段：${address}`);
  }
  if (kind !== 'loopback' && !isLocalAddress(address)) {
    throw new DeploymentError('bind-address-not-local', 'bind', 500, `监听地址不在本机地址表：${address}`);
  }
  if (scope === 'runtime' && kind !== 'loopback') {
    throw new DeploymentError('runtime-bind-not-local', 'runtime', 500, `运行时监听只允许回环地址：${address}`);
  }
  return { address, kind };
}

/**
 * 核对运行时的转发目标地址：运行时只绑回环，控制平面也只能把请求转给本机运行时。
 * @param target - 运行时地址。
 * @returns 解析后的地址。
 * @throws DeploymentError 目标不是回环地址或写法非法。
 */
export function assertRuntimeTarget(target: string): URL {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new DeploymentError('runtime-target-invalid', 'runtime', 500, '运行时地址不是合法 URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DeploymentError('runtime-target-invalid', 'runtime', 500, `运行时地址协议不受支持：${url.protocol}`);
  }
  const kind = classifyAddress(url.hostname).kind;
  if (kind !== 'loopback') {
    throw new DeploymentError('runtime-target-not-local', 'runtime', 500, '运行时地址只允许回环主机');
  }
  return url;
}

/**
 * 核对一次运行时请求的来源：运行时的监听只服务本机。
 * @param remoteAddress - 对端地址。
 * @throws DeploymentError 对端不是回环地址或缺少对端地址。
 */
export function assertRuntimeRemote(remoteAddress: string | undefined): void {
  if (remoteAddress === undefined) {
    throw new DeploymentError('runtime-remote-unknown', 'runtime', 403, '运行时请求缺少对端地址');
  }
  const kind = classifyAddress(remoteAddress).kind;
  if (kind !== 'loopback') {
    throw new DeploymentError('runtime-remote-forbidden', 'runtime', 403, '运行时请求的对端不是回环地址');
  }
}
