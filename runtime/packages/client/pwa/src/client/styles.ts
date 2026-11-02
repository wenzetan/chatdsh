/**
 * 把移动布局样式挂到文档上。
 *
 * 样式以文本随产物内联，挂载时写到固定标识的 `<style>` 节点；重复挂载只保留一份。配色来自
 * 主题插件注入的令牌，本样式只引用令牌。
 * @module @chatdsh/client-pwa/styles
 */

import mobileCss from './mobile.css';

/** 本包注入的样式文本。 */
export const PWA_CSS = mobileCss;

/** 样式节点的标识。 */
export const STYLE_ID = 'chatdsh-pwa-styles';

/**
 * 挂载样式。
 * @param doc - 目标文档。
 * @returns 卸载函数：移除样式节点。
 */
export function installPwaStyles(doc: Document = document): () => void {
  const existing = doc.getElementById(STYLE_ID);
  if (existing !== null) return () => undefined;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = PWA_CSS;
  doc.head.append(style);
  return () => {
    style.remove();
  };
}
