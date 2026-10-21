/**
 * 临时数据根。
 *
 * 验收脚本各自需要一个独立的数据根，跑完不该留在 `.run` 里。这里统一分配，并在进程退出时
 * 删除。设置 `CHATDSH_KEEP_RUN=1` 可以保留现场，便于排查。
 */

import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');

/** 本次运行创建的数据根。 */
const created = [];

/** 是否已经注册退出钩子。 */
let registered = false;

/**
 * 分配一个本次运行专用的数据根。
 * @param {string} prefix - 目录名前缀，通常取脚本名。
 * @returns {string} 数据根的绝对路径。
 */
export function tempHome(prefix) {
  const home = resolve(ROOT, '.run', `${prefix}-${Date.now()}`);
  mkdirSync(home, { recursive: true });
  created.push(home);
  if (!registered) {
    registered = true;
    const cleanup = () => {
      if (process.env.CHATDSH_KEEP_RUN === '1') return;
      for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
    };
    process.once('exit', cleanup);
    // 收到信号时进程直接终止，exit 事件不触发；显式接管，清理之后再退出。
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => {
        cleanup();
        process.exit(130);
      });
    }
  }
  return home;
}
