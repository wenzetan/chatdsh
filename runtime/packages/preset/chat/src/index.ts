/**
 * 会话平面组合包。
 *
 * 三档 preset 声明在这个组合包的补丁层里：它们列出会话要挂载的行，工具可见范围由预设
 * 差异与 `ctx.tools.restrict` 收敛。档位从轻到重是聊天、工作、全量，工作档为默认。
 * 聊天会话在 `chatBackend` 为 `hermes` 时改用空组合，执行由 Hermes 承载。
 *
 * 档位的声明同时存在于 `@chatdsh/core-contracts` 的 `tool-tiers` 里：装配助手与校验脚本
 * 从那里读，补丁层按同一顺序书写，改动时两处同步。
 * @module @chatdsh/preset-chat
 */

import {
  CHAT_TIER,
  DEFAULT_TOOL_TIER,
  FULL_TIER,
  WORK_TIER,
  presetIdOf,
  type ChatdshToolTier,
} from '@chatdsh/core-contracts';

export { CHAT_TIER, DEFAULT_TOOL_TIER, FULL_TIER, WORK_TIER, presetIdOf };
export type { ChatdshToolTier };

/** 默认预设标识，会话的 `agentPreset` 取这个值。 */
export const CHATDSH_PRESET_ID = presetIdOf(DEFAULT_TOOL_TIER);

/** 全部档位，按排序值排列。 */
export const CHATDSH_PRESETS: readonly ChatdshToolTier[] = [CHAT_TIER, WORK_TIER, FULL_TIER];

/** 人格、指令与时间上下文这三行所有档位共用。 */
export const CHATDSH_COMMON_ROWS = ['persona', 'agent-instructions', 'time-context'] as const;

/** 工作档挂载的行 id，按补丁层里的书写顺序；保留旧名以兼容既有引用。 */
export const CHATDSH_PRESET_ROWS = [
  ...CHATDSH_COMMON_ROWS,
  ...WORK_TIER.upstreamRows,
  ...WORK_TIER.chatdshRows,
] as const;

/** 相对组合包根的补丁文件路径。 */
export const PATCH_FILE = './cordis.patch.yml';
