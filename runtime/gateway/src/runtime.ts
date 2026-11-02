/**
 * 运行时进程编排：由控制平面启动、等待就绪与停止运行时。
 *
 * 单机形态下一个运行时进程；启动命令沿用 DSH 自己的命令行，端口从配置的起始值开始
 * 逐个探测。就绪判定以运行时打印的带令牌地址为准，再探一次该地址确认端口已开。
 * 令牌只用于交给客户端换取会话 cookie，不写入日志与遥测。
 * @module @chatdsh/gateway/runtime
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { ChatdshTelemetry } from '@chatdsh/core-contracts';

/** 运行时启动参数。 */
export interface RuntimeLaunchConfig {
  /** DSH 启动入口：`.js`、`.mjs`、`.cjs` 文件或可执行文件。 */
  readonly bin: string;
  /** profile 名。 */
  readonly profile: string;
  /** 运行时的 DSH_HOME。 */
  readonly home: string;
  /** 子进程工作目录。 */
  readonly cwd: string;
  /** 起始端口；占用时逐个顺延。 */
  readonly port: number;
  /** 等待就绪的上限，单位毫秒。 */
  readonly readyTimeoutMs: number;
}

/** 反代目标的读面。 */
export interface RuntimeTarget {
  /** 监听的基地址，不含令牌。 */
  url(): string;
  /** 换取会话 cookie 的路径与查询串；外部运行时没有可下发的启动路径。 */
  bootPath(): string | undefined;
  /** 是否已经可以转发请求。 */
  ready(): boolean;
}

/** 构造输入。 */
export interface RuntimeSupervisorOptions {
  /** 托管配置；缺省时沿用外部运行时地址。 */
  readonly config: RuntimeLaunchConfig | undefined;
  /** 外部运行时地址，托管配置缺省时使用。 */
  readonly externalUrl: string;
  readonly telemetry: ChatdshTelemetry;
  /** 运行时输出行回调；调用方负责脱敏后留存。 */
  readonly onLog?: (line: string) => void;
}

/** 编排器的状态，供诊断页显示托管事实。 */
export interface RuntimeSupervisorState {
  /** 托管还是外部地址。 */
  readonly mode: 'managed' | 'external';
  /** 当前反代目标。 */
  readonly url: string;
  /** 是否就绪。 */
  readonly ready: boolean;
  /** 托管进程标识；外部地址模式下恒为缺省。 */
  readonly pid: number | undefined;
  /** 启动路径；外部地址模式下恒为缺省。 */
  readonly bootPath: string | undefined;
  /** 最近一次托管进程退出。 */
  readonly lastExit: {
    /** 退出码。 */
    readonly code: number | undefined;
    /** 终止信号。 */
    readonly signal: string | undefined;
    /** 退出时刻。 */
    readonly at: number;
  } | undefined;
}

/**
 * 解析托管配置。
 *
 * 只有显式给出 `CHATDSH_RUNTIME_BIN` 才启动子进程；否则控制平面只做反代，便于测试与
 * 多运行时分派。取值非法时直接抛出，不静默回退到别的入口。
 * @param env - 进程环境变量。
 * @param dataRoot - 数据根。
 * @returns 托管配置；未启用时返回 undefined。
 */
export function parseRuntimeLaunchConfig(env: NodeJS.ProcessEnv, dataRoot: string): RuntimeLaunchConfig | undefined {
  const bin = env.CHATDSH_RUNTIME_BIN;
  if (bin === undefined || bin.trim() === '') return undefined;
  const port = Number.parseInt(env.CHATDSH_RUNTIME_PORT ?? '3080', 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`CHATDSH_RUNTIME_PORT 非法：${env.CHATDSH_RUNTIME_PORT}`);
  const readyTimeoutMs = Number.parseInt(env.CHATDSH_RUNTIME_READY_TIMEOUT_MS ?? '120000', 10);
  if (!Number.isInteger(readyTimeoutMs) || readyTimeoutMs <= 0) {
    throw new Error(`CHATDSH_RUNTIME_READY_TIMEOUT_MS 非法：${env.CHATDSH_RUNTIME_READY_TIMEOUT_MS}`);
  }
  return {
    bin,
    profile: env.CHATDSH_RUNTIME_PROFILE ?? 'chatdsh-web',
    home: env.CHATDSH_RUNTIME_HOME ?? join(dataRoot, 'harness'),
    cwd: env.CHATDSH_RUNTIME_CWD ?? process.cwd(),
    port,
    readyTimeoutMs,
  };
}

/** 判断一个回环端口当前能否绑定。 */
async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

/**
 * 从起始端口开始找一个可绑定的回环端口。
 * @param start - 起始端口。
 * @param attempts - 最多尝试的连续端口数。
 * @returns 可绑定的端口号。
 */
export async function findFreePort(start: number, attempts = 20): Promise<number> {
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

/** 探测地址状态码；连接失败时抛出。 */
function probe(url: string): Promise<number> {
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

/** 抹掉输出里的令牌。 */
function redactToken(text: string): string {
  return text.replace(/(\?|\b)token=[A-Za-z0-9_-]+/g, '$1token=<已隐藏>');
}

/**
 * 运行时进程编排器。
 *
 * 外部地址模式下没有子进程，`start` 只把就绪标记置真；托管模式下先找端口、再启动
 * DSH、从标准输出取启动地址，最后探一次确认可访问。
 */
export class RuntimeSupervisor implements RuntimeTarget {
  private child: ChildProcess | undefined;
  private targetUrl: string;
  private boot: string | undefined;
  private readyFlag = false;
  private lastExit: RuntimeSupervisorState['lastExit'];

  constructor(private readonly options: RuntimeSupervisorOptions) {
    this.targetUrl = options.externalUrl;
  }

  /** 监听地址。 */
  url(): string {
    return this.targetUrl;
  }

  /** 启动路径。 */
  bootPath(): string | undefined {
    return this.boot;
  }

  /** 是否就绪。 */
  ready(): boolean {
    return this.readyFlag;
  }

  /** 状态快照。 */
  state(): RuntimeSupervisorState {
    return {
      mode: this.options.config === undefined ? 'external' : 'managed',
      url: this.targetUrl,
      ready: this.readyFlag,
      pid: this.child?.pid,
      bootPath: this.boot,
      lastExit: this.lastExit,
    };
  }

  /**
   * 启动运行时并等待就绪。
   *
   * 托管模式下同一时刻只允许一个子进程：已经就绪时直接返回。
   * @throws 子进程无法启动、提前退出或超时。
   */
  async start(): Promise<void> {
    const config = this.options.config;
    if (config === undefined) {
      this.readyFlag = true;
      return;
    }
    if (this.readyFlag && this.child !== undefined && this.child.exitCode === null) return;
    const telemetry = this.options.telemetry;
    await telemetry.runSpan('chatdsh.gateway.runtime.lifecycle', {
      action: 'start',
      'runtime.id': 'pending',
    }, async (span) => {
      const port = await findFreePort(config.port);
      const runAsNode = config.bin.endsWith('.js') || config.bin.endsWith('.mjs') || config.bin.endsWith('.cjs');
      const command = runAsNode ? process.execPath : config.bin;
      const args = runAsNode
        ? [config.bin, '--profile', config.profile, '--port', String(port), '--no-open']
        : ['--profile', config.profile, '--port', String(port), '--no-open'];
      const child = spawn(command, args, {
        cwd: config.cwd,
        env: { ...process.env, DSH_HOME: config.home }, // gitleaks:allow
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.child = child;
      child.once('exit', (code, signal) => {
        const afterReady = this.readyFlag;
        this.readyFlag = false;
        this.child = undefined;
        this.lastExit = { code: code ?? undefined, signal: signal ?? undefined, at: Date.now() };
        if (!afterReady) return;
        telemetry.event('chatdsh.gateway.runtime.exited', {
          'runtime.id': this.targetUrl,
          'exit.code': code ?? -1,
          signal: signal ?? 'none',
        });
      });

      let bootUrl: string | undefined;
      let buffered = '';
      let tail = '';
      const consume = (chunk: string): void => {
        buffered += chunk;
        tail = `${tail}${chunk}`.slice(-4000);
        for (const line of redactToken(chunk).split(/\r?\n/)) {
          if (line.trim() !== '') this.options.onLog?.(line);
        }
        if (bootUrl === undefined) {
          const found = buffered.match(/dsh web: (http:\/\/\S+\?token=\S+)/);
          if (found?.[1] !== undefined) bootUrl = found[1];
        }
      };
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', consume);
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', consume);

      const spawnError = new Promise<never>((_resolve, reject) => {
        child.once('error', (error) => reject(new Error(`运行时无法启动：${error.message}`)));
      });
      let ready = false;
      const exited = new Promise<never>((_resolve, reject) => {
        child.once('exit', (code, signal) => {
          if (ready) return;
          reject(new Error(`运行时提前退出（${signal ?? code ?? 'unknown'}）：\n${redactToken(tail).slice(-1200)}`));
        });
      });
      try {
        const deadline = Date.now() + config.readyTimeoutMs;
        while (bootUrl === undefined && Date.now() < deadline) {
          await Promise.race([
            new Promise((settle) => setTimeout(settle, 200)),
            spawnError,
            exited,
          ]);
        }
        if (bootUrl === undefined) throw new Error(`运行时在 ${config.readyTimeoutMs} 毫秒内没有打印启动地址`);
        const parsed = new URL(bootUrl);
        this.targetUrl = `${parsed.protocol}//${parsed.host}`;
        this.boot = `${parsed.pathname}${parsed.search}`;
        // 带令牌访问一次，既验证端口已开，也让运行时完成首次初始化。
        while (Date.now() < deadline) {
          try {
            const status = await probe(bootUrl);
            if (status >= 200 && status < 500) {
              this.readyFlag = true;
              ready = true;
              break;
            }
          } catch {
            // 端口还没开，继续轮询。
          }
          await new Promise((settle) => setTimeout(settle, 200));
        }
        if (!this.readyFlag) throw new Error(`运行时端口在 ${config.readyTimeoutMs} 毫秒内不可访问`);
        span.setAttribute('runtime.id', this.targetUrl);
        span.setAttribute('outcome', 'ready');
        telemetry.event('chatdsh.gateway.runtime.ready', { 'runtime.id': this.targetUrl });
      } catch (error) {
        span.recordException(error);
        span.setAttribute('outcome', 'failed');
        throw error;
      }
    });
  }

  /** 停止托管进程；外部地址模式为空操作。 */
  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.readyFlag = false;
    if (child === undefined || child.exitCode !== null) return;
    await this.options.telemetry.runSpan('chatdsh.gateway.runtime.lifecycle', {
      action: 'stop',
      'runtime.id': this.targetUrl,
    }, async (span) => {
      child.kill('SIGTERM');
      const exited = await Promise.race([
        new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
      ]);
      if (!exited) child.kill('SIGKILL');
      span.setAttribute('outcome', exited ? 'stopped' : 'killed');
    });
    this.boot = undefined;
  }
}

/**
 * 建立运行时编排器。
 * @param options - 托管配置、外部地址、遥测与输出回调。
 * @returns 编排器。
 */
export function createRuntimeSupervisor(options: RuntimeSupervisorOptions): RuntimeSupervisor {
  return new RuntimeSupervisor(options);
}
