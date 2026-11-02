/**
 * 桌面窗口的关闭、最后窗口与恢复策略。
 *
 * 关闭一个窗口与退出应用是两件事：还有别的窗口时只关当前窗口，正在执行的回合留在运行时里
 * 继续；最后一个窗口在托盘常驻时隐藏到托盘，未开启托盘时按正在执行的回合与未发送草稿向
 * 用户确认。恢复按存盘的窗口列表重建，第二窗口相对主窗口逐级偏移并夹在显示器可用区域内。
 *
 * 判定全是纯函数，输入是当前窗口数量、托盘开关、回合与草稿计数，输出是明确的动作与原因，
 * 便于主进程与测试共用同一套结论。
 * @module chatdsh-desktop-shell/windows/lifecycle
 */

import { cascadedBounds, normalizeBounds, windowTitleOf } from './registry.mjs';

/** 关闭窗口的动作。 */
export const CLOSE_ACTIONS = Object.freeze(['hide', 'close', 'confirm-quit']);

/**
 * 判定关闭一个窗口的动作。
 *
 * 退出流程中直接关闭；还有别的窗口时只关这一个；最后一个窗口在托盘常驻时隐藏；否则先按
 * 正在执行的回合与未发送草稿确认。
 * @param {{
 *   windowCount: number,
 *   trayEnabled?: boolean,
 *   quitting?: boolean,
 *   runningTurns?: number,
 *   unsavedDrafts?: number
 * }} context - 关闭时的现场。
 * @returns {{
 *   action: 'hide' | 'close' | 'confirm-quit',
 *   reason: string,
 *   keepsRuntime: boolean,
 *   prompt?: { message: string, choices: string[] }
 * }} 关闭结论。
 */
export function decideWindowClose(context) {
  const windowCount = context.windowCount;
  if (!Number.isInteger(windowCount) || windowCount < 0) {
    throw new Error(`窗口数量不合法：${String(windowCount)}`);
  }
  if (context.quitting === true) {
    return { action: 'close', reason: 'quitting', keepsRuntime: false };
  }
  if (windowCount > 1) {
    return { action: 'close', reason: 'other-windows', keepsRuntime: true };
  }
  if (context.trayEnabled === true) {
    return { action: 'hide', reason: 'tray', keepsRuntime: true };
  }
  const runningTurns = context.runningTurns ?? 0;
  const unsavedDrafts = context.unsavedDrafts ?? 0;
  if (!Number.isInteger(runningTurns) || runningTurns < 0) throw new Error(`回合数量不合法：${String(runningTurns)}`);
  if (!Number.isInteger(unsavedDrafts) || unsavedDrafts < 0) throw new Error(`草稿数量不合法：${String(unsavedDrafts)}`);
  if (runningTurns > 0) {
    return {
      action: 'confirm-quit',
      reason: 'running-turns',
      keepsRuntime: true,
      prompt: {
        message: `还有 ${String(runningTurns)} 个回合正在执行。退出会结束这些回合；等待完成后再退出可以保留结果。`,
        choices: ['等待任务完成', '确认退出'],
      },
    };
  }
  if (unsavedDrafts > 0) {
    return {
      action: 'confirm-quit',
      reason: 'unsaved-drafts',
      keepsRuntime: true,
      prompt: {
        message: `本窗口有 ${String(unsavedDrafts)} 份未发送草稿。草稿保存在本机，退出后重新打开可以继续。`,
        choices: ['继续编辑', '确认退出'],
      },
    };
  }
  return { action: 'close', reason: 'last-window', keepsRuntime: false };
}

/**
 * 判定全部窗口关闭之后应用的行为。
 * @param {{ trayEnabled?: boolean, quitting?: boolean }} context - 托盘与退出状态。
 * @returns {'keep-running' | 'quit'} 常驻或退出。
 */
export function windowAllClosedAction(context) {
  if (context.quitting === true) return 'quit';
  if (context.trayEnabled === true) return 'keep-running';
  return 'quit';
}

/**
 * 生成关闭结论的说明。
 * @param {ReturnType<typeof decideWindowClose>} decision - 关闭结论。
 * @returns {string} 说明文本。
 */
export function describeCloseDecision(decision) {
  switch (decision.reason) {
    case 'quitting':
      return '应用正在退出，直接关闭窗口';
    case 'other-windows':
      return '还有其他窗口，关闭本窗口后后台回合继续执行';
    case 'tray':
      return '托盘常驻，窗口隐藏到托盘，运行时继续执行';
    case 'running-turns':
      return decision.prompt?.message ?? '仍有回合在执行';
    case 'unsaved-drafts':
      return decision.prompt?.message ?? '本窗口还有未发送草稿';
    case 'last-window':
      return '最后一个窗口，关闭后应用退出';
    default:
      return decision.reason;
  }
}

/**
 * 按存盘的窗口列表生成恢复计划。
 *
 * 主窗口沿用存盘的边界并按显示器可用区域纠正；第二窗口逐级偏移摆放。显示器不存在或边界
 * 无法度量的记录进入 `skipped`，原因写在记录里，恢复过程不会静默丢窗口。
 * @param {{
 *   snapshot: { version: number, windows: object[] },
 *   workAreas: Array<{ x: number, y: number, width: number, height: number }>
 * }} input - 快照与显示器可用区域，第一项按约定是主显示器。
 * @returns {{
 *   windows: Array<{ descriptor: object, bounds: { x: number, y: number, width: number, height: number }, adjustment: string }>,
 *   skipped: Array<{ id: string, reason: string }>
 * }} 恢复计划。
 */
export function planRestore(input) {
  const workAreas = input.workAreas;
  if (!Array.isArray(workAreas) || workAreas.length === 0) throw new Error('没有可用的显示器');
  const primaryArea = workAreas[0];
  const windows = [];
  const skipped = [];
  let secondaryIndex = 0;
  for (const descriptor of input.snapshot.windows) {
    if (descriptor.kind === 'main') {
      let bounds;
      let adjustment = 'none';
      try {
        const stored = descriptor.bounds === undefined ? undefined : normalizeBounds(descriptor.bounds);
        if (stored === undefined) {
          bounds = { x: primaryArea.x, y: primaryArea.y, width: primaryArea.width, height: primaryArea.height };
          adjustment = 'default';
        } else {
          const width = Math.min(stored.width, primaryArea.width);
          const height = Math.min(stored.height, primaryArea.height);
          const x = Math.min(Math.max(stored.x ?? primaryArea.x, primaryArea.x), primaryArea.x + Math.max(primaryArea.width - width, 0));
          const y = Math.min(Math.max(stored.y ?? primaryArea.y, primaryArea.y), primaryArea.y + Math.max(primaryArea.height - height, 0));
          bounds = { x, y, width, height };
          adjustment = x === stored.x && y === stored.y && width === stored.width ? 'none' : 'clamped';
        }
      } catch (error) {
        skipped.push({ id: descriptor.id, reason: error instanceof Error ? error.message : String(error) });
        continue;
      }
      windows.push({ descriptor, bounds, adjustment });
      continue;
    }
    const base = windows[0]?.bounds ?? {
      x: primaryArea.x,
      y: primaryArea.y,
      width: primaryArea.width,
      height: primaryArea.height,
    };
    const placed = cascadedBounds(base, secondaryIndex, primaryArea);
    secondaryIndex += 1;
    windows.push({
      descriptor,
      bounds: { x: placed.x, y: placed.y, width: placed.width, height: placed.height },
      adjustment: placed.adjustment,
    });
  }
  return { windows, skipped };
}

/**
 * 托盘菜单「打开窗口」需要的路由列表。
 * @param {object[]} descriptors - 窗口登记。
 * @returns {Array<{ id: string, title: string, route: string }>} 可恢复的窗口目标。
 */
export function trayRestoreTargets(descriptors) {
  return descriptors.map((descriptor) => ({
    id: descriptor.id,
    title: windowTitleOf(descriptor),
    route: descriptor.route,
  }));
}
