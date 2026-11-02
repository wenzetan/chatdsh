/**
 * 导出面板的数据入口。
 *
 * 面板按同源相对路径访问控制平面的真实接口：预估、建立、列举、读取单条、取消与下载。
 * 返回值在这里逐项核对形状，形状不符按失败抛出并带上错误码，界面据码给出说明，不把残缺
 * 数据渲染成成功。下载响应按附件处理，文件名优先取 `Content-Disposition` 的 UTF-8 部分。
 * @module @chatdsh/client-exports/gateway
 */

import type {
  AttachmentPolicy,
  ExportAttachmentView,
  ExportEstimateView,
  ExportGateway,
  ExportJobList,
  ExportJobView,
  ExportScopeView,
  ExportSelection,
  ExportSource,
  PanelTelemetry,
  ExportAttachmentState,
  ExportFormat,
  ExportState,
} from './types.ts';
import { ATTACHMENT_POLICIES, EXPORT_ATTACHMENT_STATES, EXPORT_FORMATS, EXPORT_STATES } from './types.ts';
import { scopeOf } from './scope.ts';

/** 预估路径。 */
export const ESTIMATE_PATH = '/chatdsh/gateway/export/estimate';

/** 任务集合路径。 */
export const JOBS_PATH = '/chatdsh/gateway/exports';

/** 写操作要求的请求头，跨站表单无法携带。 */
export const CSRF_HEADER = 'x-chatdsh-csrf';

/** 一次调用失败。 */
export class ExportCallError extends Error {
  /**
   * @param code - 错误码，取自返回体或本端的失败分类。
   * @param message - 面向用户的说明。
   * @param status - HTTP 状态码；没有拿到应答时为 0。
   * @param reason - 控制平面给出的具体条件，可以缺省。
   */
  constructor(readonly code: string, message: string, readonly status = 0, readonly reason?: string) {
    super(message);
    this.name = 'ExportCallError';
  }
}

/** 断言一个对象。 */
function requireRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ExportCallError('gateway/internal', `${what}的返回形状不符合约定`);
  }
  return value as Record<string, unknown>;
}

/** 断言一个字符串。 */
function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new ExportCallError('gateway/internal', `${what}的返回形状不符合约定`);
  }
  return value;
}

/** 断言一个非负数值。 */
function requireNumber(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ExportCallError('gateway/internal', `${what}的返回形状不符合约定`);
  }
  return value;
}

/** 读导出源。 */
function sourceOf(value: unknown): ExportSource {
  const record = requireRecord(value, '导出源');
  const kind = record['kind'];
  if (kind === 'session') return { kind: 'session', sessionId: requireString(record['sessionId'], '导出源') };
  if (kind === 'artifact') {
    return {
      kind: 'artifact',
      artifactId: requireString(record['artifactId'], '导出源'),
      version: requireNumber(record['version'], '导出源'),
    };
  }
  throw new ExportCallError('gateway/internal', '导出源的种类不符合约定');
}

/** 读附件。 */
function attachmentOf(value: unknown): ExportAttachmentView {
  const record = requireRecord(value, '附件');
  const state = record['state'];
  if (typeof state !== 'string' || !(EXPORT_ATTACHMENT_STATES as readonly string[]).includes(state)) {
    throw new ExportCallError('gateway/internal', '附件状态不符合约定');
  }
  return {
    id: requireString(record['id'], '附件'),
    filename: requireString(record['filename'], '附件'),
    state: state as ExportAttachmentState,
    ...(record['size'] === undefined ? {} : { size: requireNumber(record['size'], '附件') }),
  };
}

/** 读附件列表。 */
function attachmentsOf(value: unknown, what: string): ExportAttachmentView[] {
  if (!Array.isArray(value)) throw new ExportCallError('gateway/internal', `${what}的附件清单不符合约定`);
  return value.map(attachmentOf);
}

/** 读预估。 */
function estimateOf(value: unknown): ExportEstimateView {
  const record = requireRecord(value, '预估');
  return {
    eventCount: requireNumber(record['eventCount'], '预估'),
    charCount: requireNumber(record['charCount'], '预估'),
    bytes: requireNumber(record['bytes'], '预估'),
    attachments: attachmentsOf(record['attachments'], '预估'),
  };
}

/** 读内容范围。 */
function scopeOfValue(value: unknown): ExportScopeView {
  const record = requireRecord(value, '导出范围');
  const scope = requireRecord(record['scope'], '导出范围');
  const format = record['format'];
  if (typeof format !== 'string' || !(EXPORT_FORMATS as readonly string[]).includes(format)) {
    throw new ExportCallError('gateway/internal', '导出格式不符合约定');
  }
  const policy = record['attachmentPolicy'];
  if (typeof policy !== 'string' || !(ATTACHMENT_POLICIES as readonly string[]).includes(policy)) {
    throw new ExportCallError('gateway/internal', '附件处理方式不符合约定');
  }
  return {
    source: sourceOf(record['source']),
    scope: {
      turnFrom: requireNumber(scope['turnFrom'], '导出范围'),
      turnTo: requireNumber(scope['turnTo'], '导出范围'),
      eventCount: requireNumber(scope['eventCount'], '导出范围'),
      charCount: requireNumber(scope['charCount'], '导出范围'),
      compressed: scope['compressed'] === true,
      attachmentsComplete: scope['attachmentsComplete'] === true,
    },
    format: format as ExportFormat,
    includeToolReads: record['includeToolReads'] === true,
    attachmentPolicy: policy as AttachmentPolicy,
    timeDisplay: record['timeDisplay'] === 'utc' ? 'utc' : 'local',
    redaction: record['redaction'] === 'strict' ? 'strict' : 'default',
    privateExport: record['privateExport'] === true,
  };
}

/** 读一条任务。 */
function jobOf(value: unknown): ExportJobView {
  const record = requireRecord(value, '导出任务');
  const state = record['state'];
  if (typeof state !== 'string' || !(EXPORT_STATES as readonly string[]).includes(state)) {
    throw new ExportCallError('gateway/internal', '导出状态不符合约定');
  }
  return {
    jobId: requireString(record['jobId'], '导出任务'),
    state: state as ExportState,
    scope: scopeOfValue(record['scope']),
    estimate: estimateOf(record['estimate']),
    createdAt: requireNumber(record['createdAt'], '导出任务'),
    ...(record['completedAt'] === undefined ? {} : { completedAt: requireNumber(record['completedAt'], '导出任务') }),
    ...(record['expiresAt'] === undefined ? {} : { expiresAt: requireNumber(record['expiresAt'], '导出任务') }),
    ...(record['code'] === undefined ? {} : { code: requireString(record['code'], '导出任务') }),
  };
}

/** 读应答里的 UTF-8 文件名。 */
function filenameOfDisposition(value: string | null): string | undefined {
  if (value === null) return undefined;
  const utf8 = /filename\*=UTF-8''([^;]+)/u.exec(value);
  if (utf8?.[1] !== undefined) return decodeURIComponent(utf8[1]);
  const plain = /filename="([^"]+)"/u.exec(value);
  return plain?.[1];
}

/** 读返回体。 */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) {
    let code = `http/${String(response.status)}`;
    let reason: string | undefined;
    if (text !== '') {
      const body: unknown = JSON.parse(text);
      if (typeof body === 'object' && body !== null) {
        const record = body as Record<string, unknown>;
        if (typeof record['error'] === 'string') code = record['error'];
        if (typeof record['reason'] === 'string') reason = record['reason'];
      }
    }
    throw new ExportCallError(code, '导出接口返回失败', response.status, reason);
  }
  return JSON.parse(text) as unknown;
}

/** 加上写操作要求的请求头。 */
function writeHeaders(extra?: Record<string, string>): Record<string, string> {
  return { 'Content-Type': 'application/json', [CSRF_HEADER]: '1', ...extra };
}

/** 数据入口的选项。 */
export interface ExportGatewayOptions {
  /** 遥测面；缺省使用同源中继。 */
  readonly telemetry: PanelTelemetry;
  /** 请求实现；测试可以换成受控的 fetch。 */
  readonly fetch?: typeof fetch;
  /** 路径前缀；缺省同源。 */
  readonly base?: string;
}

/**
 * 建立数据入口。
 * @param options - 遥测面与可选的请求实现。
 * @returns 数据入口。
 */
export function createExportGateway(options: ExportGatewayOptions): ExportGateway {
  const doFetch = options.fetch ?? fetch;
  const base = options.base ?? '';
  const url = (path: string): string => `${base}${path}`;

  return {
    telemetry: options.telemetry,
    async estimate(selection: ExportSelection): Promise<ExportEstimateView> {
      const body = { scope: scopeOf(selection, { eventCount: 0, charCount: 0, attachments: [] }) };
      const response = await doFetch(url(ESTIMATE_PATH), {
        method: 'POST',
        headers: writeHeaders(),
        body: JSON.stringify(body),
      });
      return estimateOf(await readJson(response));
    },
    async create(request): Promise<ExportJobView> {
      const response = await doFetch(url(JOBS_PATH), {
        method: 'POST',
        headers: writeHeaders(),
        body: JSON.stringify(request),
      });
      return jobOf(await readJson(response));
    },
    async jobs(): Promise<ExportJobList> {
      const response = await doFetch(url(JOBS_PATH), { method: 'GET', headers: { Accept: 'application/json' } });
      const body = requireRecord(await readJson(response), '任务列表');
      if (!Array.isArray(body['jobs'])) throw new ExportCallError('gateway/internal', '任务列表的形状不符合约定');
      return { jobs: body['jobs'].map(jobOf) };
    },
    async job(jobId: string): Promise<ExportJobView> {
      const response = await doFetch(url(`${JOBS_PATH}/${encodeURIComponent(jobId)}`), {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      return jobOf(await readJson(response));
    },
    async cancel(jobId: string): Promise<ExportJobView> {
      const response = await doFetch(url(`${JOBS_PATH}/${encodeURIComponent(jobId)}/cancel`), {
        method: 'POST',
        headers: writeHeaders(),
      });
      return jobOf(await readJson(response));
    },
    async download(jobId: string) {
      const response = await doFetch(url(`${JOBS_PATH}/${encodeURIComponent(jobId)}/download`), { method: 'GET' });
      if (!response.ok) {
        await readJson(response);
        throw new ExportCallError('gateway/internal', '下载没有拿到内容', response.status);
      }
      const filename = filenameOfDisposition(response.headers.get('content-disposition')) ?? `导出-${jobId}`;
      const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { filename, contentType, bytes };
    },
  };
}
