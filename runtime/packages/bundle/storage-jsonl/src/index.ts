/**
 * 存储组合包：会话日志落 JSONL 文件。
 *
 * 组合包本身不注册服务，内容由补丁层表达：显式钉住会话日志的存储位置。
 * @module @chatdsh/bundle-storage-jsonl
 */

/** 相对组合包根的补丁文件路径。 */
export const PATCH_FILE = './cordis.patch.yml';

/** 本组合包覆盖的宿主行 id。 */
export const STORAGE_ROWS = ['session-persistence-jsonl'] as const;
