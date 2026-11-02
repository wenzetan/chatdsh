/**
 * 入站请求的传输层安全校验。
 *
 * 每个请求先核对 Host，再核对代理链与身份头，最后核对精确来源。可信代理之外出现的转发头与
 * 身份头一律拒绝；静态资源、SSE 与 WebSocket 升级分别按同一套来源规则判定，升级请求还要求
 * 浏览器握手的版本与密钥头。校验通过的请求把身份头剥掉再交给业务处理，下游不会读到未经
 * 传输层验证的用户身份。
 * @module @chatdsh/core-deployment/guard
 */

import type { ChatdshTelemetry } from '@chatdsh/core-contracts';
import { assertRuntimeRemote } from './address.ts';
import type { DeploymentErrorType, GuardRejection, GuardSource } from './errors.ts';
import { blockContains, isWriteMethod, type ValidatedListenerPlan } from './policy.ts';
import { emitRejection } from './telemetry.ts';

/** 请求的分类；决定 span 名字与长连接附加规则。 */
export type RequestKind = 'api' | 'static' | 'sse' | 'upgrade';

/** 一次待校验的请求。 */
export interface GuardRequest {
  /** 请求分类。 */
  readonly kind: RequestKind;
  /** HTTP 方法。 */
  readonly method: string;
  /** 请求地址，含查询串。 */
  readonly url: string;
  /** 请求头；同名多值以数组给出。 */
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** 对端地址；取不到时为空。 */
  readonly remoteAddress?: string;
  /** 客户端证书是否已通过 TLS 握手校验。 */
  readonly clientAuthorized: boolean;
}

/** 校验通过的结果。 */
export interface AllowedRequestVerdict {
  readonly allowed: true;
  readonly source: GuardSource;
  /** 需要从下游请求里剥掉的头。 */
  readonly stripHeaders: readonly string[];
}

/** 一次校验的判定。 */
export type GuardVerdict = AllowedRequestVerdict | GuardRejection;

/** 校验之后可以直接使用的守卫。 */
export interface RequestGuard {
  /** 校验通过的计划。 */
  readonly plan: ValidatedListenerPlan;
  /**
   * 校验一次请求。
   * @param request - 请求内容。
   * @param telemetry - 遥测客户端。
   * @returns 允许时给出来源与要剥掉的头，拒绝时给出状态与错误码。
   */
  check(request: GuardRequest, telemetry: ChatdshTelemetry): GuardVerdict;
}

/** 转发相关头：出现即代表请求经过代理。 */
const FORWARDED_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip'] as const;

/** 一次读取请求头的结果。 */
interface HeaderRead {
  readonly value?: string;
  readonly duplicate: boolean;
}

/** 读取一个请求头，记录同名多值。 */
function readHeader(headers: GuardRequest['headers'], name: string): HeaderRead {
  const raw = headers[name];
  if (raw === undefined) return { duplicate: false };
  if (Array.isArray(raw)) {
    if (raw.length > 1) return { value: raw[0], duplicate: true };
    const value = raw[0];
    return value === undefined ? { duplicate: false } : { value, duplicate: false };
  }
  return { value: raw, duplicate: false };
}

/** 读取合并后的请求头；多值以逗号连接，供转发链解析。 */
function readJoinedHeader(headers: GuardRequest['headers'], name: string): string | undefined {
  const raw = headers[name];
  if (raw === undefined) return undefined;
  return Array.isArray(raw) ? raw.join(',') : raw;
}

/** 默认端口后缀。 */
function defaultPort(secure: boolean): string {
  return secure ? '443' : '80';
}

/** Host 是否与允许列表中的某一项逐字相同。 */
function hostAllowed(plan: ValidatedListenerPlan, host: string): boolean {
  const value = host.trim().toLowerCase();
  if (value === '') return false;
  const suffix = `:${defaultPort(plan.secureTransport)}`;
  for (const allowed of plan.allowedHosts) {
    if (value === allowed) return true;
    if (!allowed.includes(':') && value === `${allowed}${suffix}`) return true;
    if (!value.includes(':') && allowed === `${value}${suffix}`) return true;
  }
  return false;
}

/** 解析转发链；写法非法或超出跳数时说明原因。 */
function parseForwardedFor(
  raw: string | undefined,
  depth: number
): { readonly hops: readonly string[] } | { readonly error: string } {
  if (raw === undefined) return { hops: [] };
  const hops: string[] = [];
  for (const part of raw.split(',')) {
    const hop = part.trim();
    if (hop === '' || hop.length > 64) return { error: 'proxy-header-invalid' };
    if (hop !== 'unknown' && !/^[0-9a-fA-F:.]+$/.test(hop)) return { error: 'proxy-header-invalid' };
    hops.push(hop);
  }
  if (hops.length > depth) return { error: 'proxy-chain-too-long' };
  return { hops };
}

/** 拒绝结果。 */
function rejection(status: number, errorType: DeploymentErrorType, errorCode: string): GuardRejection {
  return { allowed: false, status, errorType, errorCode };
}

/** span 名字随请求分类变化，长连接单独一个。 */
function spanNameOf(kind: RequestKind): string {
  return kind === 'upgrade' ? 'chatdsh.gateway.deploy.upgrade' : 'chatdsh.gateway.deploy.request';
}

/**
 * 建立请求守卫。
 * @param plan - 校验通过的监听计划。
 * @returns 可以逐请求调用的守卫。
 */
export function createRequestGuard(plan: ValidatedListenerPlan): RequestGuard {
  const mode = plan.secureTransport ? 'tls' : 'plaintext';
  const trustedProxyConfigured = plan.trustedProxies.length > 0;
  const clientRangeConfigured = (plan.trustedClientRanges ?? []).length > 0;

  function check(request: GuardRequest, telemetry: ChatdshTelemetry): GuardVerdict {
    return telemetry.runSpanSync(
      spanNameOf(request.kind),
      { 'http.method': request.method, transport: request.kind, mode },
      (span) => {
        const reject = (verdict: GuardRejection): GuardRejection => {
          emitRejection(telemetry, {
            action: request.kind,
            errorType: verdict.errorType,
            errorCode: verdict.errorCode,
            span,
            mode,
          });
          return verdict;
        };

        if (plan.scope === 'runtime') {
          try {
            assertRuntimeRemote(request.remoteAddress);
          } catch (error) {
            const code = error instanceof Error && 'code' in error ? String(error.code) : 'runtime-remote-forbidden';
            return reject(rejection(403, 'runtime', code));
          }
        }

        // Host 必须逐字命中允许列表；Serve 与反代都保留用户访问的原始域名。
        const host = readHeader(request.headers, 'host');
        if (host.value === undefined || host.value.trim() === '') {
          return reject(rejection(400, 'host', 'host-missing'));
        }
        if (host.duplicate || !hostAllowed(plan, host.value)) {
          return reject(rejection(403, 'host', 'host-mismatch'));
        }

        // 代理链：只有配置的来源可以带转发头，否则按伪造代理身份拒绝。
        const forwardedPresent = FORWARDED_HEADERS.some((name) => request.headers[name] !== undefined);
        const remote = request.remoteAddress;
        const trustedProxy = remote !== undefined && trustedProxyConfigured && blockContains(plan.proxyBlock, remote);
        if (forwardedPresent && !trustedProxy) {
          return reject(rejection(403, 'proxy', 'proxy-untrusted'));
        }
        let clientHop: string | undefined;
        if (trustedProxy) {
          const parsed = parseForwardedFor(readJoinedHeader(request.headers, 'x-forwarded-for'), plan.proxyDepth);
          if ('error' in parsed) {
            return reject(rejection(403, 'proxy', parsed.error));
          }
          clientHop = parsed.hops[0];
          const proto = readHeader(request.headers, 'x-forwarded-proto');
          if (proto.duplicate) return reject(rejection(403, 'proxy', 'proxy-header-invalid'));
          if (proto.value !== undefined) {
            const value = proto.value.trim().toLowerCase();
            if (value !== 'http' && value !== 'https') {
              return reject(rejection(403, 'proxy', 'proxy-header-invalid'));
            }
            if (plan.secureTransport && value === 'http') {
              return reject(rejection(403, 'proxy', 'proxy-proto-mismatch'));
            }
          }
          const forwardedHost = readHeader(request.headers, 'x-forwarded-host');
          if (forwardedHost.duplicate) return reject(rejection(403, 'proxy', 'proxy-header-invalid'));
          if (forwardedHost.value !== undefined && !hostAllowed(plan, forwardedHost.value)) {
            return reject(rejection(403, 'proxy', 'proxy-host-mismatch'));
          }
        }

        // 身份头：可信代理之外出现即拒绝；配置了来源地址段时还要求转发链首跳落在段内。
        const stripHeaders: string[] = [];
        for (const name of plan.identityHeaderNames) {
          const header = readHeader(request.headers, name);
          if (header.value === undefined) continue;
          if (!trustedProxy) {
            return reject(rejection(403, 'identity', 'identity-header-untrusted'));
          }
          if (clientRangeConfigured) {
            if (clientHop === undefined || !blockContains(plan.clientBlock, clientHop)) {
              return reject(rejection(403, 'identity', 'identity-client-untrusted'));
            }
          }
          stripHeaders.push(name);
        }

        const source: GuardSource = trustedProxy && forwardedPresent ? 'proxy' : isLocalRemote(remote) ? 'local' : 'direct';
        const origin = readHeader(request.headers, 'origin');
        if (origin.duplicate) {
          return reject(rejection(403, 'origin', 'origin-mismatch'));
        }
        // 浏览器标注的跨站来源即使不带 Origin 也拒绝，静态资源与读取请求同样适用。
        const fetchSite = readHeader(request.headers, 'sec-fetch-site');
        const site = fetchSite.value?.trim().toLowerCase();
        if (site === 'cross-site' || site === 'same-site') {
          return reject(rejection(403, 'origin', 'origin-cross-site'));
        }
        if (origin.value !== undefined) {
          if (!plan.allowedOrigins.includes(origin.value)) {
            return reject(rejection(403, 'origin', 'origin-mismatch'));
          }
        } else if (isWriteMethod(request.method)) {
          // 写动作必须带精确来源，借助自动附带的 Origin 挡住跨站写入。
          return reject(rejection(403, 'origin', 'origin-missing'));
        } else if (source === 'direct' && !request.clientAuthorized) {
          // 读取动作允许不带 Origin，前提是来源本身已经可信：本机、可信代理或已校验的客户端证书。
          return reject(rejection(403, 'origin', 'origin-missing'));
        }

        if (request.kind === 'upgrade') {
          const key = readHeader(request.headers, 'sec-websocket-key');
          if (key.value === undefined || key.value.trim() === '') {
            return reject(rejection(400, 'upgrade', 'upgrade-header-invalid'));
          }
          const version = readHeader(request.headers, 'sec-websocket-version');
          if (version.value?.trim() !== '13') {
            return reject(rejection(426, 'upgrade', 'upgrade-version-unsupported'));
          }
          if (origin.value === undefined && source === 'direct' && !request.clientAuthorized) {
            return reject(rejection(403, 'upgrade', 'upgrade-origin-missing'));
          }
        }

        span.setAttribute('source', source);
        span.setAttribute('outcome', 'allowed');
        return { allowed: true, source, stripHeaders };
      }
    );
  }

  return { plan, check };
}

/** 对端是否属于本机回环。 */
function isLocalRemote(remote: string | undefined): boolean {
  if (remote === undefined) return false;
  const value = remote.trim().toLowerCase();
  if (value === '::1' || value === 'localhost') return true;
  const mapped = value.startsWith('::ffff:') ? value.slice(7) : value;
  return /^127\./.test(mapped);
}

/**
 * 把身份头从转发给下游的请求里删掉。
 * @param headers - 原始请求头。
 * @param stripHeaders - 校验通过时给出的待删除头。
 * @returns 删除之后的请求头副本。
 */
export function stripIdentityHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  stripHeaders: readonly string[]
): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = { ...headers };
  for (const name of stripHeaders) delete out[name];
  return out;
}
