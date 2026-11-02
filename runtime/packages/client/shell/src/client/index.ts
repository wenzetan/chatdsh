/**
 * 客户端外壳：聚合会话、逻辑路由、创建、继续与草稿。
 *
 * 页面由控制平面托管，脚本是单文件产物。数据来自三个真实入口：控制平面的私有客户端读取
 * 入口（分页会话摘要、标题、未读、归属设备）、控制平面的设备与本机端点、以及经
 * `/d/<deviceId>/` 前缀转发到目标设备运行时的 Remote 一元调用。界面内的导航全部写进浏览器
 * 历史，深链接、刷新、前进后退都还原到同一个路由对象；目标设备离线时只保留本地草稿与只读
 * 副本入口，写操作立即失败，不进入待发队列。
 * @module @chatdsh/client-shell
 */

import styles from './shell.css';
import { createShellApi, describeFailure, type DeviceInfo, type DirectoryListing, type LocalRuntime } from './api.ts';
import { createShellTelemetry, randomHex } from './telemetry.ts';
import { RouteNavigator, type RouteChangeReason } from './history.ts';
import {
  continueRoute,
  isSettingsSection,
  routePath,
  sameRoute,
  sessionRoute,
  type Route,
} from './route.ts';
import { ALL_DEVICES, normalizeFilters, readFilters, writeFilters, type SessionFilters } from './filters.ts';
import { findSession, groupByDevice, groupByWorkspace, type SessionItem } from './sessions.ts';
import { ReadGeneration, SessionPages } from './pages.ts';
import { OperationGate } from './idempotency.ts';
import { estimateFork, textOfEvent, type ForkEstimate, type ImportMode, type ReplicaEvent } from './estimate.ts';
import {
  clientIdentity,
  draftStorageAvailable,
  offlineSendOutcome,
  readDraft,
  windowIdentity,
  writeDraft,
  type DraftFailureReason,
  type DraftIdentity,
} from './drafts.ts';
import { ShellListView, type Selection } from './list-view.ts';
import {
  ShellMainView,
  type ContinueDialogInput,
  type ContinueSubmit,
  type CreateSubmit,
  type CreateWizardInput,
  type ReadonlyPaneInput,
  type SessionPaneInput,
} from './main-view.ts';
import {
  buildShellCommands,
  isPaletteShortcut,
  orderByRecent,
  readRecentCommands,
  recordRecentCommand,
  SETTINGS_SECTION_TITLES,
  type CommandDescriptor,
} from './commands.ts';

/** 外壳容器的标识。 */
const ROOT_ID = 'chatdsh-shell';

/** 每页读取的会话条数。 */
const PAGE_SIZE = 50;
/** 左栏自动刷新的间隔，单位毫秒。 */
const REFRESH_INTERVAL_MS = 10_000;

/** 草稿写入的等待时间，单位毫秒。 */
const DRAFT_DEBOUNCE_MS = 300;

/** 只读副本里显示的最近片段数量。 */
const READONLY_EXCERPTS = 20;

/** 单条只读片段的字符上限。 */
const EXCERPT_MAX = 240;

/** 草稿写入失败原因的说明。 */
const DRAFT_FAILURE_TEXT: Readonly<Record<DraftFailureReason, string>> = {
  'storage-full': '本地存储空间不足',
  'storage-unavailable': '本地存储不可用',
  'privacy-mode': '浏览器隐私模式禁止本地存储',
  'cleared-by-browser': '浏览器已清理本地存储',
};

/** 创建向导的状态。 */
interface WizardState {
  devices: readonly DeviceInfo[];
  deviceId: string | undefined;
  listing: DirectoryListing | undefined;
  listingError: string | undefined;
  listingBusy: boolean;
  busy: boolean;
  error: string | undefined;
  /** 已经创建但归属未登记成功的会话：再次提交只重试归属。 */
  created: { readonly sessionId: string; readonly deviceId: string; readonly cwd: string } | undefined;
}

/** 继续确认的状态。 */
interface ContinueState {
  readonly sessionId: string;
  readonly deviceId: string | undefined;
  readonly item: SessionItem | undefined;
  events: readonly ReplicaEvent[] | undefined;
  estimate: ForkEstimate | undefined;
  estimateError: string | undefined;
  importMode: ImportMode;
  listing: DirectoryListing | undefined;
  listingError: string | undefined;
  listingBusy: boolean;
  busy: boolean;
  error: string | undefined;
}

/**
 * 安全地取一个存储。
 * @param getter - 取存储的函数；隐私模式下访问本身就会抛出。
 * @returns 存储；不可用时返回 `undefined`。
 */
function safeStorage(getter: () => Storage): Storage | undefined {
  try {
    return getter();
  } catch {
    return undefined;
  }
}

/** 应用样式：重复挂载只保留一份。 */
function applyStyles(): void {
  const style = document.createElement('style');
  style.textContent = styles;
  document.head.append(style);
}

/**
 * 把副本事件压成可读片段。
 * @param events - 副本事件。
 * @returns 最近的内容片段。
 */
function excerptsOf(events: readonly ReplicaEvent[]): string[] {
  const excerpts: string[] = [];
  for (const event of events) {
    if (!event.kind.endsWith('/message') && event.kind !== 'tool/result') continue;
    const text = textOfEvent(event.payload).replace(/\s+/gu, ' ').trim();
    if (text === '') continue;
    excerpts.push(`${event.kind}：${text.length > EXCERPT_MAX ? `${text.slice(0, EXCERPT_MAX)}…` : text}`);
  }
  return excerpts.slice(-READONLY_EXCERPTS);
}

/**
 * 启动外壳。
 * @param root - 容器元素。
 */
function startShell(root: HTMLElement): void {
  root.classList.add('shell');
  const localStore = safeStorage(() => window.localStorage);
  const sessionStore = safeStorage(() => window.sessionStorage);
  const clientId = clientIdentity(localStore, () => crypto.randomUUID());
  const windowId = windowIdentity(sessionStore, () => crypto.randomUUID());

  const telemetry = createShellTelemetry({
    fetchImpl: (input, init) => fetch(input, init),
    randomHex,
    now: () => Date.now(),
  });
  const api = createShellApi({
    fetchImpl: (input, init) => fetch(input, init),
    newRequestId: () => crypto.randomUUID(),
    telemetry,
  });

  let filters: SessionFilters = readFilters(localStore, clientId);
  const pages = new SessionPages();
  const generation = new ReadGeneration();
  const gate = new OperationGate();
  const routeItems = new Map<string, SessionItem>();
  const readonlyCache = new Map<string, ReadonlyPaneInput>();
  const readonlyLoading = new Set<string>();

  let devices: readonly DeviceInfo[] = [];
  let deviceError: string | undefined;
  let localRuntime: LocalRuntime | undefined;
  let selection: Selection | undefined;
  let route: Route = { kind: 'sessions' };
  let loading = false;
  let loadingMore = false;
  let listError: string | undefined;
  let wizard: WizardState | undefined;
  let continueState: ContinueState | undefined;
  let draftIdentity: DraftIdentity | undefined;
  let draftTimer: number | undefined;
  let lastSelectionKey: string | undefined;

  const listView = new ShellListView({
    onSelect: (item) => router.push(sessionRoute(item.sessionId, item.deviceId)),
    onFiltersChange: (next) => applyFilters(next),
    onQueryCommit: (query) => applyFilters({ ...filters, query }),
    onLoadMore: () => void loadMore(),
    onRefresh: () => void refreshAll(),
    onNewSession: () => router.push({ kind: 'new-session' }),
    onOpenPalette: () => openPalette(),
  });

  const mainView = new ShellMainView({
    onContinueRemote: () => runRemoteContinue(),
    onContinueLocal: () => {
      if (selection === undefined) {
        listView.setStatus('先选择一条会话，再选择继续方式。');
        return;
      }
      router.push(continueRoute(selection.sessionId, selection.deviceId));
    },
    onDraftInput: (text) => queueDraftSave(text),
    onDraftSend: () => sendOfflineDraft(),
    onRetryNavigation: () => {
      const item = currentSelectionItem();
      if (item !== undefined) void requestSelection(item, true);
    },
    onReturnList: () => router.push({ kind: 'sessions' }),
    onCreateDeviceChange: (deviceId) => void changeWizardDevice(deviceId),
    onCreateDirectoryOpen: (path) => void loadWizardDirectory(path),
    onCreateDirectoryRefresh: () => void loadWizardDirectory(wizard?.listing?.path),
    onCreateSubmit: (input) => submitCreate(input),
    onCreateCancel: () => closeWizard(true),
    onContinueModeChange: (mode) => changeContinueMode(mode),
    onContinueDirectoryOpen: (path) => void loadContinueDirectory(path),
    onContinueSubmit: (input) => submitContinue(input),
    onContinueCancel: () => closeContinue(),
    onPaletteRun: (command) => runCommand(command),
    onPaletteClose: () => mainView.closePalette(),
  });

  const router = new RouteNavigator(window, (next: Route, reason: RouteChangeReason) => {
    route = next;
    telemetry.action('route', 'ok');
    handleRoute(reason);
  });

  root.replaceChildren(listView.element, mainView.element);

  /** 当前选中的会话。 */
  function currentSelectionItem(): SessionItem | undefined {
    if (selection === undefined) return undefined;
    return findSession(pages.items, selection.sessionId, selection.deviceId) ?? routeItems.get(`${selection.deviceId}\u0000${selection.sessionId}`);
  }

  /** 渲染左栏。 */
  function renderList(): void {
    listView.render({
      workspaces: groupByWorkspace(pages.items),
      deviceGroups: groupByDevice(pages.items),
      filters,
      devices,
      selection,
      loading,
      error: listError,
      hasMore: pages.hasMore,
      total: pages.items.length,
      pendingQuery: filters.query,
    });
    const note = deviceError;
    if (note !== undefined) listView.setStatus(note);
    else listView.setStatus(loading ? '正在读取会话列表…' : '');
  }

  /**
   * 读设备列表。
   */
  async function refreshDevices(): Promise<void> {
    try {
      devices = await api.listDevices();
      deviceError = undefined;
    } catch (error) {
      deviceError = describeFailure(error, '读取设备列表');
    }
  }

  /** 读本机运行时的可用性。 */
  async function refreshLocalRuntime(): Promise<void> {
    try {
      localRuntime = await api.localRuntime();
    } catch (error) {
      localRuntime = { available: false, deviceId: 'local', reason: describeFailure(error, '读取本机状态') };
    }
  }

  /**
   * 读一页会话列表并替换累积。
   * @param quiet - 静默刷新时不显示读取中状态。
   */
  async function refreshList(quiet = false): Promise<void> {
    const ticket = generation.next();
    if (!quiet) {
      loading = true;
      renderList();
    }
    try {
      const page = await api.listSessions({
        limit: PAGE_SIZE,
        query: filters.query,
        ...(filters.deviceId === ALL_DEVICES ? {} : { deviceId: filters.deviceId }),
      });
      if (!generation.isCurrent(ticket)) return;
      pages.reset(page);
      routeItems.clear();
      listError = undefined;
    } catch (error) {
      if (!generation.isCurrent(ticket)) return;
      listError = describeFailure(error, '读取会话列表');
      pages.reset({ items: [], page: { hasMore: false } });
    } finally {
      if (generation.isCurrent(ticket)) {
        loading = false;
        renderList();
        restoreRoute();
      }
    }
  }

  /** 刷新全部状态。 */
  async function refreshAll(): Promise<void> {
    await refreshDevices();
    await refreshLocalRuntime();
    await refreshList();
  }

  /** 加载下一页。 */
  async function loadMore(): Promise<void> {
    const cursor = pages.nextCursor;
    if (loadingMore || !pages.hasMore || cursor === undefined) return;
    loadingMore = true;
    const ticket = generation.current;
    try {
      const page = await api.listSessions({
        limit: PAGE_SIZE,
        query: filters.query,
        cursor,
        ...(filters.deviceId === ALL_DEVICES ? {} : { deviceId: filters.deviceId }),
      });
      if (!generation.isCurrent(ticket)) return;
      pages.append(page);
      renderList();
    } catch (error) {
      if (!generation.isCurrent(ticket)) return;
      listError = describeFailure(error, '加载更多会话');
      renderList();
    } finally {
      loadingMore = false;
    }
  }

  /**
   * 应用筛选并重新读取。
   * @param next - 新筛选。
   */
  function applyFilters(next: SessionFilters): void {
    filters = normalizeFilters(next);
    writeFilters(localStore, clientId, filters);
    listError = undefined;
    void refreshList();
  }

  /**
   * 处理一次路由变化。
   * @param reason - 变化原因；后退与前进时把焦点放回选中的会话。
   */
  function handleRoute(reason: RouteChangeReason): void {
    if (route.kind !== 'new-session') closeWizard(false);
    if (route.kind !== 'continue') closeContinueDialogOnly();
    if (route.kind === 'sessions') {
      loading = true;
      void openRouteSession().finally(() => {
        if (reason === 'pop') listView.focusSelection();
      });
      return;
    }
    selection = undefined;
    if (route.kind === 'new-session') {
      renderList();
      void openWizard();
      return;
    }
    if (route.kind === 'continue') {
      renderList();
      void openContinue(route.sessionId, route.deviceId);
      return;
    }
    if (route.kind === 'settings') {
      renderList();
      mainView.renderSettings(route.section, SETTINGS_SECTION_TITLES[route.section]);
      return;
    }
    if (route.kind === 'share') {
      renderList();
      mainView.renderShare(route.token);
      return;
    }
    if (route.kind === 'diagnostics') {
      renderList();
      renderDiagnostics();
      return;
    }
    renderList();
    mainView.renderRouteError(`无法识别的地址：${route.path}`);
  }

  /**
   * 在列表刷新后重建当前路由的右栏。
   */
  function restoreRoute(): void {
    if (route.kind === 'sessions') {
      void openRouteSession();
      return;
    }
    if (route.kind === 'continue' && continueState !== undefined) {
      pushContinue();
    }
  }

  /**
   * 解析会话路由并渲染右栏。
   */
  async function openRouteSession(): Promise<void> {
    if (route.kind !== 'sessions') return;
    const sessionId = route.sessionId;
    if (sessionId === undefined) {
      selection = undefined;
      loading = false;
      renderList();
      mainView.renderPending('从左边选一条会话；也可以按 Ctrl/Cmd+K 搜索命令。');
      return;
    }
    selection = { deviceId: route.deviceId ?? '', sessionId };
    renderList();
    const known =
      findSession(pages.items, sessionId, route.deviceId) ??
      routeItems.get(`${route.deviceId ?? ''}\u0000${sessionId}`);
    if (known !== undefined) {
      loading = false;
      renderSessionPane(known);
      return;
    }
    mainView.renderPending('正在读取会话…');
    try {
      const page = await api.listSessions({
        limit: 200,
        query: '',
        ...(route.deviceId === undefined ? {} : { deviceId: route.deviceId }),
      });
      const found = findSession(page.items, sessionId, route.deviceId);
      if (route.kind !== 'sessions' || route.sessionId !== sessionId) return;
      loading = false;
      if (found === undefined) {
        selection = { deviceId: route.deviceId ?? '', sessionId };
        renderList();
        mainView.renderRouteError(
          route.deviceId === undefined ? '该会话不存在或已被删除。' : `该设备上不存在会话 ${sessionId}。`
        );
        return;
      }
      routeItems.set(`${found.deviceId}\u0000${found.sessionId}`, found);
      selection = { deviceId: found.deviceId, sessionId: found.sessionId };
      renderList();
      renderSessionPane(found);
    } catch (error) {
      if (route.kind !== 'sessions' || route.sessionId !== sessionId) return;
      loading = false;
      renderList();
      mainView.renderRouteError(describeFailure(error, '读取会话'));
    }
  }

  /**
   * 渲染会话右栏。
   * @param item - 会话。
   */
  function renderSessionPane(item: SessionItem): void {
    const pane: SessionPaneInput = {
      title: item.title,
      kind: item.kind,
      deviceLabel: item.deviceName,
      deviceId: item.deviceId,
      cwd: item.cwd,
      online: item.online,
      sessionId: item.sessionId,
      note: item.online ? '' : '目标设备离线：只读副本与本地草稿可用，写操作立即失败。',
    };
    mainView.renderSession(pane);
    mainView.setRemoteContinue(item.online, item.online ? '在源设备上打开原会话，编号不变' : '源设备离线，远程继续不可用');
    const localAvailable = localRuntime?.available === true;
    mainView.setLocalContinue(localAvailable, localAvailable ? '在本机新建带血缘的会话' : (localRuntime?.reason ?? '本机运行时未登记为设备'));
    if (item.online) {
      closeDraft();
      void requestSelection(item, false);
      return;
    }
    openDraft(item);
    const readonly = readonlyCache.get(`${item.deviceId}\u0000${item.sessionId}`);
    if (readonly !== undefined) mainView.renderReadonly(readonly);
    void loadReadonly(item);
  }

  /**
   * 请求内容端打开指定会话。
   * @param item - 会话。
   * @param force - 跳过同会话的重复请求。
   */
  async function requestSelection(item: SessionItem, force: boolean): Promise<void> {
    const key = `${item.deviceId}\u0000${item.sessionId}`;
    if (!force && key === lastSelectionKey) return;
    lastSelectionKey = key;
    await mainView.requestSessionSelection(item.deviceId, item.sessionId);
  }

  /**
   * 读离线会话的只读副本。
   * @param item - 会话。
   */
  async function loadReadonly(item: SessionItem): Promise<void> {
    const key = `${item.deviceId}\u0000${item.sessionId}`;
    if (readonlyLoading.has(key)) return;
    readonlyLoading.add(key);
    mainView.renderReadonly({
      readAt: Date.now(),
      eventCount: 0,
      excerpts: [],
      missing: false,
      reason: '正在读取控制平面副本…',
    });
    try {
      const events = await api.readReplica(item.sessionId);
      const pane: ReadonlyPaneInput = {
        readAt: Date.now(),
        eventCount: events.length,
        excerpts: excerptsOf(events),
        missing: events.length === 0,
        reason: '目标设备离线，读取控制平面副本',
      };
      readonlyCache.set(key, pane);
      if (selection?.deviceId === item.deviceId && selection.sessionId === item.sessionId && !item.online) {
        mainView.renderReadonly(pane);
      }
      if (events.length === 0) {
        readonlyCache.delete(key);
      }
    } catch (error) {
      const pane: ReadonlyPaneInput = {
        readAt: Date.now(),
        eventCount: 0,
        excerpts: [],
        missing: true,
        reason: describeFailure(error, '读取副本'),
      };
      if (selection?.deviceId === item.deviceId && selection.sessionId === item.sessionId && !item.online) {
        mainView.renderReadonly(pane);
      }
    } finally {
      readonlyLoading.delete(key);
    }
  }

  /** 渲染诊断页面。 */
  function renderDiagnostics(): void {
    const onlineCount = devices.filter((device) => device.online).length;
    const rows: [string, string][] = [
      ['当前路由', routePath(route)],
      ['已加载会话', `${String(pages.items.length)} 条`],
      ['已知设备', `${String(onlineCount)} 台在线 / ${String(devices.length)} 台登记`],
      ['本机运行时', localRuntime === undefined ? '状态未知' : localRuntime.available ? `可用（${localRuntime.deviceId}）` : `不可用：${localRuntime.reason ?? '原因未知'}`],
      ['本地草稿存储', draftStorageAvailable(localStore) ? '可读写' : '不可用'],
      ['遥测上报', '同源中继 /chatdsh/telemetry/browser'],
      ['客户端标识', `${clientId.slice(0, 8)}…`],
      ['窗口标识', `${windowId.slice(0, 8)}…`],
    ];
    mainView.renderDiagnostics(rows);
  }

  /** 打开创建向导。 */
  async function openWizard(): Promise<void> {
    if (wizard !== undefined) {
      pushWizard();
      return;
    }
    wizard = {
      devices: [],
      deviceId: undefined,
      listing: undefined,
      listingError: undefined,
      listingBusy: false,
      busy: false,
      error: undefined,
      created: undefined,
    };
    mainView.openCreateWizard(wizardInput());
    await refreshDevices();
    if (wizard === undefined) return;
    wizard.devices = devices;
    const firstOnline = devices.find((device) => device.online);
    wizard.deviceId = firstOnline?.id;
    if (wizard.deviceId === undefined) {
      wizard.listingError = '没有在线设备：先让目标设备上线，再创建会话。';
      wizard.error = '没有在线设备，无法创建会话。';
      pushWizard();
      return;
    }
    pushWizard();
    await loadWizardDirectory(undefined);
  }

  /** 向导的渲染数据。 */
  function wizardInput(): CreateWizardInput {
    const state = wizard;
    if (state === undefined) throw new Error('创建向导未打开');
    return {
      devices: state.devices,
      deviceId: state.deviceId,
      listing: state.listing,
      listingError: state.listingError,
      listingBusy: state.listingBusy,
      busy: state.busy,
      error: state.error,
      ...(state.created === undefined ? {} : { createdSessionId: state.created.sessionId }),
    };
  }

  /** 重绘向导。 */
  function pushWizard(): void {
    if (wizard === undefined) return;
    mainView.updateCreateWizard(wizardInput());
  }

  /**
   * 更换创建向导的目标设备。
   * @param deviceId - 设备标识。
   */
  async function changeWizardDevice(deviceId: string): Promise<void> {
    if (wizard === undefined) return;
    wizard.deviceId = deviceId;
    wizard.listing = undefined;
    wizard.listingError = undefined;
    wizard.error = undefined;
    pushWizard();
    await loadWizardDirectory(undefined);
  }

  /**
   * 读创建向导里目标设备的目录。
   * @param path - 目录路径；省略时读默认入口。
   */
  async function loadWizardDirectory(path: string | undefined): Promise<void> {
    const state = wizard;
    if (state === undefined) return;
    const deviceId = state.deviceId;
    if (deviceId === undefined) {
      state.listingError = '请先选择在线设备。';
      pushWizard();
      return;
    }
    const device = devices.find((entry) => entry.id === deviceId);
    if (device?.online !== true) {
      state.listingError = `${device?.name ?? deviceId} 离线，无法读取目录。`;
      state.listing = undefined;
      pushWizard();
      return;
    }
    state.listingBusy = true;
    state.listingError = undefined;
    pushWizard();
    try {
      const listing = await api.listDirectory(deviceId, path);
      if (wizard !== state || state.deviceId !== deviceId) return;
      state.listing = listing;
      mainView.setCreateCwd(listing.path);
    } catch (error) {
      if (wizard !== state || state.deviceId !== deviceId) return;
      state.listing = undefined;
      state.listingError = describeFailure(error, '读取设备目录');
    } finally {
      if (wizard === state) {
        state.listingBusy = false;
        pushWizard();
      }
    }
  }

  /**
   * 提交创建。
   * @param input - 表单内容。
   */
  function submitCreate(input: CreateSubmit): void {
    const state = wizard;
    if (state === undefined) return;
    if (state.created !== undefined) {
      repairOwnership(state);
      return;
    }
    const device = devices.find((entry) => entry.id === input.deviceId);
    if (device === undefined || !device.online) {
      state.error = `${device?.name ?? input.deviceId} 离线，创建失败：请先让设备上线。`;
      telemetry.action('session-create', 'rejected');
      pushWizard();
      return;
    }
    state.busy = true;
    state.error = undefined;
    pushWizard();
    const key = `create\u0000${input.deviceId}\u0000${input.cwd}`;
    void gate.run(key, async () => {
      try {
        const created = await api.createSession({
          deviceId: input.deviceId,
          cwd: input.cwd,
          ...(input.title === '' ? {} : { title: input.title }),
        });
        if (created.ownershipWarning !== undefined) {
          // 部分成功：会话已经存在，按钮改成重新登记归属，绝不再建一条。
          telemetry.action('session-create', 'failed');
          if (wizard === state) {
            state.created = { sessionId: created.sessionId, deviceId: input.deviceId, cwd: input.cwd };
            state.error = created.ownershipWarning;
            state.busy = false;
            pushWizard();
          }
          return;
        }
        telemetry.action('session-create', 'ok');
        closeWizard(false);
        router.push(sessionRoute(created.sessionId, input.deviceId));
        await refreshList();
        if (created.titleWarning !== undefined) listView.setStatus(created.titleWarning);
      } catch (error) {
        telemetry.action('session-create', 'failed');
        if (wizard === state) {
          state.error = describeFailure(error, '创建会话');
          state.busy = false;
          pushWizard();
        }
      }
    });
  }

  /**
   * 重新登记一条已经创建好的会话的归属。
   * @param state - 创建向导状态。
   */
  function repairOwnership(state: WizardState): void {
    const created = state.created;
    if (created === undefined) return;
    state.busy = true;
    state.error = undefined;
    pushWizard();
    void gate.run(`repair\u0000${created.sessionId}`, async () => {
      try {
        await api.registerOwnership(created);
        telemetry.action('session-create', 'ok');
        if (wizard === state) {
          state.created = undefined;
          closeWizard(false);
        }
        router.push(sessionRoute(created.sessionId, created.deviceId));
        await refreshList();
      } catch (error) {
        telemetry.action('session-create', 'failed');
        if (wizard === state) {
          state.error = describeFailure(error, '登记会话归属');
          state.busy = false;
          pushWizard();
        }
      }
    });
  }

  /**
   * 关闭创建向导。
   * @param backToList - 是否回到列表路由。
   */
  function closeWizard(backToList: boolean): void {
    if (wizard !== undefined) {
      wizard = undefined;
      mainView.closeCreateWizard();
    }
    if (!backToList) return;
    const target: Route = { kind: 'sessions' };
    if (sameRoute(target, route)) handleRoute('replace');
    else router.push(target);
  }

  /**
   * 打开继续确认。
   * @param sessionId - 源会话。
   * @param deviceId - 源设备。
   */
  async function openContinue(sessionId: string, deviceId: string | undefined): Promise<void> {
    const known = findSession(pages.items, sessionId, deviceId) ?? routeItems.get(`${deviceId ?? ''}\u0000${sessionId}`);
    if (continueState !== undefined && continueState.sessionId === sessionId && continueState.deviceId === deviceId) {
      pushContinue();
      return;
    }
    continueState = {
      sessionId,
      deviceId,
      item: known,
      events: undefined,
      estimate: undefined,
      estimateError: undefined,
      importMode: 'full-prefix',
      listing: undefined,
      listingError: undefined,
      listingBusy: false,
      busy: false,
      error: undefined,
    };
    await refreshLocalRuntime();
    if (continueState !== undefined) {
      mainView.openContinueDialog(continueInput());
      void loadEstimate();
      void loadContinueDirectory(undefined);
    }
  }

  /** 继续确认的渲染数据。 */
  function continueInput(): ContinueDialogInput {
    const state = continueState;
    if (state === undefined) throw new Error('继续确认未打开');
    return {
      sourceTitle: state.item?.title ?? state.sessionId,
      sourceDeviceLabel: state.item?.deviceName ?? state.deviceId ?? '未知设备',
      sourceDeviceId: state.item?.deviceId ?? state.deviceId ?? '',
      sourceOnline: state.item?.online === true,
      sourceSessionId: state.sessionId,
      estimate:
        state.estimate === undefined
          ? undefined
          : {
              eventCount: state.estimate.eventCount,
              charCount: state.estimate.charCount,
              missingAttachmentIds: state.estimate.missingAttachmentIds,
              compressionLoss: state.estimate.compressionLoss,
              sourceState: state.estimate.source.state === 'complete' ? 'complete' : 'partial',
            },
      estimateError: state.estimateError,
      importMode: state.importMode,
      localAvailable: localRuntime?.available === true,
      localReason: localRuntime?.reason,
      listing: state.listing,
      listingError: state.listingError,
      listingBusy: state.listingBusy,
      busy: state.busy,
      error: state.error,
    };
  }

  /** 重绘继续确认。 */
  function pushContinue(): void {
    if (continueState === undefined) return;
    mainView.updateContinueDialog(continueInput());
  }

  /** 读源会话副本并计算预估。 */
  async function loadEstimate(): Promise<void> {
    const state = continueState;
    if (state === undefined) return;
    try {
      const events = await api.readReplica(state.sessionId);
      if (continueState !== state) return;
      state.events = events;
      applyEstimate();
    } catch (error) {
      if (continueState !== state) return;
      state.events = undefined;
      state.estimate = undefined;
      state.estimateError = describeFailure(error, '读取副本');
      pushContinue();
    }
  }

  /** 按当前复制方式重算预估。 */
  function applyEstimate(): void {
    const state = continueState;
    if (state === undefined) return;
    if (state.events === undefined) {
      state.estimate = undefined;
      pushContinue();
      return;
    }
    const result = estimateFork(state.events, {
      importMode: state.importMode,
      sourceOnline: state.item?.online === true,
      readAt: Date.now(),
    });
    if (result.ok) {
      state.estimate = result.estimate;
      state.estimateError = undefined;
    } else {
      state.estimate = undefined;
      state.estimateError = '该会话没有可读副本，无法在本机继续。';
    }
    pushContinue();
  }

  /**
   * 更换复制方式。
   * @param mode - 复制方式。
   */
  function changeContinueMode(mode: ImportMode): void {
    const state = continueState;
    if (state === undefined) return;
    state.importMode = mode;
    applyEstimate();
  }

  /**
   * 读本机目录。
   * @param path - 目录路径。
   */
  async function loadContinueDirectory(path: string | undefined): Promise<void> {
    const state = continueState;
    if (state === undefined) return;
    state.listingBusy = true;
    state.listingError = undefined;
    pushContinue();
    try {
      const listing = await api.listDirectory(undefined, path);
      if (continueState !== state) return;
      state.listing = listing;
      mainView.setContinueCwd(listing.path);
    } catch (error) {
      if (continueState !== state) return;
      state.listing = undefined;
      state.listingError = describeFailure(error, '读取本机目录');
    } finally {
      if (continueState === state) {
        state.listingBusy = false;
        pushContinue();
      }
    }
  }

  /**
   * 提交本机继续。
   * @param input - 表单内容。
   */
  function submitContinue(input: ContinueSubmit): void {
    const state = continueState;
    if (state === undefined) return;
    if (localRuntime?.available !== true) {
      state.error = localRuntime?.reason ?? '本机运行时不可用：在 Web 上需要已登记且已启动的本机运行时。';
      pushContinue();
      return;
    }
    if (state.estimate === undefined) {
      state.error = '副本不可用，无法在本机继续。';
      pushContinue();
      return;
    }
    const targetDeviceId = localRuntime.deviceId;
    state.busy = true;
    state.error = undefined;
    pushContinue();
    const key = `local-continue\u0000${state.sessionId}\u0000${input.cwd}`;
    void gate.run(key, async () => {
      try {
        const result = await api.importSession({
          sourceSessionId: state.sessionId,
          deviceId: targetDeviceId,
          cwd: input.cwd,
        });
        telemetry.action('continue-local', 'ok');
        if (continueState === state) {
          continueState = undefined;
          mainView.closeContinueDialog();
        }
        router.push(sessionRoute(result.sessionId, targetDeviceId));
        await refreshList();
        listView.setStatus(`已在本机新开会话，来源会话：${result.parentSession}`);
      } catch (error) {
        telemetry.action('continue-local', 'failed');
        if (continueState === state) {
          state.error = describeFailure(error, '在本机继续');
          state.busy = false;
          pushContinue();
        }
      }
    });
  }

  /** 关闭继续确认并回到源会话。 */
  function closeContinue(): void {
    const state = continueState;
    continueState = undefined;
    mainView.closeContinueDialog();
    const target: Route =
      state === undefined ? { kind: 'sessions' } : sessionRoute(state.sessionId, state.deviceId ?? (state.item?.deviceId ?? ''));
    const normalized: Route =
      target.kind === 'sessions' && target.deviceId === '' ? { kind: 'sessions', sessionId: target.sessionId } : target;
    if (sameRoute(normalized, route)) handleRoute('replace');
    else router.push(normalized);
  }

  /** 关闭继续确认的界面，不改路由。 */
  function closeContinueDialogOnly(): void {
    if (continueState === undefined) return;
    continueState = undefined;
    mainView.closeContinueDialog();
  }

  /** 在远程继续：使用源会话与源设备。 */
  function runRemoteContinue(): void {
    const item = currentSelectionItem();
    if (item === undefined) return;
    if (!item.online) {
      telemetry.action('continue-remote', 'rejected');
      listView.setStatus('源设备离线，无法在远程继续；可以从副本在本机新建分支。');
      return;
    }
    telemetry.action('continue-remote', 'ok');
    const target = sessionRoute(item.sessionId, item.deviceId);
    if (sameRoute(target, route)) {
      void requestSelection(item, true);
      return;
    }
    router.push(target);
  }

  /**
   * 记一次草稿输入。
   * @param text - 输入文本。
   */
  function queueDraftSave(text: string): void {
    const identity = draftIdentity;
    if (identity === undefined) return;
    if (draftTimer !== undefined) window.clearTimeout(draftTimer);
    draftTimer = window.setTimeout(() => {
      draftTimer = undefined;
      saveDraft(identity, text);
    }, DRAFT_DEBOUNCE_MS);
  }

  /**
   * 写一次草稿。
   * @param identity - 草稿键。
   * @param text - 输入文本。
   */
  function saveDraft(identity: DraftIdentity, text: string): void {
    const result = writeDraft(localStore, identity, { text });
    if (result.outcome === 'saved') {
      mainView.setDraftMessage('草稿已保存在本机。', 'ok');
      return;
    }
    telemetry.action('draft-save', 'failed');
    mainView.setDraftMessage(`草稿保存失败：${DRAFT_FAILURE_TEXT[result.reason ?? 'storage-unavailable']}，输入已保留。`, 'error');
  }

  /** 立即落盘当前的草稿。 */
  function flushDraft(): void {
    if (draftTimer !== undefined) {
      window.clearTimeout(draftTimer);
      draftTimer = undefined;
    }
    if (draftIdentity === undefined) return;
    writeDraft(localStore, draftIdentity, { text: mainView.getDraftText() });
  }

  /**
   * 打开一条会话的草稿。
   * @param item - 会话。
   */
  function openDraft(item: SessionItem): void {
    const next: DraftIdentity = { clientId, windowId, deviceId: item.deviceId, sessionId: item.sessionId };
    const current = draftIdentity;
    // 轮询刷新会重复走到这里：同一条会话的草稿只装载一次，避免覆盖正在输入的状态提示。
    if (
      current !== undefined &&
      current.clientId === next.clientId &&
      current.windowId === next.windowId &&
      current.deviceId === next.deviceId &&
      current.sessionId === next.sessionId
    ) {
      return;
    }
    flushDraft();
    draftIdentity = next;
    const record = readDraft(localStore, next);
    const available = draftStorageAvailable(localStore);
    if (!available) {
      mainView.setDraft(record?.text ?? '', '本地存储不可用：草稿只在本次页面有效。');
      return;
    }
    mainView.setDraft(
      record?.text ?? '',
      record === undefined ? '尚未保存草稿。' : `草稿已从本机恢复：${new Date(record.updatedAt).toLocaleTimeString()}`
    );
  }

  /** 关闭当前草稿。 */
  function closeDraft(): void {
    flushDraft();
    draftIdentity = undefined;
    mainView.setDraft('', '');
  }

  /** 离线发送：立即失败，草稿保留，不进入待发队列。 */
  function sendOfflineDraft(): void {
    if (draftIdentity === undefined) return;
    const result = offlineSendOutcome(mainView.getDraftText());
    if (result.outcome === 'empty') {
      mainView.setDraftMessage('输入为空，没有发送。', 'error');
      return;
    }
    flushDraft();
    telemetry.action('offline-send', 'rejected');
    mainView.setDraftMessage(result.message, 'error');
  }

  /** 打开命令面板。 */
  function openPalette(): void {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const recent = readRecentCommands(localStore, clientId);
    mainView.openPalette({ commands: orderByRecent(paletteCommands(), recent), recent, trigger });
  }

  /** 命令面板里的命令。 */
  function paletteCommands(): CommandDescriptor[] {
    return buildShellCommands({
      hasSelection: currentSelectionItem() !== undefined,
      localAvailable: localRuntime?.available === true,
      localReason: localRuntime?.reason,
    });
  }

  /**
   * 执行一条命令。
   * @param command - 命令。
   */
  function runCommand(command: CommandDescriptor): void {
    if (!command.enabled) return;
    recordRecentCommand(localStore, clientId, command.id);
    mainView.closePalette();
    if (command.id === 'go-list') {
      router.push({ kind: 'sessions' });
      return;
    }
    if (command.id === 'new-session') {
      router.push({ kind: 'new-session' });
      return;
    }
    if (command.id === 'refresh') {
      void refreshAll();
      return;
    }
    if (command.id === 'diagnostics') {
      router.push({ kind: 'diagnostics' });
      return;
    }
    if (command.id === 'continue-local') {
      if (selection === undefined) return;
      router.push(continueRoute(selection.sessionId, selection.deviceId));
      return;
    }
    if (command.id.startsWith('settings:')) {
      const section = command.id.slice('settings:'.length);
      if (isSettingsSection(section)) router.push({ kind: 'settings', section });
    }
  }

  document.addEventListener('keydown', (event) => {
    if (isPaletteShortcut(event)) {
      event.preventDefault();
      openPalette();
      return;
    }
    if (event.key === 'Escape' && mainView.paletteOpen) {
      event.preventDefault();
      mainView.closePalette();
    }
  });

  window.addEventListener('focus', () => void refreshList(true));
  window.setInterval(() => void refreshList(true), REFRESH_INTERVAL_MS);
  // 页面隐藏或卸载前把草稿立刻落盘：等待中的防抖写入不会因此丢失输入。
  window.addEventListener('pagehide', () => flushDraft());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushDraft();
  });

  /** 启动：先取数据再应用路由，深链接因此能立即还原。 */
  async function boot(): Promise<void> {
    loading = true;
    renderList();
    await refreshDevices();
    await refreshLocalRuntime();
    await refreshList();
    router.start();
  }

  void boot().catch((error: unknown) => {
    root.replaceChildren();
    const failure = document.createElement('p');
    failure.className = 'shell-notice shell-notice-error';
    failure.textContent = `外壳启动失败：${error instanceof Error ? error.message : String(error)}`;
    root.append(failure);
  });
}

applyStyles();

const root = document.getElementById(ROOT_ID);
if (root === null) throw new Error(`外壳页面缺少 #${ROOT_ID} 容器`);
startShell(root);
