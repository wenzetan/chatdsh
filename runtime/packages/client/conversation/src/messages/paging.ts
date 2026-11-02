/**
 * 长会话的分段渲染与滚动位置保持。
 *
 * 会话只渲染最近一段消息，向上翻动时按段追加更早的消息。滚动位置用锚点表达：一段消息进入
 * 或离开视口之前记下当时在视口顶部的消息标识与偏移，重排之后按同一锚点恢复，因此翻页、
 * 折叠工具卡片与到达新消息都不会把正在读的位置顶走。
 *
 * 阅读历史时不自动拉到末尾：视口离底部超过阈值就视为「正在读历史」，新消息只增加「有新
 * 消息」入口，用户点它才回到末尾。
 * @module @chatdsh/client-conversation/messages/paging
 */

/** 每段渲染的消息条数。 */
export const DEFAULT_PAGE_SIZE = 40;

/** 离底部多近算作停在末尾，单位像素。 */
export const DEFAULT_BOTTOM_THRESHOLD = 48;

/** 一段消息的渲染窗口。 */
export interface MessageWindow {
  /** 段内第一条消息在完整列表里的下标。 */
  readonly startIndex: number;
  /** 段内最后一条消息的下标（含）。 */
  readonly endIndex: number;
  /** 是否还有更早的消息。 */
  readonly hasOlder: boolean;
  /** 是否还有更新的消息。 */
  readonly hasNewer: boolean;
}

/**
 * 计算最近一段的渲染窗口。
 * @param total - 消息总数。
 * @param pageSize - 每段条数。
 * @returns 窗口；没有消息时两端都是 -1。
 */
export function latestWindow(total: number, pageSize: number = DEFAULT_PAGE_SIZE): MessageWindow {
  if (!Number.isInteger(total) || total < 0) throw new Error('消息总数必须是非负整数');
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error('每段条数必须是正整数');
  if (total === 0) return { startIndex: -1, endIndex: -1, hasOlder: false, hasNewer: false };
  const startIndex = Math.max(0, total - pageSize);
  return { startIndex, endIndex: total - 1, hasOlder: startIndex > 0, hasNewer: false };
}

/**
 * 向上追加一段。
 * @param window - 当前窗口。
 * @param pageSize - 每段条数。
 * @returns 扩展后的窗口。
 */
export function extendOlder(window: MessageWindow, pageSize: number = DEFAULT_PAGE_SIZE): MessageWindow {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error('每段条数必须是正整数');
  if (window.startIndex < 0) return window;
  const startIndex = Math.max(0, window.startIndex - pageSize);
  return { ...window, startIndex, hasOlder: startIndex > 0 };
}

/**
 * 向新消息方向追加一段。
 * @param window - 当前窗口。
 * @param total - 消息总数。
 * @param pageSize - 每段条数。
 * @returns 扩展后的窗口。
 */
export function extendNewer(
  window: MessageWindow,
  total: number,
  pageSize: number = DEFAULT_PAGE_SIZE
): MessageWindow {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error('每段条数必须是正整数');
  if (!Number.isInteger(total) || total < 0) throw new Error('消息总数必须是非负整数');
  if (window.endIndex < 0) return latestWindow(total, pageSize);
  const endIndex = Math.min(total - 1, window.endIndex + pageSize);
  return { ...window, endIndex, hasNewer: endIndex < total - 1 };
}

/** 滚动锚点。 */
export interface ScrollAnchor {
  /** 视口顶部那一条消息的标识。 */
  readonly messageId: string;
  /** 该消息顶部相对视口顶部的偏移，单位像素。 */
  readonly offsetPx: number;
}

/** 视口的滚动量。 */
export interface ScrollMetrics {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** 一条消息在列表里的位置。 */
export interface MessageBox {
  readonly id: string;
  readonly offsetTop: number;
  readonly offsetHeight: number;
}

/**
 * 记录滚动锚点。
 *
 * 取视口顶部所在的消息；视口在第一条消息之上时用第一条消息。
 * @param viewport - 视口滚动量。
 * @param boxes - 当前已渲染消息的位置，按列表顺序。
 * @returns 锚点；没有消息时返回 `undefined`。
 */
export function captureAnchor(viewport: ScrollMetrics, boxes: readonly MessageBox[]): ScrollAnchor | undefined {
  if (boxes.length === 0) return undefined;
  const top = viewport.scrollTop;
  for (const box of boxes) {
    if (box.offsetTop + box.offsetHeight > top) {
      return { messageId: box.id, offsetPx: box.offsetTop - top };
    }
  }
  const last = boxes.at(-1)!;
  return { messageId: last.id, offsetPx: last.offsetTop - top };
}

/**
 * 按锚点算出恢复后的滚动位置。
 *
 * 锚点消息已经不在了（例如被删除）时返回 `undefined`，由调用方按列表顶部处理。
 * @param anchor - 锚点。
 * @param boxes - 重排后的消息位置。
 * @returns 需要设置的滚动位置。
 */
export function restoreScroll(anchor: ScrollAnchor, boxes: readonly MessageBox[]): number | undefined {
  const box = boxes.find((item) => item.id === anchor.messageId);
  if (box === undefined) return undefined;
  return Math.max(0, box.offsetTop - anchor.offsetPx);
}

/**
 * 判断视口是否停在末尾。
 * @param viewport - 视口滚动量。
 * @param threshold - 允许的偏差，单位像素。
 * @returns 停在末尾时为真。
 */
export function isAtBottom(viewport: ScrollMetrics, threshold: number = DEFAULT_BOTTOM_THRESHOLD): boolean {
  const distance = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
  return distance <= threshold;
}

/**
 * 判断新消息到达时是否要自动滚到末尾。
 *
 * 用户停在末尾、并且没有暂停自动跟随时自动跟随；正在读历史时不跟随，只登记未读数。
 * @param viewport - 视口滚动量。
 * @param options - 是否暂停自动跟随与阈值。
 * @returns 需要自动滚到末尾时为真。
 */
export function shouldAutoFollow(
  viewport: ScrollMetrics,
  options: { readonly paused?: boolean; readonly threshold?: number } = {}
): boolean {
  if (options.paused === true) return false;
  return isAtBottom(viewport, options.threshold ?? DEFAULT_BOTTOM_THRESHOLD);
}

/**
 * 生成「有新消息」入口的说明。
 * @param count - 新消息条数。
 * @returns 说明文字；没有新消息时返回 `undefined`。
 */
export function newMessagesLabel(count: number): string | undefined {
  if (!Number.isInteger(count) || count < 0) throw new Error('新消息条数必须是非负整数');
  if (count === 0) return undefined;
  return `${count} 条新消息`;
}
