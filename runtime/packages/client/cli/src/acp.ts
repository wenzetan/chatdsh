/**
 * 本机运行时的子进程传输层。
 *
 * 本机运行时按上游 ACP（Agent Client Protocol）在 stdio 上收发 JSON-RPC 2.0 消息：每行一条
 * 消息，请求带 `id`，通知不带 `id`，服务端也会反向发起请求（权限提示）。这一层只负责帧的
 * 编解码、子进程生命周期与在途请求的收尾，不解释任何业务方法。
 * @module @chatdsh/client-cli/acp
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { CliError } from './protocol.ts';

/** 一条 JSON-RPC 消息。 */
export interface AcpMessage {
  readonly jsonrpc: '2.0';
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

/** 启动本机运行时的命令。 */
export interface RuntimeCommand {
  /** 可执行文件。 */
  readonly file: string;
  /** 启动参数。 */
  readonly args: readonly string[];
}

/** 传输层选项。 */
export interface AcpConnectionOptions {
  /** 启动命令。 */
  readonly command: RuntimeCommand;
  /** 子进程工作目录。 */
  readonly cwd: string;
  /** 子进程环境变量。 */
  readonly env: NodeJS.ProcessEnv;
  /** 收到通知。 */
  readonly onNotification: (message: AcpMessage) => void;
  /** 收到服务端发起的请求；调用方必须用 {@link AcpConnection.respond} 或 `respondError` 收尾。 */
  readonly onRequest: (message: AcpMessage) => void;
  /** 子进程退出。 */
  readonly onExit: (info: { readonly code: number | null; readonly signal: NodeJS.Signals | null }) => void;
  /** 子进程的一行诊断输出。 */
  readonly onDiagnostic: (line: string) => void;
  /** 在途请求在子进程退出后的收尾超时，省略为 0（立即收尾）。 */
  readonly closeTimeoutMs?: number;
}

/** 传输层计数。 */
export interface AcpStats {
  /** 已写入的请求条数。 */
  readonly requests: number;
  /** 已写入的通知条数。 */
  readonly notifications: number;
  /** 已写入的应答条数。 */
  readonly responses: number;
  /** 已写入的全部帧数。 */
  readonly writes: number;
  /** 从子进程读到的帧数。 */
  readonly frames: number;
}

/** 一个在途请求。 */
interface PendingCall {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/** 读取一行的缓冲上限；单条 ACP 消息超过这个长度按协议错误处理。 */
const FRAME_LIMIT = 4 * 1024 * 1024;

/**
 * 本机运行时连接。
 *
 * 打开后写请求、读通知与反向请求；关闭时先停止写，再按 `SIGTERM`、`SIGKILL` 的顺序等待子进程
 * 退出，未结束的在途请求按 `offline` 收尾，因此调用方不会挂起。
 */
export class AcpConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingCall>();
  private readonly options: AcpConnectionOptions;
  private nextId = 1;
  private buffer = '';
  private stderrBuffer = '';
  private closed = false;
  private counters: AcpStats = { requests: 0, notifications: 0, responses: 0, writes: 0, frames: 0 };

  private constructor(options: AcpConnectionOptions) {
    this.options = options;
    this.child = spawn(options.command.file, [...options.command.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.consume(chunk));
    this.child.stderr.on('data', (chunk: string) => this.consumeDiagnostics(chunk));
    this.child.on('error', (error: Error) => {
      this.failAll(new CliError('offline', `本机运行时无法启动：${error.message}`));
    });
    this.child.on('exit', (code, signal) => {
      this.closed = true;
      this.failAll(new CliError('offline', `本机运行时已退出（code=${code ?? 'null'}，signal=${signal ?? 'null'}）`));
      this.options.onExit({ code, signal });
    });
    // 子进程的错误事件不写到 stdout，避免污染行协议。
    this.child.stdin.on('error', (error: Error) => {
      this.options.onDiagnostic(`写入本机运行时失败：${error.message}`);
    });
  }

  /**
   * 启动本机运行时。
   * @param options - 传输层选项。
   * @returns 连接。
   */
  static start(options: AcpConnectionOptions): AcpConnection {
    return new AcpConnection(options);
  }

  /** 子进程标识；进程已退出时为 `undefined`。 */
  get pid(): number | undefined {
    return this.child.pid;
  }

  /** 是否已关闭。 */
  get isClosed(): boolean {
    return this.closed;
  }

  /** 计数快照。 */
  get stats(): AcpStats {
    return { ...this.counters };
  }
  /** 在途请求数量。 */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * 发一个请求并等待应答。
   * @param method - 方法名。
   * @param params - 参数。
   * @param timeoutMs - 等待上限。
   * @returns 应答的 `result`。
   * @throws {CliError} 已关闭时为 `offline`，超时时为 `timeout`，应答为错误时为 `runtime`。
   */
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new CliError('offline', `本机运行时未连接：${method}`));
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CliError('timeout', `${method} 在 ${timeoutMs} 毫秒内没有应答`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
      this.counters = { ...this.counters, requests: this.counters.requests + 1 };
    });
  }

  /**
   * 发一个通知，不等应答。
   * @param method - 方法名。
   * @param params - 参数。
   */
  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.write({ jsonrpc: '2.0', method, params });
    this.counters = { ...this.counters, notifications: this.counters.notifications + 1 };
  }

  /**
   * 应答服务端发起的请求。
   * @param id - 请求标识。
   * @param result - 结果。
   */
  respond(id: number | string, result: unknown): void {
    if (this.closed) return;
    this.write({ jsonrpc: '2.0', id, result });
    this.counters = { ...this.counters, responses: this.counters.responses + 1 };
  }

  /**
   * 用错误应答服务端发起的请求。
   * @param id - 请求标识。
   * @param code - JSON-RPC 错误码。
   * @param message - 错误说明。
   */
  respondError(id: number | string, code: number, message: string): void {
    if (this.closed) return;
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
    this.counters = { ...this.counters, responses: this.counters.responses + 1 };
  }

  /**
   * 关闭连接并等待子进程退出。
   * @param timeoutMs - 从 `SIGTERM` 到 `SIGKILL` 的等待上限。
   */
  async close(timeoutMs: number): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new CliError('offline', '本机运行时连接已关闭'));
    const exited = new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        resolve();
        return;
      }
      this.child.once('exit', () => resolve());
    });
    this.child.stdin.end();
    this.child.kill('SIGTERM');
    const escalate = setTimeout(() => this.child.kill('SIGKILL'), timeoutMs);
    escalate.unref();
    await exited;
    clearTimeout(escalate);
  }

  /**
   * 写一帧。
   * @param message - 消息。
   */
  private write(message: AcpMessage): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
    this.counters = { ...this.counters, writes: this.counters.writes + 1 };
  }

  /**
   * 处理 stdout 分片。
   * @param chunk - 文本分片。
   */
  private consume(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > FRAME_LIMIT) {
      this.buffer = '';
      this.options.onDiagnostic('收到超长的协议帧，已丢弃缓冲');
      return;
    }
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line !== '') this.dispatch(line);
      index = this.buffer.indexOf('\n');
    }
  }

  /**
   * 处理 stderr 分片，按行交给诊断出口。
   * @param chunk - 文本分片。
   */
  private consumeDiagnostics(chunk: string): void {
    this.stderrBuffer += chunk;
    let index = this.stderrBuffer.indexOf('\n');
    while (index >= 0) {
      const line = this.stderrBuffer.slice(0, index);
      this.stderrBuffer = this.stderrBuffer.slice(index + 1);
      if (line.trim() !== '') this.options.onDiagnostic(line);
      index = this.stderrBuffer.indexOf('\n');
    }
  }

  /**
   * 分派一帧。
   * @param line - 一行 JSON。
   */
  private dispatch(line: string): void {
    let message: AcpMessage;
    try {
      message = JSON.parse(line) as AcpMessage;
    } catch {
      this.options.onDiagnostic('收到无法解析的协议帧');
      return;
    }
    this.counters = { ...this.counters, frames: this.counters.frames + 1 };
    const id = message.id;
    if (message.method !== undefined) {
      // 带 method 且带 id 的是服务端请求，必须应答；带 method 不带 id 的是通知。
      if (id === undefined) this.options.onNotification(message);
      else this.options.onRequest(message);
      return;
    }
    if (id === undefined) {
      this.options.onDiagnostic('收到既没有 method 也没有 id 的协议帧');
      return;
    }
    const pending = typeof id === 'number' ? this.pending.get(id) : undefined;
    if (pending === undefined) {
      this.options.onDiagnostic(`收到没有在途请求的应答：${String(id)}`);
      return;
    }
    this.pending.delete(id as number);
    clearTimeout(pending.timer);
    if (message.error !== undefined) {
      pending.reject(new CliError('runtime', `${pending.method} 失败：${message.error.message}`));
      return;
    }
    pending.resolve(message.result ?? {});
  }

  /**
   * 收尾全部在途请求。
   * @param error - 收尾原因。
   */
  private failAll(error: CliError): void {
    for (const [id, call] of this.pending) {
      this.pending.delete(id);
      clearTimeout(call.timer);
      call.reject(error);
    }
  }
}
