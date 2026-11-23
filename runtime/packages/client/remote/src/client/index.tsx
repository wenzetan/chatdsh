/**
 * 客户端远程设备插件的浏览器侧入口。
 *
 * 通过官方 slots 服务注册一个侧栏入口、一个主面板、一个设置区段与对话顶部的
 * 远程执行状态条；宿主导入服务通过 `$mount` 挂到 `chatdshImport` 命名空间，
 * 「在本机继续」调用真实的 `chatdshImport.fork`。
 * @module @chatdsh/client-remote/client
 */

import { RemoteController } from './controller.ts';
import { PanelIcon } from './icon.tsx';
import { importContribution } from './import-service.ts';
import { en, zh } from './locales.ts';
import { PanelPage } from './panel.tsx';
import { SettingsSection } from './settings.tsx';
import { RemoteStatusBar } from './status-bar.tsx';
import { installRemoteStyles } from './styles.ts';
import { createRemoteTelemetry } from './telemetry.ts';
import type { ClientContext } from './types.ts';

/** 本插件的语言命名空间。 */
export const NS = 'chatdshRemote';

/** 侧栏入口与主面板共用的标识。 */
export const PANEL_ID = 'chatdsh-remote';

/** 需要的宿主服务。 */
export const inject = ['slots', 'layout', 'locale', 'remote'];

/**
 * 安装界面与宿主导入服务的客户端贡献。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  if (typeof document !== 'undefined') installRemoteStyles(document);
  const telemetry = createRemoteTelemetry();
  const controller = new RemoteController(ctx, telemetry);
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'chatdsh-remote: dictionaries');
  const t = ctx.locale.bind(NS);
  ctx.effect(() => ctx.remote.$mount(importContribution()), 'chatdsh-remote: import remote');
  ctx.effect(() => () => controller.dispose(), 'chatdsh-remote: controller');
  ctx.slots.inject('main', function* () {
    yield ctx.slots.register({
      name: 'main',
      key: PANEL_ID,
      locale: NS,
      inject: () => ({ controller }),
    }, PanelPage);
  });
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 30,
    label: () => t('panel'),
    locale: NS,
  }, PanelIcon));
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'chatdsh-remote',
    order: 40,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({ controller }),
  }, SettingsSection));
  ctx.slots.inject('conversation.header.leading', () => ctx.slots.register({
    name: 'conversation.header.leading',
    locale: NS,
    inject: () => ({ controller }),
  }, RemoteStatusBar));
}
