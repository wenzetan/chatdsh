/**
 * 桌面壳的原生能力入口策略。
 *
 * 目录选择、外部打开与剪贴板写入都在这里先过策略，再交给 Electron。外部打开只放行 http
 * 与 https，文件路径只放行数据根内的非可执行文件；目录选择只接受用户亲自选出的真实目录。
 * @module chatdsh-desktop-shell/native
 */

import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

/** 一次原生能力请求被拒绝。 */
export class NativeRejection extends Error {
  /**
   * @param code - 拒绝原因代码。
   * @param detail - 供日志使用的说明。
   */
  constructor(code, detail) {
    super(detail === undefined ? `原生能力拒绝：${code}` : `原生能力拒绝：${code}（${detail}）`);
    this.name = 'NativeRejection';
    this.code = code;
    this.detail = detail;
  }
}

/** 交给系统打开时一律拦下的可执行扩展名。 */
export const BLOCKED_EXTENSIONS = Object.freeze([
  '.exe', '.com', '.bat', '.cmd', '.msi', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse',
  '.wsf', '.wsh', '.scr', '.lnk', '.url', '.reg', '.jar', '.app', '.dmg', '.pkg', '.deb', '.rpm',
]);

/** 允许外部打开的网络协议。 */
const WEB_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * 校验一个外部地址。
 * @param raw - 原始地址文本。
 * @returns 解析后的 URL。
 */
export function assertExternalUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') throw new NativeRejection('url-empty', '地址为空');
  const value = raw.trim();
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new NativeRejection('url-malformed', '地址无法解析');
  }
  if (!WEB_PROTOCOLS.has(parsed.protocol)) {
    throw new NativeRejection('url-scheme', `不允许的协议 ${parsed.protocol}`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new NativeRejection('url-credentials', '地址里带有凭据');
  }
  if (parsed.hostname === '') throw new NativeRejection('url-host', '地址缺少主机名');
  return parsed;
}

/**
 * 校验一个受限文件路径。
 * @param raw - 原始路径文本。
 * @param roots - 允许的根目录列表。
 * @returns 解析后的绝对路径。
 */
export function assertControlledPath(raw, roots) {
  if (typeof raw !== 'string' || raw.trim() === '') throw new NativeRejection('path-empty', '路径为空');
  const value = raw.trim();
  if (!isAbsolute(value)) throw new NativeRejection('path-not-absolute', '路径必须是绝对路径');
  const resolved = resolve(value);
  const inside = roots.some((root) => {
    const base = resolve(root);
    return resolved === base || resolved.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
  });
  if (!inside) throw new NativeRejection('path-escape', '路径不在允许的目录内');
  const lower = resolved.toLowerCase();
  for (const extension of BLOCKED_EXTENSIONS) {
    if (lower.endsWith(extension)) throw new NativeRejection('path-executable', `不允许打开 ${extension} 文件`);
  }
  if (!existsSync(resolved)) throw new NativeRejection('path-missing', '路径不存在');
  return resolved;
}

/**
 * 判定一次外部打开走网络地址还是文件路径。
 * @param raw - 原始目标。
 * @param roots - 允许的文件根目录列表。
 * @returns 目标类型与规范值。
 */
export function classifyOpenTarget(raw, roots) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '') throw new NativeRejection('target-empty', '目标为空');
  if (value.includes('://')) {
    const url = assertExternalUrl(value);
    return { kind: 'url', value: url.toString() };
  }
  const path = assertControlledPath(value, roots);
  return { kind: 'file', value: path };
}

/**
 * 目录选择对话框的选项。
 * @param purpose - 选择用途。
 */
export function directoryPickerOptions(purpose) {
  const titles = {
    workspace: '选择工作区目录',
    export: '选择导出目录',
    artifact: '选择制品目录',
  };
  const title = titles[purpose];
  if (title === undefined) throw new NativeRejection('purpose-unknown', `未知用途 ${purpose}`);
  return {
    title,
    buttonLabel: '选择此目录',
    properties: ['openDirectory', 'createDirectory'],
  };
}

/**
 * 校验用户选出的目录。
 * @param filePaths - 对话框返回的路径列表。
 * @returns 选中的目录绝对路径。
 */
export function assertDirectoryChoice(filePaths) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    throw new NativeRejection('picker-cancelled', '用户取消了选择');
  }
  if (filePaths.length !== 1) throw new NativeRejection('picker-multiple', '一次只能选一个目录');
  const chosen = filePaths[0];
  if (typeof chosen !== 'string' || !isAbsolute(chosen)) throw new NativeRejection('picker-not-absolute', '选择的目录不是绝对路径');
  const resolved = resolve(chosen);
  if (!existsSync(resolved)) throw new NativeRejection('picker-missing', '选择的目录不存在');
  if (!statSync(resolved).isDirectory()) throw new NativeRejection('picker-not-directory', '选择的不是目录');
  return resolved;
}

/**
 * 校验要写入剪贴板的文本。
 * @param text - 原始文本。
 * @returns 可写入的文本。
 */
export function assertClipboardText(text) {
  if (typeof text !== 'string') throw new NativeRejection('clipboard-not-text', '剪贴板只接受文本');
  if (text.length === 0) throw new NativeRejection('clipboard-empty', '文本为空');
  if (text.includes('\u0000')) throw new NativeRejection('clipboard-control', '文本包含空字符');
  return text;
}
