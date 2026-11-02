/**
 * PWA 客户端插件的浏览器侧入口。
 *
 * 模块导出可安装壳所需的全部能力：清单构造与安装检查、Service Worker 源码生成、权限查询与
 * 请求、受保护的设备凭据、离线草稿、配对码手动输入与扫码能力、移动布局控制器、界面组件与
 * 遥测面。宿主在页面里放好 `#chatdsh-pwa` 容器后，`apply` 会把界面挂上去；WP39 接入静态
 * 资源路由与构建，本模块只提供内容。
 * @module @chatdsh/client-pwa/client
 */

import { createPwa, type PwaOptions, type PwaRuntime } from './runtime.ts';
import { installPwaStyles } from './styles.ts';
import { mountPwaUi, type PwaUi, type PwaUiOptions } from './ui.ts';

export * from './cache-policy.ts';
export * from './drafts.ts';
export * from './install.ts';
export * from './manifest.ts';
export * from './mobile-layout.ts';
export * from './offline.ts';
export * from './paths.ts';
export * from './permissions.ts';
export * from './runtime.ts';
export * from './scanner.ts';
export * from './secure-storage.ts';
export * from './service-worker.ts';
export * from './service-worker-client.ts';
export * from './styles.ts';
export * from './telemetry.ts';
export * from './ui.ts';

/** 浏览器侧不依赖其它客户端模块。 */
export const inject: string[] = [];

/** 挂载容器的标识。 */
export const ROOT_ID = 'chatdsh-pwa';

/** 启动选项：运行时选项与界面选项合在一起。 */
export type StartOptions = PwaOptions & PwaUiOptions;

/**
 * 安装样式、建立运行时、启动并挂载界面。
 * @param root - 挂载容器。
 * @param options - 路径、版本、草稿归属与界面选项。
 * @returns 界面句柄与运行时。
 */
export async function startPwa(root: Element, options: StartOptions = {}): Promise<PwaUi> {
  installPwaStyles(root.ownerDocument);
  const runtime: PwaRuntime = await createPwa(options);
  await runtime.start();
  return mountPwaUi(root, runtime, {
    ...(options.pairingEndpoint === undefined ? {} : { pairingEndpoint: options.pairingEndpoint }),
    ...(options.canReload === undefined ? {} : { canReload: options.canReload }),
  });
}

/**
 * 客户端插件入口：宿主页面有挂载容器时启动界面。
 * @param _ctx - 客户端根上下文；本插件不从中取服务。
 */
export function apply(_ctx: unknown): void {
  void _ctx;
  if (typeof document === 'undefined') return;
  const root = document.getElementById(ROOT_ID);
  if (root === null) return;
  void startPwa(root);
}
