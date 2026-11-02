/**
 * 托盘状态与菜单。
 *
 * 托盘图标按空闲、运行中、需处理三种状态切换颜色，菜单给出待审批数量、最近会话、
 * 保活开关、更新入口与退出。状态判定与菜单描述是纯函数，图标位图由主进程生成。
 * @module chatdsh-desktop-shell/tray
 */

/** 托盘状态。 */
export const TRAY_STATES = Object.freeze(['idle', 'running', 'attention']);

/** 状态文案。 */
const STATE_LABELS = Object.freeze({
  idle: '空闲',
  running: '运行中',
  attention: '需处理',
});

/** 状态对应的图标颜色。 */
const STATE_COLORS = Object.freeze({
  idle: [0x22, 0xc5, 0x5e, 0xff],
  running: [0xf5, 0x9e, 0x0b, 0xff],
  attention: [0xef, 0x44, 0x44, 0xff],
});

/**
 * 判定托盘状态。
 * @param activity - 就绪标记、运行中回合、待审批数量、启动失败。
 * @returns 状态与文案。
 */
export function trayStateOf(activity = {}) {
  const pendingApprovals = activity.pendingApprovals ?? 0;
  const runningTurns = activity.runningTurns ?? 0;
  const state = activity.failure !== undefined || pendingApprovals > 0
    ? 'attention'
    : runningTurns > 0 ? 'running' : 'idle';
  return { state, label: STATE_LABELS[state] };
}

/**
 * 返回托盘图标颜色。
 * @param state - 托盘状态。
 * @returns 四通道颜色数组。
 */
export function trayIconColor(state) {
  const color = STATE_COLORS[state];
  if (color === undefined) throw new Error(`未知托盘状态：${state}`);
  return [...color];
}

/**
 * 托盘悬停提示。
 * @param snapshot - 工作区、状态、待审批数量、是否就绪。
 * @returns 提示文本。
 */
export function trayTooltip(snapshot = {}) {
  const state = trayStateOf(snapshot);
  const workspace = snapshot.workspace === undefined ? '' : ` · ${snapshot.workspace}`;
  if (snapshot.ready !== true) return `ChatDSH${workspace} · 启动中`;
  const pending = snapshot.pendingApprovals ?? 0;
  const pendingText = pending > 0 ? ` · ${pending} 个待审批` : '';
  return `ChatDSH${workspace} · ${state.label}${pendingText}`;
}

/**
 * 构建托盘菜单描述。
 * @param snapshot - 工作区、状态、计数、开关与更新可用性。
 * @returns 菜单项数组。
 */
export function trayMenu(snapshot = {}) {
  const state = trayStateOf(snapshot);
  const pendingApprovals = snapshot.pendingApprovals ?? 0;
  const recentSessions = snapshot.recentSessions ?? 0;
  const workspace = snapshot.workspace ?? '未打开工作区';
  const enabled = snapshot.ready === true;
  return [
    { id: 'tray.header', label: `ChatDSH · ${workspace} · ${state.label}`, enabled: false },
    { type: 'separator' },
    { id: 'tray.approvals', label: `待审批 ${pendingApprovals}`, action: 'session.approvals', enabled: enabled && pendingApprovals > 0 },
    { id: 'tray.recent', label: `最近会话 ${recentSessions}`, action: 'session.recent', enabled: enabled && recentSessions > 0 },
    { type: 'separator' },
    { id: 'tray.prevent-sleep', label: `阻止睡眠：${snapshot.preventSleep === true ? '开' : '关'}`, action: 'power.toggle' },
    { id: 'tray.tray-enabled', label: `托盘常驻：${snapshot.trayEnabled === true ? '开' : '关'}`, action: 'tray.toggle' },
    { id: 'tray.login', label: `开机启动：${snapshot.launchAtLogin === true ? '开' : '关'}`, action: 'login.toggle' },
    { type: 'separator' },
    { id: 'tray.update', label: '检查更新…', action: 'update.check', enabled: snapshot.updateEnabled === true },
    { id: 'tray.open', label: '打开主窗口', action: 'window.open' },
    { type: 'separator' },
    { id: 'tray.quit', label: '退出 ChatDSH', action: 'app.quit' },
  ];
}

/**
 * 关闭窗口时的处理方式。
 * @param context - 是否正在退出、托盘是否常驻、运行时是否就绪。
 * @returns `hide` 表示隐藏到托盘，`close` 表示真正关闭。
 */
export function windowCloseAction(context = {}) {
  if (context.quitting === true) return 'close';
  if (context.trayEnabled === true) return 'hide';
  return 'close';
}

/**
 * 生成托盘位图。
 * @param state - 托盘状态。
 * @param size - 边长，缺省 16。
 * @returns 位图缓冲与尺寸。
 */
export function trayBitmap(state, size = 16) {
  const [r, g, b, a] = trayIconColor(state);
  const buffer = Buffer.alloc(size * size * 4);
  for (let index = 0; index < size * size; index += 1) {
    buffer[index * 4] = r;
    buffer[index * 4 + 1] = g;
    buffer[index * 4 + 2] = b;
    buffer[index * 4 + 3] = a;
  }
  return { buffer, width: size, height: size };
}
