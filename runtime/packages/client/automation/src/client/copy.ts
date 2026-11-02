/**
 * 复制 webhook 地址。
 *
 * 写剪贴板可能被浏览器拒绝（明文 HTTP 的局域网地址不是安全上下文、权限被拒）。失败时把
 * 结论交回界面，由界面展示可选择的地址文本，不让用户以为已经复制成功。
 * @module @chatdsh/client-automation/copy
 */

/** 复制结论。 */
export type CopyOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'not-supported' | 'not-allowed' | 'write-failed'; readonly detail: string };

/**
 * 把一段文本写进剪贴板。
 * @param text - 待复制的地址。
 * @param clipboard - 剪贴板实现；缺省用浏览器接口。
 * @returns 复制结论。
 */
export async function copyText(
  text: string,
  clipboard: { writeText(value: string): Promise<void> } | undefined = typeof navigator === 'undefined' ? undefined : navigator.clipboard,
): Promise<CopyOutcome> {
  if (text === '') return { ok: false, code: 'write-failed', detail: '没有可复制的地址' };
  if (clipboard === undefined) {
    return { ok: false, code: 'not-supported', detail: '当前页面没有剪贴板接口（明文 HTTP 的局域网地址不是安全上下文），请手动选择地址复制' };
  }
  try {
    await clipboard.writeText(text);
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'NotAllowedError') {
      return { ok: false, code: 'not-allowed', detail: '浏览器拒绝了剪贴板写入，请手动选择地址复制' };
    }
    return { ok: false, code: 'write-failed', detail: `剪贴板写入失败（${name === '' ? '未知错误' : name}），请手动选择地址复制` };
  }
  return { ok: true };
}
