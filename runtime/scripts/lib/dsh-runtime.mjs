/**
 * 在隔离的 DSH_HOME 里安装官方 `web` profile 与 `@chatdsh/bundle`。
 *
 * 走官方 `dsh plugin --profile web add` 的真实安装路径：profile 的 bundle 列表与
 * node_modules 都由 DSH 自己维护，验收进程加载的是真实组合包，不使用替身。
 */

import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { dshCommand } from './dsh.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');

/** 组合包目录。 */
export const BUNDLE_PATH = join(ROOT, 'packages', 'bundle', 'chatdsh');

/** pnpm 存储目录；容器里的用户级目录只读。 */
export const PNPM_STORE_DIR = join(ROOT, '.run', 'pnpm-store');

/**
 * 初始化官方 web profile 并安装组合包。
 * @param {string} home - 本次运行专用的 DSH_HOME。
 */
export function installRuntimeProfile(home) {
  const env = { ...process.env, DSH_HOME: home };
  const initialized = spawnSync(dshCommand(), ['--profile', 'web', '--help'], { env, encoding: 'utf8' });
  if (initialized.status !== 0) {
    throw new Error(`初始化 web profile 失败：${initialized.stderr || initialized.stdout}`);
  }
  const installed = spawnSync(dshCommand(), [
    'plugin', '--profile', 'web', 'add', BUNDLE_PATH, `--store-dir=${PNPM_STORE_DIR}`,
  ], { env, encoding: 'utf8' });
  if (installed.status !== 0) {
    throw new Error(`安装 @chatdsh/bundle 失败：${installed.stderr || installed.stdout}`);
  }
  return home;
}
