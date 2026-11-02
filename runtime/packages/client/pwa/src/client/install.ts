/**
 * 安装入口与可安装性检查。
 *
 * 检查按真实环境取值：清单从网络读取并解析，Service Worker 状态取自注册句柄，显示模式取自
 * 媒体查询。浏览器提供 `beforeinstallprompt` 时保存该事件，由用户在界面点击后触发安装提示；
 * 没有该事件时说明需要在浏览器菜单里手动安装。安装结果只来自浏览器的 `userChoice`。
 * @module @chatdsh/client-pwa/install
 */

import {
  checkInstallability,
  parseManifest,
  type InstallabilityReport,
  type InstallabilityServiceWorker,
  type WebAppManifest,
} from './manifest.ts';
import type { PwaTelemetry } from './telemetry.ts';

/** 浏览器安装提示事件的最小形状。 */
interface BeforeInstallPromptLike extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ readonly outcome: 'accepted' | 'dismissed' }>;
}

/** 安装状态。 */
export interface InstallState {
  /** 是否已经以独立窗口运行。 */
  readonly installed: boolean;
  /** 浏览器是否已经提供安装提示。 */
  readonly canPrompt: boolean;
  /** 上一次安装动作的结果。 */
  readonly outcome?: 'accepted' | 'dismissed';
  /** 无法弹出提示的原因。 */
  readonly reason?: 'prompt-not-offered';
}

/** 安装句柄。 */
export interface InstallHandle {
  /** 读取当前安装状态。 */
  state(): InstallState;
  /** 触发浏览器安装提示。 */
  prompt(): Promise<InstallState>;
  /** 重新执行可安装性检查。 */
  check(): Promise<InstallabilityReport>;
}

/** 安装句柄的构造依赖。 */
export interface InstallOptions {
  /** 清单地址。 */
  readonly manifestPath: string;
  /** 期望的清单对象，用于对照服务端返回的内容。 */
  readonly manifest: WebAppManifest;
  readonly telemetry: PwaTelemetry;
  readonly window: Window;
  readonly fetchImpl: typeof fetch;
  /** 读取 Service Worker 状态的函数。 */
  readonly serviceWorkerState: () => InstallabilityServiceWorker;
}

/**
 * 建立安装句柄。
 * @param options - 清单地址、遥测与浏览器对象。
 * @returns 安装句柄。
 */
export function createInstallHandle(options: InstallOptions): InstallHandle {
  const win = options.window;
  const telemetry = options.telemetry;
  let deferred: BeforeInstallPromptLike | undefined;
  let outcome: 'accepted' | 'dismissed' | undefined;
  let installed = win.matchMedia('(display-mode: standalone)').matches;

  win.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferred = event as BeforeInstallPromptLike;
  });
  win.addEventListener('appinstalled', () => {
    installed = true;
    deferred = undefined;
  });

  return {
    state(): InstallState {
      return deferred === undefined
        ? { installed, canPrompt: false, ...(outcome === undefined ? {} : { outcome }), reason: 'prompt-not-offered' }
        : { installed, canPrompt: true, ...(outcome === undefined ? {} : { outcome }) };
    },

    async prompt(): Promise<InstallState> {
      if (deferred === undefined) {
        telemetry.action('install-prompt', 'unavailable');
        return { installed, canPrompt: false, outcome, reason: 'prompt-not-offered' };
      }
      const event = deferred;
      deferred = undefined;
      await event.prompt();
      const choice = await event.userChoice;
      outcome = choice.outcome;
      telemetry.action('install-prompt', outcome === 'accepted' ? 'ok' : 'rejected');
      return { installed, canPrompt: false, outcome };
    },

    async check(): Promise<InstallabilityReport> {
      const response = await options.fetchImpl(options.manifestPath, { cache: 'reload' });
      const text = await response.text();
      let served: WebAppManifest | undefined;
      try {
        served = parseManifest(text);
      } catch {
        served = undefined;
      }
      const serviceWorker = options.serviceWorkerState();
      const startUrl = new URL(served?.start_url ?? '/', win.location.href).href;
      const displayMode = win.matchMedia('(display-mode: standalone)').matches ? 'standalone' : 'browser';
      const report = checkInstallability({
        manifest: served,
        manifestStatus: response.status,
        manifestContentType: response.headers.get('content-type') ?? '',
        secureContext: win.isSecureContext,
        serviceWorker,
        displayMode,
        startUrl,
      });
      telemetry.action('install-check', report.installable ? 'ok' : 'failed');
      return report;
    },
  };
}
