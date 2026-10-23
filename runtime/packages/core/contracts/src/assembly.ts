/**
 * 装配常量：会话平面预设与自建插件共用的行 id。
 *
 * 这些 id 同时出现在组合包的补丁层与会话级装配代码里，集中在这里避免两处各写一份。
 * 行 id 对应的上游包名不在本包：那是上游内部 API 的引用，由 @chatdsh/adapter 登记。
 *
 * 档位的权威声明在 `./tool-tiers.ts`；这里的常量由它派生，改动档位时自动跟随。
 * @module @chatdsh/core-contracts/assembly
 */

import { DEFAULT_TOOL_TIER, presetIdOf, toolTierOf } from './tool-tiers.ts';

/** 默认会话预设的标识，会话的 `agentPreset` 缺省取这个值。 */
export const CHATDSH_PRESET_ID = presetIdOf(DEFAULT_TOOL_TIER);

/** 默认档位挂载的上游工具行 id，按补丁层里的书写顺序去掉人格与指令行之后的工具部分。 */
export const CHATDSH_TOOL_ROWS: readonly string[] = toolTierOf(DEFAULT_TOOL_TIER).upstreamRows;
