/**
 * 记忆组合包。
 *
 * 组合包本身不注册服务，内容由补丁层表达：挂载记忆接入行并给出连接配置的默认值。
 * @module @chatdsh/bundle-memory-hindsight
 */

/** 相对组合包根的补丁文件路径。 */
export const PATCH_FILE = './cordis.patch.yml';

/** 本组合包挂载的行 id。 */
export const MEMORY_ROWS = ['chatdsh-memory'] as const;
