/**
 * Hermes 依赖的生命周期托管。
 *
 * 部署给出外部地址时控制平面只记录地址，从不启动或停止外部进程；给出托管入口时控制平面
 * 负责单实例：启动一个子进程、按能力接口探到就绪、子进程退出后标记不可用并回收句柄、
 * 关闭能力时终止并等待回收。地址与凭据只从环境变量读取，凭据只保存变量名。
 *
 * 就绪探测只在启动阶段与关闭阶段发生，运行期不做周期性轮询；发送时的可达判断由调用方
 * 在发送准备阶段发起一次。
 * @module @chatdsh/gateway/backends/supervisor
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import type { ChatdshTelemetry } from '@chatdsh/core-contracts';

/** 环境变量名。 */
export const HERMES_ENV = {
  /** 外部服务地址；给出时使用外部模式。 */
  externalUrl: 'CHATDSH_HERMES_URL',
  /** 托管入口：可执行文件或 `.js` 脚本；给出时使用托管模式。 */
  bin: 'CHATDSH_HERMES_BIN',
  /** 传给托管入口的参数，JSON 字符串数组。 */
  args: 'CHATDSH_HERMES_ARGS',
  /** 托管进程监听的端口，用于拼出探活地址。 */
  port: 'CHATDSH_HERMES_PORT',
  /** 托管进程的数据根，写入子进程的 `HERMES_HOME`。 */
  home: 'CHATDSH_HERMES_HOME',
  /** 凭据所在的环境变量名，缺省为 `HERMES_API_KEY`。 */
  apiKeyEnv: 'CHATDSH_HERMES_API_KEY_ENV',
  /** 等待就绪的上限，单位毫秒。 */
  readyTimeoutMs: 'CHATDSH_HERMES_READY_TIMEOUT_MS',
  /** 单次探活的超时，单位毫秒。 */
  probeTimeoutMs: 'CHATDSH_HERMES_PROBE_TIMEOUT_MS',
} as const;

/** 依赖模式。 */
export type HermesDependencyMode = 'managed' | 'external';

/** 解析之后的依赖配置。 */
export interface HermesDependencyConfig {
  /** 托管还是外部地址。 */
  readonly mode: HermesDependencyMode;
  /** 服务根地址，不含凭据。 */
  readonly url: string;
  /** 托管入口；外部模式下缺省。 */
  readonly bin: string | undefined;
  /** 托管参数。 */
  readonly args: readonly string[];
  /** 托管进程的数据根；缺省时沿用父进程的环境。 */
  readonly home: string | undefined;
  /** 凭据所在的环境变量名。 */
  readonly apiKeyEnv: string;
  /** 等待就绪的上限。 */
  readonly readyTimeoutMs: number;
  /** 单次探活的超时。 */
  readonly probeTimeoutMs: number;
}

/** 就绪判断。 */
export interface HermesReadiness {
  /** 是否可以立即使用。 */
  readonly ready: boolean;
  /** 不可用的原因。 */
  readonly reason?: 'unconfigured' | 'external' | 'unreachable' | 'start-failed' | 'exited';
  /** 附加说明，不含地址之外的敏感内容。 */
  readonly detail?: string;
}

/** 一次子进程退出。 */
export interface HermesChildExit {
  /** 退出码。 */
  readonly code: number | undefined;
  /** 终止信号。 */
  readonly signal: string | undefined;
  /** 退出时刻。 */
  readonly at: number;
  /** 退出是否发生在就绪之后。 */
  readonly afterReady: boolean;
}

/** 依赖状态，供诊断与界面显示。 */
export interface HermesDependencyState {
  /** 部署是否配置了 Hermes。 */
  readonly configured: boolean;
  /** 依赖模式。 */
  readonly mode: HermesDependencyMode | 'unconfigured';
  /** 服务根地址；未配置时为空串。 */
  readonly url: string;
  /** 当前是否就绪。 */
  readonly ready: boolean;
  /** 托管进程标识；外部模式恒为缺省。 */
  readonly pid: number | undefined;
  /** 本次就绪的时刻。 */
  readonly readyAt: number | undefined;
  /** 最近一次退出。 */
  readonly lastExit: HermesChildExit | undefined;
}

/** 构造输入。 */
export interface HermesSupervisorOptions {
  /** 依赖配置；未配置时缺省。 */
  readonly config: HermesDependencyConfig | undefined;
  /** 遥测出口。 */
  readonly telemetry: ChatdshTelemetry;
  /** 输出行回调；调用方负责留存，凭据已在内部脱敏。 */
  readonly onLog?: (line: string) => void;
}

/** 终止之后等待退出的上限。 */
const STOP_GRACE_MS = 5000;

/** 就绪轮询间隔。 */
const READY_POLL_MS = 100;

/** 抹掉输出里的凭据形态。 */
function redact(line: string): string {
  return line
    .replace(/(\?|\b)token=[^\s&]+/g, '$1token=<已隐藏>')
    .replace(/\bBearer\s+[^\s]+/g, 'Bearer <已隐藏>');
}

/** 取一个正整数环境变量。 */
function positiveInteger(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${key} 必须是正整数，收到 ${raw}`);
  return value;
}

/**
 * 读依赖配置。
 *
 * 同时给出外部地址与托管入口时抛出：两种模式的启停责任不同，让其一胜出会让「外部模式
 * 不启停外部进程」这条保证变成猜测。
 * @param env - 进程环境变量。
 * @returns 依赖配置；两者都没有时返回 undefined。
 */
export function readHermesDependencyConfig(env: NodeJS.ProcessEnv): HermesDependencyConfig | undefined {
  const externalUrl = env[HERMES_ENV.externalUrl]?.trim() ?? '';
  const bin = env[HERMES_ENV.bin]?.trim() ?? '';
  if (externalUrl !== '' && bin !== '') {
    throw new Error(`${HERMES_ENV.externalUrl} 与 ${HERMES_ENV.bin} 只能给一个：外部地址模式与托管模式的启停责任不同`);
  }
  const apiKeyEnv = env[HERMES_ENV.apiKeyEnv]?.trim() ?? '';
  const readyTimeoutMs = positiveInteger(env, HERMES_ENV.readyTimeoutMs, 60_000);
  const probeTimeoutMs = positiveInteger(env, HERMES_ENV.probeTimeoutMs, 1500);
  if (externalUrl !== '') {
    const parsed = new URL(externalUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`${HERMES_ENV.externalUrl} 必须是 http 或 https 地址，收到 ${externalUrl}`);
    }
    return {
      mode: 'external',
      url: externalUrl.replace(/\/+$/, ''),
      bin: undefined,
      args: [],
      home: undefined,
      apiKeyEnv: apiKeyEnv === '' ? 'HERMES_API_KEY' : apiKeyEnv,
      readyTimeoutMs,
      probeTimeoutMs,
    };
  }
  if (bin !== '') {
    const port = positiveInteger(env, HERMES_ENV.port, 50011);
    if (port > 65_535) throw new Error(`${HERMES_ENV.port} 超出端口范围：${port}`);
    return {
      mode: 'managed',
      url: `http://127.0.0.1:${port}`,
      bin,
      args: parseArgs(env[HERMES_ENV.args]),
      home: env[HERMES_ENV.home]?.trim() || undefined,
      apiKeyEnv: apiKeyEnv === '' ? 'HERMES_API_KEY' : apiKeyEnv,
      readyTimeoutMs,
      probeTimeoutMs,
    };
  }
  return undefined;
}

/** 解析托管参数。 */
function parseArgs(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${HERMES_ENV.args} 必须是 JSON 字符串数组：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error(`${HERMES_ENV.args} 必须是 JSON 字符串数组`);
  }
  return parsed as string[];
}

/**
 * Hermes 依赖的托管器。
 *
 * 外部模式下没有任何子进程，`ensureReady` 立即返回，`stop` 只记录跳过；托管模式下同一时刻
 * 最多一个子进程，启动用一次性承诺做并发去重。
 */
export class HermesSupervisor {
  private readonly config: HermesDependencyConfig | undefined;
  private readonly telemetry: ChatdshTelemetry;
  private readonly onLog: ((line: string) => void) | undefined;
  private child: ChildProcess | undefined;
  private starting: Promise<HermesReadiness> | undefined;
  private ready = false;
  private readyAt: number | undefined;
  private lastExit: HermesChildExit | undefined;

  constructor(options: HermesSupervisorOptions) {
    this.config = options.config;
    this.telemetry = options.telemetry;
    this.onLog = options.onLog;
  }

  /** 依赖是否配置。 */
  configured(): boolean {
    return this.config !== undefined;
  }

  /** 当前模式，供后端配置的启用条件与诊断使用。 */
  mode(): HermesDependencyMode | 'unconfigured' {
    return this.config === undefined ? 'unconfigured' : this.config.mode;
  }

  /** 服务根地址。 */
  url(): string {
    return this.config?.url ?? '';
  }

  /** 当前状态。 */
  state(): HermesDependencyState {
    return {
      configured: this.config !== undefined,
      mode: this.mode(),
      url: this.url(),
      ready: this.ready,
      pid: this.child?.pid,
      readyAt: this.readyAt,
      lastExit: this.lastExit,
    };
  }

  /**
   * 确保依赖可用。
   *
   * 外部模式只报告已配置，真正的可达判断留给发送准备阶段的那一次请求；托管模式在需要时
   * 启动子进程并等待就绪，启动失败时终止并回收，不留下半启动的进程。
   */
  async ensureReady(): Promise<HermesReadiness> {
    const config = this.config;
    if (config === undefined) return { ready: false, reason: 'unconfigured' };
    if (config.mode === 'external') return { ready: true, reason: 'external' };
    if (this.ready && this.child !== undefined && this.child.exitCode === null) {
      return { ready: true };
    }
    if (this.starting !== undefined) return this.starting;
    const starting = this.startManaged(config).finally(() => {
      this.starting = undefined;
    });
    this.starting = starting;
    return starting;
  }

  /**
   * 停止托管进程。
   *
   * 外部模式下没有任何站在控制平面这一侧的进程，这里不向外发任何信号。
   */
  async stop(): Promise<void> {
    const config = this.config;
    if (config === undefined) return;
    if (config.mode === 'external') {
      await this.telemetry.runSpan('chatdsh.gateway.runtime.lifecycle', {
        action: 'stop',
        'runtime.id': config.url,
      }, async (span) => {
        span.setAttribute('outcome', 'external-skipped');
      });
      return;
    }
    const child = this.child;
    if (child === undefined || child.exitCode !== null) {
      this.reclaim();
      return;
    }
    await this.telemetry.runSpan('chatdsh.gateway.runtime.lifecycle', {
      action: 'stop',
      'runtime.id': config.url,
    }, async (span) => {
      this.ready = false;
      child.kill('SIGTERM');
      const exited = await Promise.race([
        new Promise<boolean>((settle) => child.once('exit', () => settle(true))),
        new Promise<boolean>((settle) => setTimeout(() => settle(false), STOP_GRACE_MS)),
      ]);
      if (!exited) child.kill('SIGKILL');
      span.setAttribute('outcome', exited ? 'stopped' : 'killed');
    });
    this.reclaim();
  }

  /** 启动托管进程并等待就绪。 */
  private startManaged(config: HermesDependencyConfig): Promise<HermesReadiness> {
    return this.telemetry.runSpan('chatdsh.gateway.runtime.lifecycle', {
      action: 'start',
      'runtime.id': config.url,
    }, async (span) => {
      const runAsNode = config.bin !== undefined
        && (config.bin.endsWith('.js') || config.bin.endsWith('.mjs') || config.bin.endsWith('.cjs'));
      const command = runAsNode ? process.execPath : config.bin ?? '';
      const args = runAsNode ? [config.bin ?? '', ...config.args] : [...config.args];
      if (config.home !== undefined) mkdirSync(config.home, { recursive: true });
      const child = spawn(command, args, {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ...(config.home === undefined ? {} : { HERMES_HOME: config.home }),
        }, // gitleaks:allow
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.child = child;
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => this.log(chunk));
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => this.log(chunk));
      let spawnFailure: string | undefined;
      child.once('error', (error) => {
        spawnFailure = `Hermes 无法启动：${error.message}`;
      });
      child.once('exit', (code, signal) => {
        const afterReady = this.ready;
        this.ready = false;
        this.readyAt = undefined;
        this.child = undefined;
        this.lastExit = { code: code ?? undefined, signal: signal ?? undefined, at: Date.now(), afterReady };
        if (afterReady) {
          this.telemetry.event('chatdsh.gateway.runtime.exited', {
            'runtime.id': config.url,
            'exit.code': code ?? -1,
            signal: signal ?? 'none',
          });
        }
      });
      const deadline = Date.now() + config.readyTimeoutMs;
      while (Date.now() < deadline) {
        if (spawnFailure !== undefined) {
          span.setAttribute('outcome', 'failed');
          this.reclaim();
          return { ready: false, reason: 'start-failed', detail: spawnFailure };
        }
        if (this.child === undefined) {
          span.setAttribute('outcome', 'failed');
          return { ready: false, reason: 'exited', detail: '托管进程在就绪之前退出' };
        }
        const probe = await this.probeOnce(config);
        if (probe.ok) {
          this.ready = true;
          this.readyAt = Date.now();
          span.setAttribute('outcome', 'ready');
          this.telemetry.event('chatdsh.gateway.runtime.ready', { 'runtime.id': config.url });
          return { ready: true };
        }
        await new Promise((settle) => setTimeout(settle, READY_POLL_MS));
      }
      span.setAttribute('outcome', 'failed');
      await this.stop();
      return { ready: false, reason: 'start-failed', detail: `在 ${config.readyTimeoutMs} 毫秒内没有就绪` };
    });
  }

  /** 探活一次；失败不抛出。 */
  private async probeOnce(config: HermesDependencyConfig): Promise<{ ok: boolean; detail?: string }> {
    try {
      const response = await fetch(`${config.url}/v1/capabilities`, {
        method: 'GET',
        signal: AbortSignal.timeout(config.probeTimeoutMs),
      });
      await response.text();
      if (response.ok) return { ok: true };
      return { ok: false, detail: `HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 回收句柄与状态。 */
  private reclaim(): void {
    this.child = undefined;
    this.ready = false;
    this.readyAt = undefined;
  }

  /** 输出子进程行。 */
  private log(chunk: string): void {
    if (this.onLog === undefined) return;
    for (const line of redact(chunk).split(/\r?\n/)) {
      if (line.trim() !== '') this.onLog(line);
    }
  }
}

/**
 * 建立一个依赖托管器。
 * @param options - 依赖配置、遥测与输出回调。
 * @returns 托管器。
 */
export function createHermesSupervisor(options: HermesSupervisorOptions): HermesSupervisor {
  return new HermesSupervisor(options);
}
