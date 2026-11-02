/**
 * 设置增强包在宿主侧与浏览器侧共用的约定。
 *
 * 这些取值同时约束设置服务的命名空间、界面上的可选项与录入快捷键的默认值；两侧从同一处
 * 取值，避免界面写入宿主不接受的枚举。
 * @module @chatdsh/host-settings-enhancements/shared
 */

/** 本插件持有的设置命名空间，等于 profile 里的行标识。 */
export const NAMESPACE_ID = 'chatdsh-settings-enhancements';

/** 动效偏好：跟随系统、减少动效、完整动效。 */
export const MOTION_PREFERENCES = ['system', 'reduced', 'full'] as const;

/** 动效偏好的取值。 */
export type MotionPreference = typeof MOTION_PREFERENCES[number];

/** 一组可录入的快捷键。 */
export interface ShortcutConfig {
  /** 发送消息。 */
  readonly send: string;
  /** 在消息里换行。 */
  readonly newline: string;
  /** 打开命令搜索。 */
  readonly command: string;
}

/** 快捷键的出厂取值。 */
export const DEFAULT_SHORTCUTS: ShortcutConfig = {
  send: 'Enter',
  newline: 'Shift+Enter',
  command: 'Ctrl+K',
};

/** 界面侧要读写的命名空间与字段，宿主与浏览器共用同一份名字。 */
export const ENHANCEMENT_FIELDS = {
  motion: 'motion',
  shellProgram: 'shellProgram',
  shellArgs: 'shellArgs',
  editorProgram: 'editorProgram',
  fileManagerProgram: 'fileManagerProgram',
  shortcutSend: 'shortcutSend',
  shortcutNewline: 'shortcutNewline',
  shortcutCommand: 'shortcutCommand',
} as const;
