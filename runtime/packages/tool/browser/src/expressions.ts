/**
 * 浏览器方法与页面表达式的对应。
 *
 * 这一层不依赖运行时：把方法翻译成在页面里执行的表达式，便于单独验证。
 * @module @chatdsh/tool-browser/expressions
 */

/** 可用的方法。 */
export const METHODS = ['navigate', 'url', 'title', 'text', 'click', 'fill', 'screenshot'] as const;

/** 一种方法。 */
export type BrowserMethod = typeof METHODS[number];

/**
 * 把方法翻译成页面里的表达式。
 * @param method - 要做的事。
 * @param selector - 可选的 CSS 选择器。
 * @param value - fill 写入的值。
 * @returns 在页面里求值的表达式。
 */
export function expressionOf(method: BrowserMethod, selector?: string, value?: string): string {
  switch (method) {
    case 'url':
      return 'location.href';
    case 'title':
      return 'document.title';
    case 'text':
      return selector === undefined
        ? 'document.body?.innerText?.slice(0, 20000) ?? ""'
        : `(document.querySelector(${JSON.stringify(selector)})?.innerText ?? "").slice(0, 20000)`;
    case 'click':
      if (selector === undefined) throw new Error('click 需要 selector');
      return `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`;
    case 'fill':
      if (selector === undefined) throw new Error('fill 需要 selector');
      return `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.value = ${JSON.stringify(value ?? '')}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`;
    default:
      throw new Error(`${method} 不需要页面表达式`);
  }
}
