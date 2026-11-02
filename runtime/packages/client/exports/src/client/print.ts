/**
 * 打印预览的范围与触发。
 *
 * 打印视图去掉应用导航、输入区与交互按钮，保留标题、时间、页码、代码换行、长表头重复与
 * 可理解的链接文本。打印样式由公开页与导出文档自带（控制平面渲染），这里只负责提交范围、
 * 说明会被隐去的部分，以及调用浏览器的打印命令。
 * @module @chatdsh/client-exports/print
 */

import type { PrintExclusion } from './types.ts';
import { PRINT_EXCLUSIONS } from './types.ts';

/** 打印范围的对外形状。 */
export interface PrintScopeView {
  readonly title: string;
  readonly pageNumbers: boolean;
  readonly codeWrapping: 'wrap' | 'scroll';
  readonly repeatTableHeader: boolean;
  readonly excluded: readonly PrintExclusion[];
}

/** 打印时隐去的界面部分与类名。 */
export const PRINT_HIDE_CLASSES: Readonly<Record<PrintExclusion, string>> = {
  navigation: 'chdsh-app-nav',
  composer: 'chdsh-composer',
  'interaction-buttons': 'chdsh-actions',
};

/** 打印时隐去部分的中文名。 */
export const PRINT_EXCLUSION_LABELS: Readonly<Record<PrintExclusion, string>> = {
  navigation: '应用导航',
  composer: '输入区',
  'interaction-buttons': '交互按钮',
};

/** 打印范围的输入。 */
export interface PrintInput {
  readonly title: string;
  readonly pageNumbers: boolean;
  readonly codeWrapping: 'wrap' | 'scroll';
  readonly repeatTableHeader: boolean;
  readonly excluded: readonly string[];
}

/**
 * 构造打印范围。
 * @param input - 标题与分页选项。
 * @returns 校验过的打印范围。
 */
export function printScopeOf(input: PrintInput): PrintScopeView {
  const title = input.title.trim();
  if (title === '' || title.length > 300) throw new Error('打印标题需要在 1 到 300 字之间');
  if (input.codeWrapping !== 'wrap' && input.codeWrapping !== 'scroll') {
    throw new Error('代码换行方式只接受 wrap 与 scroll');
  }
  const excluded: PrintExclusion[] = [];
  for (const item of input.excluded) {
    if (!(PRINT_EXCLUSIONS as readonly string[]).includes(item)) {
      throw new Error(`未登记的打印排除部分：${item}`);
    }
    if (!excluded.includes(item as PrintExclusion)) excluded.push(item as PrintExclusion);
  }
  return {
    title,
    pageNumbers: input.pageNumbers,
    codeWrapping: input.codeWrapping,
    repeatTableHeader: input.repeatTableHeader,
    excluded,
  };
}

/**
 * 打印预览的说明文字。
 * @param scope - 打印范围。
 * @returns 一句可以直接展示的说明。
 */
export function printPreviewSummary(scope: PrintScopeView): string {
  const hidden = scope.excluded.map((item) => PRINT_EXCLUSION_LABELS[item]).join('、');
  const pages = scope.pageNumbers ? '打印并显示页码' : '打印但不显示页码';
  const code = scope.codeWrapping === 'wrap' ? '代码自动换行' : '代码保持原样，超出部分横向查看';
  const header = scope.repeatTableHeader ? '长表格跨页重复表头' : '长表格不重复表头';
  return `${pages}；${code}；${header}${hidden === '' ? '' : `；去掉${hidden}`}。`;
}

/** 打印环境。 */
export interface PrintEnvironment {
  readonly print?: () => void;
  readonly matchMedia?: (query: string) => { readonly matches: boolean };
}

/**
 * 判断当前环境能否打印。
 * @param environment - 浏览器环境；缺省取全局对象。
 * @returns 能打印时为真。
 */
export function canPrint(environment: PrintEnvironment = globalThis as PrintEnvironment): boolean {
  return typeof environment.print === 'function';
}

/**
 * 触发浏览器打印。
 * @param environment - 浏览器环境；缺省取全局对象。
 * @throws 环境不支持打印时抛出。
 */
export function printDocument(environment: PrintEnvironment = globalThis as PrintEnvironment): void {
  if (typeof environment.print !== 'function') throw new Error('当前环境不支持打印');
  environment.print();
}

/**
 * 打印媒体查询是否生效的判断式。
 * @param environment - 浏览器环境；缺省取全局对象。
 * @returns 命中打印媒体时为真；环境没有媒体查询能力时为假。
 */
export function printingNow(environment: PrintEnvironment = globalThis as PrintEnvironment): boolean {
  if (typeof environment.matchMedia !== 'function') return false;
  return environment.matchMedia('print').matches;
}

/** 打印视图的默认范围：页码、换行、重复表头都打开，应用部分全部隐去。 */
export function defaultPrintInput(title: string): PrintInput {
  return {
    title,
    pageNumbers: true,
    codeWrapping: 'wrap',
    repeatTableHeader: true,
    excluded: [...PRINT_EXCLUSIONS],
  };
}
