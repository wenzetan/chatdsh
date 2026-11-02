/**
 * 设置增强包的浏览器侧入口。
 *
 * 三个区段挂在设置页的 `settings.section` 席位上：通用设置、运行设置与插件。数据入口直接
 * 调用宿主界面的同源接口（`/api/<命名空间>/<方法>` 与 `/chatdsh/device/settings/*`），
 * 每次调用记一个 span，失败再记一条错误事件与计数。区段的组件也可以单独取用，测试与嵌入
 * 场景自己构造数据入口。
 * @module @chatdsh/host-settings-enhancements/client
 */

import { createHttpCaller } from './transport.ts';
import { createSettingsGateway } from './settings.ts';
import { createPluginGateway } from './plugins.ts';
import { createPanelTelemetry } from './telemetry.ts';
import { GeneralSettingsSection, PluginsSection, RuntimeSettingsSection } from './views.tsx';
import { installMotionStyles } from './appearance.ts';
import type { PluginGateway, SettingsGateway } from './types.ts';

export { createHttpCaller } from './transport.ts';
export { createSettingsGateway, GENERAL_FIELDS, RUNTIME_FIELDS, scopeOfField, checkDraft, patchOf, textOfValue, readFieldValue } from './settings.ts';
export { createPluginGateway, INSTALL_UNSUPPORTED_REASON } from './plugins.ts';
export { createPanelTelemetry } from './telemetry.ts';
export { applyMotionPreference, installMotionStyles, MOTION_ATTRIBUTE } from './appearance.ts';
export {
  GENERAL_SECTION_TITLE,
  PLUGINS_SECTION_TITLE,
  RUNTIME_SECTION_TITLE,
  GeneralSettingsSection,
  PluginsSection,
  RuntimeSettingsSection,
  SettingsSection,
  fieldIdOf,
} from './views.tsx';
export { SettingsCallError } from './types.ts';
export type * from './types.ts';

/** 设置页区段席位名。 */
export const SECTION_SLOT = 'settings.section';

/** 通用设置区段标识。 */
export const GENERAL_SECTION_ID = 'chatdsh-settings-general';

/** 运行设置区段标识。 */
export const RUNTIME_SECTION_ID = 'chatdsh-settings-runtime';

/** 插件区段标识。 */
export const PLUGINS_SECTION_ID = 'chatdsh-settings-plugins';

/** 浏览器侧依赖：只等席位服务。 */
export const inject = ['slots'];

/** 席位服务的最小形状。 */
interface ClientSlots {
  inject(key: string, callback: () => () => void): () => void;
  register(
    spec: { name: string; id?: string; order?: number; label?: () => string; locale?: string },
    Component: () => unknown,
  ): () => void;
}

/** 浏览器侧上下文。 */
interface ClientFace {
  readonly slots: ClientSlots;
}

/** 一套数据入口。 */
export interface SettingsGateways {
  /** 设置服务入口。 */
  readonly settings: SettingsGateway;
  /** 插件清单入口。 */
  readonly plugins: PluginGateway;
  /** 界面动作与调用的上报面。 */
  readonly telemetry: { action(action: string, outcome: 'ok' | 'failed'): void };
}

/**
 * 构造两个数据入口，每个调用都经过遥测。
 * @param fetchImpl - 发请求的实现；缺省用全局 `fetch`。
 * @returns 数据入口。
 */
export function createGateways(fetchImpl: typeof fetch = globalThis.fetch): SettingsGateways {
  const caller = createHttpCaller({ fetchImpl });
  const telemetry = createPanelTelemetry({ fetchImpl });
  const traced = {
    call<T>(endpoint: string, args: Readonly<Record<string, unknown>>): Promise<T> {
      return telemetry.run(endpoint, () => caller.call<T>(endpoint, args));
    },
  };
  return {
    settings: createSettingsGateway({ caller: traced, fetchImpl }),
    plugins: createPluginGateway(traced),
    telemetry,
  };
}

/** 由两个数据入口渲染的区段集合；测试与嵌入场景直接取用。 */
export function SettingsEnhancementsPage({ gateways }: { readonly gateways: SettingsGateways }) {
  return (
    <>
      <GeneralSettingsSection gateway={gateways.settings} onAction={gateways.telemetry.action} />
      <RuntimeSettingsSection gateway={gateways.settings} onAction={gateways.telemetry.action} />
      <PluginsSection gateway={gateways.plugins} onAction={gateways.telemetry.action} />
    </>
  );
}

/**
 * 注册三个设置页区段。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientFace): void {
  installMotionStyles();
  const gateways = createGateways();
  ctx.slots.inject(SECTION_SLOT, () => ctx.slots.register({
    name: SECTION_SLOT,
    id: GENERAL_SECTION_ID,
    order: 40,
    label: () => '通用设置',
    locale: 'chatdsh.settings-enhancements',
  }, () => <GeneralSettingsSection gateway={gateways.settings} onAction={gateways.telemetry.action} />));
  ctx.slots.inject(SECTION_SLOT, () => ctx.slots.register({
    name: SECTION_SLOT,
    id: RUNTIME_SECTION_ID,
    order: 41,
    label: () => '运行设置',
    locale: 'chatdsh.settings-enhancements',
  }, () => <RuntimeSettingsSection gateway={gateways.settings} onAction={gateways.telemetry.action} />));
  ctx.slots.inject(SECTION_SLOT, () => ctx.slots.register({
    name: SECTION_SLOT,
    id: PLUGINS_SECTION_ID,
    order: 42,
    label: () => '插件',
    locale: 'chatdsh.settings-enhancements',
  }, () => <PluginsSection gateway={gateways.plugins} onAction={gateways.telemetry.action} />));
}
