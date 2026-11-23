/**
 * 端口分配：从给定起点向上找一个当前可监听的端口。
 */

import { createServer } from 'node:net';

/**
 * 判断端口是否可用。
 * @param {number} port - 待检查的端口。
 * @returns {Promise<boolean>}
 */
function isFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * 从起点开始找一个可用端口。
 * @param {number} start - 起始端口。
 * @returns {Promise<number>}
 */
export async function findFreePort(start) {
  for (let port = start; port < start + 200; port += 1) {
    if (await isFree(port)) return port;
  }
  throw new Error(`从 ${start} 起没有找到可用端口`);
}
