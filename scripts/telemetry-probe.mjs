// 本机 OpenObserve 探针：向日志、追踪、指标三个信号各写一条，再查询回来核对。
//
// 凭据只从环境变量读取，不落盘：
//   OO_URL   默认 http://127.0.0.1:5080
//   OO_ORG   默认 default
//   OO_USER  OpenObserve 登录邮箱
//   OO_PASS  OpenObserve 登录口令
//
// 用法：node scripts/telemetry-probe.mjs
// 退出码 0 表示三类信号都能写入并查询回来，1 表示任一步失败。
// CHATDSH_TELEMETRY=off 或 DSH_TELEMETRY_DISABLED 非空时直接退出，不写入任何数据。
// 该脚本依赖于 DSH 安装里的 OpenTelemetry 包，路径经 DSH_ROOT 覆盖。

import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const OO_URL = process.env.OO_URL ?? 'http://127.0.0.1:5080';
const OO_ORG = process.env.OO_ORG ?? 'default';
const OO_USER = process.env.OO_USER;
const OO_PASS = process.env.OO_PASS;
const DSH_ROOT = process.env.DSH_ROOT ?? '/usr/local/nvm/versions/node/v24.19.0/lib/node_modules/@deepseek-ai/dsh';

const telemetryOff = (process.env.CHATDSH_TELEMETRY ?? '').toLowerCase() === 'off'
  || (process.env.DSH_TELEMETRY_DISABLED ?? '') !== '';

if (telemetryOff) {
  console.error('遥测已关闭，探针不写入数据。');
  process.exit(1);
}

if (!OO_USER || !OO_PASS) {
  console.error('缺少 OO_USER 或 OO_PASS，凭据只从环境变量读取');
  process.exit(1);
}

const modulePath = (name, subpath) => {
  const require = createRequire(join(DSH_ROOT, 'package.json'));
  return pathToFileURL(require.resolve(name + subpath)).href;
};

const sdkLogs = await import(modulePath('@opentelemetry/sdk-logs', ''));
const sdkTrace = await import(modulePath('@opentelemetry/sdk-trace', ''));
const sdkMetrics = await import(modulePath('@opentelemetry/sdk-metrics', ''));
const transformer = await import(modulePath('@opentelemetry/otlp-transformer', ''));
const exporterBase = await import(modulePath('@opentelemetry/otlp-exporter-base', '/node-http'));
const resources = await import(modulePath('@opentelemetry/resources', ''));

const auth = `Basic ${Buffer.from(`${OO_USER}:${OO_PASS}`).toString('base64')}`;
const probeId = randomBytes(8).toString('hex');
const serviceName = 'chatdsh-probe';
const streamName = 'chatdsh_probe';

function transportOptions(url, timeoutMillis = 3000) {
  return {
    url,
    timeoutMillis,
    headers: async () => ({
      'Content-Type': 'application/json',
      Authorization: auth,
      'stream-name': streamName,
    }),
    agentFactory: exporterBase.httpAgentFactoryFromOptions({ keepAlive: true }),
  };
}

class JsonExporter {
  constructor(url, serializer, helper, componentType) {
    this.delegate = exporterBase.createOtlpHttpExportDelegate(
      transportOptions(url),
      serializer,
      componentType,
      helper,
      undefined,
    );
  }
  export(items, callback) { this.delegate.export(items, callback); }
  forceFlush() { return this.delegate.forceFlush(); }
  shutdown() { return this.delegate.shutdown(); }
}

const resource = resources.resourceFromAttributes({
  'service.name': serviceName,
  'deployment.environment': 'local',
  'chatdsh.instance.id': probeId,
});

const tracerProvider = new sdkTrace.TracerProvider({
  resource,
  spanProcessors: [new sdkTrace.BatchSpanProcessor({
    exporter: new JsonExporter(`${OO_URL}/api/${OO_ORG}/v1/traces`, transformer.JsonTraceSerializer, transformer.TraceExporterMetricsHelper, 'otlp_http_trace_exporter'),
    scheduledDelayMillis: 200,
  })],
});
const tracer = tracerProvider.getTracer('chatdsh.probe', '0.1.0');
const span = tracer.startSpan('chatdsh.probe.run', { attributes: { 'chatdsh.probe.id': probeId } });
span.addEvent('chatdsh.probe.event', { 'chatdsh.probe.id': probeId });

const loggerProvider = new sdkLogs.LoggerProvider({
  resource,
  processors: [new sdkLogs.BatchLogRecordProcessor({
    exporter: new JsonExporter(`${OO_URL}/api/${OO_ORG}/v1/logs`, transformer.JsonLogsSerializer, transformer.LogsExporterMetricsHelper, 'otlp_http_log_exporter'),
    scheduledDelayMillis: 200,
  })],
});
const logger = loggerProvider.getLogger('chatdsh.probe', '0.1.0');
logger.emit({
  severityNumber: 9,
  severityText: 'INFO',
  body: 'telemetry probe log',
  attributes: { 'chatdsh.probe.id': probeId, 'chatdsh.component': '@chatdsh/probe' },
});

const meterProvider = new sdkMetrics.MeterProvider({
  resource,
  readers: [new sdkMetrics.PeriodicExportingMetricReader({
    exporter: new JsonExporter(`${OO_URL}/api/${OO_ORG}/v1/metrics`, transformer.JsonMetricsSerializer, transformer.MetricsExporterMetricsHelper, 'otlp_http_metric_exporter'),
    exportIntervalMillis: 5000,
    exportTimeoutMillis: 3000,
  })],
});
const meter = meterProvider.getMeter('chatdsh.probe', '0.1.0');
meter.createCounter('chatdsh_probe_runs_total', { description: 'probe runs' }).add(1, { 'chatdsh.probe.id': probeId });
meter.createHistogram('chatdsh_probe_duration_seconds', { unit: 's' }).record(0.125, { 'chatdsh.probe.id': probeId });

span.end();

await new Promise((resolve) => setTimeout(resolve, 2000));
await loggerProvider.shutdown();
await tracerProvider.shutdown();
await meterProvider.shutdown();

const nowMicros = Date.now() * 1000;
const startMicros = nowMicros - 3_600_000_000;

async function query(type, stream, sql) {
  const response = await fetch(`${OO_URL}/api/${OO_ORG}/_search?type=${type}&stream=${stream}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify({ query: { sql, start_time: startMicros, end_time: nowMicros } }),
  });
  if (response.status !== 200) throw new Error(`${type}/${stream} 查询返回 ${response.status}: ${await response.text()}`);
  return response.json();
}

const logs = await query('logs', streamName, `select * from ${streamName} where chatdsh_probe_id = '${probeId}' limit 1`);
const traces = await query('traces', streamName, `select * from ${streamName} where chatdsh_probe_id = '${probeId}' limit 1`);
const metrics = await query('metrics', 'chatdsh_probe_runs_total', `select * from chatdsh_probe_runs_total where chatdsh_probe_id = '${probeId}' limit 1`);

const results = [
  ['logs', logs.total === 1],
  ['traces', traces.total === 1],
  ['metrics', metrics.total === 1],
];
for (const [signal, ok] of results) {
  console.log(`${ok ? '通过' : '失败'} ${signal} probe_id=${probeId}`);
}
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
