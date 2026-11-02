/**
 * 分屏几何：容器宽度、分隔条宽度与两侧面板宽度之间的换算。
 *
 * 分隔条是独立的可聚焦元素，宽度固定；两侧面板各保留 360px 的最小内容宽度，空间不够时
 * 整个布局切换为单栏。比例在所有计算里都夹在可用范围内，鼠标拖动、方向键、Home 与 End
 * 都走同一套夹取，界面显示的值与最终布局不会出现两个不同的结论。
 * @module @chatdsh/client-multi-window/split-geometry
 */

/** 面板最小内容宽度，单位像素。 */
export const MIN_PANE_WIDTH = 360;

/** 分隔条宽度，单位像素。 */
export const SEPARATOR_WIDTH = 8;

/** 低于这个容器宽度时切换为单栏，单位像素。 */
export const NARROW_WIDTH = 760;

/** 默认比例：主栏占可用宽度的一半。 */
export const DEFAULT_SPLIT_RATIO = 0.5;

/** 方向键的步长。 */
export const SPLIT_STEP = 0.02;

/** 按住 Shift 时方向键的步长。 */
export const SPLIT_LARGE_STEP = 0.1;

/** 布局模式。 */
export type SplitMode = 'split' | 'single';

/** 一次键盘调整的动作。 */
export type SplitKeyAction = 'smaller' | 'larger' | 'minimum' | 'maximum' | 'reset';

/** 键盘调整的结论。 */
export interface SplitKeyResult {
  /** 调整后的比例。 */
  readonly ratio: number;
  /** 这次调整对应的动作，用于遥测与界面说明。 */
  readonly action: SplitKeyAction;
}

/** 布局结论。 */
export interface SplitLayout {
  /** 布局模式。 */
  readonly mode: SplitMode;
  /** 实际生效的比例，已经夹在可用范围内。 */
  readonly ratio: number;
  /** 主栏宽度，单位像素；单栏时等于容器宽度。 */
  readonly primary: number;
  /** 次栏宽度，单位像素；单栏时为零。 */
  readonly secondary: number;
  /** 分隔条占用的宽度，单栏时为零。 */
  readonly separator: number;
  /** 比例的下限。 */
  readonly minRatio: number;
  /** 比例的上限。 */
  readonly maxRatio: number;
}

/**
 * 计算比例的可用范围。
 * @param width - 容器宽度，单位像素。
 * @param separator - 分隔条宽度，单位像素。
 * @returns 下限与上限。
 */
export function ratioBounds(width: number, separator: number = SEPARATOR_WIDTH): { minRatio: number; maxRatio: number } {
  const available = width - separator;
  const minRatio = available <= 0 ? DEFAULT_SPLIT_RATIO : Math.min(0.5, MIN_PANE_WIDTH / available);
  return { minRatio, maxRatio: 1 - minRatio };
}

/**
 * 把比例夹到可用范围。
 * @param ratio - 原始比例。
 * @param width - 容器宽度。
 * @param separator - 分隔条宽度。
 * @returns 夹取后的比例。
 */
export function clampRatio(ratio: number, width: number, separator: number = SEPARATOR_WIDTH): number {
  const { minRatio, maxRatio } = ratioBounds(width, separator);
  if (!Number.isFinite(ratio)) return DEFAULT_SPLIT_RATIO;
  return Math.min(Math.max(ratio, minRatio), maxRatio);
}

/**
 * 判定当前宽度下的布局。
 * @param width - 容器宽度，单位像素。
 * @param ratio - 期望比例。
 * @param separator - 分隔条宽度。
 * @returns 布局结论。
 */
export function decideSplitLayout(width: number, ratio: number, separator: number = SEPARATOR_WIDTH): SplitLayout {
  const { minRatio, maxRatio } = ratioBounds(width, separator);
  const needsSingle = width < NARROW_WIDTH || width - separator < MIN_PANE_WIDTH * 2;
  if (needsSingle) {
    return { mode: 'single', ratio: DEFAULT_SPLIT_RATIO, primary: Math.max(width, 0), secondary: 0, separator: 0, minRatio, maxRatio };
  }
  const clamped = clampRatio(ratio, width, separator);
  const available = width - separator;
  const primary = Math.round(available * clamped);
  return { mode: 'split', ratio: clamped, primary, secondary: available - primary, separator, minRatio, maxRatio };
}

/**
 * 按指针位置换算比例。
 * @param clientX - 指针的横向坐标，单位像素。
 * @param containerLeft - 容器左边界，单位像素。
 * @param width - 容器宽度，单位像素。
 * @param separator - 分隔条宽度。
 * @returns 夹取后的比例。
 */
export function ratioFromPointer(
  clientX: number,
  containerLeft: number,
  width: number,
  separator: number = SEPARATOR_WIDTH
): number {
  const available = width - separator;
  if (available <= 0) return DEFAULT_SPLIT_RATIO;
  return clampRatio((clientX - containerLeft - separator / 2) / available, width, separator);
}

/**
 * 按比例换算分隔条的横向坐标，供指针捕获与读屏描述使用。
 * @param ratio - 比例。
 * @param containerLeft - 容器左边界。
 * @param width - 容器宽度。
 * @param separator - 分隔条宽度。
 * @returns 分隔条左边界坐标。
 */
export function separatorLeft(ratio: number, containerLeft: number, width: number, separator: number = SEPARATOR_WIDTH): number {
  const available = width - separator;
  return containerLeft + Math.round(available * clampRatio(ratio, width, separator));
}

/**
 * 处理分隔条上的键盘按键。
 *
 * 方向键微调，按住 Shift 时按大步长调整；Home 收到最小宽度，End 放到最大宽度，回车恢复
 * 默认比例。其他按键不改变布局。
 * @param current - 当前比例。
 * @param key - 按键名，取 `KeyboardEvent.key`。
 * @param options - 容器宽度、分隔条宽度与是否按住 Shift。
 * @returns 调整结论；按键不参与布局时返回 `undefined`。
 */
export function applySplitKey(
  current: number,
  key: string,
  options: { readonly width: number; readonly separator?: number; readonly shiftKey?: boolean } = { width: 0 }
): SplitKeyResult | undefined {
  const separator = options.separator ?? SEPARATOR_WIDTH;
  const step = options.shiftKey === true ? SPLIT_LARGE_STEP : SPLIT_STEP;
  switch (key) {
    case 'ArrowLeft':
      return { ratio: clampRatio(current - step, options.width, separator), action: 'smaller' };
    case 'ArrowRight':
      return { ratio: clampRatio(current + step, options.width, separator), action: 'larger' };
    case 'Home':
      return { ratio: ratioBounds(options.width, separator).minRatio, action: 'minimum' };
    case 'End':
      return { ratio: ratioBounds(options.width, separator).maxRatio, action: 'maximum' };
    case 'Enter':
      return { ratio: DEFAULT_SPLIT_RATIO, action: 'reset' };
    default:
      return undefined;
  }
}

/**
 * 把比例转成读屏可读的百分比。
 * @param ratio - 比例。
 * @returns 0 到 100 的整数。
 */
export function ratioPercent(ratio: number): number {
  return Math.round(Math.min(Math.max(ratio, 0), 1) * 100);
}
