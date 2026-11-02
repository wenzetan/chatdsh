/**
 * 遥测的配置面与开关判定。
 *
 * 开关采用「任一来源关闭即关闭」，来源与优先级按 `docs/telemetry.md` 第八节：
 * 环境变量、上游开关、设置文件（落到本插件的 `enabled`）、启动参数（落到 `noTelemetry`）、平台。
 * 凭据只从环境变量读取，不写入配置、不写进日志、不进入任何信号。
 * @module @chatdsh/core-diagnostics/config
 */

import type { TelemetryOffReason } from '@chatdsh/core-contracts';

/** 流名前缀。拼装而不写成完整字面量，避免与指标名混淆。 */
const STREAM_PREFIX = 'chatdsh';

/** 默认日志流名。 */
export const DEFAULT_LOG_STREAM = `${STREAM_PREFIX}_logs`;

/** 默认追踪流名。 */
export const DEFAULT_TRACE_STREAM = `${STREAM_PREFIX}_traces`;

/** 默认端点，本机 OpenObserve。 */
export const DEFAULT_ENDPOINT = 'http://127.0.0.1:5080';

/** 本机 OpenObserve 的 OTLP 组织。 */
export const DEFAULT_ORGANIZATION = 'default';

/** 插件配置。 */
export interface TelemetryConfig {
  /** 设置文件与设置页的开关，落到这里。 */
  enabled: boolean;
  /** 启动参数 `--no-telemetry` 落到这里。 */
  noTelemetry: boolean;
  /** OTLP/HTTP 根地址，例如 `http://127.0.0.1:5080`。 */
  endpoint: string;
  /** OTLP 组织名。 */
  organization: string;
  /** 资源属性 `deployment.environment`。 */
  environment: string;
  /** 形态，取 `gateway`、`runtime`、`browser` 等，决定 `service.name`。 */
  surface: string;
  /** 产品版本，写入资源属性。 */
  version: string;
  /** 日志流名。 */
  logStream: string;
  /** 追踪流名。 */
  traceStream: string;
  /** 追踪采样比例，0 到 1。 */
  traceSampleRatio: number;
  /** 日志级别下限，取 `debug`、`info`、`warn`、`error`。 */
  logLevel: string;
  /** 调试模式：记录 `debug` 级别并放开 `error.message`。 */
  debug: boolean;
  /** 日志与追踪的导出间隔。 */
  exportIntervalMs: number;
  /** 指标的导出间隔。 */
  exportIntervalMsMetrics: number;
  /** 导出超时。 */
  exportTimeoutMs: number;
  /** 日志与追踪的批量条数。 */
  batchSize: number;
  /** 日志与追踪的队列长度。 */
  queueSize: number;
  /** 丢弃计数上报间隔。 */
  selfMonitorIntervalMs: number;
}

/** 全部关闭来源的判定结果，任一为真即关闭。 */
export interface SwitchSources {
  /** 环境变量 `CHATDSH_TELEMETRY=off`。 */
  readonly env: boolean;
  /** 上游开关 `DSH_TELEMETRY_DISABLED` 取非空值。 */
  readonly upstream: boolean;
  /** 设置文件、设置页与命令写入的 `telemetry.enabled`。 */
  readonly settings: boolean;
  /** 启动参数 `--no-telemetry`。 */
  readonly flag: boolean;
  /** 当前平台不支持遥测。 */
  readonly platform: boolean;
}

/** 开关判定结果。 */
export interface SwitchState {
  /** 是否开启。 */
  enabled: boolean;
  /** 关闭原因；开启时为 `undefined`。 */
  reason: TelemetryOffReason | undefined;
  /** 各来源的关闭事实，供状态端点报告实际生效的来源。 */
  sources: SwitchSources;
}

/** 运行期从环境变量读到的覆盖项。 */
export interface TelemetryOverrides {
  /** 端点。 */
  endpoint?: string;
  /** 组织。 */
  organization?: string;
  /** 调试模式。 */
  debug?: boolean;
  /** 采样比例。 */
  traceSampleRatio?: number;
  /** HTTP Basic 的用户名。 */
  authUser?: string;
  /** HTTP Basic 的口令。 */
  authPassword?: string;
}

function readEnv(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

/** 从环境变量读运行期覆盖项。凭据缺失时返回 `undefined` 字段，导出被跳过并计数。 */
export function readOverrides(env: NodeJS.ProcessEnv = process.env): TelemetryOverrides {
  const ratio = readEnv(env, 'CHATDSH_TELEMETRY_TRACE_SAMPLE_RATIO');
  const parsedRatio = ratio === undefined ? undefined : Number.parseFloat(ratio);
  return {
    endpoint: readEnv(env, 'CHATDSH_TELEMETRY_ENDPOINT', 'OO_URL'),
    organization: readEnv(env, 'CHATDSH_TELEMETRY_ORG', 'OO_ORG'),
    debug: readEnv(env, 'CHATDSH_TELEMETRY_DEBUG') === '1',
    traceSampleRatio: parsedRatio === undefined || Number.isNaN(parsedRatio) ? undefined : parsedRatio,
    authUser: readEnv(env, 'CHATDSH_TELEMETRY_USER', 'OO_USER'),
    authPassword: readEnv(env, 'CHATDSH_TELEMETRY_PASSWORD', 'OO_PASS'),
  };
}

/**
 * 生成一份完整的遥测配置。
 *
 * 宿主平面插件由配置树给出配置，独立进程（控制平面、命令行、MCP 服务端）用这个工厂取得
 * 同一组默认值，再按自身形态覆盖形态名与版本。
 * @param overrides - 形态、版本、部署环境等按端不同的取值。
 * @returns 补齐默认值后的配置。
 */
export function defaultTelemetryConfig(overrides: Partial<TelemetryConfig> = {}): TelemetryConfig {
  return {
    enabled: true,
    noTelemetry: false,
    endpoint: DEFAULT_ENDPOINT,
    organization: DEFAULT_ORGANIZATION,
    environment: 'local',
    surface: 'runtime',
    version: '0.1.0',
    logStream: DEFAULT_LOG_STREAM,
    traceStream: DEFAULT_TRACE_STREAM,
    traceSampleRatio: 1,
    logLevel: 'info',
    debug: false,
    exportIntervalMs: 5000,
    exportIntervalMsMetrics: 15000,
    exportTimeoutMs: 3000,
    batchSize: 512,
    queueSize: 2048,
    selfMonitorIntervalMs: 15000,
    ...overrides,
  };
}

/**
 * 判定开关状态。
 *
 * 顺序即优先级：环境变量与上游开关优先于设置文件，设置文件优先于启动参数，
 * 平台判定在最后，因为它是能力缺失而不是用户选择。每个来源都给出独立结果，
 * 状态端点据此报告全部生效来源。
 * @param config - 插件配置。
 * @param env - 进程环境变量。
 * @param platformSupported - 当前平台是否支持遥测。
 * @returns 开关状态、关闭原因与各来源的判定结果。
 */
export function resolveSwitch(
  config: TelemetryConfig,
  env: NodeJS.ProcessEnv = process.env,
  platformSupported = true,
): SwitchState {
  const sources: SwitchSources = {
    env: (env.CHATDSH_TELEMETRY ?? '').toLowerCase() === 'off',
    upstream: (env.DSH_TELEMETRY_DISABLED ?? '') !== '',
    settings: !config.enabled,
    flag: config.noTelemetry,
    platform: !platformSupported,
  };
  if (sources.env || sources.upstream) return { enabled: false, reason: 'env', sources };
  if (sources.settings) return { enabled: false, reason: 'settings', sources };
  if (sources.flag) return { enabled: false, reason: 'flag', sources };
  if (sources.platform) return { enabled: false, reason: 'platform', sources };
  return { enabled: true, reason: undefined, sources };
}

/** 热切换时等待在途记录导出的上限，超过后放弃剩余记录并计数。 */
export const SWITCH_FLUSH_MS = 3000;
