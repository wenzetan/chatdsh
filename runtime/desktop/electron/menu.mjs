/**
 * 应用菜单与退出确认。
 *
 * 菜单先描述成纯对象，测试可以直接核对分组、标签、快捷键与禁用条件；主进程再用
 * {@link toElectronTemplate} 转成 Electron 模板。快捷键在构建时查重，冲突直接报错。
 * @module chatdsh-desktop-shell/menu
 */

/** 菜单动作标识。 */
export const MENU_ACTIONS = Object.freeze({
  sessionNew: 'session.new',
  workspaceOpen: 'workspace.open',
  sessionImport: 'session.import',
  snapshotShare: 'snapshot.share',
  sessionExport: 'session.export',
  settingsOpen: 'settings.open',
  appQuit: 'app.quit',
  sessionApprovals: 'session.approvals',
  sessionRunning: 'session.running',
  sessionInterrupt: 'session.interrupt',
  sessionPause: 'session.pause',
  updateCheck: 'update.check',
  logsOpen: 'logs.open',
  logsDir: 'logs.dir',
  diagnosticsExport: 'diagnostics.export',
});

/** 由主进程直接执行的动作；其余动作转给渲染进程处理。 */
export const NATIVE_MENU_ACTIONS = Object.freeze(new Set([
  MENU_ACTIONS.appQuit,
  MENU_ACTIONS.updateCheck,
  MENU_ACTIONS.logsOpen,
  MENU_ACTIONS.logsDir,
  MENU_ACTIONS.diagnosticsExport,
]));

/** 菜单动作全集。 */
export const MENU_ACTION_IDS = Object.freeze(Object.values(MENU_ACTIONS));

/** 编辑菜单使用的系统角色。 */
const EDIT_ROLES = Object.freeze([
  { role: 'undo', label: '撤销' },
  { role: 'redo', label: '重做' },
  { type: 'separator' },
  { role: 'cut', label: '剪切' },
  { role: 'copy', label: '复制' },
  { role: 'paste', label: '粘贴' },
  { role: 'selectAll', label: '全选' },
]);

/**
 * 构建菜单描述。
 * @param context - 构建条件。
 * @param context.platform - 运行平台。
 * @param context.sourceDeviceOnline - 来源设备是否在线，决定导入可用。
 * @param context.hasSession - 当前是否有会话，决定会话相关项可用。
 * @param context.paused - 是否已暂停接收新回合。
 * @param context.updateEnabled - 是否配置了更新源。
 * @returns 菜单分组数组。
 */
export function buildAppMenuTemplate(context = {}) {
  const platform = context.platform ?? process.platform;
  const sourceDeviceOnline = context.sourceDeviceOnline ?? false;
  const hasSession = context.hasSession ?? false;
  const paused = context.paused === true;
  const updateEnabled = context.updateEnabled ?? false;

  const groups = [
    {
      id: 'file',
      label: '文件',
      submenu: [
        { id: 'menu.session.new', label: '新建会话', accelerator: 'CmdOrCtrl+N', action: MENU_ACTIONS.sessionNew },
        { id: 'menu.workspace.open', label: '打开工作区…', accelerator: 'CmdOrCtrl+O', action: MENU_ACTIONS.workspaceOpen },
        { id: 'menu.session.import', label: '导入会话…', accelerator: 'CmdOrCtrl+I', action: MENU_ACTIONS.sessionImport, enabled: sourceDeviceOnline },
        { type: 'separator' },
        { id: 'menu.snapshot.share', label: '生成快照链接', accelerator: 'CmdOrCtrl+Shift+S', action: MENU_ACTIONS.snapshotShare, enabled: hasSession },
        { id: 'menu.session.export', label: '导出会话…', accelerator: 'CmdOrCtrl+E', action: MENU_ACTIONS.sessionExport, enabled: hasSession },
        { type: 'separator' },
        { id: 'menu.settings.open', label: '设置', accelerator: 'CmdOrCtrl+,', action: MENU_ACTIONS.settingsOpen },
        {
          id: 'menu.app.quit',
          label: '退出',
          accelerator: platform === 'darwin' ? 'Cmd+Q' : 'Alt+F4',
          action: MENU_ACTIONS.appQuit,
        },
      ],
    },
    { id: 'edit', label: '编辑', submenu: EDIT_ROLES.map((item) => ({ ...item })) },
    {
      id: 'view',
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载', accelerator: 'CmdOrCtrl+R' },
        { type: 'separator' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { role: 'resetZoom', label: '实际大小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '切换全屏', accelerator: 'F11' },
      ],
    },
    {
      id: 'session',
      label: '会话',
      submenu: [
        { id: 'menu.session.approvals', label: '待审批…', accelerator: 'CmdOrCtrl+Shift+A', action: MENU_ACTIONS.sessionApprovals },
        { id: 'menu.session.running', label: '运行中的回合…', action: MENU_ACTIONS.sessionRunning, enabled: hasSession },
        { id: 'menu.session.interrupt', label: '中断当前回合', accelerator: 'CmdOrCtrl+.', action: MENU_ACTIONS.sessionInterrupt, enabled: hasSession },
        { type: 'separator' },
        { id: 'menu.session.pause', label: '暂停接收新回合', type: 'checkbox', checked: paused, action: MENU_ACTIONS.sessionPause },
      ],
    },
    {
      id: 'help',
      label: '帮助',
      submenu: [
        { id: 'menu.update.check', label: '检查更新…', action: MENU_ACTIONS.updateCheck, enabled: updateEnabled },
        { type: 'separator' },
        { id: 'menu.logs.open', label: '打开本次启动日志', action: MENU_ACTIONS.logsOpen },
        { id: 'menu.logs.dir', label: '打开日志目录', action: MENU_ACTIONS.logsDir },
        { id: 'menu.diagnostics.export', label: '导出诊断包', action: MENU_ACTIONS.diagnosticsExport },
        { type: 'separator' },
        { role: 'about', label: '关于 ChatDSH' },
      ],
    },
  ];

  if (platform === 'darwin') {
    groups.unshift({
      id: 'app',
      label: 'ChatDSH',
      submenu: [
        { role: 'about', label: '关于 ChatDSH' },
        { type: 'separator' },
        { role: 'quit', label: '退出 ChatDSH' },
      ],
    });
  }

  return groups;
}

/** 归一化快捷键，用于查重。 */
function normalizeAccelerator(accelerator) {
  return accelerator.replace(/CommandOrControl|CmdOrCtrl/gu, 'Ctrl').replace(/\s+/gu, '').toLowerCase();
}

/**
 * 核对显式快捷键没有重复。
 * @param template - 菜单描述。
 * @returns 判定通过时返回空数组，冲突时抛出并列出冲突项。
 */
export function assertUniqueAccelerators(template) {
  const owners = new Map();
  const walk = (items) => {
    for (const item of items) {
      if (Array.isArray(item.submenu)) {
        walk(item.submenu);
        continue;
      }
      if (typeof item.accelerator !== 'string') continue;
      const key = normalizeAccelerator(item.accelerator);
      const owner = owners.get(key);
      if (owner !== undefined) {
        throw new Error(`快捷键冲突：${item.accelerator} 同时用于 ${owner} 与 ${item.id ?? item.role}`);
      }
      owners.set(key, item.id ?? item.role);
    }
  };
  walk(template);
  return [];
}

/**
 * 按标识查找叶子项。
 * @param template - 菜单描述。
 * @param id - 叶子标识。
 * @returns 找到的叶子项，未找到时为 undefined。
 */
export function findMenuItem(template, id) {
  for (const group of template) {
    const found = (group.submenu ?? []).find((item) => item.id === id);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * 转成 Electron 菜单模板。
 * @param template - 菜单描述。
 * @param dispatch - 菜单动作回调。
 * @returns Electron 可用的模板数组。
 */
export function toElectronTemplate(template, dispatch) {
  return template.map((group) => ({
    label: group.label,
    submenu: group.submenu.map((item) => {
      if (item.type === 'separator') return { type: 'separator' };
      const base = { label: item.label };
      if (item.role !== undefined) base.role = item.role;
      if (item.accelerator !== undefined) base.accelerator = item.accelerator;
      if (item.enabled !== undefined) base.enabled = item.enabled;
      if (item.type !== undefined) base.type = item.type;
      if (item.checked !== undefined) base.checked = item.checked;
      if (item.action !== undefined) base.click = () => dispatch(item.action);
      return base;
    }),
  }));
}

/**
 * 计算退出前是否需要确认。
 * @param activity - 当前活动：运行中的回合、待审批数量、是否正在下载更新。
 * @returns 判定结果与提示文案。
 */
export function quitDecision(activity = {}) {
  const runningTurns = activity.runningTurns ?? 0;
  const pendingApprovals = activity.pendingApprovals ?? 0;
  const updateDownloading = activity.updateDownloading === true;
  const reasons = [];
  if (runningTurns > 0) reasons.push('running-turns');
  if (pendingApprovals > 0) reasons.push('pending-approvals');
  if (updateDownloading) reasons.push('update-download');
  if (reasons.length === 0) return { needsConfirm: false, reasons, message: '', detail: '', buttons: [] };

  const parts = [];
  if (runningTurns > 0) parts.push(`${runningTurns} 个回合正在运行`);
  if (pendingApprovals > 0) parts.push(`${pendingApprovals} 个审批等待处理`);
  if (updateDownloading) parts.push('更新包正在下载');
  return {
    needsConfirm: true,
    reasons,
    message: '现在退出会中断正在进行的任务',
    detail: `${parts.join('，')}。退出后这些任务会停止，会话内容保留。`,
    buttons: ['仍然退出', '取消'],
  };
}
