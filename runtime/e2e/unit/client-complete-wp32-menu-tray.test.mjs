// WP32 桌面菜单与托盘。
//
// 直接驱动 menu.mjs 与 tray.mjs 的纯描述：核对分组、标签、快捷键唯一性、禁用条件、
// 菜单动作派发、退出确认条件、托盘三态与图标颜色、托盘菜单计数与关闭窗口策略。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MENU_ACTIONS, MENU_ACTION_IDS, NATIVE_MENU_ACTIONS, assertUniqueAccelerators, buildAppMenuTemplate,
  findMenuItem, quitDecision, toElectronTemplate,
} from '../../desktop/electron/menu.mjs';
import {
  TRAY_STATES, trayBitmap, trayIconColor, trayMenu, trayStateOf, trayTooltip, windowCloseAction,
} from '../../desktop/electron/tray.mjs';

/** 取某一分组下的标签。 */
function labelsOf(template, groupId) {
  const group = template.find((item) => item.id === groupId);
  assert.ok(group !== undefined, `缺少分组 ${groupId}`);
  return group.submenu.filter((item) => item.type !== 'separator').map((item) => item.label);
}

test('应用菜单覆盖文件、编辑、视图、会话、帮助五组', () => {
  const template = buildAppMenuTemplate({ platform: 'win32' });
  assert.deepEqual(template.map((group) => group.label), ['文件', '编辑', '视图', '会话', '帮助']);
  assert.deepEqual(labelsOf(template, 'file'), ['新建会话', '打开工作区…', '导入会话…', '生成快照链接', '导出会话…', '设置', '退出']);
  assert.deepEqual(labelsOf(template, 'edit'), ['撤销', '重做', '剪切', '复制', '粘贴', '全选']);
  assert.deepEqual(labelsOf(template, 'view'), ['重新加载', '放大', '缩小', '实际大小', '切换全屏']);
  assert.deepEqual(labelsOf(template, 'session'), ['待审批…', '运行中的回合…', '中断当前回合', '暂停接收新回合']);
  assert.deepEqual(labelsOf(template, 'help'), ['检查更新…', '打开本次启动日志', '打开日志目录', '导出诊断包', '关于 ChatDSH']);
});

test('常用动作带快捷键，Windows 上退出用 Alt+F4', () => {
  const template = buildAppMenuTemplate({ platform: 'win32' });
  assert.equal(findMenuItem(template, 'menu.session.new').accelerator, 'CmdOrCtrl+N');
  assert.equal(findMenuItem(template, 'menu.workspace.open').accelerator, 'CmdOrCtrl+O');
  assert.equal(findMenuItem(template, 'menu.app.quit').accelerator, 'Alt+F4');
  assert.equal(findMenuItem(template, 'menu.session.interrupt').accelerator, 'CmdOrCtrl+.');
  assert.equal(findMenuItem(template, 'menu.update.check').action, MENU_ACTIONS.updateCheck);
});

test('macOS 增加应用菜单，快捷键仍然唯一', () => {
  const template = buildAppMenuTemplate({ platform: 'darwin' });
  assert.equal(template[0].label, 'ChatDSH');
  assert.equal(findMenuItem(template, 'menu.app.quit').accelerator, 'Cmd+Q');
  assert.deepEqual(assertUniqueAccelerators(template), []);
});

test('导入与导出按来源设备与会话状态禁用', () => {
  const offline = buildAppMenuTemplate({ platform: 'win32', sourceDeviceOnline: false, hasSession: false });
  assert.equal(findMenuItem(offline, 'menu.session.import').enabled, false);
  assert.equal(findMenuItem(offline, 'menu.snapshot.share').enabled, false);
  assert.equal(findMenuItem(offline, 'menu.session.export').enabled, false);
  assert.equal(findMenuItem(offline, 'menu.session.interrupt').enabled, false);
  const online = buildAppMenuTemplate({ platform: 'win32', sourceDeviceOnline: true, hasSession: true, paused: true });
  assert.equal(findMenuItem(online, 'menu.session.import').enabled, true);
  assert.equal(findMenuItem(online, 'menu.session.export').enabled, true);
  assert.equal(findMenuItem(online, 'menu.session.pause').checked, true);
  assert.equal(findMenuItem(online, 'menu.update.check').enabled, false);
});

test('快捷键冲突会被拒绝', () => {
  const template = [{
    id: 'conflict',
    label: '冲突',
    submenu: [
      { id: 'a', label: '甲', accelerator: 'CmdOrCtrl+K', action: 'a' },
      { id: 'b', label: '乙', accelerator: 'Ctrl+K', action: 'b' },
    ],
  }];
  assert.throws(() => assertUniqueAccelerators(template), /快捷键冲突/u);
});

test('菜单模板转成 Electron 结构后点击派发到动作', () => {
  const template = buildAppMenuTemplate({ platform: 'win32', hasSession: true });
  const dispatched = [];
  const electronTemplate = toElectronTemplate(template, (action) => dispatched.push(action));
  const fileGroup = electronTemplate.find((group) => group.label === '文件');
  const newSession = fileGroup.submenu.find((item) => item.label === '新建会话');
  newGroup(newSession);
  const quit = fileGroup.submenu.find((item) => item.label === '退出');
  newGroup(quit);
  const editUndo = electronTemplate.find((group) => group.label === '编辑').submenu[0];
  assert.equal(editUndo.role, 'undo');
  assert.deepEqual(dispatched, [MENU_ACTIONS.sessionNew, MENU_ACTIONS.appQuit]);
});

/** 触发一个菜单项。 */
function newGroup(item) {
  assert.equal(typeof item.click, 'function', '动作项应当带点击处理');
  item.click();
}

test('菜单动作分成主进程执行与界面处理两类', () => {
  assert.equal(NATIVE_MENU_ACTIONS.has(MENU_ACTIONS.appQuit), true);
  assert.equal(NATIVE_MENU_ACTIONS.has(MENU_ACTIONS.logsDir), true);
  assert.equal(NATIVE_MENU_ACTIONS.has(MENU_ACTIONS.updateCheck), true);
  assert.equal(NATIVE_MENU_ACTIONS.has(MENU_ACTIONS.settingsOpen), false);
  assert.equal(MENU_ACTION_IDS.length, new Set(MENU_ACTION_IDS).size);
});

test('退出确认只在有运行中任务或下载时出现', () => {
  assert.equal(quitDecision({}).needsConfirm, false);
  const running = quitDecision({ runningTurns: 2, pendingApprovals: 1 });
  assert.equal(running.needsConfirm, true);
  assert.deepEqual(running.reasons, ['running-turns', 'pending-approvals']);
  assert.match(running.detail, /2 个回合/u);
  assert.match(running.detail, /1 个审批/u);
  assert.deepEqual(running.buttons, ['仍然退出', '取消']);
  const downloading = quitDecision({ updateDownloading: true });
  assert.deepEqual(downloading.reasons, ['update-download']);
});

test('托盘三态由运行中回合与待审批数量决定', () => {
  assert.equal(trayStateOf({}).state, 'idle');
  assert.equal(trayStateOf({ runningTurns: 1 }).state, 'running');
  assert.equal(trayStateOf({ pendingApprovals: 1 }).state, 'attention');
  assert.equal(trayStateOf({ failure: '启动失败' }).state, 'attention');
  assert.deepEqual(TRAY_STATES, ['idle', 'running', 'attention']);
  assert.notDeepEqual(trayIconColor('idle'), trayIconColor('running'));
  assert.deepEqual(trayIconColor('idle').length, 4);
  assert.throws(() => trayIconColor('unknown'), /未知托盘状态/u);
});

test('托盘提示与菜单反映工作区、计数与开关', () => {
  const tooltip = trayTooltip({ ready: true, workspace: 'zerocode-web', pendingApprovals: 2, runningTurns: 1 });
  assert.match(tooltip, /zerocode-web/u);
  assert.match(tooltip, /需处理/u);
  assert.match(tooltip, /2 个待审批/u);
  assert.match(trayTooltip({ ready: false }), /启动中/u);

  const items = trayMenu({ ready: true, workspace: 'zerocode-web', pendingApprovals: 1, recentSessions: 4, preventSleep: true, trayEnabled: true, launchAtLogin: false, updateEnabled: true });
  const byId = Object.fromEntries(items.filter((item) => item.id !== undefined).map((item) => [item.id, item]));
  assert.match(byId['tray.header'].label, /zerocode-web/u);
  assert.match(byId['tray.header'].label, /需处理/u);
  assert.equal(byId['tray.approvals'].label, '待审批 1');
  assert.equal(byId['tray.recent'].label, '最近会话 4');
  assert.equal(byId['tray.prevent-sleep'].label, '阻止睡眠：开');
  assert.equal(byId['tray.login'].label, '开机启动：关');
  assert.equal(byId['tray.update'].enabled, true);
  assert.equal(byId['tray.quit'].action, 'app.quit');
  const unavailable = trayMenu({ ready: false, pendingApprovals: 0, updateEnabled: false });
  const unavailableById = Object.fromEntries(unavailable.filter((item) => item.id !== undefined).map((item) => [item.id, item]));
  assert.equal(unavailableById['tray.approvals'].enabled, false);
  assert.equal(unavailableById['tray.update'].enabled, false);
  const bitmap = trayBitmap('attention');
  assert.equal(bitmap.buffer.length, bitmap.width * bitmap.height * 4);
  assert.equal(bitmap.buffer[0], trayIconColor('attention')[0]);
});

test('关闭窗口按托盘常驻与退出来源决定', () => {
  assert.equal(windowCloseAction({ quitting: false, trayEnabled: true }), 'hide');
  assert.equal(windowCloseAction({ quitting: false, trayEnabled: false }), 'close');
  assert.equal(windowCloseAction({ quitting: true, trayEnabled: true }), 'close');
});
