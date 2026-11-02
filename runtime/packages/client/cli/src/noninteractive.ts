/**
 * 非交互模式。
 *
 * stdin 每行一条请求，stdout 每行一条应答或事件，两条流都只有 JSON 对象。诊断信息走 stderr。
 * 退出码按协议合并：出现用法错误为 2，只有运行时错误为 1，全部成功为 0。断管道（`EPIPE`）在
 * 写失败时就地停止读取并正常收尾；外部停止（信号）由调用方触发
 * {@link NonInteractiveSession.stop}。
 * @module @chatdsh/client-cli/noninteractive
 */

import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import type { ChatdshTelemetry } from '@chatdsh/core-contracts';
import type { CommandRunner } from './commands.ts';
import { buildCall, parseCommandLine, type ParsedCall } from './command-tree.ts';
import type { ChannelEvent, LocalChannel } from './local-channel.ts';
import {
  CliError,
  EXIT_CODES,
  eventLine,
  failureLine,
  parseRequestLine,
  serializeLine,
  successLine,
  worstExit,
  type ExitCode,
  type RequestLine,
} from './protocol.ts';
import { recordNonInteractiveExit } from './telemetry.ts';

/** 非交互运行的结果。 */
export interface NonInteractiveResult {
  /** 合并之后的退出码。 */
  readonly exitCode: ExitCode;
  /** 已处理的行数。 */
  readonly handled: number;
  /** 失败的行数。 */
  readonly failed: number;
  /** 收尾原因：`eof`、`epipe` 或调用方给出的原因。 */
  readonly reason: string;
}

/** 非交互运行选项。 */
export interface NonInteractiveOptions {
  /** 输入流。 */
  readonly input: Readable;
  /** 写一行到 stdout；返回假表示管道已断。 */
  readonly write: (text: string) => boolean;
  /** 诊断行出口，写 stderr。 */
  readonly diagnostics: (line: string) => void;
  /** 命令执行器。 */
  readonly runner: CommandRunner;
  /** 本机通道。 */
  readonly channel: LocalChannel;
  /** 遥测出口。 */
  readonly telemetry: ChatdshTelemetry;
}

/** 一次非交互运行。 */
export interface NonInteractiveSession {
  /** 运行结束时的结果。 */
  readonly done: Promise<NonInteractiveResult>;
  /**
   * 停止读取并收尾。
   * @param reason - 收尾原因。
   */
  stop(reason: string): void;
}

/**
 * 启动非交互模式。
 * @param options - 选项。
 * @returns 运行句柄。
 */
export function startNonInteractive(options: NonInteractiveOptions): NonInteractiveSession {
  const { input, write, diagnostics, runner, channel, telemetry } = options;
  const reader = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  let exitCode: ExitCode = EXIT_CODES.success;
  let handled = 0;
  let failed = 0;
  let finished = false;
  let reason: string | undefined;
  let settle: (result: NonInteractiveResult) => void = () => {};
  const done = new Promise<NonInteractiveResult>((resolve) => {
    settle = resolve;
  });

  /**
   * 写一行；管道已断时记下原因。
   * @param text - 一行文本。
   * @returns 写入成功时为真。
   */
  const writeLine = (text: string): boolean => {
    let accepted: boolean;
    try {
      accepted = write(text);
    } catch {
      accepted = false;
    }
    if (!accepted && reason === undefined) reason = 'epipe';
    return accepted;
  };

  const unsubscribe = channel.subscribe((event: ChannelEvent) => {
    if (finished) return;
    writeLine(serializeLine(eventLine(event.event, { ...event })));
  });

  /**
   * 收尾一次运行。
   * @param stopReason - 收尾原因。
   * @param code - 覆盖退出码；信号中断时用。
   */
  const finish = (stopReason: string, code?: ExitCode): void => {
    if (finished) return;
    finished = true;
    if (code !== undefined) exitCode = worstExit(exitCode, code);
    unsubscribe();
    reader.close();
    recordNonInteractiveExit(telemetry, exitCode, stopReason);
    settle({ exitCode, handled, failed, reason: stopReason });
  };

  /**
   * 处理一行请求。
   * @param text - 行内容。
   */
  const handle = async (text: string): Promise<void> => {
    const trimmed = text.trim();
    if (trimmed === '') return;
    let request: RequestLine;
    try {
      request = parseRequestLine(trimmed);
    } catch (error) {
      failed += 1;
      exitCode = worstExit(exitCode, EXIT_CODES.usage);
      const failure = error instanceof CliError ? error : new CliError('usage', String(error));
      const id =
        typeof error === 'object' && error !== null && 'requestId' in error
          ? ((error as { requestId?: string }).requestId ?? '-')
          : '-';
      writeLine(serializeLine(failureLine(id, undefined, failure)));
      return;
    }
    let call: ParsedCall | undefined;
    try {
      call = request.line === undefined
        ? buildCall(request.command as string, request.arguments ?? {})
        : parseCommandLine(request.line);
      if (call.spec.needsChannel && channel.state === 'idle') await channel.open();
      const result = await runner.run(call);
      writeLine(serializeLine(successLine(request.id, call.spec.id, result.data)));
    } catch (error) {
      failed += 1;
      const failure =
        error instanceof CliError ? error : new CliError('runtime', error instanceof Error ? error.message : String(error));
      exitCode = worstExit(exitCode, failure.exitCode);
      writeLine(serializeLine(failureLine(request.id, call?.spec.id ?? request.command, failure)));
    }
  };

  void (async () => {
    for await (const line of reader) {
      await handle(line);
      if (reason === 'epipe') break;
    }
    finish(reason ?? 'eof');
  })();

  return {
    done,
    stop(stopReason: string): void {
      diagnostics(`收到 ${stopReason}，结束非交互模式`);
      finish(stopReason, EXIT_CODES.interrupted);
    },
  };
}
