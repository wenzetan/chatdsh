/**
 * 一次读取的三种状态。
 *
 * 面板不把「还没读到」「读失败」「读到了空」混成同一种渲染：失败必须显示原因，空状态单独
 * 出现，避免把失败画成成功。
 * @module @chatdsh/client-share/loadable
 */

/** 读取状态。 */
export type Loadable<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly error: unknown }
  | { readonly status: 'ready'; readonly value: T };
