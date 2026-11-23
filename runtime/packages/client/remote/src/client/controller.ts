/**
 * 远程设备面板的状态机。
 *
 * 组件只读 `getSnapshot()` 并订阅变化；全部网络读取都在这里完成。中继不可达时
 * 快照进入 `disconnected` 状态，界面显示「中继未连接」，已有数据保留。
 * @module @chatdsh/client-remote/controller
 */

import { RemoteGateway } from './api.ts';
import { forkOnHost } from './import-service.ts';
import {
  buildOverview,
  buildReplicaView,
  completeTurnOf,
  forkRecordsOf,
  type OverviewSession,
  type ReplicaEvent,
} from './model.ts';
import { classifyRelayFailure, deviceHostPrefix, errorCodeOf } from './state.ts';
import { normalizeControlUrl } from './control-url.ts';
import { readControlUrl, writeControlUrl } from './storage.ts';
import type { RemoteTelemetry } from './telemetry.ts';
import type {
  ClientContext,
  ForkInput,
  ForkOutcome,
  ReplicaSelection,
  RemoteSettingsSnapshot,
  RemoteSnapshot,
  TelemetrySettingState,
} from './types.ts';

/** 控制器读取浏览器全局对象的覆盖点，供测试与嵌入式宿主使用。 */
export interface RemoteControllerOptions {
  /** 当前文档路径；缺省读取 `location.pathname`。 */
  readonly pathname?: () => string;
}

/** 一次设置读取的结果。 */
interface SettingRead<T> {
  readonly value: T | null;
  readonly error: string | null;
}

/** 生成一个 UUID v4；自定义协议下没有 `randomUUID` 时按同一格式构造。 */
function newSessionId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 远程设备面板的控制器。 */
export class RemoteController {
  private snapshotValue: RemoteSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly gateway: RemoteGateway;
  private controlUrlValue: string;
  private replicaEvents: readonly ReplicaEvent[] = [];
  private overviewStarted = false;
  private settingsStarted = false;
  private refreshGeneration = 0;
  private settingsGeneration = 0;
  private replicaGeneration = 0;
  private disposed = false;

  constructor(
    private readonly ctx: ClientContext,
    private readonly telemetry: RemoteTelemetry,
    private readonly options: RemoteControllerOptions = {},
  ) {
    let controlUrl = '';
    let notice: RemoteSnapshot['notice'] = null;
    const stored = readControlUrl();
    if (stored !== '') {
      try {
        controlUrl = normalizeControlUrl(stored);
      } catch (error) {
        notice = { kind: 'error', code: errorCodeOf(error) };
        writeControlUrl('');
      }
    }
    this.controlUrlValue = controlUrl;
    this.gateway = new RemoteGateway(() => this.controlUrlValue, () => this.hostBase(), telemetry);
    const settings: RemoteSettingsSnapshot = {
      controlUrl,
      identity: null,
      identityError: null,
      telemetry: null,
      telemetryError: null,
      loading: false,
    };
    this.snapshotValue = {
      relay: { state: 'checking' },
      devices: [],
      sessions: [],
      loadingOverview: false,
      overviewError: null,
      replica: null,
      settings,
      pairing: null,
      notice,
    };
  }

  /** 当前快照。 */
  getSnapshot(): RemoteSnapshot {
    return this.snapshotValue;
  }

  /**
   * 订阅快照变化。
   * @param listener - 变化回调。
   * @returns 取消订阅。
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 第一次需要设备列表时读取中继；重复调用不重复发起。 */
  ensureOverview(): void {
    if (this.overviewStarted) return;
    this.overviewStarted = true;
    void this.refresh();
  }

  /** 重新读取设备与会话。 */
  async refresh(): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.refreshGeneration;
    this.overviewStarted = true;
    this.patch({ loadingOverview: true, overviewError: null, relay: { state: 'checking' } });
    try {
      const [devices, sessions] = await Promise.all([this.gateway.devices(), this.gateway.sessions()]);
      if (generation !== this.refreshGeneration) return;
      const overview = buildOverview(devices.devices, sessions.devices);
      this.patch({
        relay: { state: 'connected' },
        devices: overview.devices,
        sessions: overview.sessions,
        loadingOverview: false,
        overviewError: null,
      });
      this.telemetry.action('devices.refresh', 'ok');
    } catch (error) {
      if (generation !== this.refreshGeneration) return;
      const relay = classifyRelayFailure(error);
      this.patch({
        relay,
        loadingOverview: false,
        overviewError: relay.state === 'disconnected' ? relay.code : null,
      });
      this.telemetry.action('devices.refresh', 'failed');
    }
  }

  /** 第一次打开设置区段时读取本机状态；重复调用不重复发起。 */
  ensureSettings(): void {
    if (this.settingsStarted) return;
    this.settingsStarted = true;
    void this.refreshSettings();
  }

  /** 重新读取本机设备标识与遥测开关。 */
  async refreshSettings(): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.settingsGeneration;
    this.settingsStarted = true;
    this.patch({ settings: { ...this.snapshotValue.settings, loading: true, identityError: null, telemetryError: null } });
    const [identity, telemetry] = await Promise.all([this.readIdentity(), this.readTelemetry()]);
    if (generation !== this.settingsGeneration) return;
    this.patch({
      settings: {
        ...this.snapshotValue.settings,
        loading: false,
        identity: identity.value,
        identityError: identity.error,
        telemetry: telemetry.value,
        telemetryError: telemetry.error,
      },
    });
  }

  /**
   * 打开一条会话的只读副本。
   * @param session - 会话行。
   */
  async openReplica(session: OverviewSession): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.replicaGeneration;
    const selection: ReplicaSelection = {
      session,
      deviceOnline: session.online,
      items: [],
      loading: true,
      error: null,
      forking: false,
      fork: null,
      forkError: null,
      turnTo: 0,
      canFork: false,
    };
    this.replicaEvents = [];
    this.patch({ replica: selection, notice: null });
    try {
      const payload = await this.gateway.replica(session.sessionId);
      if (generation !== this.replicaGeneration || this.snapshotValue.replica?.session.sessionId !== session.sessionId) return;
      const events = payload.events;
      const turnTo = completeTurnOf(events);
      const canFork = turnTo > 0 && events.every((event) => event.payload !== undefined);
      this.replicaEvents = events;
      this.patch({
        replica: { ...selection, items: buildReplicaView(events), loading: false, turnTo, canFork },
      });
      this.telemetry.action('replica.open', 'ok');
    } catch (error) {
      if (generation !== this.replicaGeneration || this.snapshotValue.replica?.session.sessionId !== session.sessionId) return;
      this.patch({ replica: { ...selection, loading: false, error: errorCodeOf(error) } });
      this.telemetry.action('replica.open', 'failed');
    }
  }

  /** 关闭只读副本。 */
  closeReplica(): void {
    this.replicaGeneration += 1;
    this.replicaEvents = [];
    this.patch({ replica: null });
    this.telemetry.action('replica.close', 'ok');
  }

  /** 把当前只读副本在本机分叉成新会话。 */
  async forkReplica(): Promise<void> {
    const selection = this.snapshotValue.replica;
    if (selection === null || selection.loading || selection.forking || !selection.canFork) return;
    const home = this.ctx.remote.$host.home;
    const cwd = home !== undefined && home !== '' ? home : selection.session.cwd;
    if (cwd === '') {
      this.patch({ replica: { ...selection, forkError: 'cwd-unavailable' } });
      this.telemetry.action('replica.fork', 'unavailable');
      return;
    }
    const input: ForkInput = {
      sessionId: newSessionId(),
      cwd,
      records: forkRecordsOf(this.replicaEvents),
      sourceSessionId: selection.session.sessionId,
      sourceDeviceId: selection.session.deviceId,
      turnTo: selection.turnTo,
      importMode: 'full-prefix',
      availableAttachmentIds: [],
      scheduledTasks: 0,
    };
    this.patch({ replica: { ...selection, forking: true, forkError: null, fork: null } });
    try {
      const outcome = await this.telemetry.call<ForkOutcome>('import.fork', () => forkOnHost(this.ctx, input));
      if (this.snapshotValue.replica?.session.sessionId !== selection.session.sessionId) {
        this.patch({ notice: { kind: 'ok', code: 'fork.created', detail: outcome.sessionId } });
        this.telemetry.action('replica.fork', 'ok');
        return;
      }
      this.patch({
        replica: { ...selection, forking: false, fork: outcome, forkError: null },
        notice: { kind: 'ok', code: 'fork.created', detail: outcome.sessionId },
      });
      this.telemetry.action('replica.fork', 'ok');
    } catch (error) {
      if (this.snapshotValue.replica?.session.sessionId !== selection.session.sessionId) {
        this.telemetry.action('replica.fork', 'failed');
        return;
      }
      this.patch({ replica: { ...selection, forking: false, fork: null, forkError: errorCodeOf(error) } });
      this.telemetry.action('replica.fork', 'failed');
    }
  }

  /**
   * 保存中继地址并立即重新读取设备。
   * @param value - 用户输入的地址；空字符串表示同源根路径。
   */
  saveControlUrl(value: string): void {
    let normalized: string;
    try {
      normalized = normalizeControlUrl(value);
    } catch (error) {
      this.patch({ notice: { kind: 'error', code: errorCodeOf(error) } });
      this.telemetry.failure('controlUrl.save', error);
      return;
    }
    this.controlUrlValue = normalized;
    writeControlUrl(normalized);
    this.patch({
      settings: { ...this.snapshotValue.settings, controlUrl: normalized },
      notice: { kind: 'ok', code: 'control-url.saved' },
    });
    this.telemetry.action('controlUrl.save', 'ok');
    void this.refresh();
  }

  /**
   * 用一次性配对码登记一台执行节点。
   * @param code - 一次性配对码。
   */
  async pair(code: string): Promise<void> {
    const trimmed = code.trim();
    if (trimmed === '') {
      this.patch({ pairing: { error: 'pairing-code-required' } });
      this.telemetry.action('device.pair', 'rejected');
      return;
    }
    this.patch({ pairing: null });
    try {
      const payload = await this.gateway.pair(trimmed, this.deviceName(), this.devicePlatform());
      this.patch({ pairing: { deviceId: payload.deviceId, token: payload.token } });
      this.telemetry.action('device.pair', 'ok');
    } catch (error) {
      this.patch({ pairing: { error: errorCodeOf(error) } });
      this.telemetry.action('device.pair', 'failed');
    }
  }

  /** 清空界面提示。 */
  clearNotice(): void {
    this.patch({ notice: null });
  }

  /** 清空配对结果，避免令牌继续留在内存与界面里。 */
  clearPairing(): void {
    this.patch({ pairing: null });
  }

  /** 卸载控制器。 */
  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  private hostBase(): string {
    const pathname = this.options.pathname?.() ?? location.pathname;
    return deviceHostPrefix(pathname);
  }

  private patch(changes: Partial<RemoteSnapshot>): void {
    if (this.disposed) return;
    this.snapshotValue = { ...this.snapshotValue, ...changes };
    for (const listener of this.listeners) listener();
  }

  private async readIdentity(): Promise<SettingRead<string>> {
    try {
      const payload = await this.gateway.identity();
      return { value: payload.deviceId, error: null };
    } catch (error) {
      if (this.statusOf(error) === 404) return { value: null, error: 'not-found' };
      return { value: null, error: errorCodeOf(error) };
    }
  }

  private async readTelemetry(): Promise<SettingRead<TelemetrySettingState>> {
    try {
      const payload = await this.gateway.telemetryStatus();
      const reason = typeof payload.reason === 'string' && payload.reason !== '' ? payload.reason : undefined;
      return {
        value: payload.enabled === true ? { enabled: true } : { enabled: false, ...(reason === undefined ? {} : { reason }) },
        error: null,
      };
    } catch (error) {
      if (this.statusOf(error) === 403) return { value: null, error: 'loopback-only' };
      return { value: null, error: errorCodeOf(error) };
    }
  }

  private statusOf(error: unknown): number | undefined {
    if (typeof error !== 'object' || error === null) return undefined;
    const status = (error as { readonly status?: unknown }).status;
    return typeof status === 'number' ? status : undefined;
  }

  private deviceName(): string {
    if (typeof document === 'undefined') return 'DSH Web';
    const title = document.title.trim();
    return title === '' ? 'DSH Web' : title;
  }

  private devicePlatform(): string {
    if (typeof navigator === 'undefined') return 'web';
    return navigator.userAgent.includes('Electron') ? 'desktop' : 'web';
  }
}
