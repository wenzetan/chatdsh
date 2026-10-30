/**
 * 客户端外壳：左栏按工作区聚合全部设备的会话，右栏是一个 iframe。
 *
 * 页面由控制平面托管（根路径，脚本在 `/shell/shell.js`）。左栏读两个端点：
 * `GET /chatdsh/gateway/devices` 给出设备与在线状态，`GET /chatdsh/gateway/sessions`
 * 给出按设备分组、带工作区显示名的会话。左栏按工作区显示名跨设备合并同一个仓库的多份
 * 检出；选中会话时右栏 iframe 的 `src` 指向 `/d/<deviceId>/`，设备离线时改为离线遮罩并
 * 禁用输入。新建会话先选设备再填目录，由控制平面登记归属并在该设备上创建会话。
 * @module @chatdsh/client-shell
 */

import styles from './shell.css';

/** 设备列表端点。 */
const DEVICES_PATH = '/chatdsh/gateway/devices';

/** 聚合会话列表端点。 */
const SESSIONS_PATH = '/chatdsh/gateway/sessions';

/** 归属写入端点。 */
const OWNERSHIP_PATH = '/chatdsh/gateway/ownership';

/** 本机可用性端点。 */
const LOCAL_PATH = '/chatdsh/gateway/local';

/** 导入端点，供「在本机继续」使用。 */
const IMPORT_PATH = '/chatdsh/gateway/import';

/** 左栏自动刷新的间隔，单位毫秒。 */
const REFRESH_INTERVAL_MS = 10_000;

/** 外壳容器的标识。 */
const ROOT_ID = 'chatdsh-shell';

/** 一条会话。 */
interface SessionSummary {
  readonly sessionId: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly cwd: string;
  readonly workspaceName: string;
  readonly kind: string;
}

/** 一台设备及其会话。 */
interface DeviceSessions {
  readonly deviceId: string;
  readonly name: string;
  readonly platform: string;
  readonly online: boolean;
  readonly lastSeenAt: number;
  readonly sessions: readonly SessionSummary[];
}

/** 设备列表端点的响应。 */
interface DevicesResponse {
  readonly devices: readonly { readonly id: string; readonly name: string; readonly online: boolean }[];
}

/** 聚合会话列表端点的响应。 */
interface SessionsResponse {
  readonly devices: readonly DeviceSessions[];
}

/** 本机可用性端点的响应。 */
interface LocalResponse {
  readonly available: boolean;
  readonly deviceId: string;
  readonly reason?: string;
}

/** 当前选中的会话。 */
interface Selection {
  readonly deviceId: string;
  readonly sessionId: string;
}

/** 一个工作区节点：同一显示名下的全部条目。 */
interface WorkspaceView {
  readonly workspaceName: string;
  /** 条目：一台设备上的一个目录。 */
  readonly entries: readonly WorkspaceEntry[];
}

/** 工作区里的一个条目。 */
interface WorkspaceEntry {
  readonly deviceId: string;
  readonly deviceName: string;
  readonly online: boolean;
  readonly cwd: string;
  readonly sessions: readonly SessionSummary[];
}

/** 把样式挂到文档上，重复挂载只保留一份。 */
function applyStyles(): void {
  const style = document.createElement('style');
  style.textContent = styles;
  document.head.append(style);
}

/**
 * 取一个端点的 JSON。
 * @param path - 同源路径。
 * @returns 响应体。
 */
async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${path} 返回 ${response.status}`);
  return await response.json() as T;
}

/**
 * 把设备与会话按工作区显示名合并。
 *
 * 同一个显示名在不同设备、不同路径下的会话合成一个工作区节点；每个「设备 + 目录」是一条
 * 条目。这条合并只影响呈现。
 * @param devices - 设备列表端点。
 * @param sessions - 聚合会话列表端点。
 * @returns 工作区节点，按最近活动倒序。
 */
function composeWorkspaces(devices: DevicesResponse, sessions: SessionsResponse): WorkspaceView[] {
  const onlineById = new Map(devices.devices.map((device) => [device.id, device.online] as const));
  const nameById = new Map(devices.devices.map((device) => [device.id, device.name] as const));
  const workspaces = new Map<string, { workspaceName: string; entries: Map<string, WorkspaceEntry>; latest: number }>();
  for (const device of sessions.devices) {
    const online = onlineById.get(device.deviceId) ?? device.online;
    const deviceName = nameById.get(device.deviceId) ?? device.name;
    for (const session of device.sessions) {
      const workspaceName = session.workspaceName || deviceName;
      let workspace = workspaces.get(workspaceName);
      if (workspace === undefined) {
        workspace = { workspaceName, entries: new Map(), latest: 0 };
        workspaces.set(workspaceName, workspace);
      }
      const entryKey = `${device.deviceId}\u0000${session.cwd}`;
      let entry = workspace.entries.get(entryKey);
      if (entry === undefined) {
        entry = { deviceId: device.deviceId, deviceName, online, cwd: session.cwd, sessions: [] };
        workspace.entries.set(entryKey, entry);
      }
      (entry.sessions as SessionSummary[]).push(session);
      workspace.latest = Math.max(workspace.latest, session.updatedAt);
    }
  }
  return [...workspaces.values()]
    .sort((left, right) => right.latest - left.latest)
    .map((workspace) => ({
      workspaceName: workspace.workspaceName,
      entries: [...workspace.entries.values()]
        .map((entry) => ({ ...entry, sessions: [...entry.sessions].sort((a, b) => b.updatedAt - a.updatedAt) }))
        .sort((a, b) => (a.deviceName < b.deviceName ? -1 : a.deviceName > b.deviceName ? 1 : 0)),
    }));
}

/** 时间的短写法：当天只写时分，更早的写月日，再早写年月日。 */
function timeText(time: number): string {
  const at = new Date(time);
  const now = new Date();
  const two = (value: number): string => String(value).padStart(2, '0');
  if (at.toDateString() === now.toDateString()) return `${two(at.getHours())}:${two(at.getMinutes())}`;
  if (at.getFullYear() === now.getFullYear()) return `${at.getMonth() + 1}-${at.getDate()}`;
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
}

/** 外壳的界面与刷新循环。 */
interface ShellView {
  /** 立即刷新一次。 */
  refresh(): Promise<void>;
}

/**
 * 创建外壳界面。
 * @param root - 容器元素。
 * @returns 界面句柄。
 */
function createShell(root: HTMLElement): ShellView {
  root.classList.add('shell');

  // ── 左栏 ────────────────────────────────────────────────
  const list = document.createElement('aside');
  list.className = 'shell-list';
  const header = document.createElement('header');
  header.className = 'shell-header';
  const heading = document.createElement('h1');
  heading.textContent = 'ChatDSH';
  const actions = document.createElement('div');
  actions.className = 'shell-header-actions';
  const newButton = document.createElement('button');
  newButton.type = 'button';
  newButton.className = 'shell-action shell-new';
  newButton.textContent = '新建会话';
  const refreshButton = document.createElement('button');
  refreshButton.type = 'button';
  refreshButton.className = 'shell-action shell-refresh';
  refreshButton.textContent = '刷新';
  actions.append(newButton, refreshButton);
  header.append(heading, actions);
  const devicesBox = document.createElement('div');
  devicesBox.className = 'shell-devices';
  list.append(header, devicesBox);

  // ── 右栏 ────────────────────────────────────────────────
  const frame = document.createElement('main');
  frame.className = 'shell-frame';
  const actionBar = document.createElement('div');
  actionBar.className = 'shell-actions';
  const remoteBtn = document.createElement('button');
  remoteBtn.type = 'button';
  remoteBtn.className = 'shell-action shell-continue-remote';
  remoteBtn.textContent = '在远程继续';
  const localBtn = document.createElement('button');
  localBtn.type = 'button';
  localBtn.className = 'shell-action shell-continue-local';
  localBtn.textContent = '在本机继续';
  const actionNote = document.createElement('span');
  actionNote.className = 'shell-action-note';
  actionBar.append(remoteBtn, localBtn, actionNote);

  const iframe = document.createElement('iframe');
  iframe.className = 'shell-iframe';
  iframe.title = '会话';
  const placeholder = document.createElement('p');
  placeholder.className = 'shell-placeholder';
  placeholder.textContent = '从左边选一条会话';

  const overlay = document.createElement('div');
  overlay.className = 'shell-offline-overlay';
  overlay.hidden = true;
  const overlayText = document.createElement('p');
  overlayText.className = 'shell-offline-text';
  const overlayInput = document.createElement('input');
  overlayInput.type = 'text';
  overlayInput.className = 'shell-offline-input';
  overlayInput.placeholder = '设备离线，无法发送消息';
  overlayInput.disabled = true;
  overlay.append(overlayText, overlayInput);

  frame.append(actionBar, iframe, placeholder, overlay);
  root.append(list, frame);

  let selection: Selection | undefined;
  let currentSessions: SessionsResponse = { devices: [] };
  let localInfo: LocalResponse = { available: false, deviceId: 'local', reason: '尚未查询' };

  const showNotice = (text: string, error: boolean): void => {
    devicesBox.replaceChildren();
    const notice = document.createElement('p');
    notice.className = error ? 'shell-notice shell-notice-error' : 'shell-notice';
    notice.textContent = text;
    devicesBox.append(notice);
  };

  /** 按设备在线状态刷新右栏的遮罩与动作可用性；不重设 iframe 的 `src`，避免轮询把页面重载。 */
  const syncRightPane = (): void => {
    if (selection === undefined) {
      overlay.hidden = true;
      placeholder.hidden = false;
      actionBar.hidden = true;
      return;
    }
    const device = currentSessions.devices.find((entry) => entry.deviceId === selection?.deviceId);
    const online = device?.online ?? false;
    placeholder.hidden = true;
    actionBar.hidden = false;
    if (online) {
      overlay.hidden = true;
    } else {
      // 离线时不加载 iframe，改为遮罩，遮罩里的输入框带 disabled。
      iframe.removeAttribute('src');
      overlay.hidden = false;
      overlayText.textContent = `${device?.name ?? selection.deviceId}：设备离线`;
      overlayInput.disabled = true;
    }
    // 「在本机继续」只在有本机运行时登记时可用。
    localBtn.disabled = !localInfo.available;
    localBtn.title = localInfo.available ? '在本机新开一条会话' : (localInfo.reason ?? '本机运行时未登记为设备');
  };

  /** 用户选中某条会话：立即加载右栏（在线时设 iframe 的 src，离线时显示遮罩）。 */
  const applySelection = (): void => {
    if (selection === undefined) {
      iframe.removeAttribute('src');
      syncRightPane();
      return;
    }
    const device = currentSessions.devices.find((entry) => entry.deviceId === selection?.deviceId);
    const online = device?.online ?? false;
    actionNote.textContent = '';
    if (online) {
      overlay.hidden = true;
      iframe.src = `/d/${encodeURIComponent(selection.deviceId)}/`;
    }
    syncRightPane();
  };

  /** 渲染一条会话按钮。 */
  const renderSession = (session: SessionSummary, deviceId: string): HTMLElement => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    const chosen = selection?.deviceId === deviceId && selection.sessionId === session.sessionId;
    button.type = 'button';
    button.className = chosen ? 'session session-selected' : 'session';
    button.dataset['deviceId'] = deviceId;
    button.dataset['sessionId'] = session.sessionId;
    const title = document.createElement('span');
    title.className = 'session-title';
    title.textContent = session.title;
    const meta = document.createElement('span');
    meta.className = 'session-meta';
    const cwd = document.createElement('span');
    cwd.className = 'session-cwd';
    cwd.textContent = session.cwd;
    const time = document.createElement('span');
    time.textContent = timeText(session.updatedAt);
    meta.append(cwd, time);
    button.append(title, meta);
    button.addEventListener('click', () => {
      selection = { deviceId, sessionId: session.sessionId };
      applySelection();
      void guardedRefresh();
    });
    item.append(button);
    return item;
  };

  /** 渲染一个工作区节点。 */
  const renderWorkspace = (workspace: WorkspaceView): HTMLElement => {
    const section = document.createElement('section');
    section.className = 'workspace';
    section.dataset['workspaceName'] = workspace.workspaceName;
    const head = document.createElement('header');
    head.className = 'workspace-header';
    const name = document.createElement('span');
    name.className = 'workspace-name';
    name.textContent = workspace.workspaceName;
    const count = document.createElement('span');
    count.className = 'workspace-count';
    const sessionCount = workspace.entries.reduce((total, entry) => total + entry.sessions.length, 0);
    count.textContent = `${String(workspace.entries.length)} 个位置 · ${String(sessionCount)} 条会话`;
    head.append(name, count);
    section.append(head);
    for (const entry of workspace.entries) {
      const entryBox = document.createElement('div');
      entryBox.className = 'workspace-entry';
      entryBox.dataset['deviceId'] = entry.deviceId;
      const entryHead = document.createElement('header');
      entryHead.className = 'entry-header';
      const deviceName = document.createElement('span');
      deviceName.className = 'entry-device';
      deviceName.textContent = entry.deviceName;
      const state = document.createElement('span');
      state.className = entry.online ? 'device-state device-state-online' : 'device-state device-state-offline';
      state.textContent = entry.online ? '在线' : '离线';
      const path = document.createElement('span');
      path.className = 'entry-path';
      path.textContent = entry.cwd;
      entryHead.append(deviceName, state, path);
      entryBox.append(entryHead);
      const ul = document.createElement('ul');
      ul.className = 'device-sessions';
      for (const session of entry.sessions) ul.append(renderSession(session, entry.deviceId));
      entryBox.append(ul);
      section.append(entryBox);
    }
    return section;
  };

  const refresh = async (): Promise<void> => {
    const [deviceList, sessionList, local] = await Promise.all([
      getJson<DevicesResponse>(DEVICES_PATH),
      getJson<SessionsResponse>(SESSIONS_PATH),
      getJson<LocalResponse>(LOCAL_PATH).catch((): LocalResponse => ({ available: false, deviceId: 'local', reason: '本机状态不可用' })),
    ]);
    localInfo = local;
    currentSessions = sessionList;
    const workspaces = composeWorkspaces(deviceList, sessionList);
    if (workspaces.length === 0) {
      showNotice('还没有设备与会话', false);
      syncRightPane();
      return;
    }
    devicesBox.replaceChildren(...workspaces.map(renderWorkspace));
    // 轮询刷新只更新遮罩与动作可用性，不重设 iframe 的 src（否则每十秒重载一次）。
    syncRightPane();
  };

  const guardedRefresh = async (): Promise<void> => {
    try {
      await refresh();
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error), true);
    }
  };

  // ── 「在远程继续」：右栏已按选中会话指向 /d/<deviceId>/，这里只是显式重载。 ──
  remoteBtn.addEventListener('click', () => {
    if (selection === undefined) return;
    const device = currentSessions.devices.find((entry) => entry.deviceId === selection?.deviceId);
    if (device?.online !== true) {
      actionNote.textContent = '设备离线，无法继续';
      return;
    }
    iframe.src = `/d/${encodeURIComponent(selection.deviceId)}/`;
    actionNote.textContent = '已在远程继续：同一条会话，deviceId 不变';
  });

  // ── 「在本机继续」：fork 到本机运行时，产生新会话。 ──
  localBtn.addEventListener('click', () => {
    if (selection === undefined || !localInfo.available) return;
    void (async () => {
      actionNote.textContent = '正在本机继续…';
      try {
        const response = await fetch(IMPORT_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sourceSessionId: selection?.sessionId, deviceId: localInfo.deviceId }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          actionNote.textContent = `在本机继续失败：${String(body.error ?? response.status)}`;
          return;
        }
        selection = { deviceId: localInfo.deviceId, sessionId: String(body.sessionId) };
        actionNote.textContent = `已在本机新开会话：${String(body.sessionId).slice(0, 12)}…（cwd 与 deviceId 是本机，parentSession 指向源会话）`;
        await guardedRefresh();
      } catch (error) {
        actionNote.textContent = `在本机继续失败：${error instanceof Error ? error.message : String(error)}`;
      }
    })();
  });

  // ── 新建会话：先选设备，再填目录，由控制平面登记归属并在设备上创建。 ──
  newButton.addEventListener('click', () => {
    const devices = currentSessions.devices;
    if (devices.length === 0) {
      showNotice('还没有可用设备', true);
      return;
    }
    const dialog = buildNewSessionDialog(devices, {
      onCreate: async (deviceId, cwd) => {
        const created = await createSessionOnDevice(deviceId, cwd);
        selection = { deviceId, sessionId: created };
        dialog.remove();
        await guardedRefresh();
      },
      onCancel: () => dialog.remove(),
    });
    root.append(dialog);
  });

  refreshButton.addEventListener('click', () => void guardedRefresh());
  window.addEventListener('focus', () => void guardedRefresh());
  window.setInterval(() => void guardedRefresh(), REFRESH_INTERVAL_MS);

  return { refresh: guardedRefresh };
}

/**
 * 在设备上创建一条真实会话，并在控制平面登记归属。
 * @param deviceId - 目标设备。
 * @param cwd - 目标目录。
 * @returns 新会话标识。
 */
async function createSessionOnDevice(deviceId: string, cwd: string): Promise<string> {
  const rpcId = (globalThis.crypto as { randomUUID(): string }).randomUUID();
  const response = await fetch(`/d/${encodeURIComponent(deviceId)}/api/session/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method: 'session/create', payload: { args: { request: { cwd } } } }),
  });
  if (!response.ok) throw new Error(`在设备上创建会话失败：${response.status}`);
  const envelope = await response.json();
  const sessionId = envelope?.result?.ok === true ? envelope.result.value?.sessionId : undefined;
  if (typeof sessionId !== 'string' || sessionId === '') throw new Error('设备没有返回会话标识');
  const owned = await fetch(OWNERSHIP_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, deviceId, cwd, kind: 'work' }),
  });
  if (!owned.ok) throw new Error(`登记会话归属失败：${owned.status}`);
  return sessionId;
}

/** 新建会话对话框的回调。 */
interface NewSessionHandlers {
  onCreate(deviceId: string, cwd: string): Promise<void>;
  onCancel(): void;
}

/**
 * 构造新建会话的对话框。
 *
 * 设备用下拉框选择，离线设备不可选；目录用手动输入，界面里说明该形态下未启用远程目录列举。
 * @param devices - 当前设备。
 * @param handlers - 创建与取消回调。
 * @returns 对话框元素。
 */
function buildNewSessionDialog(devices: readonly DeviceSessions[], handlers: NewSessionHandlers): HTMLElement {
  const dialog = document.createElement('div');
  dialog.className = 'new-session-dialog';
  const box = document.createElement('div');
  box.className = 'new-session-box';
  const title = document.createElement('h2');
  title.textContent = '新建会话';

  const deviceLabel = document.createElement('label');
  deviceLabel.className = 'new-session-field';
  deviceLabel.textContent = '设备';
  const deviceSelect = document.createElement('select');
  deviceSelect.className = 'new-session-device';
  for (const device of devices) {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.online ? device.name : `${device.name}（离线）`;
    option.disabled = !device.online;
    deviceSelect.append(option);
  }
  const firstOnline = devices.find((device) => device.online);
  if (firstOnline !== undefined) deviceSelect.value = firstOnline.deviceId;
  deviceLabel.append(deviceSelect);

  const cwdLabel = document.createElement('label');
  cwdLabel.className = 'new-session-field';
  cwdLabel.textContent = '目录';
  const cwdInput = document.createElement('input');
  cwdInput.type = 'text';
  cwdInput.className = 'new-session-cwd';
  cwdInput.placeholder = '/绝对路径';
  cwdLabel.append(cwdInput);
  const hint = document.createElement('p');
  hint.className = 'new-session-hint';
  hint.textContent = '目录需手动输入：该形态下未启用远程目录列举。';

  const error = document.createElement('p');
  error.className = 'new-session-error';
  const buttons = document.createElement('div');
  buttons.className = 'new-session-buttons';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'shell-action new-session-cancel';
  cancel.textContent = '取消';
  const create = document.createElement('button');
  create.type = 'button';
  create.className = 'shell-action new-session-create';
  create.textContent = '创建';
  buttons.append(cancel, create);

  box.append(title, deviceLabel, cwdLabel, hint, error, buttons);
  dialog.append(box);

  cancel.addEventListener('click', () => handlers.onCancel());
  create.addEventListener('click', () => {
    const deviceId = deviceSelect.value;
    const cwd = cwdInput.value.trim();
    if (cwd === '') {
      error.textContent = '请填写目录';
      return;
    }
    const device = devices.find((entry) => entry.deviceId === deviceId);
    if (device === undefined || !device.online) {
      error.textContent = '目标设备离线，无法创建';
      return;
    }
    create.disabled = true;
    handlers.onCreate(deviceId, cwd).catch((cause: unknown) => {
      create.disabled = false;
      error.textContent = cause instanceof Error ? cause.message : String(cause);
    });
  });
  return dialog;
}

applyStyles();

const root = document.getElementById(ROOT_ID);
if (root === null) throw new Error(`外壳页面缺少 #${ROOT_ID} 容器`);
createShell(root).refresh().catch((error: unknown) => {
  root.textContent = `外壳加载失败：${error instanceof Error ? error.message : String(error)}`;
});
