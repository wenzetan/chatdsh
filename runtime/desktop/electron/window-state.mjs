/**
 * 主窗口位置与尺寸的持久化。
 *
 * 保存普通状态下的边界与最大化标记；恢复时按当前显示器集合纠正：显示器被拔掉、分辨率
 * 变小、窗口超出可用区域都落到主显示器上重新摆放。判定全是纯函数，显示器由调用方传入。
 * @module chatdsh-desktop-shell/window-state
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 状态文件格式版本。 */
export const WINDOW_STATE_VERSION = 1;

/** 窗口最小尺寸。 */
export const MIN_WIDTH = 1024;
export const MIN_HEIGHT = 680;

/** 默认窗口状态。 */
export const DEFAULT_WINDOW_STATE = Object.freeze({
  version: WINDOW_STATE_VERSION,
  bounds: { width: 1440, height: 900 },
  maximized: false,
});

/**
 * 解析状态文件内容。
 * @param text - 文件正文。
 * @returns 状态，无法解析时抛出。
 */
export function parseWindowState(text) {
  const raw = JSON.parse(text);
  if (raw === null || typeof raw !== 'object') throw new Error('窗口状态必须是对象');
  if (raw.version !== WINDOW_STATE_VERSION) throw new Error(`窗口状态版本不认识：${raw.version}`);
  const bounds = raw.bounds;
  if (bounds === null || typeof bounds !== 'object') throw new Error('窗口状态缺少边界');
  for (const key of ['width', 'height']) {
    if (!Number.isInteger(bounds[key]) || bounds[key] <= 0) throw new Error(`窗口状态的 ${key} 不合法`);
  }
  for (const key of ['x', 'y']) {
    if (bounds[key] !== undefined && !Number.isInteger(bounds[key])) throw new Error(`窗口状态的 ${key} 不合法`);
  }
  return {
    version: WINDOW_STATE_VERSION,
    bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
    maximized: raw.maximized === true,
    displayId: raw.displayId,
  };
}

/**
 * 读取状态文件。
 * @param file - 状态文件路径。
 * @returns 状态与来源：`stored` 表示读到已有状态，`default` 表示文件不存在，`invalid` 表示文件损坏。
 */
export function readWindowState(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { state: { ...DEFAULT_WINDOW_STATE, bounds: { ...DEFAULT_WINDOW_STATE.bounds } }, source: 'default', detail: undefined };
    throw error;
  }
  try {
    return { state: parseWindowState(text), source: 'stored', detail: undefined };
  } catch (error) {
    return { state: { ...DEFAULT_WINDOW_STATE, bounds: { ...DEFAULT_WINDOW_STATE.bounds } }, source: 'invalid', detail: error.message };
  }
}

/**
 * 写入状态文件：先写同目录临时文件再改名，避免进程中断留下半份文件。
 * @param file - 状态文件路径。
 * @param state - 要保存的状态。
 */
export function writeWindowState(file, state) {
  mkdirSync(dirname(file), { recursive: true });
  const payload = {
    version: WINDOW_STATE_VERSION,
    bounds: {
      x: state.bounds.x,
      y: state.bounds.y,
      width: state.bounds.width,
      height: state.bounds.height,
    },
    maximized: state.maximized === true,
    displayId: state.displayId,
  };
  const temporary = `${file}.writing`;
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`);
  renameSync(temporary, file);
}

/** 计算两个矩形的重叠面积。 */
function overlapArea(a, b) {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (width <= 0 || height <= 0) return 0;
  return width * height;
}

/** 把一个数值夹到区间内。 */
function clamp(value, low, high) {
  if (high < low) return low;
  return Math.min(Math.max(value, low), high);
}

/**
 * 选出与给定边界重叠最多的显示器。
 * @param bounds - 窗口边界。
 * @param displays - 显示器列表，第一项按约定是主显示器。
 * @returns 显示器与重叠面积。
 */
export function selectDisplay(bounds, displays) {
  if (!Array.isArray(displays) || displays.length === 0) throw new Error('没有可用的显示器');
  let best = displays[0];
  let bestArea = overlapArea(bounds, displays[0].workArea);
  for (const display of displays.slice(1)) {
    const area = overlapArea(bounds, display.workArea);
    if (area > bestArea) {
      best = display;
      bestArea = area;
    }
  }
  return { display: best, overlap: bestArea };
}

/**
 * 把窗口边界纠正到显示器可用区域内。
 * @param bounds - 期望边界，可以缺少 x 与 y。
 * @param displays - 显示器列表。
 * @returns 纠正后的边界与做过的调整。
 */
export function clampBounds(bounds, displays) {
  if (!Array.isArray(displays) || displays.length === 0) throw new Error('没有可用的显示器');
  const primary = displays[0];
  const adjustments = [];
  const hasPosition = Number.isInteger(bounds.x) && Number.isInteger(bounds.y);
  let target = primary;
  if (hasPosition) {
    const selected = selectDisplay({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }, displays);
    if (selected.overlap > 0) {
      target = selected.display;
    } else {
      adjustments.push('display-changed');
    }
  } else {
    adjustments.push('display-changed');
  }

  const area = target.workArea;
  const width = clamp(bounds.width, Math.min(MIN_WIDTH, area.width), area.width);
  const height = clamp(bounds.height, Math.min(MIN_HEIGHT, area.height), area.height);
  if (width !== bounds.width || height !== bounds.height) adjustments.push('size');

  let x;
  let y;
  if (adjustments.includes('display-changed')) {
    x = Math.round(area.x + (area.width - width) / 2);
    y = Math.round(area.y + (area.height - height) / 2);
  } else {
    x = clamp(bounds.x, area.x, area.x + area.width - width);
    y = clamp(bounds.y, area.y, area.y + area.height - height);
    if (x !== bounds.x) adjustments.push('position');
    if (y !== bounds.y) adjustments.push('position');
  }

  return {
    bounds: { x, y, width, height },
    adjustments: [...new Set(adjustments)],
    displayId: target.id,
  };
}

/**
 * 读取并纠正窗口状态，供创建主窗口使用。
 * @param options.file - 状态文件路径。
 * @param options.displays - 当前显示器列表。
 * @returns 边界、最大化标记、调整记录与来源。
 */
export function restoreWindowState({ file, displays }) {
  const loaded = readWindowState(file);
  const corrected = clampBounds(loaded.state.bounds, displays);
  return {
    bounds: corrected.bounds,
    maximized: loaded.state.maximized,
    adjustments: corrected.adjustments,
    displayId: corrected.displayId,
    displayCount: displays.length,
    source: loaded.source,
    detail: loaded.detail,
  };
}

/**
 * 从 Electron 窗口取得可保存的状态。
 * @param window - BrowserWindow 实例。
 * @param displayId - 窗口当前所在的显示器标识。
 * @returns 状态对象，可直接交给 {@link writeWindowState}。
 */
export function captureWindowState(window, displayId) {
  const bounds = window.getNormalBounds();
  return {
    bounds: {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    },
    maximized: window.isMaximized(),
    displayId,
  };
}
