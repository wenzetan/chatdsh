/**
 * 插件清单与操作的数据入口。
 *
 * 清单来自宿主装载树：`pluginInventory/list` 给出每个条目的模块名、启用状态与生命周期阶段，
 * `pluginManager/listBundles` 给出组合包与它补丁层插入的行。启停与卸载直接调宿主插件管理
 * 服务；安装需要允许安装的来源清单（SYS07），宿主没有提供时界面明确说明并保持入口不可用。
 * @module @chatdsh/host-settings-enhancements/plugins
 */

import { SettingsCallError, type BundleView, type PluginEntryView, type PluginGateway, type RemoteCaller } from './types.ts';

/** 判一个取值是普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 读界面文案：上游给的是 `{en, zh}` 或字符串。 */
function titleOf(meta: unknown): string | undefined {
  if (!isRecord(meta)) return undefined;
  const title = meta.title;
  if (typeof title === 'string') return title;
  if (isRecord(title)) {
    if (typeof title.zh === 'string') return title.zh;
    if (typeof title.en === 'string') return title.en;
  }
  return undefined;
}

/** 解析插件行。 */
function pluginOf(value: unknown): PluginEntryView {
  if (!isRecord(value) || typeof value.entryId !== 'string' || typeof value.moduleName !== 'string') {
    throw new SettingsCallError('gateway/internal', '插件行的返回形状不符合约定');
  }
  return {
    entryId: value.entryId,
    moduleName: value.moduleName,
    enabled: value.enabled === true,
    ...(typeof value.fiberPhase === 'string' ? { fiberPhase: value.fiberPhase } : { fiberPhase: value.fiberPhase === null ? null : undefined }),
    ...(titleOf(value.meta) === undefined ? {} : { title: titleOf(value.meta) }),
    ...(typeof value.readOnlyReason === 'string' ? { readOnlyReason: value.readOnlyReason } : {}),
    ...(typeof value.patchId === 'string' ? { patchId: value.patchId } : {}),
  };
}

/** 解析组合包。 */
function bundleOf(value: unknown): BundleView {
  if (!isRecord(value) || typeof value.name !== 'string') {
    throw new SettingsCallError('gateway/internal', '组合包的返回形状不符合约定');
  }
  const rows = Array.isArray(value.rows) ? value.rows : [];
  return {
    name: value.name,
    enabled: value.enabled === true,
    availability: typeof value.availability === 'string' ? value.availability : 'unknown',
    removable: value.removable === true,
    ...(typeof value.version === 'string' ? { version: value.version } : {}),
    ...(typeof value.readOnlyReason === 'string' ? { readOnlyReason: value.readOnlyReason } : {}),
    rows: rows.filter(isRecord).map((row) => ({
      rowId: String(row.rowId ?? ''),
      moduleName: String(row.moduleName ?? ''),
      ...(typeof row.entryId === 'string' ? { entryId: row.entryId } : {}),
    })),
  };
}

/**
 * 建立插件入口。
 * @param caller - 同源 Remote 调用器。
 * @returns 插件入口。
 */
export function createPluginGateway(caller: RemoteCaller): PluginGateway {
  return {
    async load(): Promise<{ readonly plugins: readonly PluginEntryView[]; readonly bundles: readonly BundleView[] }> {
      const inventory = await caller.call<unknown>('pluginInventory/list', {});
      const bundles = await caller.call<unknown>('pluginManager/listBundles', {});
      if (!isRecord(inventory) || !Array.isArray(inventory.entries)) {
        throw new SettingsCallError('gateway/internal', '装配清单的返回形状不符合约定');
      }
      if (!Array.isArray(bundles)) throw new SettingsCallError('gateway/internal', '组合包列表的返回形状不符合约定');
      return {
        plugins: inventory.entries.map(pluginOf),
        bundles: bundles.map(bundleOf),
      };
    },

    async setPluginEnabled(entryId: string, enabled: boolean): Promise<void> {
      await caller.call('pluginManager/setPluginEnabled', { id: entryId, enabled });
    },

    async setBundleEnabled(name: string, enabled: boolean): Promise<void> {
      await caller.call('pluginManager/setBundleEnabled', { name, enabled });
    },

    async removeBundle(name: string): Promise<void> {
      await caller.call('pluginManager/removeBundle', { name });
    },
  };
}

/** 安装入口的说明：安装需要允许安装的来源清单。 */
export const INSTALL_UNSUPPORTED_REASON = '本部署没有允许安装的插件来源清单（SYS07），安装入口不下载任何包。';
