/**
 * 把主题样式挂到文档上。
 *
 * 两段样式：`tokens.css` 是从界面基础设计原样带来的令牌与基础重置，`shell.css` 把这些
 * 令牌映射到上游组件读取的 `--dsw-alias-*`。样式以静态文本随产物内联，挂载时按固定顺序
 * 追加到 `<head>`，重复挂载只保留一份；配色切换由上游主题呈现器写 `data-ds-dark-theme`，
 * 本插件再按其取值补写 `data-color-scheme`，让本设计的令牌块跟着切换。
 * @module @chatdsh/client-theme/apply-styles
 */

import tokens from './styles/tokens.css';
import shell from './styles/shell.css';

/** 样式节点标识，用于判断是否已经挂过。 */
const STYLE_ID = 'chatdsh-theme-styles';

/** 上游主题呈现器写的暗色属性。 */
const DARK_ATTRIBUTE = 'data-ds-dark-theme';

/** 本设计令牌块读取的配色属性。 */
const SCHEME_ATTRIBUTE = 'data-color-scheme';

/** 把本设计令牌与上游令牌映射合并成一段样式。 */
function composeStyles(): string {
  return `${tokens}\n${shell}`;
}

/**
 * 按上游的暗色属性同步 `data-color-scheme`。
 *
 * 本设计的令牌在 `:root` 里是暗色默认值，`body[data-color-scheme="light"]` 覆盖成亮色。
 * 上游用 `body[data-ds-dark-theme]` 表示暗色，两者取值相反，这里逐一翻译。
 * @param body - 文档 body 元素。
 */
function syncScheme(body: HTMLElement): void {
  const dark = body.hasAttribute(DARK_ATTRIBUTE);
  body.setAttribute(SCHEME_ATTRIBUTE, dark ? 'dark' : 'light');
}

/**
 * 挂载主题样式并持续同步配色属性。
 * @returns 卸载函数：移除样式节点与观察器。
 */
export function installThemeStyles(): () => void {
  const head = document.head;
  let node = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (node === null) {
    node = document.createElement('style');
    node.id = STYLE_ID;
    node.textContent = composeStyles();
    head.appendChild(node);
  }
  const body = document.body;
  syncScheme(body);
  const observer = new MutationObserver(() => syncScheme(body));
  observer.observe(body, { attributes: true, attributeFilter: [DARK_ATTRIBUTE] });
  return () => {
    observer.disconnect();
    node?.remove();
  };
}
