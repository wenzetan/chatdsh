/**
 * 组件样式：全部以 `var(--chatdsh-*)` 与 `var(--cdh-*)` 引用界面基础设计的令牌。
 *
 * 令牌由主题插件挂到文档根上，组件自身不写颜色字面值，因此两套配色随主题一起切换。
 * @module @chatdsh/core-ui-kit/styles
 */

/** 一段样式文本，注入到 `<style data-chatdsh-ui-kit>`。 */
export const UI_KIT_CSS = `
.chdsh-panel { --chdsh-row-h: calc(var(--cdh-fs-13) * 1.6 + var(--cdh-fs-12) * 1.6 + 22px); font-family: var(--cdh-font-ui); font-size: var(--cdh-fs-13); color: var(--chatdsh-ink-2); line-height: var(--cdh-lh-base); }
.chdsh-panel__head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 10px; }
.chdsh-panel__title { margin: 0; font-size: var(--cdh-fs-14); font-weight: 600; color: var(--chatdsh-ink); letter-spacing: -0.01em; }
.chdsh-panel__sub { margin: 0 0 12px; color: var(--chatdsh-muted); font-size: var(--cdh-fs-12); }
.chdsh-panel__count { margin-left: auto; font-family: var(--cdh-font-mono); font-size: var(--cdh-fs-11); color: var(--chatdsh-faint); }
.chdsh-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.chdsh-row { display: flex; align-items: center; gap: 10px; padding: 9px 10px; min-height: var(--chdsh-row-h); border-radius: var(--cdh-r2); border: 1px solid transparent; }
.chdsh-row:hover { background: var(--cdh-hover); }
.chdsh-row + .chdsh-row { border-top: 1px solid var(--chatdsh-line); }
.chdsh-row__body { min-width: 0; flex: 1; }
.chdsh-row__title { display: flex; align-items: center; gap: 6px; font-weight: 600; color: var(--chatdsh-ink); font-size: var(--cdh-fs-13); }
.chdsh-row__meta { margin-top: 2px; color: var(--chatdsh-muted); font-size: var(--cdh-fs-12); font-family: var(--cdh-font-mono); word-break: break-all; }
.chdsh-row__acts { display: flex; gap: 6px; flex-shrink: 0; }
.chdsh-badge { display: inline-flex; align-items: center; height: 20px; padding: 0 8px; border-radius: var(--cdh-r-pill); font-size: var(--cdh-fs-11); font-weight: 600; letter-spacing: 0.02em; border: 1px solid var(--chatdsh-line-2); color: var(--chatdsh-muted); }
.chdsh-badge--ok { border-color: transparent; background: var(--cdh-ok-soft); color: var(--chatdsh-ok); }
.chdsh-badge--warn { border-color: transparent; background: var(--cdh-warn-soft); color: var(--chatdsh-warn); }
.chdsh-badge--danger { border-color: transparent; background: var(--cdh-danger-soft); color: var(--chatdsh-danger); }
.chdsh-badge--brand { border-color: transparent; background: var(--chatdsh-brand-soft); color: var(--chatdsh-brand-text); }
.chdsh-dot { width: 8px; height: 8px; border-radius: var(--cdh-r-pill); background: var(--chatdsh-faint); flex: 0 0 auto; }
.chdsh-dot--ok { background: var(--chatdsh-ok); }
.chdsh-dot--warn { background: var(--chatdsh-warn); }
.chdsh-dot--danger { background: var(--chatdsh-danger); }
.chdsh-btn { height: 26px; padding: 0 10px; border-radius: var(--cdh-r1); font-family: inherit; font-size: var(--cdh-fs-12); background: transparent; color: var(--chatdsh-muted); border: 1px solid var(--chatdsh-line-2); cursor: pointer; transition: color var(--cdh-dur-1) var(--cdh-ease), background var(--cdh-dur-1) var(--cdh-ease); }
.chdsh-btn:hover { color: var(--chatdsh-ink); background: var(--cdh-hover); }
.chdsh-btn:focus-visible { outline: 2px solid var(--chatdsh-brand); outline-offset: 1px; }
.chdsh-btn:disabled { opacity: 0.5; cursor: default; }
.chdsh-btn--danger { color: var(--chatdsh-danger); }
.chdsh-btn--danger:hover { background: var(--cdh-danger-soft); }
.chdsh-btn--primary { background: var(--chatdsh-brand-fill); color: var(--cdh-on-brand); border-color: transparent; }
.chdsh-btn--primary:hover { background: var(--chatdsh-brand-fill-down); color: var(--cdh-on-brand); }
.chdsh-skeleton { padding: 9px 10px; min-height: var(--chdsh-row-h); border-radius: var(--cdh-r2); border: 1px solid transparent; }
.chdsh-skeleton + .chdsh-skeleton { margin-top: 2px; border-top-color: var(--chatdsh-line); }
.chdsh-skeleton::before, .chdsh-skeleton::after { content: ""; display: block; border-radius: var(--cdh-r1); background: linear-gradient(90deg, var(--chatdsh-line) 0%, var(--chatdsh-line-2) 50%, var(--chatdsh-line) 100%); background-size: 240% 100%; animation: chdsh-shimmer 1.5s linear infinite; }
.chdsh-skeleton::before { height: calc(var(--cdh-fs-13) * 1.6); }
.chdsh-skeleton::after { height: calc(var(--cdh-fs-12) * 1.6); margin-top: 2px; }
@keyframes chdsh-shimmer { 0% { background-position: 100% 0; } 100% { background-position: -140% 0; } }
@media (prefers-reduced-motion: reduce) { .chdsh-skeleton::before, .chdsh-skeleton::after { animation-duration: 0.001ms; } .chdsh-btn { transition-duration: 0.001ms; } }
.chdsh-empty { padding: 18px 12px; border: 1px dashed var(--chatdsh-line-2); border-radius: var(--cdh-r2); color: var(--chatdsh-muted); font-size: var(--cdh-fs-12); text-align: center; }
.chdsh-empty__action { margin-top: 8px; color: var(--chatdsh-brand-text); }
.chdsh-bar { height: 4px; border-radius: var(--cdh-r-pill); background: var(--chatdsh-line); overflow: hidden; }
.chdsh-bar__fill { height: 100%; border-radius: var(--cdh-r-pill); background: var(--chatdsh-brand); }
.chdsh-bar__fill--warn { background: var(--chatdsh-warn); }
.chdsh-bar__fill--danger { background: var(--chatdsh-danger); }
.chdsh-error { margin: 0 0 8px; padding: 8px 10px; border-left: 2px solid var(--chatdsh-danger); background: var(--cdh-danger-soft); color: var(--chatdsh-ink-2); border-radius: 0 var(--cdh-r1) var(--cdh-r1) 0; font-size: var(--cdh-fs-12); }
`;
