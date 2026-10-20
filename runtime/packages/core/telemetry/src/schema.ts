/**
 * 遥测的配置 schema。
 *
 * schema 依赖 schemastery，只在宿主平面（配置树由 DSH 装载）使用；独立进程用
 * `defaultTelemetryConfig` 取得同一组默认值，因此配置模块本身不依赖 schemastery。
 * @module @chatdsh/core-telemetry/schema
 */

import { schema as z } from '@chatdsh/adapter';
import {
  DEFAULT_ENDPOINT,
  DEFAULT_LOG_STREAM,
  DEFAULT_ORGANIZATION,
  DEFAULT_TRACE_STREAM,
  type TelemetryConfig,
} from './config.ts';

/** 配置 schema。 */
export const Config: z<TelemetryConfig> = z.object({
  enabled: z.boolean().default(true),
  noTelemetry: z.boolean().default(false),
  endpoint: z.string().default(DEFAULT_ENDPOINT),
  organization: z.string().default(DEFAULT_ORGANIZATION),
  environment: z.string().default('local'),
  surface: z.string().default('runtime'),
  version: z.string().default('0.1.0'),
  logStream: z.string().default(DEFAULT_LOG_STREAM),
  traceStream: z.string().default(DEFAULT_TRACE_STREAM),
  traceSampleRatio: z.number().default(1),
  logLevel: z.string().default('info'),
  debug: z.boolean().default(false),
  exportIntervalMs: z.number().default(5000),
  exportIntervalMsMetrics: z.number().default(15000),
  exportTimeoutMs: z.number().default(3000),
  batchSize: z.number().default(512),
  queueSize: z.number().default(2048),
  selfMonitorIntervalMs: z.number().default(15000),
});
