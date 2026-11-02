/**
 * 会话区样式：只引用界面基础设计的令牌。
 *
 * 颜色、字号、间距、圆角与动效时长全部来自主题插件挂到文档根上的自定义属性，这里不写颜色
 * 字面值，因此暗色、亮色与高对比度随主题一起切换。宽内容（代码、工具结果）各自拥有独立横向
 * 滚动区域与可访问名称。
 * @module @chatdsh/client-conversation/styles
 */

/** 会话区样式文本。 */
export const CONVERSATION_CSS = `
.chdsh-conv { display: grid; grid-template-rows: auto minmax(0, 1fr) auto auto; min-height: 0; height: 100%; background: var(--chatdsh-bg); color: var(--chatdsh-ink-2); font-family: var(--cdh-font-ui); font-size: var(--cdh-fs-13); line-height: var(--cdh-lh-base); }
.chdsh-conv__header { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--cdh-s2); padding: var(--cdh-s2) var(--cdh-s3); border-bottom: 1px solid var(--chatdsh-line); }
.chdsh-conv__title { margin: 0; font-size: var(--cdh-fs-14); color: var(--chatdsh-ink); }
.chdsh-conv__meta { color: var(--chatdsh-muted); font-size: var(--cdh-fs-12); font-family: var(--cdh-font-mono); overflow-wrap: anywhere; }
.chdsh-conv__messages { position: relative; overflow: auto; padding: var(--cdh-s3); display: flex; flex-direction: column; gap: var(--cdh-s3); min-height: 0; }
.chdsh-conv__msg { display: grid; gap: var(--cdh-s1); border: 1px solid transparent; border-radius: var(--cdh-r2); padding: var(--cdh-s2); }
.chdsh-conv__msg--user { border-color: var(--chatdsh-line-2); background: var(--chatdsh-panel-2); }
.chdsh-conv__msg--system, .chdsh-conv__msg--developer { border-style: dashed; border-color: var(--chatdsh-line-2); }
.chdsh-conv__msg--streaming { border-color: var(--chatdsh-brand); }
.chdsh-conv__msg--failed { border-color: var(--chatdsh-danger); }
.chdsh-conv__msgmeta { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--cdh-s2); color: var(--chatdsh-muted); font-size: var(--cdh-fs-11); }
.chdsh-conv__role { color: var(--chatdsh-ink); font-weight: 600; }
.chdsh-conv__body { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--chatdsh-ink-2); }
.chdsh-conv__body--mono { font-family: var(--cdh-font-mono); }
.chdsh-conv__thinking { border: 1px dashed var(--chatdsh-line-2); border-radius: var(--cdh-r1); padding: var(--cdh-s2); color: var(--chatdsh-muted); }
.chdsh-conv__thinking summary, .chdsh-conv__tool summary, .chdsh-conv__trace summary { cursor: pointer; min-height: 44px; display: flex; align-items: center; gap: var(--cdh-s2); }
.chdsh-conv__tool { border: 1px solid var(--chatdsh-line-2); border-radius: var(--cdh-r2); background: var(--chatdsh-panel); padding: var(--cdh-s2); }
.chdsh-conv__toolhead { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--cdh-s2); }
.chdsh-conv__toolname { color: var(--chatdsh-ink); font-weight: 600; }
.chdsh-conv__code { margin: var(--cdh-s1) 0 0; padding: var(--cdh-s2); border: 1px solid var(--chatdsh-line-2); border-radius: var(--cdh-r1); background: var(--chatdsh-code-bg); color: var(--chatdsh-ink-2); font-family: var(--cdh-font-mono); font-size: var(--cdh-fs-12); overflow: auto; max-height: 320px; white-space: pre; }
.chdsh-conv__trace { border-top: 1px solid var(--chatdsh-line); padding-top: var(--cdh-s2); }
.chdsh-conv__traceitem { color: var(--chatdsh-muted); font-size: var(--cdh-fs-12); font-family: var(--cdh-font-mono); }
.chdsh-conv__composer { border-top: 1px solid var(--chatdsh-line); padding: var(--cdh-s2) var(--cdh-s3); display: grid; gap: var(--cdh-s2); background: var(--chatdsh-panel); }
.chdsh-conv__input { box-sizing: border-box; width: 100%; min-height: 88px; padding: var(--cdh-s2); border: 1px solid var(--chatdsh-line-2); border-radius: var(--cdh-r1); background: var(--chatdsh-panel-2); color: var(--chatdsh-ink); font: inherit; resize: vertical; }
.chdsh-conv__input:focus-visible, .chdsh-conv__chip:focus-visible, .chdsh-conv__newmsg:focus-visible { outline: 2px solid var(--chatdsh-focus); outline-offset: 2px; }
.chdsh-conv__input[aria-invalid=true] { border-color: var(--chatdsh-danger); }
.chdsh-conv__row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--cdh-s2); }
.chdsh-conv__hint { margin: 0; color: var(--chatdsh-muted); font-size: var(--cdh-fs-12); }
.chdsh-conv__hint--danger { color: var(--chatdsh-danger); }
.chdsh-conv__chips { display: flex; flex-wrap: wrap; gap: var(--cdh-s1); margin: 0; padding: 0; list-style: none; }
.chdsh-conv__chip { display: inline-flex; align-items: center; gap: var(--cdh-s1); min-height: 44px; padding: 0 var(--cdh-s2); border: 1px solid var(--chatdsh-line-2); border-radius: var(--cdh-r-pill); background: var(--chatdsh-panel-2); color: var(--chatdsh-ink-2); font-size: var(--cdh-fs-12); }
.chdsh-conv__chip--invalid { border-style: dashed; border-color: var(--chatdsh-danger); color: var(--chatdsh-danger); }
.chdsh-conv__queue { border-top: 1px solid var(--chatdsh-line); padding: var(--cdh-s2) var(--cdh-s3); display: grid; gap: var(--cdh-s1); }
.chdsh-conv__queueitem { display: flex; flex-wrap: wrap; align-items: center; gap: var(--cdh-s2); padding: var(--cdh-s1) 0; border-bottom: 1px solid var(--chatdsh-line); }
.chdsh-conv__queuetext { min-width: 0; flex: 1; overflow-wrap: anywhere; }
.chdsh-conv__newmsg { position: sticky; bottom: 0; align-self: center; min-height: 44px; padding: 0 var(--cdh-s3); border: 1px solid var(--chatdsh-brand); border-radius: var(--cdh-r-pill); background: var(--chatdsh-brand-soft); color: var(--chatdsh-brand-text); }
.chdsh-conv__sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
.chdsh-conv__palette { position: fixed; inset-block-start: 12%; inset-inline: 0; margin-inline: auto; width: min(560px, calc(100% - 24px)); z-index: 40; }
.chdsh-conv__trigger { position: absolute; inset-block-end: 100%; inset-inline: 0; z-index: 30; margin-bottom: var(--cdh-s1); }
.chdsh-conv__announce { margin: 0; }
@media (max-width: 768px) { .chdsh-conv__messages { padding: var(--cdh-s2); } .chdsh-conv__input { min-height: 72px; } }
@media (forced-colors: active) { .chdsh-conv__msg, .chdsh-conv__tool, .chdsh-conv__code, .chdsh-conv__chip, .chdsh-conv__input { border-color: ButtonText; } .chdsh-conv__msg--streaming { outline: 2px solid Highlight; } }
`;
