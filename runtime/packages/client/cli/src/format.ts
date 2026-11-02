/**
 * 终端布局与换行。
 *
 * 列表与状态栏按可用宽度排版：宽终端排成多列，窄终端改为一行一个字段。宽度按终端显示列计算，
 * 全角字符占两列，组合字符不占列。样式由主题注入，本模块不写颜色。
 * @module @chatdsh/client-cli/format
 */

import type { Theme } from './theme.ts';

/** 默认终端宽度。 */
export const DEFAULT_WIDTH = 80;

/** 宽度小于这个值时改用单列布局。 */
export const NARROW_WIDTH = 48;

/** 全角区间。 */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

/** 组合字符匹配。 */
const COMBINING = /\p{M}/u;

/**
 * 判断一个码位是否占两列。
 * @param code - 码位。
 * @returns 全角或宽字符时为真。
 */
function isWide(code: number): boolean {
  for (const [start, end] of WIDE_RANGES) {
    if (code >= start && code <= end) return true;
  }
  return false;
}

/**
 * 计算一段文本的显示宽度。
 * @param text - 原文。
 * @returns 列数。
 */
export function textWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (COMBINING.test(character)) continue;
    width += isWide(code) ? 2 : 1;
  }
  return width;
}

/**
 * 按显示宽度换行。
 *
 * 已有换行保留，长词按宽度硬切。
 * @param text - 原文。
 * @param width - 每行最多列数。
 * @returns 行列表。
 */
export function wrapText(text: string, width: number): string[] {
  const limit = Math.max(8, width);
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let current = '';
    let currentWidth = 0;
    for (const character of paragraph) {
      const characterWidth = textWidth(character);
      if (currentWidth + characterWidth > limit && current !== '') {
        lines.push(current);
        current = '';
        currentWidth = 0;
      }
      current += character;
      currentWidth += characterWidth;
    }
    lines.push(current);
  }
  return lines;
}

/**
 * 右侧补空格到指定宽度。
 * @param text - 原文。
 * @param width - 目标列数。
 * @returns 补齐后的文本；原文更宽时原样返回。
 */
export function padRight(text: string, width: number): string {
  const missing = width - textWidth(text);
  return missing > 0 ? `${text}${' '.repeat(missing)}` : text;
}

/** 一列的定义。 */
export interface Column {
  /** 表头。 */
  readonly header: string;
  /** 取值函数。 */
  readonly value: (row: Readonly<Record<string, unknown>>) => string;
}

/**
 * 取终端宽度。
 * @param columns - 显式给出的列数，例如 `process.stdout.columns`。
 * @param env - 环境变量，回退到 `COLUMNS`。
 * @returns 列数。
 */
export function terminalWidth(columns: number | undefined, env: NodeJS.ProcessEnv = process.env): number {
  if (columns !== undefined && Number.isFinite(columns) && columns > 0) return Math.floor(columns);
  const fromEnv = env.COLUMNS === undefined ? Number.NaN : Number(env.COLUMNS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  return DEFAULT_WIDTH;
}

/**
 * 排版一张表。
 *
 * 宽度不足 {@link NARROW_WIDTH} 时改成每条记录多行展示，避免横向溢出。
 * @param rows - 记录。
 * @param columns - 列定义。
 * @param options - 宽度与主题。
 * @returns 多行文本。
 */
export function formatTable(
  rows: readonly Readonly<Record<string, unknown>>[],
  columns: readonly Column[],
  options: { readonly width: number; readonly theme: Theme },
): string[] {
  const { width, theme } = options;
  if (rows.length === 0) return [theme.paint('muted', '（空）')];
  if (width < NARROW_WIDTH) {
    const lines: string[] = [];
    rows.forEach((row, index) => {
      if (index > 0) lines.push('');
      for (const column of columns) {
        lines.push(`${theme.paint('label', column.header)}：${column.value(row)}`);
      }
    });
    return lines;
  }
  const widths = columns.map((column) => {
    const headerWidth = textWidth(column.header);
    const cellWidth = rows.reduce((max, row) => Math.max(max, textWidth(column.value(row))), 0);
    return Math.max(headerWidth, cellWidth);
  });
  const gap = 2;
  const total = widths.reduce((sum, cell) => sum + cell, 0) + gap * Math.max(0, columns.length - 1);
  if (total > width) {
    // 超出宽度时压掉最长一列，只保证不横向溢出。
    const overflow = total - width;
    let widest = 0;
    for (let index = 1; index < widths.length; index += 1) {
      if ((widths[index] ?? 0) > (widths[widest] ?? 0)) widest = index;
    }
    widths[widest] = Math.max(8, (widths[widest] ?? 0) - overflow);
  }
  const lines: string[] = [];
  lines.push(
    columns
      .map((column, index) => theme.paint('label', padRight(column.header, widths[index] ?? 0)))
      .join(' '.repeat(gap))
      .trimEnd(),
  );
  lines.push(theme.paint('muted', widths.map((cell) => '─'.repeat(cell)).join(' '.repeat(gap))));
  for (const row of rows) {
    const cells = columns.map((column, index) => {
      const wrapped = wrapText(column.value(row), widths[index] ?? 0);
      return wrapped;
    });
    const height = Math.max(...cells.map((cell) => cell.length));
    for (let line = 0; line < height; line += 1) {
      const parts = columns.map((_column, index) => padRight(cells[index]?.[line] ?? '', widths[index] ?? 0));
      lines.push(parts.join(' '.repeat(gap)).trimEnd());
    }
  }
  return lines;
}

/**
 * 排版键值对。
 * @param entries - 键与值。
 * @param options - 宽度与主题。
 * @returns 多行文本。
 */
export function formatKeyValue(
  entries: readonly (readonly [string, string])[],
  options: { readonly width: number; readonly theme: Theme },
): string[] {
  const { width, theme } = options;
  const labelWidth = entries.reduce((max, [key]) => Math.max(max, textWidth(key)), 0);
  const lines: string[] = [];
  for (const [key, value] of entries) {
    const head = theme.paint('label', padRight(key, labelWidth));
    const room = Math.max(8, width - labelWidth - 2);
    const wrapped = wrapText(value, room);
    lines.push(`${head}  ${wrapped[0] ?? ''}`.trimEnd());
    for (const extra of wrapped.slice(1)) lines.push(`${' '.repeat(labelWidth)}  ${extra}`.trimEnd());
  }
  return lines;
}
