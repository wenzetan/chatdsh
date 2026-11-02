/**
 * PWA 运行时：把清单、Service Worker、权限、凭据、草稿与移动布局装成一份。
 *
 * 启动顺序固定：先记录模块装填、保存已保留的导航元数据，再注册 Service Worker，最后记录一次
 * 启动 span。设备凭据在启动时打开受保护的存储；浏览器缺少 WebCrypto 或 IndexedDB 时退回
 * 内存并保留原因。在线状态取自浏览器，发送动作按在线状态判定，离线时被拒绝且不排队。
 * @module @chatdsh/client-pwa/runtime
 */

import { defaultCacheRules, type CacheRules } from './cache-policy.ts';
import {
  clearDraft,
  clientIdentity,
  readDraft,
  saveDraft,
  submitDraft,
  resolveWindowIdentity,
  type DraftIdentity,
  type DraftWriteResult,
  type OfflineDraft,
  type SendResult,
} from './drafts.ts';
import { createInstallHandle, type InstallHandle } from './install.ts';
import { buildManifest, type InstallabilityReport, type WebAppManifest } from './manifest.ts';
import { createMobileLayout, type MobileLayout } from './mobile-layout.ts';
import { readNavigationMeta, saveNavigationMeta, type NavigationMeta } from './offline.ts';
import { createPermissionClient, type PermissionClient } from './permissions.ts';
import { createPairingScanner, type PairingScanner, type ScanCapability } from './scanner.ts';
import { openCredentialStore, type CredentialStore } from './secure-storage.ts';
import { createServiceWorkerHandle, type ServiceWorkerHandle } from './service-worker-client.ts';
import { createPwaTelemetry, type PwaTelemetry } from './telemetry.ts';
import {
  DEFAULT_PROBE_PATH,
  DEFAULT_SCOPE,
  DEFAULT_SEND_ENDPOINT,
  MANIFEST_PATH,
  PWA_VERSION,
  SERVICE_WORKER_PATH,
} from './paths.ts';

/** 草稿句柄。 */
export interface DraftHandle {
  /** 当前草稿键。 */
  identity(): DraftIdentity;
  /** 读取草稿。 */
  read(): OfflineDraft | undefined;
  /** 保存草稿。 */
  save(input: unknown): DraftWriteResult;
  /** 清掉草稿。 */
  clear(): void;
}

/** PWA 运行时的的构造选项。 */
export interface PwaOptions {
  /** 清单地址。 */
  readonly manifestPath?: string;
  /** Service Worker 脚本地址。 */
  readonly serviceWorkerPath?: string;
  /** Service Worker 作用域。 */
  readonly scope?: string;
  /** 版本号；写入清单图标地址与 Service Worker 缓存名。 */
  readonly version?: string;
  /** 已保留的导航元数据。 */
  readonly navigation?: NavigationMeta;
  /** 草稿归属的设备与会话。 */
  readonly draft?: { readonly deviceId: string; readonly sessionId?: string };
  /** 发送目标地址。 */
  readonly sendEndpoint?: string;
  /** 可达性探测的地址。 */
  readonly probePath?: string;
  /** 切换新版本前的确认；返回假表示正在执行回合，不允许刷新。 */
  readonly canReload?: () => boolean;
  /** 遥测面覆盖。 */
  readonly telemetry?: PwaTelemetry;
  readonly fetchImpl?: typeof fetch;
  readonly navigator?: Navigator;
  readonly window?: Window;
  readonly document?: Document;
  readonly storage?: Storage;
  readonly sessionStorage?: Storage;
  readonly crypto?: Crypto;
  readonly indexedDB?: IDBFactory;
  readonly generateId?: () => string;
  readonly now?: () => number;
}

/** PWA 运行时。 */
export interface PwaRuntime {
  readonly version: string;
  readonly manifest: WebAppManifest;
  readonly rules: CacheRules;
  readonly install: InstallHandle;
  readonly serviceWorker: ServiceWorkerHandle;
  readonly permissions: PermissionClient;
  readonly credentials: CredentialStore;
  readonly layout: MobileLayout;
  readonly telemetry: PwaTelemetry;
  readonly scanner: PairingScanner;
  readonly scanCapability: ScanCapability;
  readonly drafts: DraftHandle;
  /** 读取已保留的导航元数据。 */
  navigation(): NavigationMeta | undefined;
  /** 保存导航元数据。 */
  setNavigation(meta: NavigationMeta): void;
  /** 当前是否在线。 */
  isOnline(): boolean;
  /** 最近一次可达性探测的结论；尚未探测时为 `undefined`。 */
  reachable(): boolean | undefined;
  /** 向探活端点发起一次真实请求，返回是否可达。 */
  probe(): Promise<boolean>;
  /** 重新执行可安装性检查。 */
  checkInstallability(): Promise<InstallabilityReport>;
  /** 提交一次草稿文本。 */
  submit(text: string): Promise<SendResult>;
  /** 启动：记录模块装填、保存导航元数据、注册 Service Worker。 */
  start(): Promise<void>;
}

/**
 * 生成随机十六进制标识。
 * @returns 32 位十六进制文本。
 */
function defaultGenerateId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * 建立 PWA 运行时。
 * @param options - 版本、路径、草稿归属与依赖覆盖。
 * @returns 运行时。
 */
export async function createPwa(options: PwaOptions = {}): Promise<PwaRuntime> {
  const win = options.window ?? window;
  const nav = options.navigator ?? navigator;
  const doc = options.document ?? document;
  const version = options.version ?? PWA_VERSION;
  const storage = options.storage ?? win.localStorage;
  const session = options.sessionStorage ?? win.sessionStorage;
  const generateId = options.generateId ?? defaultGenerateId;
  const now = options.now ?? (() => Date.now());
  const fetchImpl = options.fetchImpl ?? win.fetch.bind(win);
  const telemetry = options.telemetry ?? createPwaTelemetry({ fetchImpl, now });
  const manifest = buildManifest({ version });
  const rules = defaultCacheRules();
  const windowResolved = await resolveWindowIdentity({ session, storage, generate: generateId });
  const draftIdentity: DraftIdentity = {
    clientId: clientIdentity(storage, generateId),
    windowId: windowResolved.windowId,
    deviceId: options.draft?.deviceId ?? '',
    ...(options.draft?.sessionId === undefined ? {} : { sessionId: options.draft.sessionId }),
  };
  if (draftIdentity.deviceId === '') throw new Error('PWA 运行时需要草稿归属的设备标识');

  const layout = createMobileLayout({ window: win, document: doc, telemetry });
  const credentials = await openCredentialStore({
    ...(options.crypto === undefined ? {} : { crypto: options.crypto }),
    ...(options.indexedDB === undefined ? {} : { indexedDB: options.indexedDB }),
    telemetry,
  });
  const serviceWorker = createServiceWorkerHandle({
    scriptPath: options.serviceWorkerPath ?? SERVICE_WORKER_PATH,
    scope: options.scope ?? DEFAULT_SCOPE,
    telemetry,
    navigator: nav,
    window: win,
  });
  const install = createInstallHandle({
    manifestPath: options.manifestPath ?? MANIFEST_PATH,
    manifest,
    telemetry,
    window: win,
    fetchImpl,
    serviceWorkerState: () => {
      const state = serviceWorker.state();
      return {
        registered: state.registered,
        active: state.active,
        controlling: state.controlling,
        ...(state.scope === undefined ? {} : { scope: state.scope }),
      };
    },
  });
  const permissions = createPermissionClient({ telemetry, navigator: nav });
  const scanner = createPairingScanner({ navigator: nav, document: doc });

  const drafts: DraftHandle = {
    identity: () => draftIdentity,
    read: () => readDraft(storage, draftIdentity),
    save(input: unknown): DraftWriteResult {
      const result = saveDraft(storage, draftIdentity, input, now());
      telemetry.action('draft-save', result.outcome === 'saved' ? 'ok' : 'rejected');
      return result;
    },
    clear(): void {
      clearDraft(storage, draftIdentity);
    },
  };

  if (options.navigation !== undefined) saveNavigationMeta(storage, options.navigation);

  let lastReachable: boolean | undefined;

  const runtime: PwaRuntime = {
    version,
    manifest,
    rules,
    install,
    serviceWorker,
    permissions,
    credentials,
    layout,
    telemetry,
    scanner,
    scanCapability: scanner.capability,
    drafts,
    navigation: () => readNavigationMeta(storage),

    setNavigation(meta: NavigationMeta): void {
      saveNavigationMeta(storage, meta);
    },

    isOnline(): boolean {
      return nav.onLine;
    },

    reachable(): boolean | undefined {
      return lastReachable;
    },

    async probe(): Promise<boolean> {
      try {
        const response = await fetchImpl(options.probePath ?? DEFAULT_PROBE_PATH, { cache: 'no-store' });
        lastReachable = response.ok;
      } catch (error) {
        lastReachable = false;
        telemetry.failure('connection-probe', error);
      }
      telemetry.action('connection-probe', lastReachable ? 'ok' : 'unavailable');
      return lastReachable;
    },

    checkInstallability(): Promise<InstallabilityReport> {
      return install.check();
    },

    submit(text: string): Promise<SendResult> {
      return submitDraft({
        endpoint: options.sendEndpoint ?? DEFAULT_SEND_ENDPOINT,
        text,
        online: nav.onLine,
        fetchImpl,
        telemetry,
      });
    },

    async start(): Promise<void> {
      for (const moduleId of ['manifest', 'service-worker', 'permissions', 'secure-storage', 'drafts', 'layout']) {
        telemetry.moduleLoad(moduleId, 'ok');
      }
      await serviceWorker.register();
      await runtime.probe();
      telemetry.boot(6, 'ok');
    },
  };
  return runtime;
}
