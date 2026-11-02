/**
 * 工作区工具的样式文本。
 *
 * 只引用界面基础设计的令牌，不写颜色字面值；由主题插件与令牌一起注入文档。
 * @module @chatdsh/client-workspace-tools/styles
 */

/** 工作区面板的样式文本。 */
export const WORKSPACE_CSS = `
.chdsh-wp14 { display: flex; flex-direction: column; gap: 16px; }
.chdsh-wp14__toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.chdsh-wp14__path { flex: 1 1 220px; min-width: 160px; padding: 6px 8px; border: 1px solid var(--chatdsh-line); border-radius: var(--cdh-r-pill); background: var(--chatdsh-panel); color: var(--chatdsh-ink); }
.chdsh-wp14__preview { display: flex; flex-direction: column; gap: 8px; }
.chdsh-wp14__lines { margin: 0; padding: 0; list-style: none; font-family: var(--cdh-font-mono); font-size: 13px; }
.chdsh-wp14__lines > li { display: flex; gap: 8px; white-space: pre-wrap; }
.chdsh-wp14__lineno { min-width: 3ch; text-align: right; color: var(--chatdsh-muted); user-select: none; }
.chdsh-wp14__linetext { white-space: pre-wrap; overflow-wrap: anywhere; }
.chdsh-wp14__image { max-width: 100%; height: auto; border: 1px solid var(--chatdsh-line); border-radius: var(--cdh-r-pill); }
.chdsh-wp14__meta { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; color: var(--chatdsh-muted); font-size: 13px; }
.chdsh-wp14__filelabel { display: inline-flex; flex-direction: column; gap: 4px; font-size: 13px; }
.chdsh-wp14__attachments { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px; }
.chdsh-wp14__attachment { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px; border: 1px solid var(--chatdsh-line); border-radius: var(--cdh-r-pill); }
.chdsh-wp14__attachment:focus-visible { outline: 2px solid var(--chatdsh-focus); outline-offset: 2px; }
.chdsh-wp14__actions { display: inline-flex; gap: 6px; }
.chdsh-wp14__failure { color: var(--chatdsh-danger); }
.chdsh-wp14__rejected { margin: 0; padding-left: 20px; color: var(--chatdsh-danger); }
.chdsh-wp14__purpose { color: var(--chatdsh-muted); font-size: 13px; }
.chdsh-wp14__terminal { margin: 0; padding: 0; list-style: none; font-family: var(--cdh-font-mono); font-size: 13px; }
.chdsh-wp14__terminal > li { display: flex; gap: 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
.chdsh-wp14__terminal > li[data-terminal-kind="command"] { color: var(--chatdsh-ink); font-weight: 600; }
.chdsh-wp14__terminal > li[data-terminal-kind="notice"] { color: var(--chatdsh-muted); }
.chdsh-wp14__field { font-size: 13px; color: var(--chatdsh-muted); }
.chdsh-wp14__sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
`;
