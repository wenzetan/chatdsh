/**
 * 附件：内容写进产品数据目录，元数据进结构化存储，同一份内容登记到制品库。
 *
 * 上传先校验文件名、字节数与媒体类型，超限、类型不符都就地拒绝并给出真实限制；内容文件
 * 以独占方式创建，元数据写入结构化存储，制品库同时得到一份可浏览的同源条目。读取按
 * `storageKey` 取回字节并核对摘要，摘要不符或文件缺失都按失败返回。实例重建后重新打开
 * 存储域与内容目录，之前写入的附件继续可以读取。
 *
 * 对外方法走 typert Remote：客户端与控制平面按 `chatdshAttachments` 命名空间调用。
 * @module @chatdsh/host-attachments
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Remote, storageDomainOf, telemetryOf, TypertRemoteService, type Context } from '@chatdsh/adapter';
import { ATTACHMENTS_DOMAIN, type AttachmentRecord } from './domain.ts';
import { ATTACHMENT_ERROR_CODES, AttachmentError } from './errors.ts';
import {
  assertSize,
  assertType,
  attachmentLimits,
  contentBytes,
  contextOf,
  validFilename,
  type AttachmentContextEntry,
  type AttachmentLimits,
} from './rules.ts';

export type { AttachmentRecord } from './domain.ts';
export { ATTACHMENTS_DOMAIN, attachmentSchema } from './domain.ts';
export { ATTACHMENT_ERROR_CODES, AttachmentError, type AttachmentErrorCode } from './errors.ts';
export {
  ALLOWED_ATTACHMENT_TYPES,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_FILENAME_LENGTH,
  ATTACHMENT_MAX_PER_MESSAGE,
  attachmentLimits,
  attachmentMarker,
  contextOf,
  normalizeMimeType,
  type AttachmentContextEntry,
  type AttachmentLimits,
} from './rules.ts';

/** 附件运行时使用的服务名，同时是 Remote 命名空间。 */
export const SERVICE_NAME = 'chatdshAttachments';

/** 上传一份附件的输入。 */
export interface AttachmentInput {
  readonly sessionId: string;
  /** 所属消息；发送前为空。 */
  readonly messageId?: string;
  readonly filename: string;
  readonly mimeType: string;
  /** 内容字节；字符串内容默认按 UTF8 解释，图像等二进制内容用 base64。 */
  readonly content: string | Uint8Array;
  readonly encoding?: 'utf8' | 'base64';
}

/** 一次读取的结果。内容以 base64 传出，跨 wire 无损。 */
export interface AttachmentReadResult {
  readonly record: AttachmentRecord;
  readonly base64: string;
  /** 报告给客户端的内容类型。 */
  readonly contentType: string;
}

/** 一次摘要核对的结果。 */
export interface AttachmentIntegrity {
  readonly attachmentId: string;
  readonly declaredBytes: number;
  readonly contentBytes: number;
  readonly digestMatches: boolean;
  readonly filePresent: boolean;
}

/** 附件操作的动作名，写入 span 的 `rpc.method`。 */
export type AttachmentAction = 'put' | 'read' | 'list' | 'delete' | 'verify' | 'context' | 'limits';

/** 遥测 span 用到的最小接口。 */
type SpanLike = { setAttribute(key: string, value: unknown): void };

/** 用到的遥测面。 */
interface AttachmentsTelemetry {
  runSpan<T>(name: string, attributes: Record<string, unknown>, body: (span: SpanLike) => Promise<T>): Promise<T>;
  counter(name: string, options: { description: string }): { add(delta: number, attributes?: Record<string, unknown>): void };
}

/** 制品库的最小形状：只用到写入与删除。 */
interface ArtifactsStore {
  put(input: {
    readonly sessionId: string;
    readonly title: string;
    readonly kind?: string;
    readonly mimeType: string;
    readonly content: Uint8Array;
  }): Promise<{ readonly id: string; readonly version: number }>;
}

/** 只用到四个方法的键值表。 */
interface Table<V> {
  get(key: string): V | undefined;
  entries(): IterableIterator<[string, V]>;
  put(key: string, value: V): Promise<void>;
  delete(key: string): Promise<boolean>;
}

/** 数据根：附件内容写在这里的 `attachments/` 下。 */
function dataRoot(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

/** 内容字节的 sha256。 */
function digestOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 把写入失败的底层原因收进错误说明。 */
function reasonOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return `${String((error as { readonly code: unknown }).code)}：${error instanceof Error ? error.message : String(error)}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * 附件服务。
 */
export class ChatdshAttachmentsService extends TypertRemoteService {
  /** 结构化存储是唯一注入依赖；制品库按名读取。 */
  static inject = ['storageDomain'];

  private attachments: Table<AttachmentRecord> | undefined;

  constructor(ctx: Context) {
    super(ctx, SERVICE_NAME);
  }

  /** 打开存储域。失败按 fiber 启动失败上报。 */
  async [TypertRemoteService.init](): Promise<void> {
    const domain = await storageDomainOf(this.ctx).open(ATTACHMENTS_DOMAIN);
    this.attachments = domain.table('attachments') as unknown as Table<AttachmentRecord>;
  }

  /** 部署上限：字节数、单条消息数量、允许的媒体类型与文件名长度。 */
  @Remote('limits')
  limits(): AttachmentLimits {
    return attachmentLimits();
  }

  /**
   * 上传一份附件：校验、写内容文件、登记制品、写元数据。
   * @param input - 会话、文件名、媒体类型与内容。
   * @returns 写入后的记录。
   */
  @Remote('put')
  async put(input: AttachmentInput): Promise<AttachmentRecord> {
    return this.access('put', async (span) => {
      const table = this.require(this.attachments);
      if (typeof input.sessionId !== 'string' || input.sessionId.trim() === '') {
        throw new AttachmentError(ATTACHMENT_ERROR_CODES.requestInvalid, '上传附件需要会话标识');
      }
      const filename = validFilename(input.filename);
      const mimeType = assertType(input.mimeType);
      const bytes = contentBytes(input);
      assertSize(bytes.byteLength);
      if (input.messageId !== undefined && input.messageId.trim() === '') {
        throw new AttachmentError(ATTACHMENT_ERROR_CODES.requestInvalid, '消息标识不能是空串');
      }
      const id = randomUUID();
      const storageKey = join(id, filename);
      const absolute = join(dataRoot(), 'attachments', storageKey);
      const artifacts = this.artifacts();
      const artifact = await artifacts.put({
        sessionId: input.sessionId,
        title: filename,
        kind: 'attachment',
        mimeType,
        content: bytes,
      });
      const record: AttachmentRecord = {
        id,
        sessionId: input.sessionId,
        ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
        filename,
        mimeType,
        size: bytes.byteLength,
        digest: digestOf(bytes),
        createdAt: Date.now(),
        storageKey,
        artifactId: artifact.id,
        artifactVersion: artifact.version,
      };
      await this.writeContent(absolute, bytes);
      await table.put(id, record);
      span?.setAttribute('bytes', bytes.byteLength);
      return record;
    });
  }

  /**
   * 读取一份附件的字节。
   * @param id - 附件标识。
   * @returns 记录、base64 内容与内容类型。
   */
  @Remote('read')
  async read(id: string): Promise<AttachmentReadResult> {
    return this.access('read', async (span) => {
      const record = this.recordOf(id);
      const bytes = await this.readContent(record);
      const digest = digestOf(bytes);
      if (digest !== record.digest) {
        throw new AttachmentError(
          ATTACHMENT_ERROR_CODES.contentCorrupt,
          `附件 ${id} 的内容摘要与元数据不一致`,
        );
      }
      span?.setAttribute('bytes', bytes.byteLength);
      return { record, base64: bytes.toString('base64'), contentType: record.mimeType };
    });
  }

  /**
   * 列出附件；给出会话标识时只列该会话的。
   * @param sessionId - 会话标识。
   * @returns 按写入时间升序排列的记录。
   */
  @Remote('list')
  list(sessionId?: string): AttachmentRecord[] {
    const table = this.require(this.attachments);
    const all = [...table.entries()].map(([, record]) => record);
    const scoped = sessionId === undefined ? all : all.filter((record) => record.sessionId === sessionId);
    return scoped.sort((left, right) => left.createdAt - right.createdAt);
  }

  /**
   * 删除附件的内容文件与元数据；制品库里的同源条目按制品库自己的删除流程处理。
   * @param id - 附件标识。
   * @returns 是否存在并删除。
   */
  @Remote({ name: 'delete' })
  async remove(id: string): Promise<boolean> {
    return this.access('delete', async () => {
      const table = this.require(this.attachments);
      if (table.get(id) === undefined) return false;
      await rm(join(dataRoot(), 'attachments', id), { recursive: true, force: true });
      return table.delete(id);
    });
  }

  /**
   * 核对元数据与内容文件是否一致。
   * @param id - 附件标识。
   * @returns 字节数、摘要与文件是否在场。
   */
  @Remote('verify')
  async verify(id: string): Promise<AttachmentIntegrity> {
    return this.access('verify', async () => {
      const record = this.recordOf(id);
      const absolute = join(dataRoot(), 'attachments', record.storageKey);
      if (!existsSync(absolute)) {
        return {
          attachmentId: id,
          declaredBytes: record.size,
          contentBytes: 0,
          digestMatches: false,
          filePresent: false,
        };
      }
      const bytes = await this.readContent(record);
      return {
        attachmentId: id,
        declaredBytes: record.size,
        contentBytes: bytes.byteLength,
        digestMatches: digestOf(bytes) === record.digest,
        filePresent: true,
      };
    });
  }

  /**
   * 附件在模型上下文里的表示。
   * @param ids - 按发送顺序排列的附件标识。
   * @returns 逐项与整段文本。
   */
  @Remote('context')
  context(ids: readonly string[]): { readonly entries: AttachmentContextEntry[]; readonly text: string } {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new AttachmentError(ATTACHMENT_ERROR_CODES.requestInvalid, '上下文表示需要至少一个附件标识');
    }
    return contextOf(ids.map((id) => this.recordOf(id)));
  }

  /** 取一条记录，缺失时就地抛出。 */
  private recordOf(id: string): AttachmentRecord {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new AttachmentError(ATTACHMENT_ERROR_CODES.requestInvalid, '附件标识不能为空');
    }
    const record = this.require(this.attachments).get(id);
    if (record === undefined) throw new AttachmentError(ATTACHMENT_ERROR_CODES.notFound, `附件 ${id} 不存在`);
    return record;
  }

  /** 独占创建内容文件；同一路径已经存在时拒绝覆盖。 */
  private async writeContent(absolute: string, bytes: Buffer): Promise<void> {
    await mkdir(dirname(absolute), { recursive: true });
    try {
      await writeFile(absolute, bytes, { flag: 'wx' });
    } catch (error) {
      throw new AttachmentError(
        ATTACHMENT_ERROR_CODES.writeFailed,
        `附件内容写入失败：${reasonOf(error)}`,
      );
    }
  }

  /** 读取内容文件；不存在或没有权限都按失败返回。 */
  private async readContent(record: AttachmentRecord): Promise<Buffer> {
    try {
      return await readFile(join(dataRoot(), 'attachments', record.storageKey));
    } catch (error) {
      throw new AttachmentError(
        ATTACHMENT_ERROR_CODES.readFailed,
        `附件 ${record.id} 的内容读取失败：${reasonOf(error)}`,
      );
    }
  }

  /** 取制品库；没有挂载时就地拒绝，避免把附件写成只有本机一份的孤立文件。 */
  private artifacts(): ArtifactsStore {
    const store = this.ctx.reflect.get('chatdshArtifacts') as ArtifactsStore | undefined;
    if (store === undefined || typeof store.put !== 'function') {
      throw new AttachmentError(
        ATTACHMENT_ERROR_CODES.storeUnavailable,
        '制品库没有挂载，附件无法登记到制品库',
      );
    }
    return store;
  }

  /**
   * 在一个动作 span 里执行，失败时补计数与结果属性。
   * @param action - 动作名，写入 `rpc.method`。
   * @param body - 动作主体。
   * @returns 动作结果。
   */
  private async access<T>(action: AttachmentAction, body: (span: SpanLike | undefined) => Promise<T> | T): Promise<T> {
    const telemetry = telemetryOf<AttachmentsTelemetry>(this.ctx);
    const method = `${SERVICE_NAME}/${action}`;
    const counter = telemetry?.counter('chatdsh_remote_calls_total', { description: 'Remote 调用数' });
    const run = async (span?: SpanLike): Promise<T> => {
      try {
        const value = await body(span);
        span?.setAttribute('outcome', 'ok');
        counter?.add(1, { method, outcome: 'ok' });
        return value;
      } catch (error) {
        const code = error instanceof AttachmentError ? error.code : 'internal-error';
        span?.setAttribute('outcome', 'failed');
        counter?.add(1, { method, outcome: 'failed', error_code: code });
        throw error;
      }
    };
    if (telemetry === undefined) return run();
    return telemetry.runSpan('chatdsh.runtime.remote.call', { 'rpc.method': method }, run);
  }

  private require<V>(table: Table<V> | undefined): Table<V> {
    if (table === undefined) throw new Error('attachment storage is not ready');
    return table;
  }
}

export default ChatdshAttachmentsService;
