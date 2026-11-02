/**
 * 快捷键录入：按键格式化、系统保留键与冲突判定。
 *
 * 录入只看键盘事件本身：组合键按 Ctrl、Alt、Shift、Meta 的顺序排列，字母转成大写；单独的
 * 修饰键与输入法组合过程不算一次录入。系统保留键与同一组快捷键里的重复键都不允许覆盖，
 * 界面按原因提示；录入过程不执行任何命令。
 * @module @chatdsh/host-settings-enhancements/shortcuts
 */

/** 系统保留的快捷键。 */
export const RESERVED_SHORTCUTS: readonly { readonly combo: string; readonly reason: string }[] = [
  { combo: 'Ctrl+L', reason: '浏览器的地址栏快捷键' },
  { combo: 'Ctrl+T', reason: '浏览器的标签页快捷键' },
  { combo: 'Ctrl+W', reason: '浏览器的关闭标签页快捷键' },
  { combo: 'Ctrl+N', reason: '浏览器的窗口快捷键' },
  { combo: 'Ctrl+R', reason: '浏览器的重新加载快捷键' },
  { combo: 'Ctrl+Shift+I', reason: '浏览器的开发者工具快捷键' },
  { combo: 'F5', reason: '浏览器的重新加载快捷键' },
  { combo: 'F11', reason: '浏览器的全屏快捷键' },
  { combo: 'Alt+Tab', reason: '操作系统的窗口切换快捷键' },
  { combo: 'Meta+Q', reason: '操作系统保留的退出快捷键' },
  { combo: 'Meta+W', reason: '操作系统保留的关闭快捷键' },
  { combo: 'Meta+Tab', reason: '操作系统保留的窗口切换快捷键' },
];

/** 一次按键录入的结论。 */
export type CaptureResult =
  | { readonly ok: true; readonly combo: string }
  | { readonly ok: false; readonly reason: string }
  | undefined;

/** 键盘事件里本模块用到的部分。 */
export interface KeyEventLike {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly isComposing?: boolean;
  readonly keyCode?: number;
  preventDefault(): void;
  stopPropagation(): void;
}

/** 判一次事件处于输入法组合过程。 */
export function isComposing(event: KeyEventLike): boolean {
  return event.isComposing === true || event.keyCode === 229;
}

/** 单独的修饰键。 */
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'CapsLock', 'Dead', 'Unidentified']);

/** 需要原样保留名字的按键。 */
const NAMED_KEYS = new Set([
  'Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space',
]);

/**
 * 把一次按键格式化成组合键文本。
 * @param event - 键盘事件。
 * @returns 组合键文本；单独的修饰键或输入法组合过程返回空。
 */
export function formatCombo(event: KeyEventLike): string | undefined {
  if (isComposing(event)) return undefined;
  if (MODIFIER_KEYS.has(event.key)) return undefined;
  const parts: string[] = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Meta');
  const key = NAMED_KEYS.has(event.key) ? event.key : event.key.toUpperCase();
  parts.push(key);
  return parts.join('+');
}

/**
 * 录入一次按键：找到系统保留键时拒绝，其它情况返回组合键。
 *
 * 录入路径在这里吞掉事件，浏览器与命令层都收不到这次按键，因此录入过程中不会执行命令。
 * @param event - 键盘事件。
 * @returns 录入结论；单独的修饰键返回空。
 */
export function capture(event: KeyEventLike): CaptureResult {
  event.preventDefault();
  event.stopPropagation();
  if (isComposing(event)) return { ok: false, reason: '输入法正在组合文字，这次按键不录入' };
  if (MODIFIER_KEYS.has(event.key)) return undefined;
  const combo = formatCombo(event);
  if (combo === undefined) return undefined;
  const reserved = RESERVED_SHORTCUTS.find((entry) => entry.combo === combo);
  if (reserved !== undefined) return { ok: false, reason: `${combo} 是${reserved.reason}，不能录入` };
  if (combo === 'Escape') return { ok: false, reason: 'Escape 用于取消录入，不能作为快捷键' };
  return { ok: true, combo };
}

/**
 * 在一组快捷键里找冲突。
 * @param combo - 待录入的组合键。
 * @param bindings - 现有快捷键，键是字段名。
 * @param own - 正在录入的字段名，不算冲突。
 * @returns 冲突的字段名与组合键；没有冲突时为空。
 */
export function conflictOf(
  combo: string,
  bindings: Readonly<Record<string, string>>,
  own: string,
): { readonly key: string; readonly combo: string } | undefined {
  for (const [key, value] of Object.entries(bindings)) {
    if (key === own) continue;
    if (value !== '' && value === combo) return { key, combo: value };
  }
  return undefined;
}
