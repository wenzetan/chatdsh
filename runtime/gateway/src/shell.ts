/**
 * 客户端外壳的页面与静态资源。
 *
 * 外壳是控制平面托管的静态页面：左栏聚合全部设备的会话，右栏是一个 iframe，`src` 按选中
 * 的会话指向 `/d/<deviceId>/`。页面脚本由 `scripts/build-shell.mjs` 从
 * `packages/client/shell` 打成单文件产物，落在本包编译目录下的 `shell/shell.js`，这里按
 * 自身产物位置读取它，控制平面因此不依赖任何运行时的 web 前端产物。
 * @module @chatdsh/gateway/shell
 */

import { existsSync, readFileSync } from 'node:fs';

/** 外壳脚本的路径。 */
export const SHELL_SCRIPT_PATH = '/shell/shell.js';

/** 外壳脚本的磁盘位置，跟随本模块的编译产物定位。 */
function shellScriptFile(): URL {
  return new URL('./shell/shell.js', import.meta.url);
}

/**
 * 判断外壳脚本是否已经构建。
 * @returns 构建产物存在时为真。
 */
export function shellBuilt(): boolean {
  return existsSync(shellScriptFile());
}

/**
 * 读外壳脚本。
 * @returns 脚本字节。
 */
export function readShellScript(): Buffer {
  return readFileSync(shellScriptFile());
}

/**
 * 渲染外壳页面。
 * @returns 完整 HTML。
 */
export function renderShellPage(): string {
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    '<title>ChatDSH</title>',
    `<script defer src="${SHELL_SCRIPT_PATH}"></script>`,
    '</head>',
    '<body>',
    '<div id="chatdsh-shell"></div>',
    '<noscript>这个页面需要浏览器执行脚本。</noscript>',
    '</body>',
    '</html>',
  ].join('\n');
}
