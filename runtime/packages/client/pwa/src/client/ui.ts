/**
 * PWA 界面：安装、更新、权限、配对、凭据状态、移动导航与输入区。
 *
 * 页面结构与外壳共用同一套令牌，窄屏下导航收进抽屉、右栏以弹层打开，输入区跟随视觉视口
 * 上移。所有状态都来自运行时的真实接口：清单检查读取网络上的清单，权限状态来自浏览器，
 * 配对提交到控制平面的配对接口并把令牌交给受保护的凭据存储。界面动作与失败都写进遥测。
 * @module @chatdsh/client-pwa/ui
 */

import type { InstallabilityReport } from './manifest.ts';
import type { NavigationMeta } from './offline.ts';
import { PERMISSION_LABELS, PERMISSION_TARGETS, type PermissionStatus, type PermissionTarget } from './permissions.ts';
import type { PwaRuntime } from './runtime.ts';
import { formatPairingCode, pairingCodeError, type ScanCapability } from './scanner.ts';
import type { DraftWriteResult } from './drafts.ts';

/** 界面的构造选项。 */
export interface PwaUiOptions {
  /** 配对请求的目标地址。 */
  readonly pairingEndpoint?: string;
  /** 切换新版本前的确认；返回假表示正在执行回合。 */
  readonly canReload?: () => boolean;
}

/** 挂载后的界面句柄。 */
export interface PwaUi {
  readonly runtime: PwaRuntime;
  readonly element: HTMLElement;
  /** 重新读取全部状态。 */
  refresh(): Promise<void>;
  /** 卸载界面与布局监听。 */
  unmount(): void;
}

/** 草稿自动保存的等待时间，单位毫秒。 */
const DRAFT_DEBOUNCE_MS = 300;

/** 权限状态的中文写法。 */
const PERMISSION_STATE_TEXT: Readonly<Record<PermissionStatus['state'], string>> = {
  granted: '已允许',
  denied: '已拒绝',
  prompt: '未请求',
  unavailable: '不可用',
};

/**
 * 建一个元素。
 * @param doc - 文档。
 * @param tag - 标签名。
 * @param className - 类名。
 * @param text - 文本内容。
 * @returns 元素。
 */
function create<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag);
  if (className !== undefined) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/**
 * 建立界面。
 * @param root - 挂载容器。
 * @param runtime - PWA 运行时。
 * @param options - 配对地址与切换确认。
 * @returns 界面句柄。
 */
export function mountPwaUi(root: Element, runtime: PwaRuntime, options: PwaUiOptions = {}): PwaUi {
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  if (win === null) throw new Error('界面需要浏览器窗口');
  const telemetry = runtime.telemetry;
  const pairingEndpoint = options.pairingEndpoint ?? '/chatdsh/gateway/devices/pair';
  const canReload = options.canReload ?? (() => true);

  const container = create(doc, 'div', 'chatdsh-pwa');

  // ---------- 顶栏 ----------
  const topbar = create(doc, 'header', 'pwa-topbar');
  const toggle = create(doc, 'button', 'pwa-drawer-toggle', '导航');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', 'pwa-drawer');
  const title = create(doc, 'span', 'pwa-title', 'ChatDSH');
  const connection = create(doc, 'span', 'pwa-conn', '在线');
  connection.dataset['online'] = 'true';
  topbar.append(toggle, title, connection);

  // ---------- 抽屉导航 ----------
  const scrim = create(doc, 'button', 'pwa-scrim');
  scrim.type = 'button';
  scrim.hidden = true;
  scrim.setAttribute('aria-label', '关闭导航');
  const drawer = create(doc, 'nav', 'pwa-drawer');
  drawer.id = 'pwa-drawer';
  drawer.hidden = true;
  drawer.setAttribute('aria-label', '移动导航');
  const drawerTitle = create(doc, 'p', 'pwa-drawer-title', '导航');
  const backItem = create(doc, 'button', 'pwa-nav-item', '返回');
  backItem.type = 'button';
  backItem.dataset['pwaNav'] = 'back';
  const searchItem = create(doc, 'button', 'pwa-nav-item', '搜索');
  searchItem.type = 'button';
  searchItem.dataset['pwaNav'] = 'search';
  const searchField = create(doc, 'div', 'pwa-field');
  const searchLabel = create(doc, 'label', 'pwa-visually-hidden', '搜索会话');
  searchLabel.htmlFor = 'pwa-search';
  const searchInput = create(doc, 'input', 'pwa-input');
  searchInput.id = 'pwa-search';
  searchInput.type = 'search';
  searchInput.placeholder = '搜索会话标题';
  searchField.append(searchLabel, searchInput);
  const workspaceMeta = create(doc, 'div', 'pwa-nav-meta');
  const workspaceKey = create(doc, 'span', undefined, '工作区位置');
  const workspaceValue = create(doc, 'span', undefined, '未记录');
  workspaceValue.dataset['pwaWorkspace'] = '';
  const deviceMeta = create(doc, 'div', 'pwa-nav-meta');
  const deviceKey = create(doc, 'span', undefined, '设备');
  const deviceValue = create(doc, 'span', undefined, runtime.drafts.identity().deviceId);
  deviceValue.dataset['pwaDevice'] = '';
  const unreadMeta = create(doc, 'div', 'pwa-nav-meta');
  const unreadKey = create(doc, 'span', undefined, '未读');
  const unreadValue = create(doc, 'span', undefined, '0');
  unreadValue.dataset['pwaUnread'] = '';
  workspaceMeta.append(workspaceKey, workspaceValue);
  deviceMeta.append(deviceKey, deviceValue);
  unreadMeta.append(unreadKey, unreadValue);
  drawer.append(drawerTitle, backItem, searchItem, searchField, workspaceMeta, deviceMeta, unreadMeta);

  // ---------- 安装 ----------
  const installSection = create(doc, 'section', 'pwa-section');
  installSection.dataset['pwaSection'] = 'install';
  const installHeading = create(doc, 'h2', undefined, '可安装壳');
  const installStatus = create(doc, 'p', 'pwa-status');
  installStatus.dataset['pwaInstallState'] = '';
  const installDetail = create(doc, 'p', 'pwa-detail');
  installDetail.dataset['pwaInstallDetail'] = '';
  const installRow = create(doc, 'div', 'pwa-row');
  const checkButton = create(doc, 'button', 'pwa-button', '检查可安装性');
  checkButton.type = 'button';
  checkButton.dataset['pwaInstallCheck'] = '';
  const installButton = create(doc, 'button', 'pwa-button pwa-button--primary', '安装应用');
  installButton.type = 'button';
  installButton.dataset['pwaInstall'] = '';
  installRow.append(checkButton, installButton);
  const installIssues = create(doc, 'ul', 'pwa-list');
  installIssues.dataset['pwaInstallIssues'] = '';
  const installNote = create(doc, 'p', 'pwa-detail', '系统操作：浏览器菜单里的“安装应用”或“添加到主屏幕”；iOS 使用分享菜单里的“添加到主屏幕”。');
  installSection.append(installHeading, installStatus, installDetail, installRow, installIssues, installNote);

  // ---------- 版本更新 ----------
  const updateSection = create(doc, 'section', 'pwa-update');
  updateSection.dataset['pwaSection'] = 'update';
  updateSection.hidden = true;
  const updateHeading = create(doc, 'h2', undefined, '新版本已就绪');
  const updateDetail = create(doc, 'p', 'pwa-detail', '新版本已下载并等待启用。草稿会先保存，确认后启用；正在执行的回合不会被强制刷新。');
  const updateRow = create(doc, 'div', 'pwa-row');
  const applyButton = create(doc, 'button', 'pwa-button pwa-button--primary', '启用更新');
  applyButton.type = 'button';
  applyButton.dataset['pwaUpdateApply'] = '';
  const laterButton = create(doc, 'button', 'pwa-button', '下次启动');
  laterButton.type = 'button';
  laterButton.dataset['pwaUpdateLater'] = '';
  updateRow.append(applyButton, laterButton);
  const updateStatus = create(doc, 'p', 'pwa-status');
  updateStatus.dataset['pwaUpdateState'] = '';
  updateSection.append(updateHeading, updateDetail, updateRow, updateStatus);

  // ---------- 权限 ----------
  const permissionSection = create(doc, 'section', 'pwa-section');
  permissionSection.dataset['pwaSection'] = 'permissions';
  const permissionHeading = create(doc, 'h2', undefined, '浏览器权限');
  permissionSection.append(permissionHeading);
  const permissionRows = new Map<PermissionTarget, { readonly state: HTMLElement; readonly guidance: HTMLElement; readonly button: HTMLButtonElement }>();
  for (const target of PERMISSION_TARGETS) {
    const row = create(doc, 'div', 'pwa-row');
    const text = create(doc, 'div', 'pwa-detail');
    const label = create(doc, 'span', undefined, PERMISSION_LABELS[target]);
    const state = create(doc, 'span', undefined, '未查询');
    state.dataset['pwaPermission'] = target;
    const guidance = create(doc, 'p', 'pwa-status');
    guidance.dataset['pwaGuidance'] = target;
    text.append(label, doc.createTextNode('：'), state);
    const button = create(doc, 'button', 'pwa-button', '请求');
    button.type = 'button';
    button.dataset['pwaPermissionRequest'] = target;
    row.append(text, button);
    permissionSection.append(row, guidance);
    permissionRows.set(target, { state, guidance, button });
  }

  // ---------- 配对 ----------
  const pairingSection = create(doc, 'section', 'pwa-section');
  pairingSection.dataset['pwaSection'] = 'pairing';
  const pairingHeading = create(doc, 'h2', undefined, '设备配对');
  const scanDetail = create(doc, 'p', 'pwa-detail');
  scanDetail.dataset['pwaScan'] = '';
  const pairingField = create(doc, 'div', 'pwa-field');
  const pairingLabel = create(doc, 'label', undefined, '手动输入配对码');
  pairingLabel.htmlFor = 'pwa-pairing-code';
  const pairingInput = create(doc, 'input', 'pwa-input');
  pairingInput.id = 'pwa-pairing-code';
  pairingInput.type = 'text';
  pairingInput.inputMode = 'text';
  pairingInput.autocomplete = 'off';
  pairingInput.placeholder = 'ABCD-EFGH-JKLM-NPQR';
  pairingInput.setAttribute('aria-describedby', 'pwa-pairing-status');
  pairingField.append(pairingLabel, pairingInput);
  const pairingButton = create(doc, 'button', 'pwa-button pwa-button--primary', '提交配对码');
  pairingButton.type = 'button';
  const pairingStatus = create(doc, 'p', 'pwa-status');
  pairingStatus.id = 'pwa-pairing-status';
  pairingStatus.dataset['pwaPairingState'] = '';
  pairingSection.append(pairingHeading, scanDetail, pairingField, pairingButton, pairingStatus);

  // ---------- 凭据 ----------
  const credentialSection = create(doc, 'section', 'pwa-section');
  credentialSection.dataset['pwaSection'] = 'credential';
  const credentialHeading = create(doc, 'h2', undefined, '设备凭据');
  const credentialDetail = create(doc, 'p', 'pwa-detail');
  credentialDetail.dataset['pwaCredential'] = '';
  const credentialRow = create(doc, 'div', 'pwa-row');
  const clearCredentialButton = create(doc, 'button', 'pwa-button', '清除凭据');
  clearCredentialButton.type = 'button';
  clearCredentialButton.dataset['pwaCredentialClear'] = '';
  credentialRow.append(clearCredentialButton);
  credentialSection.append(credentialHeading, credentialDetail, credentialRow);

  // ---------- 离线提示 ----------
  const offlineSection = create(doc, 'section', 'pwa-section');
  offlineSection.dataset['pwaSection'] = 'offline';
  offlineSection.hidden = true;
  const offlineHeading = create(doc, 'h2', undefined, '当前离线');
  const offlineDetail = create(doc, 'p', 'pwa-status');
  offlineDetail.dataset['pwaOffline'] = '';
  offlineDetail.textContent = '正文读取失败：当前无法连接控制平面，会话内容没有加载。已保留的导航位置与草稿仍可查看。';
  offlineSection.append(offlineHeading, offlineDetail);

  // ---------- 主体与输入区 ----------
  const main = create(doc, 'main', 'pwa-main');
  main.append(offlineSection, installSection, updateSection, permissionSection, pairingSection, credentialSection);

  const composer = create(doc, 'footer', 'pwa-composer');
  const composerRow = create(doc, 'div', 'pwa-composer-row');
  const draftLabel = create(doc, 'label', 'pwa-visually-hidden', '草稿');
  draftLabel.htmlFor = 'pwa-draft';
  const draftInput = create(doc, 'textarea', 'pwa-input');
  draftInput.id = 'pwa-draft';
  draftInput.rows = 2;
  draftInput.placeholder = '输入消息，离线时草稿保存在本机';
  const sendButton = create(doc, 'button', 'pwa-button pwa-button--primary', '发送');
  sendButton.type = 'button';
  sendButton.dataset['pwaSend'] = '';
  composerRow.append(draftInput, sendButton);
  const draftStatus = create(doc, 'p', 'pwa-status');
  draftStatus.dataset['pwaDraftState'] = '';
  composer.append(draftLabel, composerRow, draftStatus);

  container.append(topbar, scrim, drawer, main, composer);
  root.replaceChildren(container);

  // ---------- 状态渲染 ----------
  let draftTimer: ReturnType<typeof setTimeout> | undefined;

  /** 最近一次配对成功的设备标识。 */
  let pairedDeviceId: string | undefined;

  /** 显示草稿状态。 */
  const showDraftStatus = (text: string, tone: 'ok' | 'warn' | 'error'): void => {
    draftStatus.textContent = text;
    draftStatus.dataset['tone'] = tone;
  };

  /** 渲染安装检查结果。 */
  const renderInstallReport = (report: InstallabilityReport): void => {
    const codes = report.issues.map((issue) => issue.code);
    installStatus.textContent = report.installed
      ? '已安装：当前以独立窗口运行'
      : report.installable
        ? '可安装：满足安装条件'
        : codes.includes('insecure-context')
          ? '需要安全来源：当前不是 HTTPS 或本机地址'
          : codes.includes('manifest-unreachable') || codes.includes('manifest-invalid')
            ? '不支持：应用清单不可用'
            : '当前不满足安装条件';
    installStatus.dataset['tone'] = report.installed || report.installable ? 'ok' : 'warn';
    installIssues.replaceChildren();
    for (const issue of report.issues) {
      installIssues.append(create(doc, 'li', undefined, `${issue.severity === 'blocking' ? '阻断' : '提醒'}：${issue.message}`));
    }
    installButton.disabled = !report.installable && !report.installed;
  };

  /** 渲染安装入口状态。 */
  const renderInstallState = (): void => {
    const state = runtime.install.state();
    installDetail.textContent = [
      `清单 ${runtime.manifest.name}（版本 ${runtime.version}），起始地址 ${runtime.manifest.start_url}，显示模式 ${runtime.manifest.display}`,
      `Service Worker 版本 ${runtime.serviceWorker.state().version ?? '未就绪'}`,
      state.canPrompt ? '浏览器已提供安装提示。' : '浏览器未提供安装提示，使用系统菜单安装。',
    ].join('；');
  };

  /** 渲染导航元数据。 */
  const renderNavigation = (): void => {
    const meta: NavigationMeta | undefined = runtime.navigation();
    workspaceValue.textContent = meta?.workspace ?? '未记录';
    deviceValue.textContent = meta?.deviceId ?? runtime.drafts.identity().deviceId;
    unreadValue.textContent = String(meta?.unread ?? 0);
  };

  /** 渲染权限状态。 */
  const renderPermission = (status: PermissionStatus): void => {
    const row = permissionRows.get(status.target);
    if (row === undefined) return;
    row.state.textContent = PERMISSION_STATE_TEXT[status.state];
    row.guidance.textContent = status.guidance ?? status.detail;
    row.guidance.dataset['tone'] = status.state === 'granted' ? 'ok' : status.state === 'unavailable' ? 'warn' : 'error';
  };

  /** 渲染凭据状态。 */
  const renderCredential = (): void => {
    const kind = runtime.credentials.kind === 'indexeddb' ? '受保护的存储（IndexedDB 加密）' : '仅内存';
    const reason = runtime.credentials.reason === undefined ? '' : `，退回原因 ${runtime.credentials.reason}`;
    const deviceId = pairedDeviceId ?? runtime.drafts.identity().deviceId;
    credentialDetail.textContent = runtime.credentials.has(deviceId)
      ? `存储方式 ${kind}${reason}；设备 ${deviceId} 的凭据已保存。`
      : `存储方式 ${kind}${reason}；当前设备没有保存的凭据。`;
  };

  /** 渲染扫码能力。 */
  const renderScan = (capability: ScanCapability): void => {
    scanDetail.textContent = `${capability.detail} 替代方式：手动输入配对码。`;
    scanDetail.dataset['available'] = capability.available ? 'true' : 'false';
  };

  /** 最近一次网络请求是否不可达。 */
  let networkUnreachable = runtime.reachable() === false;

  /** 渲染连接状态：浏览器报告离线，或者最近一次网络请求不可达。 */
  const renderConnection = (): void => {
    const online = runtime.isOnline() && !networkUnreachable;
    connection.textContent = online ? '在线' : networkUnreachable ? '网络不可达' : '离线（只读缓存）';
    connection.dataset['online'] = online ? 'true' : 'false';
    offlineSection.hidden = online;
  };

  /** 渲染更新提示。 */
  const renderUpdate = (): void => {
    const state = runtime.serviceWorker.state();
    updateSection.hidden = !state.waiting;
    if (!state.waiting) return;
    updateStatus.textContent = `等待启用版本 ${state.waitingVersion ?? '未知'}，当前版本 ${state.version ?? '未知'}。`;
  };

  // ---------- 事件 ----------
  const syncDrawerState = (): void => {
    const open = runtime.layout.layerOpen('drawer');
    scrim.hidden = !open;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  };

  const openDrawer = (): void => {
    runtime.layout.openLayer('drawer', drawer);
    syncDrawerState();
  };
  const closeDrawer = (): void => {
    runtime.layout.closeLayer('drawer');
    syncDrawerState();
  };

  toggle.addEventListener('click', () => {
    if (runtime.layout.layerOpen('drawer')) closeDrawer();
    else openDrawer();
  });
  scrim.addEventListener('click', closeDrawer);
  backItem.addEventListener('click', () => {
    closeDrawer();
    win.location.assign('/');
  });
  searchItem.addEventListener('click', () => {
    searchInput.focus();
  });
  const offLayer = runtime.layout.on('layer-close', () => {
    syncDrawerState();
  });

  checkButton.addEventListener('click', () => {
    void runtime.checkInstallability().then((report) => {
      renderInstallReport(report);
    });
  });

  installButton.addEventListener('click', () => {
    void runtime.install.prompt().then((state) => {
      installStatus.textContent = state.outcome === 'accepted'
        ? '安装已确认'
        : state.outcome === 'dismissed'
          ? '安装被取消'
          : '浏览器未提供安装提示，使用系统菜单安装';
      renderInstallState();
    });
  });

  applyButton.addEventListener('click', () => {
    if (!canReload()) {
      telemetry.action('sw-update-apply', 'rejected');
      updateStatus.textContent = '正在执行回合，草稿保存后再启用新版本。';
      updateStatus.dataset['tone'] = 'warn';
      return;
    }
    flushDraft();
    updateStatus.textContent = '正在启用新版本并刷新页面。';
    updateStatus.dataset['tone'] = 'ok';
    void runtime.serviceWorker.applyUpdate();
  });

  laterButton.addEventListener('click', () => {
    runtime.serviceWorker.dismissUpdate();
    updateSection.hidden = true;
  });

  for (const target of PERMISSION_TARGETS) {
    const row = permissionRows.get(target);
    if (row === undefined) continue;
    row.button.addEventListener('click', () => {
      void runtime.permissions.request(target).then((status) => {
        renderPermission(status);
      });
    });
  }

  pairingInput.addEventListener('input', () => {
    const error = pairingCodeError(pairingInput.value);
    pairingStatus.textContent = pairingInput.value === '' ? '' : error ?? `配对码格式有效：${formatPairingCode(pairingInput.value.replaceAll(/[\s-]/g, '').toUpperCase())}`;
    pairingStatus.dataset['tone'] = pairingInput.value === '' ? 'warn' : error === undefined ? 'ok' : 'error';
  });

  pairingButton.addEventListener('click', () => {
    const error = pairingCodeError(pairingInput.value);
    if (error !== undefined) {
      pairingStatus.textContent = error;
      pairingStatus.dataset['tone'] = 'error';
      telemetry.action('pairing-manual', 'rejected');
      return;
    }
    const code = pairingInput.value.replaceAll(/[\s-]/g, '').toUpperCase();
    void fetchPairing(pairingEndpoint, code, runtime, pairingStatus).then((deviceId) => {
      if (deviceId === undefined) return;
      pairedDeviceId = deviceId;
      renderCredential();
    });
  });

  clearCredentialButton.addEventListener('click', () => {
    void runtime.credentials.clear().then(() => {
      renderCredential();
      runtime.telemetry.action('credential-clear', 'ok');
    });
  });

  /** 保存当前输入。 */
  const flushDraft = (): void => {
    if (draftTimer !== undefined) {
      clearTimeout(draftTimer);
      draftTimer = undefined;
    }
    const result: DraftWriteResult = runtime.drafts.save({ text: draftInput.value });
    if (result.outcome === 'rejected') showDraftStatus('草稿保存失败：本地存储不可用', 'error');
  };

  draftInput.addEventListener('input', () => {
    if (draftTimer !== undefined) clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      flushDraft();
      showDraftStatus('草稿已保存在本机', 'ok');
    }, DRAFT_DEBOUNCE_MS);
  });

  sendButton.addEventListener('click', () => {
    flushDraft();
    void runtime.submit(draftInput.value).then((result) => {
      if (result.outcome === 'sent') {
        networkUnreachable = false;
        renderConnection();
        runtime.drafts.clear();
        draftInput.value = '';
        showDraftStatus('已发送', 'ok');
        return;
      }
      if (result.code === 'network' || result.code === 'offline') {
        networkUnreachable = result.code === 'network';
        renderConnection();
      }
      showDraftStatus(result.message ?? '发送被拒绝', result.code === 'offline' ? 'warn' : 'error');
    });
  });

  const onOnline = (): void => {
    void runtime.probe().then((reachable) => {
      networkUnreachable = !reachable;
      renderConnection();
    });
  };
  const onOffline = (): void => {
    renderConnection();
    showDraftStatus('网络已断开，草稿保存在本机，发送被阻止', 'warn');
  };
  win.addEventListener('online', onOnline);
  win.addEventListener('offline', onOffline);
  win.addEventListener('pagehide', flushDraft);

  const offUpdateAvailable = runtime.serviceWorker.on('update-available', renderUpdate);
  const offStateChange = runtime.serviceWorker.on('state-change', renderUpdate);

  // ---------- 启动 ----------
  runtime.layout.attach(container);
  renderConnection();
  renderScan(runtime.scanCapability);
  renderCredential();
  renderNavigation();
  const savedDraft = runtime.drafts.read();
  if (savedDraft !== undefined) {
    draftInput.value = savedDraft.text;
    showDraftStatus('已恢复本机草稿', 'ok');
    telemetry.action('draft-restore', 'ok');
  }
  void runtime.checkInstallability().then((report) => {
    renderInstallReport(report);
    renderInstallState();
  });
  void runtime.permissions.queryAll().then((statuses) => {
    for (const status of statuses) renderPermission(status);
  });
  runtime.layout.syncViewport();

  return {
    runtime,
    element: container,

    async refresh(): Promise<void> {
      const report = await runtime.checkInstallability();
      renderInstallReport(report);
      renderInstallState();
      for (const status of await runtime.permissions.queryAll()) renderPermission(status);
      renderCredential();
      renderNavigation();
      renderUpdate();
      renderConnection();
    },

    unmount(): void {
      flushDraft();
      offUpdateAvailable();
      offStateChange();
      offLayer();
      win.removeEventListener('online', onOnline);
      win.removeEventListener('offline', onOffline);
      win.removeEventListener('pagehide', flushDraft);
      runtime.layout.detach();
      container.remove();
    },
  };
}

/**
 * 提交配对码并保存返回的设备凭据。
 * @param endpoint - 配对接口地址。
 * @param code - 规范化后的配对码。
 * @param runtime - PWA 运行时。
 * @param status - 状态文本节点。
 * @returns 配对成功的设备标识；失败时为 `undefined`。
 */
async function fetchPairing(
  endpoint: string,
  code: string,
  runtime: PwaRuntime,
  status: HTMLElement
): Promise<string | undefined> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, name: '浏览器客户端', platform: 'web', role: 'access', capabilities: [] }),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { readonly error?: unknown };
    const reason = typeof payload.error === 'string' ? payload.error : `状态 ${String(response.status)}`;
    status.textContent = `配对失败：${reason}`;
    status.dataset['tone'] = 'error';
    runtime.telemetry.action('pairing-manual', 'rejected');
    return undefined;
  }
  const payload = (await response.json()) as { readonly deviceId?: unknown; readonly token?: unknown };
  if (typeof payload.deviceId !== 'string' || typeof payload.token !== 'string') {
    status.textContent = '配对响应缺少设备标识或令牌';
    status.dataset['tone'] = 'error';
    runtime.telemetry.failure('pairing-manual', new Error('配对响应缺少设备标识或令牌'));
    return undefined;
  }
  await runtime.credentials.save({ deviceId: payload.deviceId, token: payload.token, issuedAt: Date.now() });
  status.textContent = `配对成功，设备 ${payload.deviceId} 的凭据已保存。`;
  status.dataset['tone'] = 'ok';
  runtime.telemetry.action('pairing-manual', 'ok');
  return payload.deviceId;
}
