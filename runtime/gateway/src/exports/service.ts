/**
 * 导出的生命周期：预估、生成、取消、完成、下载、失效与失败。
 *
 * 预估按权威会话日志的完整回合计算条数、字符数与字节，并给出逐项附件的可用状态。生成走
 * 后台任务：建立时立刻返回 `generating` 的任务，文件写进导出包目录，完成后状态转 `completed`
 * 并带文件名、内容类型与失效时刻。取消会终止正在写的任务（含 PDF 渲染进程）并删掉半成品；
 * 失败与取消都不留下可下载的残缺文件。同一操作标识配同一请求摘要重复提交返回原任务，不
 * 重复生成文件；摘要不同按冲突拒绝。
 * @module @chatdsh/gateway/exports/service
 */

import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  CHATDSH_ERROR_CODES,
  exportScopeSchema,
  type ChatdshTelemetry,
  type ExportEstimate,
  type ExportJob,
  type ExportScope,
} from '@chatdsh/core-contracts';
import { gatewayDataRoot } from '../maintenance/content.ts';
import { replicaEventsOf, sessionRowOf } from '../maintenance/rows.ts';
import { collectContent, MAX_EXPORT_CHARS, type CollectedContent } from './collect.ts';
import { createDirectoryAttachmentResolver } from './attachments.ts';
import { buildDocument, estimateOf, exportContentTypeOf, exportFilenameOf } from './document.ts';
import { renderHtml } from './html.ts';
import { renderJsonl } from './jsonl.ts';
import { renderMarkdown } from './markdown.ts';
import { createChromePdfRenderer } from './pdf.ts';
import { ExportJobStore, type ExportJobRow } from './store.ts';
import { ExportTelemetry, EXPORT_SPANS } from './telemetry.ts';
import {
  ExportError,
  type ArtifactContentSource,
  type AttachmentRef,
  type AttachmentResolver,
  type ExportActor,
  type ExportDocument,
  type ExportDownload,
  type PdfRenderer,
  type ResolvedAttachment,
} from './types.ts';

/** 导出包的下载有效期，默认一小时。 */
const DEFAULT_TTL_MS = 3_600_000;

/** 列表最多返回的条数。 */
const MAX_LIST = 50;

/** 服务选项。 */
export interface ExportServiceOptions {
  /** 控制平面数据库连接。 */
  readonly database: DatabaseSync;
  /** 遥测出口；缺省时全部遥测退化为空操作。 */
  readonly telemetry?: ChatdshTelemetry;
  /** 数据根；缺省取 `DSH_HOME` 或 `~/.dsh`。 */
  readonly dataRoot?: string;
  /** 导出包根目录；缺省为数据根下的 `exports`。 */
  readonly exportsRoot?: string;
  /** 本机设备标识；与会话归属比较来判定附件是否需要源设备。 */
  readonly localDeviceId?: string;
  /** 下载有效期。 */
  readonly ttlMs?: number;
  /** 当前时刻；缺省取系统时钟。 */
  readonly now?: () => number;
  /** 时间显示时区；缺省取本机时区。 */
  readonly timeZone?: string;
  /** 附件解析；缺省按数据根下的 `attachments/` 解析。 */
  readonly attachments?: AttachmentResolver;
  /** PDF 渲染；缺省用本机 Chrome 打印管线。 */
  readonly pdf?: PdfRenderer;
  /** 制品内容读取；缺省表示没有制品导出能力。 */
  readonly artifacts?: ArtifactContentSource;
}

/** 一次生成的上下文。 */
interface GenerationContext {
  readonly jobId: string;
  readonly exportScope: ExportScope;
  readonly signal: AbortSignal;
}

/** 会话内容的收集结果。 */
interface SessionContent {
  readonly content: CollectedContent;
  readonly attachments: readonly ResolvedAttachment[];
  readonly title: string;
}

/** 导出服务。 */
export class ExportService {
  private readonly store: ExportJobStore;
  private readonly telemetry: ExportTelemetry;
  private readonly dataRoot: string;
  private readonly exportsRoot: string;
  private readonly localDeviceId: string;
  private readonly ttlMs: number;
  private readonly timeZone: string;
  private readonly attachments: AttachmentResolver;
  private readonly pdf: PdfRenderer;
  private readonly artifacts: ArtifactContentSource | undefined;
  private readonly active = new Map<string, AbortController>();
  private readonly now: () => number;

  constructor(private readonly options: ExportServiceOptions) {
    this.store = new ExportJobStore(options.database);
    this.telemetry = new ExportTelemetry(options.telemetry);
    this.dataRoot = options.dataRoot ?? gatewayDataRoot();
    this.exportsRoot = options.exportsRoot ?? join(this.dataRoot, 'exports');
    this.localDeviceId = options.localDeviceId ?? 'local';
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.attachments = options.attachments ?? createDirectoryAttachmentResolver({ dataRoot: this.dataRoot });
    this.pdf = options.pdf ?? createChromePdfRenderer();
    this.artifacts = options.artifacts;
    this.now = options.now ?? (() => Date.now());
  }

  /** 当前时刻。 */
  private stamp(): number {
    return this.now();
  }

  /** 时间显示选项。 */
  private get timeOptions(): { timeDisplay: 'local' | 'utc'; timeZone: string } {
    return { timeDisplay: 'local', timeZone: this.timeZone };
  }

  /**
   * 展示一条任务行；已过期的完成任务在这里转成失效状态。
   * @param row - 任务行。
   * @returns 对外形状。
   */
  private viewOf(row: ExportJobRow): ExportJob {
    const scope = exportScopeSchema.parse(JSON.parse(row.scope_json) as unknown);
    const estimate: ExportEstimate = {
      eventCount: row.event_count,
      charCount: row.char_count,
      bytes: row.bytes,
      attachments: JSON.parse(row.attachments_json) as ExportEstimate['attachments'],
    };
    const expired = row.state === 'completed' && row.expires_at !== null && row.expires_at <= this.stamp();
    const state: ExportJob['state'] = expired ? 'expired' : (row.state as ExportJob['state']);
    const code = row.code ?? (expired ? CHATDSH_ERROR_CODES.exportExpired : undefined);
    return {
      jobId: row.job_id,
      state,
      scope,
      estimate,
      createdAt: row.created_at,
      ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
      ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
      ...(code === undefined ? {} : { code: code as NonNullable<ExportJob['code']> }),
    };
  }

  /** 校验格式能力与私有导出权限。 */
  private assertFormatCapability(exportScope: ExportScope, actor: ExportActor): void {
    if (exportScope.privateExport && !actor.privateExport) {
      throw new ExportError(
        CHATDSH_ERROR_CODES.permissionDenied,
        'private-export-forbidden',
        '完整业务记录导出需要单独授权的私有导出权限',
      );
    }
    if (exportScope.format === 'pdf' && !this.pdf.available()) {
      throw new ExportError(
        CHATDSH_ERROR_CODES.exportFormatUnsupported,
        this.pdf.unavailableReason(),
        '本机没有可用的 PDF 渲染器，PDF 导出不可用',
      );
    }
    if (exportScope.source.kind === 'artifact' && this.artifacts === undefined) {
      throw new ExportError(
        CHATDSH_ERROR_CODES.exportFormatUnsupported,
        'artifact-source-unavailable',
        '制品导出需要接入制品内容读取',
      );
    }
  }

  /** 解析本次范围里的附件。 */
  private async resolveAttachments(refs: readonly AttachmentRef[], ownerDeviceId: string): Promise<ResolvedAttachment[]> {
    const context = { ownerDeviceId, localDeviceId: this.localDeviceId, dataRoot: this.dataRoot };
    const resolved: ResolvedAttachment[] = [];
    for (const ref of refs) resolved.push(await this.attachments(ref, context));
    return resolved;
  }

  /** 收集会话内容并解析附件。 */
  private async sessionContent(exportScope: ExportScope): Promise<SessionContent> {
    if (exportScope.source.kind !== 'session') {
      throw new ExportError(CHATDSH_ERROR_CODES.requestInvalid, 'source-kind', '会话导出需要会话来源');
    }
    const sessionId = exportScope.source.sessionId;
    const row = sessionRowOf(this.options.database, sessionId);
    if (row === undefined || row.deleted_at !== null) {
      throw new ExportError(CHATDSH_ERROR_CODES.sessionNotFound, 'session-missing', '会话不存在或已删除');
    }
    const rows = replicaEventsOf(this.options.database, sessionId);
    if (rows.length === 0) {
      throw new ExportError(CHATDSH_ERROR_CODES.replicaUnavailable, 'replica-empty', '会话副本还没有内容');
    }
    const content = collectContent(rows, {
      turnFrom: exportScope.scope.turnFrom,
      turnTo: exportScope.scope.turnTo,
      includeToolReads: exportScope.includeToolReads,
      redaction: exportScope.redaction,
      internalRoots: [this.dataRoot, join(this.dataRoot, 'exports')],
    });
    if (content.scope.charCount > MAX_EXPORT_CHARS) {
      throw new ExportError(CHATDSH_ERROR_CODES.exportTooLarge, 'chars-too-many', '导出内容超过配额');
    }
    const attachments = await this.resolveAttachments(content.attachments, row.device_id);
    return { content, attachments, title: content.title ?? `会话 ${sessionId} 导出` };
  }

  /** 组装制品导出的文档。 */
  private async artifactDocument(exportScope: ExportScope): Promise<ExportDocument> {
    if (exportScope.source.kind !== 'artifact') {
      throw new ExportError(CHATDSH_ERROR_CODES.requestInvalid, 'source-kind', '制品导出需要制品来源');
    }
    const artifacts = this.artifacts;
    if (artifacts === undefined) {
      throw new ExportError(
        CHATDSH_ERROR_CODES.exportFormatUnsupported,
        'artifact-source-unavailable',
        '制品导出需要接入制品内容读取',
      );
    }
    const source = exportScope.source;
    const read = await artifacts.read(source.artifactId, source.version);
    const isText = read.mimeType.startsWith('text/')
      || read.mimeType.includes('json')
      || read.mimeType.includes('markdown');
    const text = isText
      ? new TextDecoder('utf-8').decode(read.bytes)
      : `二进制制品（${read.mimeType}，${String(read.bytes.byteLength)} 字节），完整字节随导出包一同写出。`;
    const generatedAt = this.stamp();
    return {
      title: read.title,
      source,
      generatedAt,
      scope: {
        turnFrom: 1,
        turnTo: 1,
        eventCount: 1,
        charCount: [...text].length,
        compressed: false,
        attachmentsComplete: true,
      },
      turns: [1],
      entries: [{ turn: 1, role: 'artifact', time: generatedAt, kind: 'message', text }],
      attachments: isText
        ? []
        : [{
          id: `${source.artifactId}-v${String(source.version)}`,
          filename: read.title,
          state: 'downloadable',
          size: read.bytes.byteLength,
        }],
      attachmentFiles: isText
        ? []
        : [{
          id: `${source.artifactId}-v${String(source.version)}`,
          filename: read.title,
          mimeType: read.mimeType,
          bytes: read.bytes,
        }],
      excluded: ['replica-watermark'],
      redactions: { paths: 0, credentials: 0 },
      timeDisplay: 'local',
      timeZone: this.timeZone,
      includeToolReads: false,
      strict: exportScope.redaction === 'strict',
      privateRecord: false,
    };
  }

  /**
   * 预估导出。
   * @param exportScope - 导出的内容范围。
   * @param actor - 已认证的请求者。
   * @returns 预估。
   */
  async estimate(exportScope: ExportScope, actor: ExportActor): Promise<ExportEstimate> {
    this.assertFormatCapability(exportScope, actor);
    return this.telemetry.run(EXPORT_SPANS.estimate, 'estimate', { format: exportScope.format }, async () => {
      if (exportScope.source.kind === 'artifact') {
        const document = await this.artifactDocument(exportScope);
        return {
          eventCount: document.scope.eventCount,
          charCount: document.scope.charCount,
          bytes: document.scope.charCount * 3,
          attachments: [...document.attachments],
        };
      }
      const { content, attachments } = await this.sessionContent(exportScope);
      return estimateOf(content, attachments);
    });
  }

  /**
   * 建立一个导出任务并开始生成。
   * @param request - 操作标识、请求摘要与内容范围。
   * @param actor - 已认证的请求者。
   * @returns 任务视图；重复提交返回原任务。
   */
  async create(
    request: { readonly operationId: string; readonly requestDigest: string; readonly scope: ExportScope },
    actor: ExportActor,
  ): Promise<ExportJob> {
    this.assertFormatCapability(request.scope, actor);
    const existing = this.store.byOperation(request.operationId);
    if (existing !== undefined) {
      if (existing.request_digest !== request.requestDigest) {
        throw new ExportError(
          CHATDSH_ERROR_CODES.operationDigestMismatch,
          'digest-mismatch',
          '同一操作标识带了不同的请求摘要',
        );
      }
      return this.viewOf(existing);
    }

    const estimate = await this.estimate(request.scope, actor);
    const jobId = randomUUID();
    this.store.insert({
      jobId,
      operationId: request.operationId,
      requestDigest: request.requestDigest,
      state: 'generating',
      exportScope: request.scope,
      eventCount: estimate.eventCount,
      charCount: estimate.charCount,
      bytes: estimate.bytes,
      attachmentsJson: JSON.stringify(estimate.attachments),
      createdAt: this.stamp(),
    });

    const controller = new AbortController();
    this.active.set(jobId, controller);
    void this.generate({ jobId, exportScope: request.scope, signal: controller.signal }).finally(() => {
      this.active.delete(jobId);
    });

    const row = this.store.byId(jobId);
    if (row === undefined) {
      throw new ExportError(CHATDSH_ERROR_CODES.internalError, 'job-missing', '导出任务写入后读不到');
    }
    return this.viewOf(row);
  }

  /** 生成文件并把结果写回任务行。 */
  private async generate(context: GenerationContext): Promise<void> {
    const jobDir = join(this.exportsRoot, context.jobId);
    const format = context.exportScope.format;
    try {
      await this.telemetry.run(EXPORT_SPANS.generate, 'create', { format }, async (span) => {
        const document = await this.documentOf(context);
        if (context.signal.aborted) {
          throw new ExportError(CHATDSH_ERROR_CODES.exportExpired, 'export-cancelled', '导出已取消');
        }
        const filename = exportFilenameOf(context.exportScope, document.generatedAt, this.timeOptions);
        const contentType = exportContentTypeOf(format);
        const rendered = await this.renderOf(document, format, jobDir, context.signal);
        if (context.signal.aborted) {
          throw new ExportError(CHATDSH_ERROR_CODES.exportExpired, 'export-cancelled', '导出已取消');
        }
        await mkdir(jobDir, { recursive: true });
        await writeFile(join(jobDir, filename), rendered);
        await this.writeAttachments(document, jobDir);
        const completedAt = this.stamp();
        this.store.update(context.jobId, {
          state: 'completed',
          bytes: rendered.byteLength,
          completedAt,
          expiresAt: completedAt + this.ttlMs,
          filename,
          storageKey: join(context.jobId, filename),
          contentType,
        });
        span?.setAttribute('turns', document.turns.length);
        span?.setAttribute('count', document.entries.length);
        span?.setAttribute('bytes', rendered.byteLength);
        this.telemetry.fileBytes('create', rendered.byteLength, format);
      });
    } catch (error) {
      if (context.signal.aborted) {
        this.store.update(context.jobId, { state: 'cancelling', completedAt: this.stamp() });
        await this.discard(jobDir);
        return;
      }
      const code = error instanceof ExportError ? error.code : CHATDSH_ERROR_CODES.internalError;
      this.store.update(context.jobId, { state: 'failed', code, completedAt: this.stamp() });
      await this.discard(jobDir);
    }
  }

  /**
   * 删掉一次生成的半成品目录。
   *
   * 任务状态先写进任务行，清理随后进行：目录本来就不存在、或者导出包根不是一个目录时直接跳过，
   * 已经记录的失败或取消结论不受影响。
   * @param jobDir - 导出包目录。
   */
  private async discard(jobDir: string): Promise<void> {
    if (!existsSync(jobDir)) return;
    await rm(jobDir, { recursive: true, force: true });
  }

  /** 按来源组装导出文档。 */
  private async documentOf(context: GenerationContext): Promise<ExportDocument> {
    if (context.exportScope.source.kind === 'artifact') return this.artifactDocument(context.exportScope);
    const collected = await this.sessionContent(context.exportScope);
    return buildDocument({
      exportScope: context.exportScope,
      title: collected.title,
      generatedAt: this.stamp(),
      content: collected.content,
      attachments: collected.attachments,
      time: this.timeOptions,
    });
  }

  /** 按格式渲染字节。 */
  private async renderOf(
    document: ExportDocument,
    format: ExportScope['format'],
    jobDir: string,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const time = { timeDisplay: document.timeDisplay, timeZone: document.timeZone };
    if (format === 'markdown') return new Uint8Array(Buffer.from(renderMarkdown(document, time), 'utf8'));
    if (format === 'jsonl') return new Uint8Array(Buffer.from(renderJsonl(document), 'utf8'));
    const html = renderHtml(document, time);
    if (format === 'html') return new Uint8Array(Buffer.from(html, 'utf8'));
    return this.pdf.render({ html, workDir: join(jobDir, 'render'), signal });
  }

  /** 把可下载附件写进导出包。 */
  private async writeAttachments(document: ExportDocument, jobDir: string): Promise<void> {
    for (const attachment of document.attachmentFiles) {
      const directory = join(jobDir, 'attachments', attachment.id);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, attachment.filename), attachment.bytes);
    }
  }

  /**
   * 取消一个任务。
   * @param jobId - 任务标识。
   * @returns 任务视图。
   */
  async cancel(jobId: string): Promise<ExportJob> {
    const row = this.store.byId(jobId);
    if (row === undefined) {
      throw new ExportError(CHATDSH_ERROR_CODES.objectNotFound, 'job-missing', '导出任务不存在');
    }
    if (row.state === 'cancelling') return this.viewOf(row);
    if (row.state === 'completed' || row.state === 'failed' || row.state === 'expired') {
      throw new ExportError(CHATDSH_ERROR_CODES.alreadyHandled, 'job-finished', '任务已经结束，无法取消');
    }
    const controller = this.active.get(jobId);
    this.store.update(jobId, { state: 'cancelling', completedAt: this.stamp() });
    if (controller !== undefined) {
      controller.abort();
    } else {
      await this.discard(join(this.exportsRoot, jobId));
    }
    const updated = this.store.byId(jobId);
    if (updated === undefined) {
      throw new ExportError(CHATDSH_ERROR_CODES.internalError, 'job-missing', '取消后读不到任务');
    }
    return this.viewOf(updated);
  }

  /**
   * 取一条任务。
   * @param jobId - 任务标识。
   * @returns 任务视图；不存在时为空。
   */
  async job(jobId: string): Promise<ExportJob | undefined> {
    const row = this.store.byId(jobId);
    return row === undefined ? undefined : this.viewOf(row);
  }

  /**
   * 列出最近的任务。
   * @returns 任务视图，按建立时刻倒序。
   */
  async list(): Promise<readonly ExportJob[]> {
    return this.store.list(MAX_LIST).map((row) => this.viewOf(row));
  }

  /**
   * 下载一个已完成任务的产物。
   * @param jobId - 任务标识。
   * @returns 文件名、内容类型与字节。
   */
  async download(jobId: string): Promise<ExportDownload> {
    return this.telemetry.run(EXPORT_SPANS.download, 'download', {}, async (span) => {
      const row = this.store.byId(jobId);
      if (row === undefined) {
        throw new ExportError(CHATDSH_ERROR_CODES.objectNotFound, 'job-missing', '导出任务不存在');
      }
      if (row.state === 'generating' || row.state === 'cancelling' || row.state === 'estimated') {
        throw new ExportError(CHATDSH_ERROR_CODES.writeUnconfirmed, 'job-running', '导出还在进行中');
      }
      if (row.state === 'failed') {
        throw new ExportError(CHATDSH_ERROR_CODES.internalError, 'job-failed', '导出失败，请调整范围或格式后重新生成');
      }
      if (row.expires_at !== null && row.expires_at <= this.stamp()) {
        this.store.update(jobId, { state: 'expired', code: CHATDSH_ERROR_CODES.exportExpired });
        throw new ExportError(CHATDSH_ERROR_CODES.exportExpired, 'download-expired', '下载地址已失效，请重新生成');
      }
      if (row.storage_key === null || row.filename === null || row.content_type === null) {
        throw new ExportError(CHATDSH_ERROR_CODES.internalError, 'job-incomplete', '导出任务缺少产物信息');
      }
      const path = join(this.exportsRoot, row.storage_key);
      const info = await stat(path).catch(() => undefined);
      if (info === undefined) {
        this.store.update(jobId, { state: 'expired', code: CHATDSH_ERROR_CODES.exportExpired });
        throw new ExportError(CHATDSH_ERROR_CODES.exportExpired, 'download-missing', '导出文件已不在磁盘上，请重新生成');
      }
      const bytes = new Uint8Array(await readFile(path));
      span?.setAttribute('bytes', bytes.byteLength);
      span?.setAttribute('format', row.format);
      this.telemetry.fileBytes('download', bytes.byteLength, row.format);
      return { filename: row.filename, contentType: row.content_type, bytes };
    });
  }
}
