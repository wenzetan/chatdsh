/**
 * 桌面壳拉起运行时的编排。
 *
 * 流程与 `@chatdsh/desktop` 的编排器一致，但这里是给 Electron 主进程直接调用的版本：
 * 取单实例锁、建中立的启动根与数据目录、拉起 `dsh --profile <name>` 子进程、等它打印出
 * 带令牌的地址。拿到地址后壳层把内置浏览器指向它。子进程的输出去掉令牌后再留存，
 * 便于失败诊断且不泄露凭据。
 * @module chatdsh-desktop-shell/launch
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';

/** 探测一个地址是否可达；连接失败时拒绝。 */
function probe(url) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: 'GET', timeout: 1500 }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    request.end();
  });
}

/** 把启动输出里的令牌抹掉，只留地址。 */
function redactToken(text) {
  return text.replace(/(\?|\b)token=[A-Za-z0-9_-]+/g, '$1token=<已隐藏>');
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

/**
 * 运行时编排器：一次进程生命周期。
 */
export class RuntimeLauncher {
  /**
   * @param {object} options - 启动参数。
   * @param {string} options.launchRoot - 中立的启动根，子进程的 cwd。
   * @param {string} options.dshHome - DSH 数据根，含 profiles。
   * @param {string} options.profile - 要启动的 profile 名。
   * @param {string} options.dshBin - `dsh` 的启动器路径或 `@deepseek-ai/dsh` 的 JS 入口。
   * @param {string} options.cwd - 启动子进程的工作目录（仓库根）。
   * @param {number} [options.readyTimeoutMs] - 就绪等待上限。
   * @param {(line: string) => void} [options.onLog] - 脱敏后的输出行回调。
   */
  constructor(options) {
    this.options = options;
    this.child = undefined;
    this.locked = false;
    this.output = [];
    this.readyTimeoutMs = options.readyTimeoutMs ?? 120_000;
    this.onLog = options.onLog ?? (() => {});
  }

  /** 锁文件路径。 */
  get lockFile() {
    return join(this.options.launchRoot, 'instance.lock');
  }

  /** 判断锁里的进程是否存活。 */
  #ownerAlive() {
    try {
      const owner = Number.parseInt(readFileSync(this.lockFile, 'utf8').trim(), 10);
      if (!Number.isInteger(owner)) return false;
      process.kill(owner, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** 取单实例锁；已被存活进程占用时抛出 owner 进程号。 */
  #acquireLock() {
    if (existsSync(this.lockFile) && this.#ownerAlive()) {
      const owner = Number.parseInt(readFileSync(this.lockFile, 'utf8').trim(), 10);
      const error = new Error(`实例已在运行（进程 ${owner}）`);
      error.code = 'ALREADY_RUNNING';
      error.ownerPid = owner;
      throw error;
    }
    const fd = openSync(this.lockFile, 'w');
    try {
      writeFileSync(fd, String(process.pid));
    } finally {
      closeSync(fd);
    }
    this.locked = true;
  }

  /** 释放锁。 */
  #releaseLock() {
    if (!this.locked) return;
    this.locked = false;
    rmSync(this.lockFile, { force: true });
  }

  /** 轮询端口直到可达。 */
  async #waitForPort(url) {
    const deadline = Date.now() + this.readyTimeoutMs;
    let last = '';
    while (Date.now() < deadline) {
      try {
        const status = await probe(url);
        if (status >= 200 && status < 500) return;
        last = `HTTP ${status}`;
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
      await new Promise((settle) => setTimeout(settle, 250));
    }
    throw new Error(`运行时在 ${this.readyTimeoutMs} 毫秒内没有就绪：${last}`);
  }

  /** 记住一行脱敏输出。 */
  #remember(chunk) {
    for (const line of redactToken(chunk).split(/\r?\n/)) {
      if (line.trim() === '') continue;
      this.output.push(line);
      this.onLog(line);
    }
    if (this.output.length > 400) this.output.splice(0, this.output.length - 400);
  }

  /**
   * 启动并等到运行时就绪。
   * @returns 带令牌的可访问地址与子进程号。
   */
  async start() {
    mkdirSync(this.options.launchRoot, { recursive: true });
    mkdirSync(this.options.dshHome, { recursive: true });
    this.#acquireLock();

    // 启动命令：`dshBin` 指向 `@deepseek-ai/dsh` 的 JS 入口时，用当前 Electron 可执行文件
    // 以 Node 方式运行（ELECTRON_RUN_AS_NODE），拿到一个可直接终止的真实子进程；否则直接
    // 执行给定的启动器。
    const profileArgs = ['--profile', this.options.profile, '--no-open'];
    if (this.options.port !== undefined) profileArgs.push('--port', String(this.options.port));
    const bin = this.options.dshBin;
    const runAsNode = bin.endsWith('.js') || bin.endsWith('.mjs') || bin.endsWith('.cjs');
    const command = runAsNode ? process.execPath : bin;
    const args = runAsNode ? [bin, ...profileArgs] : profileArgs;
    const env = { ...process.env, DSH_HOME: this.options.dshHome };
    if (runAsNode) env.ELECTRON_RUN_AS_NODE = '1';
    // Windows 上全局安装的 `dsh` 是 `.cmd` 转发脚本，没有 shell 无法直接启动；用 shell 执行。
    const useShell = !runAsNode && process.platform === 'win32';
    const child = spawn(command, args, {
      cwd: this.options.launchRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: useShell,
    });
    this.child = child;
    let bootUrl;
    let buffered = '';
    const consume = (chunk) => {
      buffered += chunk;
      this.#remember(chunk);
      if (bootUrl === undefined) {
        const found = extractBootUrl(buffered);
        if (found !== undefined) bootUrl = found;
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', consume);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', consume);
    // spawn 失败（找不到可执行文件等）不会走 exit 事件，单独记下原因。
    child.on('error', (error) => {
      this.spawnError = error instanceof Error ? error.message : String(error);
    });

    const pid = child.pid;
    if (pid === undefined) throw new Error('运行时子进程没有启动');

    // 先等地址行出现，再探端口确认可访问。
    const deadline = Date.now() + this.readyTimeoutMs;
    while (bootUrl === undefined && Date.now() < deadline) {
      if (this.spawnError !== undefined) {
        throw new Error(`运行时无法启动：${this.spawnError}`);
      }
      if (child.exitCode !== null) {
        throw new Error(`运行时提前退出（退出码 ${child.exitCode}）：\n${this.output.slice(-40).join('\n')}`);
      }
      await new Promise((settle) => setTimeout(settle, 200));
    }
    if (bootUrl === undefined) {
      throw new Error(`运行时在 ${this.readyTimeoutMs} 毫秒内没有打印地址：\n${this.output.slice(-40).join('\n')}`);
    }
    const origin = new URL(bootUrl);
    await this.#waitForPort(`${origin.origin}/`);
    return { bootUrl, pid, origin: origin.origin };
  }

  /** 停止运行时：先请求终止，超时后强制终止；最后释放锁。 */
  async stop() {
    const child = this.child;
    this.child = undefined;
    if (child !== undefined && child.exitCode === null) {
      child.kill('SIGTERM');
      const exited = new Promise((resolve) => child.once('exit', () => resolve(true)));
      const timer = new Promise((resolve) => setTimeout(() => resolve(false), 5000));
      const graceful = await Promise.race([exited, timer]);
      if (graceful !== true && child.exitCode === null) {
        child.kill('SIGKILL');
      }
    }
    this.#releaseLock();
  }
}
