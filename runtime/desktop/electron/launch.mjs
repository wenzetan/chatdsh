/**
 * 桌面壳的端口探测与启动地址解析。
 *
 * 控制平面与运行时的子进程编排分别在 `gateway-launch.mjs` 与
 * `@chatdsh/gateway/src/runtime.ts`；这里只保留两侧共用的纯函数。
 * @module chatdsh-desktop-shell/launch
 */
import { createServer } from 'node:net';


/** 判断一个回环端口当前能否绑定。 */
async function isPortAvailable(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

/**
 * 从起始端口开始找一个可绑定的回环端口，占用时逐个 +1。
 *
 * 桌面壳不传 `--port` 时 DSH 会固定用 3080；上一个实例崩溃或别的进程占用该端口时，
 * 用户只会看到 EADDRINUSE。这里按 3080、3081、3082……顺序探测，最多试 20 个；
 * 全部占用时再让操作系统分配一个。
 * @param {number} [start=3080] - 起始端口。
 * @param {number} [attempts=20] - 最多尝试的连续端口数。
 * @returns {Promise<number>} 可绑定的端口号。
 */
export async function findFreePort(start = 3080, attempts = 20) {
  const first = Number.isInteger(start) && start > 0 && start <= 65535 ? start : 3080;
  const last = Math.min(65535, first + Math.max(1, attempts) - 1);
  for (let port = first; port <= last; port += 1) {
    if (await isPortAvailable(port)) return port;
  }
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : undefined;
      server.close(() => {
        if (typeof port === 'number' && port > 0) resolve(port);
        else reject(new Error('系统没有分配可用端口'));
      });
    });
  });
}



/**
 * 从启动输出里取出带令牌的可访问地址。
 * @param text - 累积的标准输出。
 * @returns 带令牌的地址，未出现时返回 undefined。
 */
export function extractBootUrl(text) {
  const match = text.match(/dsh web: (http:\/\/\S+)/);
  return match?.[1];
}
