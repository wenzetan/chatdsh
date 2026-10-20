/**
 * 装配常量：会话平面预设与自建插件共用的行 id。
 *
 * 这些 id 同时出现在组合包的补丁层与会话级装配代码里，集中在这里避免两处各写一份。
 * 行 id 对应的上游包名不在本包：那是上游内部 API 的引用，由 @chatdsh/adapter 登记。
 * @module @chatdsh/contracts/assembly
 */

/** 会话平面预设的标识，会话的 `agentPreset` 取这个值。 */
export const CHATDSH_PRESET_ID = 'chatdsh';

/** 预设挂载的工具行 id，按补丁层里的书写顺序去掉人格与指令行之后的工具部分。 */
export const CHATDSH_TOOL_ROWS = [
  'tool-bash',
  'tool-pwsh',
  'tool-fs',
  'tool-fs-search',
  'skill-filesystem',
  'tool-skill',
  'tool-jobs',
  'tool-todo',
  'tool-web',
] as const;
