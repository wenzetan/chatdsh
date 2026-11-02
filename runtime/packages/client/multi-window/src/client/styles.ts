/**
 * 窗口与分屏界面的样式。
 *
 * 样式以文本随产物内联，挂载时写到固定标识的 `<style>` 节点；重复挂载只保留一份。配色、
 * 间距与圆角全部取自主题插件注入的令牌，本样式里不出现颜色字面值。
 * @module @chatdsh/client-multi-window/styles
 */

/** 样式节点的标识。 */
export const STYLE_ID = 'chatdsh-multi-window-styles';

/** 本包注入的样式文本。 */
export const MULTI_WINDOW_CSS = `
.chatdsh-mw {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  background: var(--chatdsh-bg);
  color: var(--chatdsh-ink);
  font: inherit;
}

.chatdsh-mw__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--cdh-s2);
  padding: var(--cdh-s2) var(--cdh-s3);
  border-bottom: 1px solid var(--chatdsh-line);
  background: var(--chatdsh-panel);
}

.chatdsh-mw__tabs {
  display: flex;
  gap: var(--cdh-s1);
  flex-wrap: wrap;
  margin: 0;
  padding: 0;
  list-style: none;
}

.chatdsh-mw__tab {
  display: inline-flex;
  align-items: center;
  gap: var(--cdh-s1);
  min-height: 32px;
  padding: 0 var(--cdh-s2);
  border: 1px solid var(--chatdsh-line);
  border-radius: var(--cdh-r2);
  background: var(--chatdsh-panel-2);
  color: var(--chatdsh-ink-2);
  font: inherit;
  cursor: pointer;
}

.chatdsh-mw__tab[aria-selected="true"] {
  border-color: var(--chatdsh-brand);
  color: var(--chatdsh-ink);
  background: var(--chatdsh-brand-soft);
}

.chatdsh-mw__tab:focus-visible,
.chatdsh-mw__button:focus-visible,
.chatdsh-mw__separator:focus-visible,
.chatdsh-mw__composer:focus-visible {
  outline: 2px solid var(--chatdsh-focus);
  outline-offset: 2px;
}

.chatdsh-mw__button {
  min-height: 32px;
  padding: 0 var(--cdh-s3);
  border: 1px solid var(--chatdsh-line-2);
  border-radius: var(--cdh-r2);
  background: var(--chatdsh-panel-2);
  color: var(--chatdsh-ink);
  font: inherit;
  cursor: pointer;
}

.chatdsh-mw__button--primary {
  border-color: var(--chatdsh-brand);
  background: var(--chatdsh-brand-fill);
  color: var(--chatdsh-ink);
}

.chatdsh-mw__status {
  margin-left: auto;
  color: var(--chatdsh-muted);
  font-size: var(--cdh-fs-12);
}

.chatdsh-mw__body {
  display: flex;
  min-height: 0;
  flex: 1;
}

.chatdsh-mw__body[data-mode="single"] .chatdsh-mw__separator {
  display: none;
}

.chatdsh-mw__pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border-top: 2px solid transparent;
}

.chatdsh-mw__pane[data-focused="true"] {
  border-top-color: var(--chatdsh-brand);
}

.chatdsh-mw__body[data-mode="single"] .chatdsh-mw__pane[data-hidden="true"] {
  display: none;
}

.chatdsh-mw__pane-head {
  display: flex;
  align-items: center;
  gap: var(--cdh-s2);
  padding: var(--cdh-s2) var(--cdh-s3);
  border-bottom: 1px solid var(--chatdsh-line);
  color: var(--chatdsh-ink-2);
  font-size: var(--cdh-fs-12);
}

.chatdsh-mw__messages,
.chatdsh-mw__object {
  flex: 1;
  margin: 0;
  padding: var(--cdh-s3);
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: var(--cdh-fs-13);
  line-height: 1.55;
}

.chatdsh-mw__messages {
  padding: 0;
  list-style: none;
}

.chatdsh-mw__messages li {
  padding: var(--cdh-s1) var(--cdh-s3);
  border-bottom: 1px solid var(--chatdsh-line);
}

.chatdsh-mw__separator {
  flex: 0 0 8px;
  width: 8px;
  border: 0;
  border-left: 1px solid var(--chatdsh-line);
  border-right: 1px solid var(--chatdsh-line);
  background: var(--chatdsh-panel-2);
  cursor: col-resize;
  touch-action: none;
}

.chatdsh-mw__separator[aria-valuenow] {
  background-image: linear-gradient(to bottom, transparent, var(--chatdsh-line-2), transparent);
}

.chatdsh-mw__conflict {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--cdh-s2);
  padding: var(--cdh-s2) var(--cdh-s3);
  border-bottom: 1px solid var(--chatdsh-warn);
  background: var(--chatdsh-panel-2);
  color: var(--chatdsh-ink);
}

.chatdsh-mw__conflict[hidden] {
  display: none;
}

.chatdsh-mw__composer-row {
  display: flex;
  gap: var(--cdh-s2);
  padding: var(--cdh-s2) var(--cdh-s3);
  border-top: 1px solid var(--chatdsh-line);
  background: var(--chatdsh-panel);
}

.chatdsh-mw__composer {
  flex: 1;
  min-height: 48px;
  max-height: 160px;
  padding: var(--cdh-s2);
  border: 1px solid var(--chatdsh-line-2);
  border-radius: var(--cdh-r2);
  background: var(--chatdsh-code-bg);
  color: var(--chatdsh-ink);
  font: inherit;
  resize: vertical;
}

.chatdsh-mw__hint {
  padding: 0 var(--cdh-s3) var(--cdh-s2);
  color: var(--chatdsh-muted);
  font-size: var(--cdh-fs-12);
}

.chatdsh-mw__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

@media (forced-colors: active) {
  .chatdsh-mw__tab[aria-selected="true"] {
    forced-color-adjust: none;
    border: 2px solid CanvasText;
  }
}

@media (prefers-reduced-motion: no-preference) {
  .chatdsh-mw__separator {
    transition: background-color 120ms linear;
  }
}
`;

/**
 * 挂载样式。
 * @param doc - 目标文档。
 * @returns 卸载函数：移除样式节点。
 */
export function installMultiWindowStyles(doc: Document = document): () => void {
  const existing = doc.getElementById(STYLE_ID);
  if (existing !== null) return () => undefined;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = MULTI_WINDOW_CSS;
  doc.head.append(style);
  return () => {
    style.remove();
  };
}
