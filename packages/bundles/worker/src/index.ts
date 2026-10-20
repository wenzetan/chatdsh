/**
 * 长任务组合包。
 *
 * 组合包本身不注册服务，内容全部由补丁层表达：按长任务形态重设落盘与截断阈值。
 * @module @chatdsh/bundle-worker
 */

/** 相对组合包根的补丁文件路径。 */
export const PATCH_FILE = './cordis.patch.yml';

/** 本组合包覆盖的宿主行 id。 */
export const WORKER_ROWS = ['spill-policy', 'tool-result-pruner'] as const;
