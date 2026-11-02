/**
 * 助手面板自带的少量样式：多选清单与装配结果的排版。
 *
 * 只引用主题插件与共享组件包给出的令牌，不写颜色字面值。样式在面板挂载时注入一次，
 * 标记属性为 `data-chatdsh-assistants`。
 * @module @chatdsh/client-assistants/styles
 */

/** 样式注入的标记属性。 */
export const STYLE_MARKER = 'data-chatdsh-assistants';

/** 面板样式文本。 */
export const ASSISTANTS_CSS = `
.chdsh-multiselect {
  display: flex;
  flex-direction: column;
  gap: var(--cdh-s1);
  max-height: 320px;
  overflow: auto;
  padding: var(--cdh-s2);
  border: 1px solid var(--chatdsh-line-2);
  border-radius: var(--cdh-r1);
  background: var(--chatdsh-panel);
}
.chdsh-field .chdsh-multiselect__option {
  display: flex;
  align-items: flex-start;
  gap: var(--cdh-s2);
  min-height: 44px;
  padding: var(--cdh-s1) 0;
}
.chdsh-field .chdsh-multiselect__option input[type=checkbox] {
  width: auto;
  min-height: 0;
  margin-block: var(--cdh-s1);
  accent-color: var(--chatdsh-brand);
}
.chdsh-multiselect__text {
  display: grid;
  gap: 2px;
  font-weight: 400;
  overflow-wrap: anywhere;
}
.chdsh-assistants-group { margin-block: var(--cdh-s3); }
.chdsh-assistants-group > h4 { margin-block: var(--cdh-s2); font-size: var(--cdh-fs-14); }
.chdsh-assistants-tools { margin: 0; padding-inline-start: var(--cdh-s4); font-size: var(--cdh-fs-12); }
.chdsh-assistants-tools li { margin-block: 2px; overflow-wrap: anywhere; }
`;

/**
 * 注入面板样式，重复挂载只注入一次。
 * @param document - 文档对象。
 */
export function installAssistantsStyles(document: Document): void {
  if (document.querySelector(`style[${STYLE_MARKER}]`) !== null) return;
  const style = document.createElement('style');
  style.setAttribute(STYLE_MARKER, '');
  style.textContent = ASSISTANTS_CSS;
  document.head.append(style);
}
