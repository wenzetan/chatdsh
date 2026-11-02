/**
 * Service Worker 的注册与受控更新。
 *
 * 注册带 `updateViaCache: 'none'`，脚本每次都按网络版本比较。新版本装好后停在等待状态，
 * 界面提示用户保存草稿后确认；确认时向等待中的工作线程发 `SKIP_WAITING`，等接管完成再刷新
 * 页面。用户选择下次启动时不再发消息，新版本在浏览器下次启动接管。
 * @module @chatdsh/client-pwa/service-worker-client
 */

import type { PwaTelemetry } from './telemetry.ts';

/** 注册后的状态。 */
export interface ServiceWorkerState {
  /** 浏览器是否提供 Service Worker 接口。 */
  readonly supported: boolean;
  /** 是否安全来源。 */
  readonly secureContext: boolean;
  readonly registered: boolean;
  readonly active: boolean;
  /** 是否有等待接管的新版本。 */
  readonly waiting: boolean;
  readonly controlling: boolean;
  readonly scope?: string;
  /** 当前生效的版本号。 */
  readonly version?: string;
  /** 等待中的版本号。 */
  readonly waitingVersion?: string;
  /** 不可用或失败的原因。 */
  readonly reason?: 'unsupported' | 'insecure-context' | 'registration-failed';
}

/** Service Worker 的事件。 */
export type ServiceWorkerEvent = 'update-available' | 'state-change';

/** Service Worker 的句柄。 */
export interface ServiceWorkerHandle {
  /** 注册并等到激活。 */
  register(): Promise<ServiceWorkerState>;
  /** 读取当前状态。 */
  state(): ServiceWorkerState;
  /** 主动检查新版本。 */
  checkForUpdate(): Promise<ServiceWorkerState>;
  /** 用户确认后切换版本。 */
  applyUpdate(options?: { readonly reload?: boolean }): Promise<void>;
  /** 放弃本次切换，等下次启动。 */
  dismissUpdate(): void;
  /** 订阅事件。 */
  on(event: ServiceWorkerEvent, listener: () => void): () => void;
}

/** 句柄的构造依赖。 */
export interface ServiceWorkerHandleOptions {
  /** 脚本地址。 */
  readonly scriptPath: string;
  /** 作用域。 */
  readonly scope: string;
  readonly telemetry: PwaTelemetry;
  /** 浏览器导航对象。 */
  readonly navigator?: Navigator;
  /** 浏览器窗口对象。 */
  readonly window?: Window;
}

/** 查询工作线程版本的等待上限，单位毫秒。 */
const VERSION_TIMEOUT_MS = 1500;

/** 等待接管的上限，单位毫秒。 */
const CONTROL_TIMEOUT_MS = 10000;

/** 等待新版本安装完成的上限，单位毫秒。 */
const INSTALL_TIMEOUT_MS = 20000;

/**
 * 等待一个安装中的工作线程进入已安装或作废状态。
 * @param worker - 安装中的工作线程。
 * @returns 状态变化或等待超时后兑现。
 */
function waitForInstallSettled(worker: ServiceWorker): Promise<void> {
  if (worker.state === 'installed' || worker.state === 'redundant') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, INSTALL_TIMEOUT_MS);
    worker.addEventListener('statechange', () => {
      if (worker.state !== 'installed' && worker.state !== 'redundant') return;
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * 向一个工作线程查询版本号。
 * @param worker - 工作线程。
 * @returns 版本号；没有回应时为 `undefined`。
 */
function requestVersion(worker: ServiceWorker): Promise<string | undefined> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      resolve(undefined);
    }, VERSION_TIMEOUT_MS);
    channel.port1.onmessage = (event: MessageEvent<{ readonly version?: unknown }>) => {
      clearTimeout(timer);
      const version = event.data.version;
      resolve(typeof version === 'string' ? version : undefined);
    };
    worker.postMessage({ type: 'VERSION' }, [channel.port2]);
  });
}

/**
 * 建立 Service Worker 句柄。
 * @param options - 脚本地址、作用域与浏览器对象。
 * @returns 句柄。
 */
export function createServiceWorkerHandle(options: ServiceWorkerHandleOptions): ServiceWorkerHandle {
  const nav = options.navigator ?? navigator;
  const win = options.window ?? window;
  const telemetry = options.telemetry;
  const listeners = new Map<ServiceWorkerEvent, Set<() => void>>();
  let registration: ServiceWorkerRegistration | undefined;
  let waitingWorker: ServiceWorker | undefined;
  let current: ServiceWorkerState = {
    supported: nav.serviceWorker !== undefined,
    secureContext: win.isSecureContext,
    registered: false,
    active: false,
    waiting: false,
    controlling: false,
  };

  const emit = (event: ServiceWorkerEvent): void => {
    for (const listener of listeners.get(event) ?? []) listener();
  };

  /** 取当前状态快照。 */
  const snapshot = async (): Promise<ServiceWorkerState> => {
    if (registration === undefined) return current;
    const active = registration.active;
    const waiting = registration.waiting;
    waitingWorker = waiting ?? undefined;
    current = {
      ...current,
      registered: true,
      active: active !== null,
      waiting: waiting !== null,
      controlling: nav.serviceWorker.controller !== null,
      scope: registration.scope,
      version: active === null ? undefined : await requestVersion(active),
      waitingVersion: waiting === null ? undefined : await requestVersion(waiting),
    };
    return current;
  };

  /** 监听新版本与接管变化。 */
  const watch = (): void => {
    if (registration === undefined) return;
    registration.addEventListener('updatefound', () => {
      const installing = registration?.installing;
      if (installing === null || installing === undefined) return;
      installing.addEventListener('statechange', () => {
        if (installing.state !== 'installed') return;
        if (nav.serviceWorker.controller === null) return;
        void snapshot().then(() => {
          telemetry.action('sw-update-available', 'waiting');
          emit('update-available');
          emit('state-change');
        });
      });
    });
    nav.serviceWorker.addEventListener('controllerchange', () => {
      void snapshot().then(() => {
        emit('state-change');
      });
    });
  };

  return {
    async register(): Promise<ServiceWorkerState> {
      if (nav.serviceWorker === undefined) {
        current = { ...current, reason: 'unsupported' };
        telemetry.action('sw-register', 'unavailable');
        return current;
      }
      if (!win.isSecureContext) {
        current = { ...current, reason: 'insecure-context' };
        telemetry.action('sw-register', 'unavailable');
        return current;
      }
      try {
        registration = await nav.serviceWorker.register(options.scriptPath, {
          scope: options.scope,
          updateViaCache: 'none',
        });
        await nav.serviceWorker.ready;
      } catch (error) {
        current = { ...current, reason: 'registration-failed' };
        telemetry.failure('sw-register', error);
        return current;
      }
      await snapshot();
      watch();
      telemetry.action('sw-register', 'ok');
      return current;
    },

    state(): ServiceWorkerState {
      return current;
    },

    async checkForUpdate(): Promise<ServiceWorkerState> {
      if (registration === undefined) return current;
      await registration.update();
      const installing = registration.installing;
      if (installing !== null) await waitForInstallSettled(installing);
      await snapshot();
      if (current.waiting) {
        telemetry.action('sw-update-available', 'waiting');
        emit('update-available');
      }
      emit('state-change');
      return current;
    },

    async applyUpdate(userChoice: { readonly reload?: boolean } = {}): Promise<void> {
      const waiting = waitingWorker ?? registration?.waiting ?? undefined;
      if (waiting === undefined) {
        telemetry.action('sw-update-apply', 'rejected');
        return;
      }
      const controlled = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CONTROL_TIMEOUT_MS);
        nav.serviceWorker.addEventListener('controllerchange', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      waiting.postMessage({ type: 'SKIP_WAITING' });
      await controlled;
      telemetry.action('sw-update-apply', 'ok');
      if (userChoice.reload !== false) win.location.reload();
    },

    dismissUpdate(): void {
      waitingWorker = undefined;
      current = { ...current, waiting: false };
      telemetry.action('sw-update-later', 'ok');
    },

    on(event: ServiceWorkerEvent, listener: () => void): () => void {
      const bucket = listeners.get(event) ?? new Set();
      bucket.add(listener);
      listeners.set(event, bucket);
      return () => {
        bucket.delete(listener);
      };
    },
  };
}
