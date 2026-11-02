/**
 * 桌面控制面板的样式。
 *
 * 只引用界面令牌，不写颜色字面值；样式由面板挂载时注入文档一次。持续指示条固定在视口顶部，
 * 覆盖其他页面内容，保证授权期间总能看见。
 * @module @chatdsh/client-desktop-control/styles
 */

/** 样式元素的标识。 */
export const CONTROL_STYLE_ID = 'chdsh-desktop-control-styles';

/** 面板样式文本。 */
export const CONTROL_CSS = `
.chdsh-control-wizard { display: flex; flex-direction: column; gap: var(--cdh-s3); }
.chdsh-control-wizard__gaps { margin: 0; padding-left: var(--cdh-s4); color: var(--chatdsh-warn); font-size: var(--cdh-fs-12); }
.chdsh-control-wizard__fields { display: flex; flex-direction: column; gap: var(--cdh-s2); border: 1px solid var(--chatdsh-line); border-radius: var(--cdh-r2); padding: var(--cdh-s3); }
.chdsh-control-wizard__row { display: flex; flex-wrap: wrap; gap: var(--cdh-s2); align-items: center; }
.chdsh-control-wizard__row label { font-size: var(--cdh-fs-12); color: var(--chatdsh-ink-2); }
.chdsh-control-wizard__items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--cdh-s2); }
.chdsh-control-wizard__item { display: flex; gap: var(--cdh-s3); align-items: flex-start; border: 1px solid var(--chatdsh-line); border-radius: var(--cdh-r2); padding: var(--cdh-s2); }
.chdsh-control-wizard__item-text { flex: 1; display: flex; flex-direction: column; gap: var(--cdh-s1); }
.chdsh-control-wizard__item-title { font-size: var(--cdh-fs-13); color: var(--chatdsh-ink); }
.chdsh-control-wizard__item-detail { font-size: var(--cdh-fs-12); color: var(--chatdsh-ink-2); }
.chdsh-control-settings { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--cdh-s2); }
.chdsh-control-settings code { font-family: var(--cdh-font-mono); font-size: var(--cdh-fs-12); }
.chdsh-control-bar { position: sticky; top: 0; z-index: 2; display: flex; flex-wrap: wrap; gap: var(--cdh-s3); align-items: center; padding: var(--cdh-s2) var(--cdh-s3); border: 1px solid var(--chatdsh-warn); border-left-width: 2px; border-radius: var(--cdh-r2); background: var(--cdh-warn-soft); color: var(--chatdsh-ink); font-size: var(--cdh-fs-13); }
.chdsh-control-bar--ended { border-color: var(--chatdsh-line); background: var(--chatdsh-panel-2); }
.chdsh-control-bar__label { display: flex; flex-direction: column; gap: var(--cdh-s1); }
.chdsh-control-bar__detail { display: flex; flex-wrap: wrap; gap: var(--cdh-s3); color: var(--chatdsh-ink-2); font-size: var(--cdh-fs-12); }
.chdsh-control-bar__acts { display: flex; gap: var(--cdh-s2); margin-left: auto; }
.chdsh-control-audit { display: flex; flex-direction: column; gap: var(--cdh-s2); }
.chdsh-control-audit__head { display: flex; gap: var(--cdh-s2); align-items: center; justify-content: space-between; }
`;
