/**
 * 中继根路径的移动端 PWA 页面。
 *
 * 页面保持单文件内联产物：样式、脚本与视图逻辑都由本模块生成，不引入打包器与新依赖。
 * 副本时间线、审批角标与 IndexedDB 草稿的纯函数从对应模块序列化进页面脚本，浏览器与
 * 单元测试执行同一份实现。
 * @module @chatdsh/gateway/pwa-page
 */

import {
  EMPTY_APPROVAL_BADGES,
  approvalCountOf,
  approvalTotalOf,
  buildReplicaTimeline,
  reduceApprovalBadge,
} from './pwa-view.ts';
import {
  DRAFT_DB_NAME,
  DRAFT_DB_VERSION,
  DRAFT_KEY_PREFIX,
  DRAFT_LEGACY_STORE_NAME,
  DRAFT_SESSION_MAX,
  DRAFT_STORE_NAME,
  DRAFT_TEXT_MAX,
  createIndexedDbDraftStore,
  draftKeyOf,
  draftRecordOf,
  draftUpgradePlan,
  migrateLegacyDraft,
  normalizeDraftRecord,
} from './pwa-drafts.ts';
import {
  BROWSER_RELAY_CSRF_HEADER,
  BROWSER_RELAY_PATH,
  BROWSER_RELAY_SIGNAL_HEADER,
  createPwaPageTelemetry,
} from './pwa-telemetry.ts';

/** 应用清单路径。 */
export const PWA_MANIFEST_PATH = '/manifest.webmanifest';

/** Service Worker 路径。 */
export const PWA_SERVICE_WORKER_PATH = '/sw.js';

/** 离线回退页路径。 */
export const PWA_OFFLINE_PATH = '/offline.html';

/** 图标目录前缀。 */
export const PWA_ICON_PREFIX = '/assets/icons/';

/** 页面渲染输入。 */
export interface PwaIndexOptions {
  /** 中继版本号。 */
  readonly version: string;
  /** 当前浏览器设备标识；推送订阅按它登记。 */
  readonly deviceId: string;
}

const PAGE_STYLE = `
    :root {
      color-scheme: dark;
      --bg:#0e0e10; --panel:#17181c; --panel-2:#1d1f24; --line:#24262c;
      --ink:#f3f5f9; --muted:#9aa1ad; --brand:#4d6bfe; --ok:#3fb37f;
      --warn:#e8b04b; --error:#e86a6a; --user:#4d6bfe; --assistant:#3fb37f;
      --tool:#9aa1ad; --approval:#e8b04b;
    }
    * { box-sizing: border-box; }
    html, body { min-height: 100%; }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--ink);
      padding-left: env(safe-area-inset-left);
      padding-right: env(safe-area-inset-right);
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 18px;
      padding-top: calc(14px + env(safe-area-inset-top));
      border-bottom: 1px solid var(--line);
      background: var(--panel);
      position: sticky;
      top: 0;
      z-index: 5;
    }
    header h1 { margin: 0; font-size: 15px; font-weight: 600; }
    header .version { font-size: 12px; color: var(--muted); }
    .header-status { display: flex; align-items: center; gap: 8px; }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 3px 10px;
      font-size: 12px;
      color: var(--muted);
      white-space: nowrap;
    }
    .pill.ok { color: var(--ok); border-color: rgba(63,179,127,0.4); }
    .pill.warn { color: var(--warn); border-color: rgba(232,176,75,0.4); }
    .pill.error { color: var(--error); border-color: rgba(232,106,106,0.4); }
    .badge {
      min-width: 22px;
      height: 22px;
      border-radius: 999px;
      background: var(--error);
      color: #fff;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 600;
      padding: 0 7px;
    }
    .badge[hidden] { display: none; }
    .badge.small { min-width: 18px; height: 18px; font-size: 11px; }
    main {
      max-width: 960px;
      margin: 0 auto;
      padding: 18px;
      padding-bottom: calc(140px + env(safe-area-inset-bottom));
      display: grid;
      gap: 16px;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 14px;
    }
    .card h2 { margin: 0 0 10px; font-size: 13px; color: var(--muted); font-weight: 600; }
    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 6px;
      border-top: 1px solid var(--line);
    }
    .row:first-of-type { border-top: 0; }
    .row-main { display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; }
    .row-title { font-size: 13px; overflow-wrap: anywhere; }
    .muted { color: var(--muted); font-size: 12px; }
    .empty { color: var(--muted); font-size: 13px; margin: 6px 0; }
    .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex: none; }
    .dot.online { background: var(--ok); }
    .dot.offline { background: var(--warn); }
    a.btn, button.btn {
      background: var(--brand);
      color: #fff;
      border: 0;
      border-radius: 7px;
      padding: 7px 12px;
      font-size: 12px;
      text-decoration: none;
      cursor: pointer;
      min-height: 36px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      white-space: nowrap;
    }
    button.btn.ghost { background: transparent; color: var(--muted); border: 1px solid var(--line); }
    button.btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .replica-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
    }
    .replica-head h2 { margin: 0 0 6px; color: var(--ink); font-size: 15px; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .timeline { display: grid; gap: 10px; }
    .event {
      border: 1px solid var(--line);
      border-left-width: 3px;
      border-radius: 8px;
      background: var(--panel-2);
      padding: 10px 12px;
    }
    .event.role-user { border-left-color: var(--user); }
    .event.role-assistant { border-left-color: var(--assistant); }
    .event.role-tool { border-left-color: var(--tool); }
    .event.role-approval { border-left-color: var(--approval); }
    .event.failed { border-left-color: var(--error); }
    .event-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
    .event-title { font-size: 12px; font-weight: 600; }
    .event-meta { font-size: 11px; color: var(--muted); text-align: right; overflow-wrap: anywhere; }
    .event-body {
      margin: 8px 0 0;
      font-size: 13px;
      line-height: 1.55;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    pre.event-body {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      max-height: 320px;
      overflow: auto;
      background: #121317;
      border-radius: 6px;
      padding: 8px;
    }
    .truncated { display: inline-block; margin-top: 6px; font-size: 11px; color: var(--warn); }
    details.unknown { border-left-color: var(--line); }
    details.unknown summary { cursor: pointer; font-size: 12px; color: var(--muted); }
    details.unknown pre { margin: 8px 0 0; max-height: 320px; overflow: auto; font-size: 11px; color: var(--muted); }
    details.raw { margin-top: 14px; border-top: 1px solid var(--line); padding-top: 10px; }
    details.raw summary { cursor: pointer; font-size: 12px; color: var(--muted); }
    details.raw pre {
      margin: 8px 0 0;
      max-height: 420px;
      overflow: auto;
      background: #121317;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 10px;
      font-size: 11px;
      color: #c7ccd6;
      white-space: pre-wrap;
    }
    .composer {
      position: sticky;
      bottom: 0;
      z-index: 4;
      margin: 16px -4px -4px;
      padding: 12px 4px calc(12px + env(safe-area-inset-bottom));
      background: linear-gradient(180deg, rgba(14,14,16,0.4), var(--panel) 30%);
      border-top: 1px solid var(--line);
    }
    .composer label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 6px; }
    .composer textarea {
      width: 100%;
      min-height: 72px;
      resize: vertical;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #121317;
      color: var(--ink);
      padding: 10px;
      font: inherit;
      font-size: 13px;
    }
    .composer-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-top: 8px;
    }
    .status-text { font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
    .status-text.ok { color: var(--ok); }
    .status-text.warn { color: var(--warn); }
    .status-text.error { color: var(--error); }
    .toast {
      position: fixed;
      left: 50%;
      bottom: calc(18px + env(safe-area-inset-bottom));
      transform: translateX(-50%);
      max-width: min(92vw, 480px);
      padding: 10px 14px;
      border-radius: 8px;
      background: #24262c;
      border: 1px solid var(--line);
      color: var(--ink);
      font-size: 13px;
      z-index: 20;
      box-shadow: 0 8px 24px rgba(0,0,0,0.35);
    }
    .toast.warn { border-color: rgba(232,176,75,0.5); }
    .toast.error { border-color: rgba(232,106,106,0.5); }
    .approval-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 0; border-top: 1px solid var(--line); }
    .approval-row:first-child { border-top: 0; }
    @media (max-width: 720px) {
      main { padding: 12px; padding-bottom: calc(150px + env(safe-area-inset-bottom)); }
      header { padding-left: 12px; padding-right: 12px; }
      .replica-head { flex-direction: column; align-items: stretch; }
      .actions { justify-content: stretch; }
      .actions .btn { flex: 1 1 140px; }
      .row { align-items: flex-start; flex-direction: column; }
      .row > .btn { align-self: stretch; }
      .event-head { flex-direction: column; gap: 4px; }
      .event-meta { text-align: left; }
    }
`;

const PAGE_SCRIPT = `
'use strict';
const PAGE_DEVICE_ID = __DEVICE_ID__;
const telemetry = createPwaPageTelemetry({ component: '@chatdsh/gateway/pwa-page' });
const state = {
  devices: [],
  sessions: [],
  selected: null,
  events: [],
  timeline: null,
  badges: EMPTY_APPROVAL_BADGES,
  drafts: null,
  draftTimer: 0,
  source: null,
  toastTimer: 0,
};

function byId(id) {
  return document.getElementById(id);
}

function make(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function clear(node) {
  while (node.firstChild !== null) node.removeChild(node.firstChild);
}

function showToast(text, tone) {
  const toast = byId('toast');
  toast.textContent = text;
  toast.className = 'toast' + (tone ? ' ' + tone : '');
  toast.hidden = false;
  if (state.toastTimer !== 0) clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    toast.hidden = true;
    state.toastTimer = 0;
  }, 4200);
}

function setStatus(id, text, tone) {
  const element = byId(id);
  element.textContent = text;
  element.className = 'status-text' + (tone ? ' ' + tone : '');
}

async function requestJson(path, init) {
  const response = await fetch(path, init);
  const text = await response.text();
  const data = text === '' ? {} : JSON.parse(text);
  if (!response.ok) {
    const error = new Error(typeof data.error === 'string' ? data.error : 'request-failed');
    error.code = typeof data.error === 'string' ? data.error : 'request-failed';
    error.status = response.status;
    throw error;
  }
  return data;
}

function formatTime(value) {
  const date = new Date(value);
  function pad(part) {
    return String(part).padStart(2, '0');
  }
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

function renderDevices() {
  const list = byId('devices-list');
  clear(list);
  if (state.devices.length === 0) {
    list.append(make('p', 'empty', '暂无已配对设备'));
    return;
  }
  for (const device of state.devices) {
    const row = make('div', 'row');
    const left = make('div', 'row-main');
    left.append(make('span', 'dot ' + (device.online ? 'online' : 'offline')));
    left.append(make('span', 'row-title', device.name + ' · ' + device.platform));
    row.append(left);
    if (device.online) {
      const link = make('a', 'btn', '打开设备 DSH');
      link.href = '/d/' + encodeURIComponent(device.id) + '/';
      row.append(link);
    } else {
      row.append(make('span', 'muted', '离线'));
    }
    list.append(row);
  }
}

function renderSessions() {
  const list = byId('sessions-list');
  clear(list);
  const rows = [];
  for (const group of state.sessions) {
    for (const session of group.sessions) rows.push({ group: group, session: session });
  }
  if (rows.length === 0) {
    list.append(make('p', 'empty', '暂无同步会话'));
    return;
  }
  for (const row of rows) {
    const element = make('div', 'row');
    const left = make('div', 'row-main');
    left.append(make('span', 'row-title', row.session.title));
    left.append(make('span', 'muted', row.group.name + ' · ' + (row.group.online ? '在线' : '离线副本')));
    const count = approvalCountOf(state.badges, row.session.sessionId);
    if (count > 0) left.append(make('span', 'badge small', String(count)));
    const button = make('button', 'btn ghost', '查看副本');
    button.type = 'button';
    button.addEventListener('click', () => {
      void openReplica(row.group, row.session).catch((error) => {
        telemetry.failure('replica-open', error);
        showToast('副本加载失败：' + (error.code || error.message), 'error');
      });
    });
    element.append(left, button);
    list.append(element);
  }
}

function renderApprovals() {
  const section = byId('approvals-section');
  const list = byId('approvals-list');
  clear(list);
  const entries = Object.values(state.badges.entries);
  section.hidden = entries.length === 0;
  if (entries.length === 0) return;
  for (const entry of entries) {
    const row = make('div', 'approval-row');
    const left = make('div', 'row-main');
    left.append(make('span', 'dot offline'));
    left.append(make('span', 'row-title', (entry.toolName || '审批请求') + ' · 会话 ' + entry.sessionId.slice(0, 8)));
    row.append(left);
    const group = sessionGroupOf(entry.sessionId);
    if (group !== undefined && group.online) {
      const link = make('a', 'btn', '前往设备');
      link.href = '/d/' + encodeURIComponent(group.deviceId) + '/';
      row.append(link);
    } else {
      row.append(make('span', 'muted', '设备离线，恢复后处理'));
    }
    list.append(row);
  }
}

function sessionGroupOf(sessionId) {
  for (const group of state.sessions) {
    for (const session of group.sessions) {
      if (session.sessionId === sessionId) return group;
    }
  }
  return undefined;
}

function renderBadge() {
  const total = approvalTotalOf(state.badges);
  const badge = byId('approval-badge');
  badge.hidden = total === 0;
  badge.textContent = String(total);
  renderApprovals();
  renderSessions();
}

function renderItem(item) {
  if (item.collapsed) {
    const details = document.createElement('details');
    details.className = 'event unknown';
    const summary = document.createElement('summary');
    summary.textContent = item.title;
    const raw = make('pre', undefined, item.raw);
    details.append(summary, raw);
    return details;
  }
  const article = make('article', 'event role-' + item.role + (item.status === 'error' ? ' failed' : ''));
  const head = make('div', 'event-head');
  head.append(make('span', 'event-title', item.title));
  const meta = [];
  if (item.time > 0) meta.push(formatTime(item.time));
  if (item.meta !== '') meta.push(item.meta);
  if (item.status === 'pending') meta.push('待审批');
  if (item.status === 'decided') meta.push('已决定');
  if (meta.length > 0) head.append(make('span', 'event-meta', meta.join(' · ')));
  article.append(head);
  article.append(make(item.role === 'tool' ? 'pre' : 'div', 'event-body', item.body));
  if (item.bodyTruncated) article.append(make('span', 'truncated', '内容已截断'));
  return article;
}

function renderReplica() {
  const selected = state.selected;
  if (selected === null) {
    byId('replica-section').hidden = true;
    return;
  }
  byId('replica-section').hidden = false;
  byId('replica-title').textContent = selected.session.title;
  const stateElement = byId('replica-state');
  stateElement.textContent = selected.group.online ? '设备在线 · 只读副本' : '设备离线 · 只读副本';
  stateElement.className = 'pill ' + (selected.group.online ? 'ok' : 'warn');
  const timeline = byId('replica-timeline');
  clear(timeline);
  if (state.timeline === null || state.timeline.empty) {
    timeline.append(make('p', 'empty', '暂无副本事件'));
  } else {
    for (const item of state.timeline.items) timeline.append(renderItem(item));
  }
  byId('replica-raw').textContent = JSON.stringify(state.events, null, 2);
  updateComposer();
}

async function openReplica(group, session) {
  state.selected = { group: group, session: session };
  const data = await requestJson('/chatdsh/gateway/replica?sessionId=' + encodeURIComponent(session.sessionId));
  state.events = Array.isArray(data.events) ? data.events : [];
  state.timeline = buildReplicaTimeline(state.events);
  renderReplica();
  await loadDraft(session.sessionId);
  byId('replica-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  telemetry.action('replica-open', 'ok');
}

async function ensureDrafts() {
  if (state.drafts !== null) return state.drafts;
  state.drafts = createIndexedDbDraftStore(indexedDB, {
    databaseName: DRAFT_DB_NAME,
    version: DRAFT_DB_VERSION,
    storeName: DRAFT_STORE_NAME,
    legacyStoreName: DRAFT_LEGACY_STORE_NAME,
    textMax: DRAFT_TEXT_MAX,
  });
  return state.drafts;
}

async function loadDraft(sessionId) {
  const input = byId('draft-input');
  input.value = '';
  if (!('indexedDB' in globalThis)) {
    setStatus('draft-status', '浏览器不支持 IndexedDB，草稿不可用', 'error');
    updateComposer();
    return;
  }
  const store = await ensureDrafts();
  const record = await store.load(sessionId);
  if (record !== undefined) input.value = record.text;
  updateComposer();
}

async function saveDraft() {
  if (state.selected === null || !('indexedDB' in globalThis)) return;
  const store = await ensureDrafts();
  const text = byId('draft-input').value;
  const record = await store.save(state.selected.session.sessionId, text);
  telemetry.action('draft-save', record === undefined ? 'cleared' : 'saved');
  if (record === undefined) setStatus('draft-status', '草稿已清空', 'muted');
  else setStatus('draft-status', '草稿已保存', 'muted');
  updateComposer();
}

function composerOnline() {
  return navigator.onLine && state.selected !== null && state.selected.group.online;
}

function updateComposer() {
  const form = byId('draft-form');
  if (state.selected === null) {
    form.hidden = true;
    return;
  }
  form.hidden = false;
  const input = byId('draft-input');
  const button = byId('draft-send');
  const hasText = input.value.trim() !== '';
  const online = composerOnline();
  button.disabled = !online || !hasText;
  if (!state.selected.group.online || !navigator.onLine) {
    setStatus('draft-status', hasText ? '草稿已保存，恢复连接后由你手动发送' : '设备离线，草稿会保存在本机', 'warn');
    return;
  }
  if (!hasText) {
    setStatus('draft-status', '设备在线，输入内容后可发送', 'muted');
    return;
  }
  setStatus('draft-status', '设备在线，可以发送', 'ok');
}

async function copyDraft(text) {
  if (navigator.clipboard === undefined) return false;
  await navigator.clipboard.writeText(text);
  return true;
}

async function sendDraft() {
  if (state.selected === null) return;
  if (!composerOnline()) {
    updateComposer();
    return;
  }
  const text = byId('draft-input').value;
  if (text.trim() === '') return;
  const target = '/d/' + encodeURIComponent(state.selected.group.deviceId) + '/';
  const opened = window.open(target, '_blank', 'noopener');
  await saveDraft();
  const copied = await copyDraft(text);
  telemetry.action('draft-send', copied ? 'copied' : 'opened');
  if (opened === null) {
    showToast('浏览器拦截了新窗口，请在设备列表打开设备页面', 'warn');
    return;
  }
  showToast(copied ? '草稿已复制，请在设备页面粘贴发送' : '已打开设备页面，请手动发送草稿', 'ok');
}

async function continueHere() {
  if (state.selected === null) return;
  const payload = { sourceSessionId: state.selected.session.sessionId };
  if (state.selected.group.online) payload.deviceId = state.selected.group.deviceId;
  const data = await requestJson('/chatdsh/gateway/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  telemetry.action('import-continue', 'ok');
  showToast('已创建本机继续的会话 ' + String(data.sessionId).slice(0, 8), 'ok');
  await loadAll();
}

async function loadAll() {
  const [deviceData, sessionData] = await Promise.all([
    requestJson('/chatdsh/gateway/devices'),
    requestJson('/chatdsh/gateway/sessions'),
  ]);
  state.devices = Array.isArray(deviceData.devices) ? deviceData.devices : [];
  state.sessions = Array.isArray(sessionData.devices) ? sessionData.devices : [];
  renderDevices();
  renderSessions();
}

function subscribeEvents() {
  if (state.source !== null) state.source.close();
  const source = new EventSource('/chatdsh/gateway/events');
  state.source = source;
  source.onopen = () => {
    const link = byId('link-state');
    link.textContent = '已连接';
    link.className = 'pill ok';
    telemetry.action('sse-open', 'ok');
  };
  source.onerror = () => {
    const link = byId('link-state');
    link.textContent = '连接中断，正在重连';
    link.className = 'pill warn';
    telemetry.failure('sse', new Error('connection-error'));
  };
  source.onmessage = (message) => {
    const event = JSON.parse(message.data);
    const before = approvalTotalOf(state.badges);
    state.badges = reduceApprovalBadge(state.badges, event);
    const after = approvalTotalOf(state.badges);
    if (before !== after) renderBadge();
    if (event.kind === 'notification') {
      const items = Array.isArray(event.items) ? event.items : [];
      if (items.some((item) => item.kind === 'approval')) showToast('有新的审批请求', 'warn');
    }
    if (event.kind === 'notification-withdraw') showToast('审批提醒已撤回', 'muted');
    if (event.kind === 'replica' && state.selected !== null && event.sessionId === state.selected.session.sessionId) {
      void openReplica(state.selected.group, state.selected.session).catch((error) => {
        telemetry.failure('replica-refresh', error);
      });
    }
  };
}

function urlBase64ToUint8Array(value) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) output[index] = raw.charCodeAt(index);
  return output;
}

async function loadPushState() {
  const element = byId('push-state');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    element.textContent = '当前浏览器不支持 Web Push';
    return;
  }
  const data = await requestJson('/chatdsh/gateway/notifications/subscription?deviceId=' + encodeURIComponent(PAGE_DEVICE_ID));
  if (data.state === 'subscribed') element.textContent = '已订阅审批提醒';
  else if (data.permission === 'denied') element.textContent = '通知权限已被拒绝，请在浏览器设置中允许';
  else if (data.state === 'gone' || data.state === 'expired') element.textContent = '推送订阅已失效，请重新订阅';
  else element.textContent = '未订阅审批提醒';
}

async function subscribePush() {
  const element = byId('push-state');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    element.textContent = '当前浏览器不支持 Web Push';
    telemetry.failure('push-subscribe', new Error('push-unsupported'));
    return;
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    element.textContent = permission === 'denied' ? '通知权限已被拒绝，请在浏览器设置中允许' : '未授予通知权限';
    telemetry.action('push-subscribe', 'denied');
    return;
  }
  const registration = await navigator.serviceWorker.ready;
  const keyData = await requestJson('/chatdsh/gateway/notifications/vapid');
  if (typeof keyData.publicKey !== 'string' || keyData.publicKey === '') {
    element.textContent = '服务端没有可用的推送公钥';
    telemetry.failure('push-subscribe', new Error('vapid-missing'));
    return;
  }
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(keyData.publicKey),
  });
  const json = subscription.toJSON();
  await requestJson('/chatdsh/gateway/notifications/subscription', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      deviceId: PAGE_DEVICE_ID,
      clientId: PAGE_DEVICE_ID,
      endpoint: json.endpoint,
      keys: json.keys,
      permission: permission,
    }),
  });
  element.textContent = '已订阅审批提醒';
  telemetry.action('push-subscribe', 'ok');
}

async function unsubscribePush() {
  const element = byId('push-state');
  if (!('serviceWorker' in navigator)) {
    element.textContent = '当前浏览器不支持 Web Push';
    return;
  }
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription !== null) await subscription.unsubscribe();
  await requestJson('/chatdsh/gateway/notifications/subscription?deviceId=' + encodeURIComponent(PAGE_DEVICE_ID), {
    method: 'DELETE',
  });
  element.textContent = '已关闭审批提醒';
  telemetry.action('push-unsubscribe', 'ok');
}

byId('replica-close').addEventListener('click', () => {
  state.selected = null;
  state.events = [];
  state.timeline = null;
  byId('replica-section').hidden = true;
});

byId('replica-import').addEventListener('click', () => {
  void continueHere().catch((error) => {
    telemetry.failure('import-continue', error);
    showToast('本机继续失败：' + (error.code || error.message), 'error');
  });
});

byId('draft-input').addEventListener('input', () => {
  updateComposer();
  if (state.draftTimer !== 0) clearTimeout(state.draftTimer);
  state.draftTimer = setTimeout(() => {
    state.draftTimer = 0;
    void saveDraft().catch((error) => {
      telemetry.failure('draft-save', error);
      setStatus('draft-status', '草稿保存失败：' + (error.code || error.message), 'error');
    });
  }, 250);
});

byId('draft-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void sendDraft().catch((error) => {
    telemetry.failure('draft-send', error);
    showToast('发送草稿失败：' + (error.code || error.message), 'error');
  });
});

byId('push-subscribe').addEventListener('click', () => {
  void subscribePush().catch((error) => {
    telemetry.failure('push-subscribe', error);
    byId('push-state').textContent = '订阅失败：' + (error.code || error.message);
  });
});

byId('push-unsubscribe').addEventListener('click', () => {
  void unsubscribePush().catch((error) => {
    telemetry.failure('push-unsubscribe', error);
    byId('push-state').textContent = '关闭订阅失败：' + (error.code || error.message);
  });
});

window.addEventListener('online', () => {
  showToast('网络已恢复', 'ok');
  updateComposer();
  void loadAll().catch((error) => telemetry.failure('refresh', error));
});

window.addEventListener('offline', () => {
  showToast('网络已断开，草稿保存在本机', 'warn');
  updateComposer();
});

window.addEventListener('error', (event) => {
  telemetry.failure('page', event.error === undefined ? new Error(event.message) : event.error);
});

window.addEventListener('unhandledrejection', (event) => {
  telemetry.failure('page', event.reason);
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('__SERVICE_WORKER__').catch((error) => {
    telemetry.failure('service-worker', error);
  });
}

telemetry.boot(6, 'ok');
void loadAll()
  .then(() => Promise.all([loadPushState(), Promise.resolve(subscribeEvents())]))
  .catch((error) => {
    telemetry.failure('boot', error);
    showToast('加载失败：' + (error.code || error.message), 'error');
  });
`;

function sharedScript(): string {
  return [
    `const EMPTY_APPROVAL_BADGES = ${JSON.stringify(EMPTY_APPROVAL_BADGES)};`,
    `const DRAFT_DB_NAME = ${JSON.stringify(DRAFT_DB_NAME)};`,
    `const DRAFT_DB_VERSION = ${JSON.stringify(DRAFT_DB_VERSION)};`,
    `const DRAFT_STORE_NAME = ${JSON.stringify(DRAFT_STORE_NAME)};`,
    `const DRAFT_LEGACY_STORE_NAME = ${JSON.stringify(DRAFT_LEGACY_STORE_NAME)};`,
    `const DRAFT_TEXT_MAX = ${JSON.stringify(DRAFT_TEXT_MAX)};`,
    `const DRAFT_KEY_PREFIX = ${JSON.stringify(DRAFT_KEY_PREFIX)};`,
    `const DRAFT_SESSION_MAX = ${JSON.stringify(DRAFT_SESSION_MAX)};`,
    `const BROWSER_RELAY_PATH = ${JSON.stringify(BROWSER_RELAY_PATH)};`,
    `const BROWSER_RELAY_SIGNAL_HEADER = ${JSON.stringify(BROWSER_RELAY_SIGNAL_HEADER)};`,
    `const BROWSER_RELAY_CSRF_HEADER = ${JSON.stringify(BROWSER_RELAY_CSRF_HEADER)};`,
    buildReplicaTimeline.toString(),
    reduceApprovalBadge.toString(),
    approvalCountOf.toString(),
    approvalTotalOf.toString(),
    draftKeyOf.toString(),
    normalizeDraftRecord.toString(),
    draftRecordOf.toString(),
    migrateLegacyDraft.toString(),
    draftUpgradePlan.toString(),
    createIndexedDbDraftStore.toString(),
    createPwaPageTelemetry.toString(),
  ].join('\n');
}

/**
 * 渲染根路径的 PWA 页面。
 * @param options - 版本与浏览器设备标识。
 * @returns 单文件 HTML。
 */
export function renderPwaIndexHtml(options: PwaIndexOptions): string {
  const script = [
    sharedScript(),
    PAGE_SCRIPT
      .replace('__DEVICE_ID__', JSON.stringify(options.deviceId))
      .replace('__SERVICE_WORKER__', JSON.stringify(PWA_SERVICE_WORKER_PATH)),
  ].join('\n');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <meta name="theme-color" content="#0e0e10" />
  <link rel="manifest" href="${PWA_MANIFEST_PATH}" />
  <title>ChatDSH 中继入口</title>
  <style>${PAGE_STYLE}</style>
</head>
<body>
  <header>
    <div>
      <h1>ChatDSH</h1>
      <span class="version">Relay v${options.version}</span>
    </div>
    <div class="header-status">
      <span id="link-state" class="pill warn">连接中</span>
      <span id="approval-badge" class="badge" hidden>0</span>
    </div>
  </header>
  <main>
    <section class="card" id="devices-section">
      <h2>已连接设备</h2>
      <div id="devices-list">加载中…</div>
    </section>
    <section class="card" id="sessions-section">
      <h2>会话与离线只读副本</h2>
      <div id="sessions-list">加载中…</div>
    </section>
    <section class="card" id="approvals-section" hidden>
      <h2>待审批</h2>
      <div id="approvals-list"></div>
    </section>
    <section class="card" id="replica-section" hidden>
      <div class="replica-head">
        <div>
          <h2 id="replica-title">只读副本</h2>
          <span id="replica-state" class="pill warn">设备离线 · 只读副本</span>
        </div>
        <div class="actions">
          <button id="replica-import" type="button" class="btn">在本机继续</button>
          <button id="replica-close" type="button" class="btn ghost">关闭</button>
        </div>
      </div>
      <div id="replica-timeline" class="timeline"></div>
      <details class="raw" id="replica-raw-wrap">
        <summary>原始事件</summary>
        <pre id="replica-raw"></pre>
      </details>
      <form id="draft-form" class="composer" hidden>
        <label for="draft-input">草稿</label>
        <textarea id="draft-input" rows="3" placeholder="输入消息；离线时保存在本机"></textarea>
        <div class="composer-row">
          <span id="draft-status" class="status-text"></span>
          <button id="draft-send" type="submit" class="btn">发送</button>
        </div>
      </form>
    </section>
    <section class="card" id="push-section">
      <h2>审批提醒推送</h2>
      <p id="push-state" class="muted">检查订阅状态…</p>
      <div class="actions">
        <button id="push-subscribe" type="button" class="btn">开启推送</button>
        <button id="push-unsubscribe" type="button" class="btn ghost">关闭推送</button>
      </div>
    </section>
  </main>
  <div id="toast" class="toast" hidden></div>
  <script>${script}</script>
</body>
</html>`;
}
