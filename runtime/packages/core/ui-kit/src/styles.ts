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
.chdsh-row + .chdsh-row { border-top: 1px solid var(--chatdsh-line-2); }
.chdsh-row__body { min-width: 0; flex: 1; }
.chdsh-row__title { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-weight: 600; color: var(--chatdsh-ink); font-size: var(--cdh-fs-13); }
.chdsh-row__meta { margin-top: 2px; color: var(--chatdsh-muted); font-size: var(--cdh-fs-12); font-family: var(--cdh-font-mono); word-break: break-all; }
.chdsh-row__acts { display: flex; flex-wrap: wrap; gap: 6px; flex-shrink: 0; max-width: 100%; }
.chdsh-badge { display: inline-flex; align-items: center; min-height: 20px; height: auto; padding: 0 8px; max-width: 100%; overflow-wrap: anywhere; border-radius: var(--cdh-r-pill); font-size: var(--cdh-fs-11); font-weight: 600; letter-spacing: 0.02em; border: 1px solid var(--chatdsh-line-2); color: var(--chatdsh-muted); }
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
.chdsh-btn:focus-visible { outline: 2px solid var(--chatdsh-focus); outline-offset: 1px; }
.chdsh-btn:disabled { opacity: 1; cursor: not-allowed; background: var(--chatdsh-panel-2); color: var(--chatdsh-muted); border-style: dashed; }
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
.chdsh-bar { height: 6px; border: 1px solid var(--chatdsh-line-2); border-radius: var(--cdh-r-pill); background: var(--chatdsh-panel); overflow: hidden; }
.chdsh-bar__fill { height: 100%; border-radius: var(--cdh-r-pill); background: var(--chatdsh-brand); }
.chdsh-bar__fill--warn { background: var(--chatdsh-warn); }
.chdsh-bar__fill--danger { background: var(--chatdsh-danger); }
.chdsh-error { margin: 0 0 8px; padding: 8px 10px; border-left: 2px solid var(--chatdsh-danger); background: var(--cdh-danger-soft); color: var(--chatdsh-ink-2); border-radius: 0 var(--cdh-r1) var(--cdh-r1) 0; font-size: var(--cdh-fs-12); }
.chdsh-btn { min-height: 44px; min-width: 44px; height: auto; padding-block: var(--cdh-s2); white-space: normal; overflow-wrap: anywhere; }
.chdsh-field { display: grid; gap: var(--cdh-s2); min-width: 0; margin-block: var(--cdh-s3); }
.chdsh-field label { color: var(--chatdsh-ink); font-weight: 600; }
.chdsh-field input, .chdsh-field textarea, .chdsh-field select { box-sizing: border-box; width: 100%; min-width: 0; min-height: 44px; padding: var(--cdh-s2); border: 1px solid var(--chatdsh-line-2); border-radius: var(--cdh-r1); background: var(--chatdsh-panel); color: var(--chatdsh-ink); font: inherit; }
.chdsh-field [aria-invalid=true] { border-color: var(--chatdsh-danger); }
.chdsh-field__help, .chdsh-field__error { margin: 0; overflow-wrap: anywhere; }
.chdsh-field__help { color: var(--chatdsh-muted); }
.chdsh-field__error { color: var(--chatdsh-danger); }
.chdsh-error-summary { border: 2px solid var(--chatdsh-danger); border-radius: var(--cdh-r2); padding: var(--cdh-s3); }
.chdsh-error-summary a { color: var(--chatdsh-brand-text); display: inline-flex; align-items: center; min-height: 44px; overflow-wrap: anywhere; }
.chdsh-scroll-region { max-width: 100%; overflow: auto; }
.chdsh-toast { display: flex; align-items: center; gap: var(--cdh-s3); padding: var(--cdh-s3); border: 1px solid var(--chatdsh-line-2); background: var(--chatdsh-panel); color: var(--chatdsh-ink); }
.chdsh-dialog { box-sizing: border-box; max-width: calc(100% - 32px); width: 560px; max-height: calc(100dvh - 32px); overflow: auto; padding: var(--cdh-s4); border: 1px solid var(--chatdsh-line-2); border-radius: var(--cdh-r4); background: var(--chatdsh-panel); color: var(--chatdsh-ink-2); }
.chdsh-dialog::backdrop { background: var(--cdh-scrim); }
.chdsh-dialog__head { display: flex; align-items: center; gap: var(--cdh-s3); justify-content: space-between; }
.chdsh-dialog__head h2 { color: var(--chatdsh-ink); margin: 0; overflow-wrap: anywhere; }
.chdsh-dialog--drawer { margin: auto 0 0 auto; height: 100dvh; max-height: 100dvh; }
.chdsh-menu { position: relative; min-width: 0; }
.chdsh-menu__list { position: absolute; z-index: 20; inset-inline-start: 0; margin: 0; padding: var(--cdh-s1); min-width: min(240px, 80vw); max-width: 90vw; list-style: none; border: 1px solid var(--chatdsh-line-2); border-radius: var(--cdh-r2); background: var(--chatdsh-panel); color: var(--chatdsh-ink); box-shadow: var(--cdh-shadow-2); }
.chdsh-menu__item { display: block; width: 100%; min-width: 44px; min-height: 44px; padding: var(--cdh-s2); border: 1px solid transparent; background: transparent; color: inherit; font: inherit; text-align: start; overflow-wrap: anywhere; cursor: pointer; }
.chdsh-menu__item:focus-visible { outline: 2px solid var(--chatdsh-focus); outline-offset: -2px; }
.chdsh-menu__item[aria-disabled=true], .chdsh-menu__reason { color: var(--chatdsh-muted); }
.chdsh-tree__root, .chdsh-tree__group { margin: 0; padding: 0; list-style: none; }
.chdsh-tree__group { padding-inline-start: var(--cdh-s4); }
.chdsh-tree__item { outline: none; }
.chdsh-tree__row { display: flex; align-items: center; min-height: 44px; min-width: 44px; gap: var(--cdh-s2); border: 1px solid transparent; padding: var(--cdh-s2); cursor: pointer; }
.chdsh-tree__item:focus-visible > .chdsh-tree__row { outline: 2px solid var(--chatdsh-focus); outline-offset: -2px; }
.chdsh-tree__item[aria-selected=true] > .chdsh-tree__row { border-color: var(--chatdsh-line-2); font-weight: 700; }
.chdsh-tree__label { min-width: 0; overflow-wrap: anywhere; user-select: text; }
.chdsh-tree__disclosure { flex-shrink: 0; }
.chdsh-tree__selected, .chdsh-tree__empty { color: var(--chatdsh-muted); }
.chdsh-error-boundary { padding: var(--cdh-s3); border: 2px solid var(--chatdsh-danger); border-radius: var(--cdh-r2); }
.chdsh-tabs { min-width: 0; }
.chdsh-tabs__list { display: flex; flex-wrap: wrap; gap: var(--cdh-s2); }
.chdsh-tabs [role=tab][aria-selected=true] { border-color: var(--chatdsh-brand); font-weight: 700; text-decoration: underline; }
.chdsh-tabs [role=tabpanel] { padding-block: var(--cdh-s3); overflow-wrap: anywhere; }
.chdsh-tabs [role=tab]:focus-visible, .chdsh-field :focus-visible, .chdsh-scroll-region:focus-visible { outline: 2px solid var(--chatdsh-focus); outline-offset: 2px; }
@media (max-width: 768px) { .chdsh-row { flex-wrap: wrap; } .chdsh-row__acts { flex-wrap: wrap; } .chdsh-dialog--drawer { width: 100%; max-width: 100%; } }
@media (forced-colors: active) { .chdsh-btn, .chdsh-field input, .chdsh-field textarea, .chdsh-field select, .chdsh-dialog { border-color: ButtonText; } .chdsh-tabs [role=tab][aria-selected=true] { outline: 2px solid Highlight; } }
.chdsh-command { display: grid; gap: var(--cdh-s2); min-width: 0; padding: var(--cdh-s4); border: 1px solid var(--chatdsh-line-2); border-radius: var(--cdh-r3); background: var(--chatdsh-panel); color: var(--chatdsh-ink-2); font-family: var(--cdh-font-ui); font-size: var(--cdh-fs-13); line-height: var(--cdh-lh-base); box-shadow: var(--cdh-shadow-2); }
.chdsh-command__input { box-sizing: border-box; width: 100%; min-width: 0; min-height: 44px; padding: var(--cdh-s2) var(--cdh-s3); border: 1px solid var(--chatdsh-line-2); border-radius: var(--cdh-r1); background: var(--chatdsh-panel-2); color: var(--chatdsh-ink); font: inherit; }
.chdsh-command__input:focus-visible { outline: 2px solid var(--chatdsh-focus); outline-offset: 2px; }
.chdsh-command__list { margin: 0; padding: var(--cdh-s1); max-height: 60dvh; overflow: auto; list-style: none; border: 1px solid var(--chatdsh-line-2); border-radius: var(--cdh-r2); background: var(--chatdsh-panel); }
.chdsh-command__item { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--cdh-s1) var(--cdh-s2); min-height: 44px; padding: var(--cdh-s2); border: 1px solid transparent; border-radius: var(--cdh-r1); overflow-wrap: anywhere; cursor: pointer; }
.chdsh-command__item--active { border-color: var(--chatdsh-brand); background: var(--chatdsh-brand-soft); color: var(--chatdsh-ink); }
.chdsh-command__item[aria-disabled=true] { border-style: dashed; color: var(--chatdsh-muted); cursor: not-allowed; }
.chdsh-command__item[aria-disabled=true] .chdsh-command__title { color: var(--chatdsh-muted); }
.chdsh-command__title { min-width: 0; overflow-wrap: anywhere; font-weight: 600; color: var(--chatdsh-ink); }
.chdsh-command__description { color: var(--chatdsh-muted); font-size: var(--cdh-fs-12); }
.chdsh-command__shortcut { margin-inline-start: auto; color: var(--chatdsh-faint); font-family: var(--cdh-font-mono); font-size: var(--cdh-fs-11); }
.chdsh-command__reason { flex-basis: 100%; color: var(--chatdsh-muted); font-size: var(--cdh-fs-12); }
.chdsh-command__hint, .chdsh-command__empty { margin: 0; padding: var(--cdh-s3); color: var(--chatdsh-muted); font-size: var(--cdh-fs-12); }
@media (forced-colors: active) { .chdsh-command, .chdsh-command__input, .chdsh-command__list, .chdsh-command__item--active { border-color: ButtonText; } .chdsh-command__item--active { outline: 2px solid Highlight; } }
`;
