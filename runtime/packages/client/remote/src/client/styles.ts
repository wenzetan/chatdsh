/**
 * 远程设备界面的样式。
 *
 * 颜色、字号与圆角全部引用官方客户端的主题令牌；类名统一使用 `chatdsh-remote-`
 * 前缀，不覆盖任何官方类名。窄屏下设备与会话改为单列，操作按钮保持可触控高度。
 * @module @chatdsh/client-remote/styles
 */

/** 本包注入的样式文本。 */
export const REMOTE_CSS = `
.chatdsh-remote-panel {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  height: 100%;
  min-height: 0;
  padding: 1rem;
  overflow: auto;
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsh-font-family-text);
  font-size: var(--dsw-font-base-16-font-size);
  line-height: 1.55;
}

.chatdsh-remote-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.chatdsh-remote-title {
  margin: 0;
  font-size: var(--dsw-font-m-18-font-size);
  font-weight: 600;
}

.chatdsh-remote-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}

.chatdsh-remote-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.25rem 0.625rem;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
  color: var(--dsw-alias-label-secondary);
  font-size: var(--dsw-font-s-14-font-size);
  white-space: nowrap;
}

.chatdsh-remote-badge[data-state="connected"] {
  color: var(--dsw-alias-state-success-primary);
  border-color: var(--dsw-alias-state-success-primary);
}

.chatdsh-remote-badge[data-state="disconnected"] {
  color: var(--dsw-alias-state-warn-primary);
  border-color: var(--dsw-alias-state-warn-primary);
}

.chatdsh-remote-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 2.25rem;
  padding: 0 0.75rem;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: var(--dsw-font-s-14-font-size);
  cursor: pointer;
}

.chatdsh-remote-button:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.chatdsh-remote-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.chatdsh-remote-button-primary {
  border-color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-bg-base);
}

.chatdsh-remote-button-primary:hover {
  background: var(--dsw-alias-brand-primary);
}

.chatdsh-remote-link {
  color: var(--dsw-alias-brand-primary);
  text-decoration: none;
  white-space: nowrap;
}

.chatdsh-remote-link:hover {
  text-decoration: underline;
}

.chatdsh-remote-columns {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr);
  gap: 1rem;
  min-height: 0;
}

.chatdsh-remote-section {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  min-width: 0;
  padding: 0.75rem;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
}

.chatdsh-remote-section-title {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: var(--dsw-font-s-14-font-size);
  font-weight: 600;
}

.chatdsh-remote-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.chatdsh-remote-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  min-width: 0;
  padding: 0.5rem 0;
  border-top: 1px solid var(--dsw-alias-border-l1);
}

.chatdsh-remote-row:first-child {
  border-top: 0;
  padding-top: 0;
}

.chatdsh-remote-row-main {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  min-width: 0;
  flex: 1 1 12rem;
}

.chatdsh-remote-row-title {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  min-width: 0;
  font-weight: 500;
  overflow-wrap: anywhere;
}

.chatdsh-remote-dot {
  flex: none;
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--dsw-alias-state-idle-primary);
}

.chatdsh-remote-dot[data-online="true"] {
  background: var(--dsw-alias-state-success-primary);
}

.chatdsh-remote-meta {
  color: var(--dsw-alias-label-tertiary);
  font-size: var(--dsw-font-s-14-font-size);
  overflow-wrap: anywhere;
}

.chatdsh-remote-empty {
  color: var(--dsw-alias-label-tertiary);
  font-size: var(--dsw-font-s-14-font-size);
}

.chatdsh-remote-error {
  color: var(--dsw-alias-state-error-primary);
  font-size: var(--dsw-font-s-14-font-size);
}

.chatdsh-remote-notice {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-layer-2);
  font-size: var(--dsw-font-s-14-font-size);
}

.chatdsh-remote-notice[data-kind="error"] {
  color: var(--dsw-alias-state-error-primary);
  border-color: var(--dsw-alias-state-error-primary);
}

.chatdsh-remote-statusbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.625rem;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-size: var(--dsw-font-s-14-font-size);
}

.chatdsh-remote-replica {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  min-height: 0;
}

.chatdsh-remote-replica-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.chatdsh-remote-replica-title {
  margin: 0;
  font-size: var(--dsw-font-m-18-font-size);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.chatdsh-remote-replica-badge {
  display: inline-flex;
  align-items: center;
  padding: 0.25rem 0.625rem;
  border: 1px solid var(--dsw-alias-state-warn-primary);
  border-radius: var(--dsw-radius-sm);
  color: var(--dsw-alias-state-warn-primary);
  font-size: var(--dsw-font-s-14-font-size);
}

.chatdsh-remote-replica-badge[data-online="true"] {
  border-color: var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
}

.chatdsh-remote-events {
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.chatdsh-remote-event {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0.625rem 0.75rem;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
}

.chatdsh-remote-event[data-kind="user"] {
  border-color: var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
}

.chatdsh-remote-event[data-kind="tool-result"][data-failed="true"],
.chatdsh-remote-event[data-kind="approval-decided"][data-failed="true"] {
  border-color: var(--dsw-alias-state-error-primary);
}

.chatdsh-remote-event-label {
  color: var(--dsw-alias-label-secondary);
  font-size: var(--dsw-font-s-14-font-size);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.chatdsh-remote-event-text {
  margin: 0;
  color: var(--dsw-alias-label-primary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.chatdsh-remote-event-code {
  margin: 0;
  padding: 0.5rem;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-secondary);
  font-family: var(--dsh-font-family-code);
  font-size: var(--dsw-font-xs-13-font-size);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.chatdsh-remote-event-detail {
  color: var(--dsw-alias-label-tertiary);
  font-size: var(--dsw-font-xs-13-font-size);
  overflow-wrap: anywhere;
}

.chatdsh-remote-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--dsw-alias-border-l1);
}

.chatdsh-remote-settings {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  max-width: 42rem;
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsh-font-family-text);
  font-size: var(--dsw-font-base-16-font-size);
  line-height: 1.55;
}

.chatdsh-remote-settings-title {
  margin: 0;
  font-size: var(--dsw-font-m-18-font-size);
  font-weight: 600;
}

.chatdsh-remote-facts {
  display: grid;
  grid-template-columns: minmax(7rem, auto) minmax(0, 1fr);
  gap: 0.5rem 1rem;
  margin: 0;
}

.chatdsh-remote-facts dt {
  color: var(--dsw-alias-label-secondary);
}

.chatdsh-remote-facts dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.chatdsh-remote-field {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.chatdsh-remote-field label {
  color: var(--dsw-alias-label-secondary);
  font-size: var(--dsw-font-s-14-font-size);
}

.chatdsh-remote-input {
  min-height: 2.25rem;
  padding: 0 0.625rem;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
}

.chatdsh-remote-input:focus-visible,
.chatdsh-remote-button:focus-visible,
.chatdsh-remote-link:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}

.chatdsh-remote-hint {
  color: var(--dsw-alias-label-tertiary);
  font-size: var(--dsw-font-xs-13-font-size);
}

.chatdsh-remote-token {
  display: block;
  padding: 0.5rem;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsh-font-family-code);
  font-size: var(--dsw-font-xs-13-font-size);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.chatdsh-remote-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@media (max-width: 720px) {
  .chatdsh-remote-panel {
    padding: 0.75rem;
  }

  .chatdsh-remote-columns {
    grid-template-columns: minmax(0, 1fr);
  }

  .chatdsh-remote-button,
  .chatdsh-remote-input {
    min-height: 2.75rem;
  }

  .chatdsh-remote-facts {
    grid-template-columns: minmax(0, 1fr);
    gap: 0.25rem;
  }

  .chatdsh-remote-facts dt {
    margin-top: 0.5rem;
  }
}
`;

/** 样式节点的标识。 */
export const STYLE_ID = 'chatdsh-remote-styles';

/**
 * 挂载样式。
 * @param doc - 目标文档。
 * @returns 卸载函数：移除样式节点。
 */
export function installRemoteStyles(doc: Document = document): () => void {
  const existing = doc.getElementById(STYLE_ID);
  if (existing !== null) return () => undefined;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = REMOTE_CSS;
  doc.head.append(style);
  return () => {
    style.remove();
  };
}
