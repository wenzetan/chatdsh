/**
 * 交互模式。
 *
 * 终端里逐行读命令，按当前终端宽度排版输出。终端尺寸变化时提示新的宽度，后续输出按新宽度
 * 重排，因此窄终端不会横向溢出。颜色由主题决定：非 TTY 不加转义序列，`--color never` 可以
 * 显式关闭。
 * @module @chatdsh/client-cli/interactive
 */

import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { CommandRunner } from './commands.ts';
import { commandGroupOf, commandsOfGroup, completeCommands, helpText, parseCommandLine } from './command-tree.ts';
import type { ChannelEvent, LocalChannel } from './local-channel.ts';
import { CliError, EXIT_CODES, type ExitCode } from './protocol.ts';
import type { Theme } from './theme.ts';

/**
 * 按当前行给出补全候选。
 *
 * 正在输入命令标识时补全命令与命令组；已经进入某个命令组时补全该组的子命令；参数位置不猜值。
 * @param line - 当前行的内容。
 * @returns 候选与替换起点。
 */
export function completeLine(line: string): [string[], string] {
  const tokens = line.trimStart().split(/\s+/u);
  if (tokens.length <= 1) {
    const prefix = tokens[0] ?? '';
    return [completeCommands(prefix), prefix];
  }
  const group = commandGroupOf(tokens[0] ?? '');
  if (group === undefined) return [[], tokens[tokens.length - 1] ?? ''];
  const prefix = tokens[tokens.length - 1] ?? '';
  const candidates = commandsOfGroup(group.id)
    .map((command) => command.id.slice(group.id.length + 1))
    .filter((name) => name.startsWith(prefix));
  return [candidates, prefix];
}

/** 交互运行选项。 */
export interface InteractiveOptions {
  /** 输入流。 */
  readonly input: Readable;
  /** 输出流。 */
  readonly output: Writable;
  /** 诊断行出口。 */
  readonly diagnostics: (line: string) => void;
  /** 命令执行器。 */
  readonly runner: CommandRunner;
  /** 本机通道。 */
  readonly channel: LocalChannel;
  /** 主题。 */
  readonly theme: Theme;
  /** 当前终端宽度。 */
  readonly width: () => number;
  /** 提示符。 */
  readonly prompt?: string;
}

/** 一次交互运行。 */
export interface InteractiveSession {
  /** 退出码。 */
  readonly done: Promise<ExitCode>;
  /**
   * 停止交互。
   * @param reason - 原因。
   */
  stop(reason: string): void;
  /** 终端尺寸变化之后的重新排版。 */
  onResize(): void;
}

/**
 * 启动交互模式。
 * @param options - 选项。
 * @returns 运行句柄。
 */
export function startInteractive(options: InteractiveOptions): InteractiveSession {
  const { input, output, diagnostics, runner, channel, theme } = options;
  const prompt = options.prompt ?? 'chatdsh> ';
  const reader = createInterface({
    input,
    output,
    terminal: true,
    prompt,
    completer: (line: string) => completeLine(line),
  });
  let finished = false;
  let settle: (code: ExitCode) => void = () => {};
  const done = new Promise<ExitCode>((resolve) => {
    settle = resolve;
  });

  /**
   * 打印若干行。
   * @param lines - 文本行。
   */
  const print = (lines: readonly string[]): void => {
    for (const line of lines) output.write(`${line}\n`);
  };

  print([
    theme.paint('heading', 'ChatDSH 本机命令行'),
    theme.paint('muted', `可用列数 ${options.width()}，输入 help 查看命令组，输入 exit 退出。`),
  ]);
  reader.prompt();

  const unsubscribe = channel.subscribe((event: ChannelEvent) => {
    if (finished) return;
    if (event.event === 'session.update') {
      const text = typeof event.text === 'string' ? event.text : '';
      const title = typeof event.title === 'string' ? event.title : '';
      const kind = String(event.kind);
      if (text !== '') output.write(`${theme.paint('accent', kind)} ${text}\n`);
      else if (title !== '') output.write(`${theme.paint('accent', kind)} ${title}\n`);
      else output.write(`${theme.paint('muted', kind)}\n`);
      reader.prompt(true);
      return;
    }
    if (event.event === 'approval.request') {
      output.write(
        `${theme.paint('warning', '待审批')} ${String(event.requestId)} ${String(event.title)}（${String(event.deadlineMs)} 毫秒内应答，否则按拒绝收尾）\n`,
      );
      reader.prompt(true);
      return;
    }
    output.write(`${theme.paint('muted', event.event)} ${JSON.stringify({ ...event })}\n`);
    reader.prompt(true);
  });

  /**
   * 收尾。
   * @param reason - 原因。
   * @param code - 退出码。
   */
  const finish = (reason: string, code: ExitCode = EXIT_CODES.success): void => {
    if (finished) return;
    finished = true;
    unsubscribe();
    reader.close();
    output.write(`${theme.paint('muted', `结束：${reason}`)}\n`);
    settle(code);
  };

  reader.on('line', (line: string) => {
    void (async () => {
      const trimmed = line.trim();
      if (trimmed === '') {
        reader.prompt();
        return;
      }
      if (trimmed === 'exit' || trimmed === 'quit') {
        finish('exit');
        return;
      }
      try {
        const call = parseCommandLine(trimmed);
        if (call.spec.needsChannel && channel.state === 'idle') await channel.open();
        const result = await runner.run(call);
        print(result.text);
      } catch (error) {
        if (error instanceof CliError) {
          output.write(`${theme.paint('danger', `[${error.code}] ${error.message}`)}\n`);
          if (error.code === 'usage' && !trimmed.includes(' ')) print(helpText());
        } else {
          output.write(`${theme.paint('danger', String(error))}\n`);
        }
      }
      if (!finished) reader.prompt();
    })();
  });

  reader.on('close', () => {
    finish('eof');
  });

  return {
    done,
    stop(reason: string): void {
      diagnostics(`收到 ${reason}，结束交互模式`);
      finish(reason, EXIT_CODES.interrupted);
    },
    onResize(): void {
      if (finished) return;
      output.write(`${theme.paint('muted', `终端宽度调整为 ${options.width()} 列`)}\n`);
      reader.prompt(true);
    },
  };
}
