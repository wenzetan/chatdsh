/**
 * 离线回退页与已保留的导航元数据。
 *
 * 断网时导航请求交给 Service Worker 处理：应用壳在缓存里就用壳，取不到就回退到这里生成的
 * 离线页。离线页说明正文读取失败的原因，并列出本机保留的导航元数据与草稿入口；它不加载
 * 脚本，也不显示任何会话内容。导航元数据只保存工作区位置、设备标识与未读数，不含消息正文。
 * @module @chatdsh/client-pwa/offline
 */

import { OFFLINE_PATH } from './paths.ts';

/** 导航元数据的存储键。 */
export const NAVIGATION_KEY = 'chatdsh-pwa.navigation.v1';

/** 已保留的导航元数据。 */
export interface NavigationMeta {
  /** 工作区路径。 */
  readonly workspace: string;
  /** 目标设备标识。 */
  readonly deviceId: string;
  /** 未读会话数量。 */
  readonly unread: number;
  /** 记录时刻的毫秒时间戳。 */
  readonly updatedAt: number;
}

/**
 * 保存导航元数据。
 *
 * 只写入三个字段；写入被拒绝（隐私模式、空间不足）时直接抛出，调用方据此说明导航元数据
 * 在本次浏览器会话内有效。
 * @param storage - 本地存储。
 * @param meta - 要保存的元数据。
 */
export function saveNavigationMeta(storage: Storage, meta: NavigationMeta): void {
  storage.setItem(
    NAVIGATION_KEY,
    JSON.stringify({
      workspace: meta.workspace,
      deviceId: meta.deviceId,
      unread: meta.unread,
      updatedAt: meta.updatedAt,
    })
  );
}

/**
 * 读取导航元数据。
 * @param storage - 本地存储。
 * @returns 元数据；没有记录或内容不合法时为 `undefined`。
 */
export function readNavigationMeta(storage: Storage): NavigationMeta | undefined {
  const raw = storage.getItem(NAVIGATION_KEY);
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const workspace = record['workspace'];
  const deviceId = record['deviceId'];
  const unread = record['unread'];
  const updatedAt = record['updatedAt'];
  if (typeof workspace !== 'string' || typeof deviceId !== 'string') return undefined;
  if (typeof unread !== 'number' || !Number.isInteger(unread) || unread < 0) return undefined;
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return undefined;
  return { workspace, deviceId, unread, updatedAt };
}

/** 离线页的输入。 */
export interface OfflinePageOptions {
  /** 标题里的产品名称。 */
  readonly name?: string;
  /** 已保留的导航元数据；缺省时只说明草稿在本机。 */
  readonly navigation?: NavigationMeta;
  /** 回退页生成的毫秒时间戳。 */
  readonly updatedAt?: number;
}

/** 把文本中可能破坏标记的字符转义。 */
function escapeText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * 生成离线回退页。
 *
 * 页面自带令牌取值与布局，不依赖缓存中的样式表，所以断网时也能完整显示。正文区域的文字说明
 * 了会话内容读取失败，避免把空白页当成空会话。
 * @param options - 产品名称与已保留的导航元数据。
 * @returns HTML 文本。
 */
export function offlinePage(options: OfflinePageOptions = {}): string {
  const name = escapeText(options.name ?? 'ChatDSH');
  const navigation = options.navigation;
  const navigationRows = navigation === undefined
    ? '<p class="note">本机没有已保留的导航位置。</p>'
    : [
        '<dl class="meta">',
        `<div><dt>工作区位置</dt><dd>${escapeText(navigation.workspace)}</dd></div>`,
        `<div><dt>设备</dt><dd>${escapeText(navigation.deviceId)}</dd></div>`,
        `<div><dt>未读</dt><dd>${String(navigation.unread)}</dd></div>`,
        '</dl>',
      ].join('\n');
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<meta name="color-scheme" content="dark light">',
    '<meta name="referrer" content="no-referrer">',
    `<title>${name}：当前离线</title>`,
    '<style>',
    '  :root { color-scheme: dark; --bg: #0e0e10; --panel: #17181c; --line: #24262c; --ink: #f3f5f9; --ink-2: #c7ccd6; --muted: #9aa1ad; --brand: #4d6bfe; --warn: #e8b04b; }',
    '  * { box-sizing: border-box; }',
    '  body { margin: 0; min-height: 100vh; min-height: 100dvh; background: var(--bg); color: var(--ink-2); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 1rem; line-height: 1.6; padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }',
    '  main { max-width: 34rem; margin: 0 auto; padding: 2rem 1.25rem; }',
    '  h1 { font-size: 1.25rem; color: var(--ink); margin: 0 0 0.5rem; }',
    '  h2 { font-size: 1rem; color: var(--ink); margin: 1.75rem 0 0.5rem; }',
    '  p { margin: 0 0 0.75rem; overflow-wrap: anywhere; }',
    '  .failure { border: 1px solid var(--warn); border-radius: 0.5rem; padding: 0.75rem 1rem; background: rgba(232, 176, 75, 0.12); color: var(--ink); }',
    '  .note { color: var(--muted); }',
    '  .meta { margin: 0; display: grid; gap: 0.5rem; }',
    '  .meta div { display: flex; justify-content: space-between; gap: 1rem; border-bottom: 1px solid var(--line); padding-bottom: 0.5rem; }',
    '  .meta dt { color: var(--muted); }',
    '  .meta dd { margin: 0; color: var(--ink); overflow-wrap: anywhere; text-align: end; }',
    '  a.button { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; min-width: 44px; padding: 0 1rem; margin-top: 1.5rem; border: 1px solid var(--brand); border-radius: 0.375rem; color: var(--ink); text-decoration: none; }',
    '  footer { margin-top: 2rem; color: var(--muted); font-size: 0.8125rem; }',
    '</style>',
    '</head>',
    '<body>',
    '<main>',
    `<h1>${name} 当前离线</h1>`,
    '<p class="failure" role="alert">正文读取失败：当前无法连接控制平面，会话内容没有加载。</p>',
    '<h2>本机保留的内容</h2>',
    '<p>离线时只能查看已缓存的界面壳、已保留的导航位置与本机草稿。发送被阻止，草稿保留在本机。</p>',
    navigationRows,
    '<h2>恢复方式</h2>',
    '<p>恢复网络后返回会话列表重新加载，草稿仍在原来的设备与会话下。</p>',
    '<a class="button" href="/">返回会话列表</a>',
    `<footer>回退页地址 ${escapeText(OFFLINE_PATH)}，生成于 ${new Date(options.updatedAt ?? Date.now()).toISOString()}</footer>`,
    '</main>',
    '</body>',
    '</html>',
  ].join('\n');
}
