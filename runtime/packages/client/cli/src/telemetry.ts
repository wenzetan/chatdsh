/**
 * 命令行的遥测出口。
 *
 * 命令行是独立进程，进程形态固定为 `chatdsh-cli`。这里只构造 `@chatdsh/core-diagnostics` 的
 * 客户端并把形态与版本写进配置，业务代码拿到的仍是同一套 `ChatdshTelemetry` 方法；关闭开关
 * 由客户端自己判定，关闭之后不构造 SDK 对象、不出网。
 * @module @chatdsh/client-cli/telemetry
 */

import type { ChatdshTelemetry } from '@chatdsh/core-contracts';
import { createTelemetryClient } from '@chatdsh/core-diagnostics/client';
import { defaultTelemetryConfig } from '@chatdsh/core-diagnostics/config';

/** 遥测出口选项。 */
export interface CliTelemetryOptions {
  /** 环境变量，交给客户端判定全部关闭来源。 */
  readonly env: NodeJS.ProcessEnv;
  /** 产品版本，写进资源属性。 */
  readonly version: string;
  /** 启动参数 `--no-telemetry`。 */
  readonly noTelemetry: boolean;
  /** 产生信号的包名。 */
  readonly component?: string;
}

/**
 * 构造命令行遥测出口。
 * @param options - 选项。
 * @returns 遥测客户端。
 */
export function createCliTelemetry(options: CliTelemetryOptions): ChatdshTelemetry {
  return createTelemetryClient({
    config: defaultTelemetryConfig({
      surface: 'cli',
      version: options.version,
      noTelemetry: options.noTelemetry,
      environment: options.env.DEPLOYMENT_ENVIRONMENT ?? 'local',
    }),
    component: options.component ?? '@chatdsh/client-cli',
    env: options.env,
  });
}

/**
 * 记录一次非交互模式退出。
 * @param telemetry - 遥测出口。
 * @param exitCode - 退出码。
 * @param reason - 退出原因，取有界枚举。
 */
export function recordNonInteractiveExit(
  telemetry: ChatdshTelemetry,
  exitCode: number,
  reason: string,
): void {
  telemetry.event('chatdsh.cli.noninteractive.exit', { 'exit.code': exitCode, reason });
}
