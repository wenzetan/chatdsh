/**
 * 桌面组合包。
 *
 * 组合包本身不注册服务，内容由补丁层表达：保留浏览器侧栏，并声明桌面形态的审批呈现
 * 由壳层承担。
 * @module @chatdsh/bundle-desktop
 */

/** 相对组合包根的补丁文件路径。 */
export const PATCH_FILE = './cordis.patch.yml';

/** 本组合包覆盖的宿主行 id。 */
export const DESKTOP_ROWS = ['ui-sidebar-browser'] as const;
