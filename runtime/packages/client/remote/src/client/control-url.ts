/**
 * 中继地址的归一化与端点拼接。
 *
 * 空字符串表示使用当前文档的同源根路径。非空值必须是精确的 HTTP 或 HTTPS 地址，
 * 可以带反向代理前缀；查询串、片段与用户信息一律拒绝，避免把凭据或一次性参数
 * 带进请求地址与界面。
 * @module @chatdsh/client-remote/control-url
 */

/** 地址归一化的失败码。 */
export type ControlUrlErrorCode =
  | 'control-url-invalid'
  | 'control-url-protocol'
  | 'control-url-credentials'
  | 'control-url-query'
  | 'control-url-hash';

/** 地址归一化失败。 */
export class ControlUrlError extends Error {
  constructor(readonly code: ControlUrlErrorCode) {
    super(code);
    this.name = 'ControlUrlError';
  }
}

/**
 * 归一化中继地址。
 * @param raw - 用户输入的地址。
 * @returns 空字符串表示同源根路径；否则是去掉末尾斜杠的绝对地址。
 * @throws {ControlUrlError} 地址不是精确的 HTTP 或 HTTPS 来源。
 */
export function normalizeControlUrl(raw: string): string {
  const value = raw.trim();
  if (value === '') return '';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ControlUrlError('control-url-invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ControlUrlError('control-url-protocol');
  }
  const schemeEnd = url.href.indexOf('://');
  const authorityEnd = url.href.indexOf('/', schemeEnd + 3);
  const authority = url.href.slice(schemeEnd + 3, authorityEnd < 0 ? undefined : authorityEnd);
  if (authority.includes('@')) throw new ControlUrlError('control-url-credentials');
  if (url.search !== '') throw new ControlUrlError('control-url-query');
  if (url.hash !== '') throw new ControlUrlError('control-url-hash');
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

/**
 * 把端点路径接到地址后面。
 * @param base - 归一化后的地址；空字符串表示同源根路径。
 * @param path - 以斜杠开头的端点路径。
 * @returns 可直接交给 `fetch` 的地址。
 */
export function endpointOf(base: string, path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return base === '' ? normalizedPath : `${base}${normalizedPath}`;
}

/** 取数通道模式。 */
export type RelayMode = 'same-origin' | 'direct' | 'proxy';

/**
 * 判断取数通道模式。
 * @param controlUrl - 归一化后的中继地址；空字符串表示同源。
 * @param origin - 当前页面的来源。
 * @returns 同源、直达中继或经本机宿主代理。
 */
export function relayMode(controlUrl: string, origin: string): RelayMode {
  const value = controlUrl.trim();
  if (value === '') return 'same-origin';
  return new URL(value).origin === origin ? 'direct' : 'proxy';
}
