/**
 * 技能面板自带的少量样式：来源分组的间距。
 *
 * 只引用主题插件给出的令牌，不写颜色字面值。样式在面板挂载时注入一次，标记属性为
 * `data-chatdsh-skills`。
 * @module @chatdsh/client-skills/styles
 */

/** 样式注入的标记属性。 */
export const STYLE_MARKER = 'data-chatdsh-skills';

/** 面板样式文本。 */
export const SKILLS_CSS = `
.chdsh-skills-group { margin-block: var(--cdh-s3); }
.chdsh-skills-group > h4 { margin-block: var(--cdh-s2); font-size: var(--cdh-fs-14); }
`;

/**
 * 注入面板样式，重复挂载只注入一次。
 * @param document - 文档对象。
 */
export function installSkillsStyles(document: Document): void {
  if (document.querySelector(`style[${STYLE_MARKER}]`) !== null) return;
  const style = document.createElement('style');
  style.setAttribute(STYLE_MARKER, '');
  style.textContent = SKILLS_CSS;
  document.head.append(style);
}
