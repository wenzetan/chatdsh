/**
 * ChatDSH 本机命令行插件。
 *
 * 交付面分四块：本机 Channel（以子进程启动本机运行时）、命令树（九个命令组，带解析、补全与
 * 帮助）、非交互 JSON 行协议（退出码、信号与断管道）以及命令行贡献点声明（场景、设置区段、
 * 扩展点与状态栏）。交互模式与单条执行共用同一条命令执行路径。
 * @module @chatdsh/client-cli
 */

export {
  AcpConnection,
  type AcpConnectionOptions,
  type AcpMessage,
  type AcpStats,
  type RuntimeCommand,
} from './acp.ts';
export { findDsh, main, parseArguments, USAGE, VERSION, type CliOptions } from './bin.ts';
export {
  buildCall,
  COMMANDS,
  commandGroupOf,
  commandOf,
  commandsOfGroup,
  commandTreeView,
  completeCommands,
  helpText,
  parseCommandLine,
  tokenize,
  usageOf,
  type ArgumentKind,
  type ArgumentSpec,
  type CommandSpec,
  type OptionSpec,
  type ParsedCall,
} from './command-tree.ts';
export { CommandRunner, type CommandResult, type CommandRunnerOptions } from './commands.ts';
export {
  COMMAND_GROUPS,
  EXTENSION_POINTS,
  SCENES,
  STATUS_ENTRIES,
  extensionPointOf,
  sceneOf,
  type CommandGroupContribution,
  type ExtensionPointContribution,
  type SceneContribution,
  type StatusEntryContribution,
} from './contributions.ts';
export {
  DEFAULT_WIDTH,
  formatKeyValue,
  formatTable,
  NARROW_WIDTH,
  padRight,
  terminalWidth,
  textWidth,
  wrapText,
  type Column,
} from './format.ts';
export {
  completeLine,
  startInteractive,
  type InteractiveOptions,
  type InteractiveSession,
} from './interactive.ts';
export {
  LocalChannel,
  type ApprovalDecision,
  type ChannelEvent,
  type ChannelInfo,
  type ChannelState,
  type ChannelStats,
  type ConfigOption,
  type Delivery,
  type LocalChannelOptions,
  type PendingApproval,
  type SessionRecord,
} from './local-channel.ts';
export {
  startNonInteractive,
  type NonInteractiveOptions,
  type NonInteractiveResult,
  type NonInteractiveSession,
} from './noninteractive.ts';
export {
  CliError,
  ERROR_CODES,
  eventLine,
  EXIT_CODES,
  failureLine,
  parseRequestLine,
  PROTOCOL,
  RequestLineError,
  requestLineSchema,
  serializeLine,
  successLine,
  worstExit,
  type ErrorCode,
  type EventLine,
  type ExitCode,
  type RequestLine,
  type ResponseLine,
} from './protocol.ts';
export { createCliTelemetry, recordNonInteractiveExit, type CliTelemetryOptions } from './telemetry.ts';
export { createTheme, hasAnsi, stripAnsi, type ColorMode, type ContrastMode, type StyleName, type Theme, type ThemeOptions } from './theme.ts';
