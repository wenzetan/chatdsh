/**
 * 设置增强包在宿主侧的入口。
 *
 * 本包的两个浏览器侧区段（运行参数与通用外观的补充项）从宿主设置服务读写；运行参数里
 * 终端程序、编辑器、文件管理器与快捷键没有上游命名空间，因此由本插件自己的配置承载，
 * 命名空间就是 profile 里这一行的标识。配置在这里给出 schema，写入经设置服务校验并落在
 * profile 补丁层，重启后由同一份 schema 读回。
 *
 * 浏览器产物由 `dsh.client` 声明与 `./client` 子路径提供。
 * @module @chatdsh/host-settings-enhancements
 */

import { schema as z } from '@chatdsh/adapter';
import { DEFAULT_SHORTCUTS, ENHANCEMENT_FIELDS, MOTION_PREFERENCES, NAMESPACE_ID } from './shared.ts';

export { DEFAULT_SHORTCUTS, ENHANCEMENT_FIELDS, MOTION_PREFERENCES, NAMESPACE_ID } from './shared.ts';
export type { MotionPreference, ShortcutConfig } from './shared.ts';

/** 设置页区段席位名，与浏览器侧共用同一个约定。 */
export const SECTION_SLOT = 'settings.section';

/** 浏览器侧产物相对包根的路径。 */
export const CLIENT_ENTRY = './client';

/** 配置：本页自有偏好，全部按设备保存。 */
export interface EnhancementsConfig {
  /** 动效偏好。 */
  readonly motion: string;
  /** 终端程序路径；空串表示使用系统缺省。 */
  readonly shellProgram: string;
  /** 终端程序的参数列表。 */
  readonly shellArgs: readonly string[];
  /** 编辑器程序路径。 */
  readonly editorProgram: string;
  /** 文件管理器程序路径。 */
  readonly fileManagerProgram: string;
  /** 可录入的快捷键：发送消息。 */
  readonly shortcutSend: string;
  /** 可录入的快捷键：消息换行。 */
  readonly shortcutNewline: string;
  /** 可录入的快捷键：命令搜索。 */
  readonly shortcutCommand: string;
}

/** 配置 schema：字段名与浏览器侧的字段目录一致；每个字段都是可热改的取值。 */
export const Config = z.object({
  [ENHANCEMENT_FIELDS.motion]: z.union([...MOTION_PREFERENCES]).default('system').volatile(),
  [ENHANCEMENT_FIELDS.shellProgram]: z.string().default('').volatile(),
  [ENHANCEMENT_FIELDS.shellArgs]: z.array(z.string()).default([]).volatile(),
  [ENHANCEMENT_FIELDS.editorProgram]: z.string().default('').volatile(),
  [ENHANCEMENT_FIELDS.fileManagerProgram]: z.string().default('').volatile(),
  [ENHANCEMENT_FIELDS.shortcutSend]: z.string().default(DEFAULT_SHORTCUTS.send).volatile(),
  [ENHANCEMENT_FIELDS.shortcutNewline]: z.string().default(DEFAULT_SHORTCUTS.newline).volatile(),
  [ENHANCEMENT_FIELDS.shortcutCommand]: z.string().default(DEFAULT_SHORTCUTS.command).volatile(),
});

/** 宿主侧插件体：本插件的全部行为在浏览器侧，宿主只提供配置 schema。 */
export function apply(): void {}

export default { name: NAMESPACE_ID, Config, apply };
