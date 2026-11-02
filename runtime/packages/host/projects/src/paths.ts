/**
 * 项目路径与展示名的规范化。
 *
 * 项目的身份是工作目录的绝对路径：同一个目录允许两种书写（末尾带斜杠、含 `.` 段），
 * 规范化之后落到同一个键上，因此「相同目录拒绝重复」不依赖调用方写法一致。展示名允许为
 * 空，此时用目录末段，界面不必再自己算一次。
 * @module @chatdsh/host-projects/paths
 */

import { statSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { ChatdshError } from '@chatdsh/core-contracts';

/** 项目名称的字符上限，与设置面允许的路径长度无关。 */
export const PROJECT_TITLE_LIMIT = 80;

/** 一个路径在磁盘上的形态。 */
export type PathKind = 'directory' | 'other' | 'missing';

/**
 * 把调用方给出的路径规范成项目身份。
 *
 * 相对路径没有确定含义（宿主的 cwd 与会话的 cwd 不是一回事），直接拒绝。
 * @param input - 调用方给出的目录路径。
 * @returns 规范化后的绝对路径。
 */
export function normalizeProjectPath(input: string): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new ChatdshError('request-invalid', '项目路径不能为空');
  }
  if (input !== input.trim()) {
    throw new ChatdshError('request-invalid', '项目路径前后不能有空白');
  }
  if (!isAbsolute(input)) {
    throw new ChatdshError('request-invalid', '项目路径必须是绝对路径', { path: input });
  }
  return resolve(input);
}

/**
 * 查明一个规范化路径在磁盘上的形态。
 *
 * 不跟随不存在之外的特殊处理：权限错误原样抛出，由调用方决定如何处理。
 * @param path - 规范化后的绝对路径。
 * @returns 目录、其他类型或缺失。
 */
export function pathKindOf(path: string): PathKind {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return 'missing';
  return stat.isDirectory() ? 'directory' : 'other';
}

/**
 * 校验名称长度。空名称是合法输入，表示使用目录末段。
 * @param title - 展示名原文。
 * @returns 去掉首尾空白之后的展示名；可能为空串。
 */
export function normalizeTitle(title: string): string {
  if (typeof title !== 'string') throw new ChatdshError('request-invalid', '项目名称必须是字符串');
  const trimmed = title.trim();
  if (trimmed.length > PROJECT_TITLE_LIMIT) {
    throw new ChatdshError('request-invalid', '项目名称超过长度上限', { limit: PROJECT_TITLE_LIMIT });
  }
  return trimmed;
}

/**
 * 计算实际展示名：名称为空时取目录末段。
 * @param path - 规范化后的绝对路径。
 * @param title - 已规范化的展示名。
 * @returns 展示名。
 */
export function displayTitleOf(path: string, title: string): string {
  if (title !== '') return title;
  const tail = basename(path);
  return tail === '' ? path : tail;
}

/**
 * 校验一条默认模型引用的写法。
 *
 * 引用形状是 `provider/model`：provider 是模型运行时的路由标识，model 是该路由下的模型
 * 标识。路由是否注册由服务层对照模型目录检查。
 * @param reference - 调用方给出的模型引用。
 * @returns 拆分后的路由与模型标识。
 */
export function parseModelReference(reference: string): { readonly provider: string; readonly model: string } {
  if (typeof reference !== 'string' || reference.trim() === '') {
    throw new ChatdshError('request-invalid', '默认模型引用不能为空');
  }
  if (reference !== reference.trim()) {
    throw new ChatdshError('request-invalid', '默认模型引用前后不能有空白');
  }
  const separator = reference.indexOf('/');
  if (separator <= 0 || separator === reference.length - 1) {
    throw new ChatdshError('request-invalid', '默认模型引用必须是 provider/model 形式', { reference });
  }
  const provider = reference.slice(0, separator);
  const model = reference.slice(separator + 1);
  if (/\s/.test(reference)) {
    throw new ChatdshError('request-invalid', '默认模型引用不能包含空白', { reference });
  }
  if (reference.length > 200) {
    throw new ChatdshError('request-invalid', '默认模型引用超过长度上限', { limit: 200 });
  }
  return { provider, model };
}
