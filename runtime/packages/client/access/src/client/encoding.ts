/**
 * 通行密钥断言里的字节与 base64url 互换。
 *
 * 浏览器 WebAuthn 接口收发 `ArrayBuffer`，访问契约收发 base64url 字符串；两个方向都只做
 * 编码转换，不做任何校验。挑战与凭据标识的校验由访问服务完成。
 * @module @chatdsh/client-access/encoding
 */

/**
 * 把 base64url 字符串解码成字节。
 * @param value - base64url 写法的字符串。
 * @returns 字节数组。
 */
export function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * 把字节编码成 base64url 字符串，不带填充。
 * @param bytes - 字节数组。
 * @returns base64url 写法的字符串。
 */
export function encodeBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
