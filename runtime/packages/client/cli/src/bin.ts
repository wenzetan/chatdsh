/**
 * 命令行入口。
 *
 * 解析启动参数，按 stdin 是否终端选择交互或非交互模式，装配本机通道、命令执行器、主题与遥测。
 * 进程退出前统一收尾：关闭通道、刷新遥测，信号按 130 退出，断管道按 0 正常结束。
 * @module @chatdsh/client-cli/bin
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CommandRunner } from './commands.ts';
import { helpText, parseCommandLine, type ParsedCall } from './command-tree.ts';
import { terminalWidth } from './format.ts';
import { startInteractive, type InteractiveSession } from './interactive.ts';
import { LocalChannel } from './local-channel.ts';
import { startNonInteractive, type NonInteractiveSession } from './noninteractive.ts';
import { CliError, EXIT_CODES, failureLine, serializeLine, successLine, type ExitCode } from './protocol.ts';
import { createCliTelemetry } from './telemetry.ts';
import { createTheme, type ColorMode, type ContrastMode } from './theme.ts';

/** 产品版本。 */
export const VERSION = '0.1.0';

/** 启动参数。 */
export interface CliOptions {
  /** 运行时 profile 名。 */
  readonly profile: string;
  /** 运行时启动器路径。 */
  readonly dsh: string;
  /** 工作区目录。 */
  readonly workspace: string;
  /** 颜色取值。 */
  readonly color: ColorMode;
  /** 对比度。 */
  readonly contrast: ContrastMode;
  /** 审批无人应答时的等待上限。 */
  readonly approvalTimeoutMs: number;
  /** 是否关闭遥测。 */
  readonly noTelemetry: boolean;
  /** 输出格式；`auto` 在 stdout 是终端时用文本，否则用 JSON 行。 */
  readonly format: 'auto' | 'json' | 'text';
  /** 单条命令。 */
  readonly command: string | undefined;
}

/** 帮助文本。 */
export const USAGE: readonly string[] = [
  '用法：chatdsh-cli [选项] [命令 [参数...]]',
  '',
  '选项：',
  '  --profile <名称>           运行时 profile，默认 chatdsh-acp',
  '  --dsh <路径>               运行时启动器，默认按 DSH_BIN、当前 node 目录与 PATH 查找',
  '  --workspace <路径>         工作区目录，默认当前目录',
  '  --color <auto|always|never> 颜色，默认 auto（非 TTY 不加转义序列）',
  '  --contrast <normal|high>   对比度，high 只用粗体与下划线',
  '  --approval-timeout <毫秒>  审批无人应答时的等待上限，默认 30000',
  '  --no-telemetry             关闭遥测',
  '  --json                     强制非交互 JSON 行模式',
  '  --format <auto|json|text>  单条命令的输出格式，默认 auto（stdout 是终端时用文本）',
  '  -e, --execute <命令>       执行一条命令后退出',
  '  --version                  打印版本',
  '  --help                     打印本帮助',
  '',
  '不给命令且 stdin 是终端时进入交互模式；否则按行读取 JSON 请求并逐行输出 JSON。',
];

/**
 * 查找运行时启动器。
 * @param env - 环境变量。
 * @returns 可执行文件路径。
 */
export function findDsh(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.DSH_BIN;
  if (fromEnv !== undefined && fromEnv !== '' && existsSync(fromEnv)) return fromEnv;
  const beside = join(dirname(process.execPath), 'dsh');
  if (existsSync(beside)) return beside;
  for (const dir of (env.PATH ?? '').split(':')) {
    if (dir === '') continue;
    const candidate = join(dir, 'dsh');
    if (existsSync(candidate)) return candidate;
  }
  return 'dsh';
}

/**
 * 解析启动参数。
 * @param argv - 参数，不含 node 与脚本路径。
 * @param env - 环境变量。
 * @returns 选项。
 * @throws {CliError} 用法错误。
 */
export function parseArguments(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  let profile = env.CHATDSH_CLI_PROFILE ?? 'chatdsh-acp';
  let dsh = env.DSH_BIN ?? '';
  let workspace = process.cwd();
  let color: ColorMode = 'auto';
  let contrast: ContrastMode = 'normal';
  let approvalTimeoutMs = 30_000;
  let noTelemetry = false;
  let format: 'auto' | 'json' | 'text' = 'auto';
  let command: string | undefined;
  const help = { value: false };
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token === '--help' || token === '-h') {
      help.value = true;
      continue;
    }
    if (token === '--version' || token === '-V') {
      rest.push(token);
      continue;
    }
    if (token === '--no-telemetry') {
      noTelemetry = true;
      continue;
    }
    if (token === '--json') {
      format = 'json';
      continue;
    }
    if (token === '-e' || token === '--execute') {
      const value = argv[++index];
      if (value === undefined) throw new CliError('usage', '--execute 缺少取值');
      command = value;
      continue;
    }
    if (token.startsWith('--')) {
      const equals = token.indexOf('=');
      const name = equals < 0 ? token.slice(2) : token.slice(2, equals);
      const value = equals < 0 ? argv[++index] : token.slice(equals + 1);
      if (value === undefined) throw new CliError('usage', `--${name} 缺少取值`);
      switch (name) {
        case 'profile':
          profile = value;
          break;
        case 'dsh':
          dsh = value;
          break;
        case 'workspace':
          workspace = resolve(value);
          break;
        case 'color':
          if (value !== 'auto' && value !== 'always' && value !== 'never') {
            throw new CliError('usage', '--color 只接受 auto、always、never');
          }
          color = value;
          break;
        case 'contrast':
          if (value !== 'normal' && value !== 'high') {
            throw new CliError('usage', '--contrast 只接受 normal、high');
          }
          contrast = value;
          break;
        case 'approval-timeout': {
          const parsed = Number(value);
          if (!Number.isInteger(parsed) || parsed <= 0) {
            throw new CliError('usage', '--approval-timeout 需要正整数毫秒');
          }
          approvalTimeoutMs = parsed;
          break;
        }
        case 'format':
          if (value !== 'auto' && value !== 'json' && value !== 'text') {
            throw new CliError('usage', '--format 只接受 auto、json、text');
          }
          format = value;
          break;
        default:
          throw new CliError('usage', `不认识的启动参数：--${name}`);
      }
      continue;
    }
    rest.push(token);
  }
  if (help.value) rest.push('--help');
  return {
    profile,
    dsh: dsh === '' ? findDsh(env) : dsh,
    workspace,
    color,
    contrast,
    approvalTimeoutMs,
    noTelemetry,
    format,
    command: command ?? (rest.length > 0 && rest[0] !== '--version' && rest[0] !== '--help' ? rest.join(' ') : undefined),
  };
}

/** 一次运行的收尾钩子。 */
interface Cleanup {
  /**
   * 收尾。
   * @param reason - 原因。
   */
  (reason: string): Promise<void>;
}

/**
 * 主入口。
 * @param argv - 参数。
 * @returns 退出码。
 */
export async function main(argv: readonly string[]): Promise<number> {
  const wantsHelp = argv.includes('--help') || argv.includes('-h');
  const wantsVersion = argv.includes('--version') || argv.includes('-V');
  let options: CliOptions;
  try {
    options = parseArguments(argv);
  } catch (error) {
    const failure = error instanceof CliError ? error : new CliError('usage', String(error));
    process.stderr.write(`${failure.message}\n`);
    for (const line of USAGE) process.stderr.write(`${line}\n`);
    return failure.exitCode;
  }
  if (wantsHelp) {
    for (const line of USAGE) process.stdout.write(`${line}\n`);
    process.stdout.write('\n');
    for (const line of helpText()) process.stdout.write(`${line}\n`);
    return EXIT_CODES.success;
  }
  if (wantsVersion) {
    process.stdout.write(`${VERSION}\n`);
    return EXIT_CODES.success;
  }

  const isTTY = process.stdin.isTTY === true;
  const theme = createTheme({ color: options.color, contrast: options.contrast, isTTY: process.stdout.isTTY === true });
  const telemetry = createCliTelemetry({
    env: process.env,
    version: VERSION,
    noTelemetry: options.noTelemetry,
  });
  const channel = new LocalChannel({
    runtime: { file: options.dsh, args: ['--profile', options.profile] },
    cwd: options.workspace,
    env: process.env,
    telemetry,
    approvalTimeoutMs: options.approvalTimeoutMs,
    onDiagnostic: (line) => {
      // 运行时自己的诊断行已经带前缀，这里原样转发到 stderr，stdout 只保留协议行。
      process.stderr.write(`${line}\n`);
    },
  });
  const runner = new CommandRunner({
    channel,
    telemetry,
    theme,
    width: terminalWidth(process.stdout.columns, process.env),
    workspace: options.workspace,
    runId: `${process.pid}-${Date.now()}`,
  });

  /**
   * 关闭通道并刷新遥测。
   * @param reason - 原因。
   */
  const cleanup: Cleanup = async (reason: string) => {
    await channel.close(reason);
    await telemetry.flush(1_500);
    await telemetry.shutdown();
  };

  // 断管道：写到 stdout 的管道断掉时按正常结束收尾，不打印错误调用明细。
  const onOutputError = (error: NodeJS.ErrnoException): void => {
    if (error.code === 'EPIPE') {
      void cleanup('epipe').then(() => process.exit(EXIT_CODES.success));
      return;
    }
    process.stderr.write(`stdout 写入失败：${error.message}\n`);
  };
  process.stdout.on('error', onOutputError);

  const commandToRun = options.command;
  const outputJson = options.format === 'json' || (options.format === 'auto' && process.stdout.isTTY !== true);
  if (commandToRun !== undefined) {
    return runOnce(commandToRun, { channel, runner, telemetry, cleanup, json: outputJson });
  }

  if (isTTY && options.format !== 'json') {
    return runInteractive({ channel, runner, theme, cleanup, width: () => terminalWidth(process.stdout.columns, process.env) });
  }
  return runLines({ channel, runner, telemetry, cleanup });
}

/**
 * 执行单条命令。
 * @param text - 命令原文。
 * @param io - 依赖。
 * @returns 退出码。
 */
async function runOnce(
  text: string,
  io: {
    readonly channel: LocalChannel;
    readonly runner: CommandRunner;
    readonly telemetry: ReturnType<typeof createCliTelemetry>;
    readonly cleanup: Cleanup;
    readonly json: boolean;
  },
): Promise<number> {
  let exitCode: ExitCode = EXIT_CODES.success;
  let call: ParsedCall | undefined;
  try {
    call = parseCommandLine(text);
    if (call.spec.needsChannel && io.channel.state === 'idle') await io.channel.open();
    const result = await io.runner.run(call);
    if (io.json) {
      process.stdout.write(serializeLine(successLine('single', call.spec.id, result.data)));
    } else {
      for (const line of result.text) process.stdout.write(`${line}\n`);
    }
  } catch (error) {
    const failure = error instanceof CliError ? error : new CliError('runtime', error instanceof Error ? error.message : String(error));
    exitCode = failure.exitCode;
    if (io.json) {
      process.stdout.write(serializeLine(failureLine('single', call?.spec.id, failure)));
    }
    process.stderr.write(`${failure.message}\n`);
  }
  await io.cleanup('once');
  return exitCode;
}

/**
 * 运行交互模式。
 * @param io - 依赖。
 * @returns 退出码。
 */
async function runInteractive(io: {
  readonly channel: LocalChannel;
  readonly runner: CommandRunner;
  readonly theme: ReturnType<typeof createTheme>;
  readonly cleanup: Cleanup;
  readonly width: () => number;
}): Promise<number> {
  const session: InteractiveSession = startInteractive({
    input: process.stdin,
    output: process.stdout,
    diagnostics: (line) => process.stderr.write(`${line}\n`),
    runner: io.runner,
    channel: io.channel,
    theme: io.theme,
    width: io.width,
  });
  const onResize = (): void => session.onResize();
  process.stdout.on('resize', onResize);
  const onSignal = (signal: NodeJS.Signals): void => {
    session.stop(signal);
  };
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const handler = (): void => onSignal(signal);
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  const code = await session.done;
  for (const [signal, handler] of handlers) process.off(signal, handler);
  process.stdout.off('resize', onResize);
  await io.cleanup('interactive');
  return code;
}

/**
 * 按行读写 JSON。
 * @param io - 依赖。
 * @returns 退出码。
 */
async function runLines(io: {
  readonly channel: LocalChannel;
  readonly runner: CommandRunner;
  readonly telemetry: ReturnType<typeof createCliTelemetry>;
  readonly cleanup: Cleanup;
}): Promise<number> {
  const session: NonInteractiveSession = startNonInteractive({
    input: process.stdin,
    write: (text) => process.stdout.write(text),
    diagnostics: (line) => process.stderr.write(`${line}\n`),
    runner: io.runner,
    channel: io.channel,
    telemetry: io.telemetry,
  });
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const handler = (): void => session.stop(signal);
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  const result = await session.done;
  for (const [signal, handler] of handlers) process.off(signal, handler);
  await io.cleanup('noninteractive');
  return result.exitCode;
}

// 直接执行时启动进程；被测试或其他模块导入时不启动。
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  void main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
