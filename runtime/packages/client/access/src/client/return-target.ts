/**
 * 登录之后的安全返回目标。
 *
 * 返回目标只接受同源相对路径：以单个斜杠开头的站内路径，可以带查询串与片段。绝对地址、
 * 双斜杠开头的协议相对地址、反斜杠、控制字符与访问页面自身一律拒绝，避免把用户带到
 * 其他来源或形成登录来回跳转。目标只保存在页面内存与 URL 里，不写入任何持久存储。
 * @module @chatdsh/client-access/return-target
 */

/** 访问页面自身的路径。 */
export const ACCESS_PAGE_PATH = '/chatdsh/access';

/** 查询串里携带返回目标的参数名。 */
export const RETURN_TARGET_PARAM = 'next';

/** 同源相对路径的最大长度。 */
const MAX_TARGET_LENGTH = 2048;

/**
 * 规范化一个返回目标。
 * @param raw - 未校验的返回目标。
 * @returns 可以安全跳转的站内路径；不满足条件时为 `undefined`。
 */
export function safeReturnTarget(raw: string | null | undefined): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const value = raw.trim();
  if (value === '' || value.length > MAX_TARGET_LENGTH) return undefined;
  if (!value.startsWith('/') || value.startsWith('//')) return undefined;
  if (value.includes('\\')) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(value)) return undefined;
  const base = 'https://chatdsh.invalid';
  const url = new URL(value, base);
  if (url.origin !== base) return undefined;
  if (url.pathname === ACCESS_PAGE_PATH || url.pathname.startsWith(`${ACCESS_PAGE_PATH}/`)) return undefined;
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * 从查询串里取返回目标。
 * @param search - `window.location.search` 形式的查询串。
 * @returns 校验通过的站内路径；缺失或不合规时为 `undefined`。
 */
export function returnTargetFromSearch(search: string): string | undefined {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  return safeReturnTarget(params.get(RETURN_TARGET_PARAM));
}
