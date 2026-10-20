/**
 * 桌面载体的启动编排。
 *
 * 桌面壳负责把一个自托管实例拉起来：取单实例锁、建立中立的启动根、启动控制平面、
 * 等运行时端口就绪，然后才把窗口指过去。这一段不依赖 Electron，可以单独运行与验证；
 * 窗口、托盘与原生能力留在主进程的壳层。
 * @module @chatdsh/desktop
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';

/** 探测一个地址的状态码；连接失败时抛出。 */
function probe(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: 'GET', timeout: 1000 }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    request.end();
  });
}

/** 编排输入。 */
export interface OrchestratorOptions {
  /** 中立的启动根：控制平面的数据与锁文件都放在这里。 */
  readonly launchRoot: string;
  /** 控制平面的启动命令。 */
  readonly gateway: { readonly command: string; readonly args: readonly string[] };
  /** 控制平面地址。 */
  readonly gatewayUrl: string;
  /** 等待就绪的运行时地址。 */
  readonly runtimeUrl: string;
  /** 就绪等待上限。 */
  readonly readyTimeoutMs: number;
  /** 子进程环境变量；缺省继承当前进程。 */
  readonly processEnv?: NodeJS.ProcessEnv;
}

/** 启动结果。 */
export interface StartedInstance {
  /** 控制平面地址。 */
  readonly gatewayUrl: string;
  /** 控制平面进程号。 */
  readonly pid: number;
}

/** 单实例锁被占用。 */
export class AlreadyRunningError extends Error {
  constructor(readonly ownerPid: number) {
    super(`实例已在运行（进程 ${ownerPid}）`);
    this.name = 'AlreadyRunningError';
  }
}

/** 锁文件路径。 */
function lockPath(launchRoot: string): string {
  return join(launchRoot, 'instance.lock');
}

/** 判断进程是否存活。 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 桌面实例的编排器。
 *
 * 启动顺序固定：取锁 → 建启动根 → 启动控制平面 → 等控制平面健康 → 等运行时就绪。
 * 任何一步失败都按失败上报，不留下半个实例：已启动的进程在 `stop` 里回收。
 */
export class DesktopOrchestrator {
  private child: ChildProcess | undefined;
  private locked = false;
  private readonly output: string[] = [];

  constructor(private readonly options: OrchestratorOptions) {}

  /** 启动实例并等到就绪。 */
  async start(): Promise<StartedInstance> {
    mkdirSync(this.options.launchRoot, { recursive: true });
    this.acquireLock();

    const child = spawn(this.options.gateway.command, [...this.options.gateway.args], {
      cwd: this.options.launchRoot,
      env: this.options.processEnv ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    // 子进程的输出必须被消费：管道写满会阻塞子进程，而失败诊断也要靠它。
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.remember(chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => this.remember(chunk));

    const pid = child.pid;
    if (pid === undefined) throw new Error('控制平面进程没有启动');

    try {
      await this.waitForHealth(`${this.options.gatewayUrl}/healthz`, this.options.readyTimeoutMs, '控制平面');
      await this.waitForHealth(`${this.options.runtimeUrl}/`, this.options.readyTimeoutMs, '运行时', true);
    } catch (error) {
      await this.stop();
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n控制平面输出：\n${this.output.join('').slice(-2000)}`);
    }
    return { gatewayUrl: this.options.gatewayUrl, pid };
  }

  private remember(chunk: string): void {
    this.output.push(chunk);
    if (this.output.length > 200) this.output.splice(0, this.output.length - 200);
  }

  /** 停止实例：先停控制平面，再释放锁。 */
  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (child !== undefined && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((settle) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          settle();
        }, 5000);
        child.once('exit', () => {
          clearTimeout(timer);
          settle();
        });
      });
    }
    this.releaseLock();
  }

  /** 进程环境变量的扩展点。 */
  private acquireLock(): void {
    const path = lockPath(this.options.launchRoot);
    try {
      const owner = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
      if (Number.isInteger(owner) && isAlive(owner)) throw new AlreadyRunningError(owner);
    } catch (error) {
      if (error instanceof AlreadyRunningError) throw error;
      // 锁文件不存在或内容不可读：视为没有实例，直接覆盖。
    }
    const fd = openSync(path, 'w');
    try {
      writeFileSync(fd, String(process.pid));
    } finally {
      closeSync(fd);
    }
    this.locked = true;
  }

  private releaseLock(): void {
    if (!this.locked) return;
    this.locked = false;
    rmSync(lockPath(this.options.launchRoot), { force: true });
  }

  /**
   * 轮询一个地址直到它有响应；`acceptAnyStatus` 用于「端口已开即算就绪」的等待。
   *
   * 这里用 node:http 直连而不是 fetch：就绪探测必须落在目标端口上，不能经过任何可能
   * 改写目标的环境设置。
   */
  private async waitForHealth(url: string, timeoutMs: number, label: string, acceptAnyStatus = false): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const status = await probe(url);
        if (status >= 200 && status < 300) return;
        if (acceptAnyStatus && status > 0) return;
        lastError = new Error(`HTTP ${status}`);
      } catch (error) {
        lastError = error;
      }
      await new Promise((settle) => setTimeout(settle, 250));
    }
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`${label}在 ${timeoutMs} 毫秒内没有就绪：${url} → ${detail}`);
  }
}

/**
 * 建立编排器。
 * @param options - 启动根、控制平面命令、两个地址与就绪上限。
 * @returns 编排器。
 */
export function createOrchestrator(options: OrchestratorOptions): DesktopOrchestrator {
  return new DesktopOrchestrator(options);
}
