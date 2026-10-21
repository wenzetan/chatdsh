/**
 * 定位可启动的 dsh。
 *
 * 用 `pnpm run` 跑脚本时 pnpm 会重置 PATH，全局安装的 `dsh` 常常不在其中。这里按三处线索
 * 依次查找：`DSH_BIN` 环境变量、与当前 node 同目录的 `dsh`、PATH 里的 `dsh`。
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * 得到启动 dsh 的命令。
 * @returns 可执行文件路径。
 */
export function dshCommand() {
  const fromEnv = process.env.DSH_BIN;
  if (fromEnv !== undefined && existsSync(fromEnv)) return fromEnv;

  // node 的 bin 目录通常与 dsh 的启动脚本同目录。
  const beside = join(dirname(process.execPath), 'dsh');
  if (existsSync(beside)) return beside;

  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir === '') continue;
    const candidate = join(dir, 'dsh');
    if (existsSync(candidate)) return candidate;
  }

  // 都找不到时交回裸命令名，让 spawn 报出清晰的 ENOENT。
  return 'dsh';
}
