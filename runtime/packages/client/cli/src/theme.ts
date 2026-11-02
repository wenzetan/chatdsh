/**
 * 无颜色主题。
 *
 * 主题只管样式，不管布局。非 TTY 一律不加转义序列，`--color always` 可以显式打开颜色；
 * 高对比度模式只用粗体与下划线，因此深色、浅色与高对比度三种终端下都不依赖色相区分信息。
 * @module @chatdsh/client-cli/theme
 */

/** 颜色取值。 */
export type ColorMode = 'auto' | 'always' | 'never';

/** 对比度取值。 */
export type ContrastMode = 'normal' | 'high';

/** 主题选项。 */
export interface ThemeOptions {
  /** 颜色取值；`auto` 按是否 TTY 决定。 */
  readonly color: ColorMode;
  /** 对比度。 */
  readonly contrast: ContrastMode;
  /** 输出目标是否终端。 */
  readonly isTTY: boolean;
  /** 环境变量，用于识别 `NO_COLOR` 与 `TERM=dumb`。 */
  readonly env?: NodeJS.ProcessEnv;
}

/** 样式名。 */
export type StyleName = 'heading' | 'accent' | 'muted' | 'success' | 'warning' | 'danger' | 'label';

/** 主题。 */
export interface Theme {
  /** 是否加颜色。 */
  readonly color: boolean;
  /** 对比度。 */
  readonly contrast: ContrastMode;
  /**
   * 按样式处理文本。
   * @param style - 样式名。
   * @param text - 原文。
   * @returns 处理后的文本。
   */
  paint(style: StyleName, text: string): string;
}

/** 颜色序列。 */
const COLOR: Readonly<Record<StyleName, string>> = {
  heading: '\u001B[1;36m',
  accent: '\u001B[36m',
  muted: '\u001B[2m',
  success: '\u001B[32m',
  warning: '\u001B[33m',
  danger: '\u001B[31m',
  label: '\u001B[1m',
};

/** 高对比度模式的样式序列：只用粗体与下划线。 */
const HIGH_CONTRAST: Readonly<Record<StyleName, string>> = {
  heading: '\u001B[1;4m',
  accent: '\u001B[1m',
  muted: '\u001B[2m',
  success: '\u001B[1m',
  warning: '\u001B[1m',
  danger: '\u001B[1;4m',
  label: '\u001B[1m',
};

/** 复位序列。 */
const RESET = '\u001B[0m';

/**
 * 判断是否应当加颜色。
 * @param options - 主题选项。
 * @returns 需要加颜色时为真。
 */
function shouldColor(options: ThemeOptions): boolean {
  if (options.color === 'never') return false;
  if (options.color === 'always') return true;
  if (!options.isTTY) return false;
  const env = options.env ?? {};
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.TERM === 'dumb') return false;
  return true;
}

/**
 * 构造主题。
 * @param options - 主题选项。
 * @returns 主题。
 */
export function createTheme(options: ThemeOptions): Theme {
  const color = shouldColor(options);
  const palette = options.contrast === 'high' ? HIGH_CONTRAST : COLOR;
  return {
    color,
    contrast: options.contrast,
    paint(style: StyleName, text: string): string {
      if (!color || text === '') return text;
      return `${palette[style]}${text}${RESET}`;
    },
  };
}

/** 转义序列匹配。 */
const ANSI = /\u001B\[[0-9;]*m/g;

/** 用于单次判定的转义序列匹配；不带全局标志，避免共享状态。 */
const ANSI_TEST = /\u001B\[[0-9;]*m/;

/**
 * 移除转义序列。
 * @param text - 原文。
 * @returns 纯文本。
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/**
 * 判断文本里是否有转义序列。
 * @param text - 原文。
 * @returns 含有序列时为真。
 */
export function hasAnsi(text: string): boolean {
  return ANSI_TEST.test(text);
}
