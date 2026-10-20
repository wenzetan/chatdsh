/**
 * 会话平面组合包。
 *
 * `chatdsh` 预设声明在这个组合包的补丁层里：它列出会话要挂载的行，工具可见范围由预设差异
 * 与 `ctx.tools.restrict` 收敛。工作会话与聊天会话共用这个预设；聊天会话在 `chatBackend`
 * 为 `hermes` 时改用空组合，执行由 Hermes 承载。
 * @module @chatdsh/preset-chat
 */

/** 预设标识，会话的 `agentPreset` 取这个值。 */
export const CHATDSH_PRESET_ID = 'chatdsh';

/** 预设挂载的行 id，按补丁层里的书写顺序。 */
export const CHATDSH_PRESET_ROWS = [
  'persona',
  'agent-instructions',
  'time-context',
  'tool-bash',
  'tool-pwsh',
  'tool-fs',
  'tool-fs-search',
  'skill-filesystem',
  'tool-skill',
  'tool-jobs',
  'tool-todo',
  'tool-web',
  'chatdsh-tool-artifact',
  'chatdsh-tool-project',
  'chatdsh-tool-share',
  'chatdsh-tool-connector',
  'chatdsh-tool-research',
  'chatdsh-tool-image',
] as const;

/** 相对组合包根的补丁文件路径。 */
export const PATCH_FILE = './cordis.patch.yml';
