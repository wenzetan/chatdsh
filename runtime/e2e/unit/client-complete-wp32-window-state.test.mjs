// WP32 窗口状态恢复。
//
// 用真实文件读写与真实的显示器数据形状验证：状态保存后能原样读回，显示器被拔掉、
// 分辨率变小、窗口跑到屏幕外时都落到可用区域内，最小尺寸与最大化标记保持。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from '../../scripts/lib/cleanup.mjs';
import {
  DEFAULT_WINDOW_STATE, MIN_HEIGHT, MIN_WIDTH, captureWindowState, clampBounds, parseWindowState,
  readWindowState, restoreWindowState, selectDisplay, writeWindowState,
} from '../../desktop/electron/window-state.mjs';

/** 主显示器加一块右侧副屏。 */
const TWO_DISPLAYS = [
  { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 },
  { id: 2, workArea: { x: 1920, y: 0, width: 1080, height: 1880 }, scaleFactor: 1 },
];

test('窗口状态写入后可以原样读回', () => {
  const dir = tempHome('wp32-window-state');
  const file = join(dir, 'window-state.json');
  writeWindowState(file, { bounds: { x: -1200, y: 40, width: 1280, height: 900 }, maximized: true, displayId: 2 });
  assert.equal(existsSync(file), true);
  const loaded = readWindowState(file);
  assert.equal(loaded.source, 'stored');
  assert.deepEqual(loaded.state.bounds, { x: -1200, y: 40, width: 1280, height: 900 });
  assert.equal(loaded.state.maximized, true);
  assert.equal(loaded.state.displayId, 2);
  const text = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(text.version, 1);
});

test('状态文件缺失或损坏时给出默认状态与来源', () => {
  const dir = tempHome('wp32-window-state-bad');
  const missing = readWindowState(join(dir, 'none.json'));
  assert.equal(missing.source, 'default');
  assert.deepEqual(missing.state.bounds, DEFAULT_WINDOW_STATE.bounds);
  const invalid = join(dir, 'invalid.json');
  writeWindowState(invalid, { bounds: { x: 0, y: 0, width: 1440, height: 900 } });
  writeBad(invalid);
  const broken = readWindowState(invalid);
  assert.equal(broken.source, 'invalid');
  assert.match(broken.detail, /./u);
  assert.throws(() => parseWindowState('{"version": 9}'), /版本不认识/u);
  assert.throws(() => parseWindowState('{"version": 1, "bounds": {"width": 0, "height": 10}}'), /width/u);
});

/** 写一份无法解析的状态文件。 */
function writeBad(file) {
  writeFileSync(file, '{"version": 1, "bounds": {"width": "宽"}}');
}

test('副屏存在时窗口留在原显示器上', () => {
  const selected = selectDisplay({ x: 1930, y: 100, width: 1060, height: 900 }, TWO_DISPLAYS);
  assert.equal(selected.display.id, 2);
  const clamped = clampBounds({ x: 1930, y: 100, width: 1060, height: 900 }, TWO_DISPLAYS);
  assert.equal(clamped.displayId, 2);
  assert.deepEqual(clamped.adjustments, []);
  assert.deepEqual(clamped.bounds, { x: 1930, y: 100, width: 1060, height: 900 });
});

test('副屏被拔掉后窗口回到主显示器中央', () => {
  const clamped = clampBounds({ x: 2000, y: 100, width: 1200, height: 800 }, [TWO_DISPLAYS[0]]);
  assert.equal(clamped.displayId, 1);
  assert.deepEqual(clamped.adjustments, ['display-changed']);
  assert.equal(clamped.bounds.width, 1200);
  assert.equal(clamped.bounds.height, 800);
  assert.equal(clamped.bounds.x, Math.round((1920 - 1200) / 2));
  assert.equal(clamped.bounds.y, Math.round((1040 - 800) / 2));
});

test('分辨率变小后尺寸与位置都被纠正', () => {
  const small = [{ id: 3, workArea: { x: 0, y: 0, width: 1280, height: 720 }, scaleFactor: 1 }];
  const clamped = clampBounds({ x: 100, y: 60, width: 1600, height: 1000 }, small);
  assert.deepEqual(clamped.adjustments, ['size', 'position']);
  assert.deepEqual(clamped.bounds, { x: 0, y: 0, width: 1280, height: 720 });
  const belowMinimum = clampBounds({ x: 0, y: 0, width: 400, height: 300 }, small);
  assert.equal(belowMinimum.bounds.width, MIN_WIDTH);
  assert.equal(belowMinimum.bounds.height, MIN_HEIGHT);
});

test('窗口完全在屏幕外时重新摆放', () => {
  const clamped = clampBounds({ x: -4000, y: -4000, width: 1200, height: 800 }, TWO_DISPLAYS);
  assert.deepEqual(clamped.adjustments, ['display-changed']);
  assert.equal(clamped.bounds.x, Math.round((1920 - 1200) / 2));
  assert.equal(clamped.bounds.y, Math.round((1040 - 800) / 2));
});

test('缺少位置的旧状态也按主显示器居中', () => {
  const clamped = clampBounds({ width: 1440, height: 900 }, TWO_DISPLAYS);
  assert.deepEqual(clamped.adjustments, ['display-changed']);
  assert.equal(clamped.bounds.x, Math.round((1920 - 1440) / 2));
});

test('恢复入口返回边界、最大化与调整记录', () => {
  const dir = tempHome('wp32-window-restore');
  const file = join(dir, 'window-state.json');
  writeWindowState(file, { bounds: { x: 2000, y: 100, width: 1200, height: 800 }, maximized: true, displayId: 2 });
  const restored = restoreWindowState({ file, displays: [TWO_DISPLAYS[0]] });
  assert.equal(restored.maximized, true);
  assert.equal(restored.displayCount, 1);
  assert.deepEqual(restored.adjustments, ['display-changed']);
  assert.equal(restored.source, 'stored');
  assert.deepEqual(restored.bounds, { x: 360, y: 120, width: 1200, height: 800 });
});

test('从窗口捕获普通状态', () => {
  const window = {
    getNormalBounds: () => ({ x: 10, y: 20, width: 1300, height: 820 }),
    isMaximized: () => false,
  };
  const captured = captureWindowState(window, 7);
  assert.deepEqual(captured.bounds, { x: 10, y: 20, width: 1300, height: 820 });
  assert.equal(captured.maximized, false);
  assert.equal(captured.displayId, 7);
});
