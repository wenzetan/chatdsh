/**
 * 制品：可版本化的产出文件。
 *
 * 元数据进结构化存储，内容字节写在产品数据目录下（不是用户工作区），因此制品不参与
 * 工作区文件的沙箱判定；制品与工作区文件是两类东西。版本只增不改：追加写入总是生成
 * 新的版本文件，版本文件以独占方式创建，已存在的版本字节不会被覆盖。
 *
 * 读取同时给出内容类型与受限预览标记：HTML 走独立受限预览，SVG 按安全图片处理，两者
 * 都拿不到宿主桥。删除范围列出全部版本与占用空间；版本引用按制品标识与版本号配对校验。
 *
 * 对外方法走 typert Remote：客户端与控制平面按 `chatdshArtifacts` 命名空间调用。
 * @module @chatdsh/host-artifacts
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Remote, storageDomainOf, telemetryOf, TypertRemoteService, type Context } from '@chatdsh/adapter';
import { ARTIFACTS_DOMAIN, type ArtifactRecord, type ArtifactVersionRecord } from './domain.ts';
import { ArtifactError, ARTIFACT_ERROR_CODES } from './errors.ts';
import { contentTypeOf, previewOf, type ArtifactPreviewView } from './safety.ts';

export type { ArtifactRecord, ArtifactVersionRecord } from './domain.ts';
export { ARTIFACTS_DOMAIN, artifactSchema, versionSchema } from './domain.ts';
export { ArtifactError, ARTIFACT_ERROR_CODES, type ArtifactErrorCode } from './errors.ts';
export { contentTypeOf, normalizeMimeType, previewModeOf, previewOf, PREVIEW_MODES, type ArtifactPreviewView, type PreviewMode } from './safety.ts';

/** 制品运行时使用的服务名，同时是 Remote 命名空间。 */
export const SERVICE_NAME = 'chatdshArtifacts';

/** 新建或更新制品的输入。 */
export interface ArtifactInput {
  /** 指定制品标识时更新它并递增版本；省略时新建。 */
  readonly id?: string;
  readonly sessionId: string;
  readonly workspaceId?: string;
  readonly title: string;
  readonly kind?: string;
  readonly mimeType: string;
  /** 内容字节。 */
  readonly content: string | Uint8Array;
  /** 字符串内容的解释方式：默认按 UTF8，图像等二进制内容用 base64。 */
  readonly encoding?: 'utf8' | 'base64';
  /** 产生该制品的会话事件序号。 */
  readonly sourceEventSeq?: number;
  /** 产生该版本的回合编号。 */
  readonly sourceTurn?: number;
}

/** 一个版本对外的形状，与跨组件契约的制品版本一致。 */
export interface ArtifactVersionView {
  readonly artifactId: string;
  readonly version: number;
  readonly mimeType: string;
  readonly size: number;
  readonly createdAt: number;
  /** 历史版本不可改写。 */
  readonly immutable: true;
  /** 产生该版本的会话。 */
  readonly sourceSessionId: string;
  /** 产生该版本的回合编号。 */
  readonly sourceTurn?: number;
  /** 内容是否可下载。 */
  readonly downloadable: boolean;
}

/** 版本列表：当前版本必须出现在列表里，且属于同一个制品。 */
export interface ArtifactVersionList {
  readonly artifactId: string;
  readonly currentVersion: number;
  readonly versions: ArtifactVersionView[];
}

/** 版本引用：制品标识与版本号成对出现。 */
export interface ArtifactVersionRef {
  readonly artifactId: string;
  readonly version: number;
}

/** 删除范围：删除全部版本时需要显式确认。 */
export interface ArtifactDeleteScope {
  readonly artifactId: string;
  readonly allVersions: boolean;
  readonly versions: number[];
  readonly affectedVersions: number[];
  readonly totalBytes: number;
  readonly requiresConfirm: true;
}

/** 一次读取的结果。内容以 base64 传出，保证跨 wire 无损。 */
export interface ArtifactReadResult {
  /** 制品的当前记录。 */
  readonly record: ArtifactRecord;
  /** 被读取的那个版本。 */
  readonly version: ArtifactVersionView;
  /** 内容字节，base64。 */
  readonly base64: string;
  /** 报告给客户端的内容类型。 */
  readonly contentType: string;
  /** 受限预览标记。HTML 与 SVG 同样不开放脚本、表单提交与宿主访问。 */
  readonly preview: ArtifactPreviewView;
}

/** 一次版本一致性核对的结果。 */
export interface ArtifactIntegrity {
  readonly artifactId: string;
  /** 记录里的当前版本。 */
  readonly currentVersion: number;
  /** 版本记录里的全部版本号，升序。 */
  readonly versions: number[];
  /** 版本记录登记的字节数之和。 */
  readonly declaredBytes: number;
  /** 存储里实际读到的字节数之和。 */
  readonly contentBytes: number;
  /** 版本记录存在但内容文件缺失的版本号。 */
  readonly missingFiles: number[];
  /** 内容摘要与记录不一致的版本号。 */
  readonly digestMismatches: number[];
}

/** 制品操作的动作名，写入 span 与错误事件。 */
export type ArtifactAction = 'put' | 'read' | 'versions' | 'delete' | 'verify' | 'resolve';

/** 遥测 span 用到的最小接口。 */
type SpanLike = { setAttribute(key: string, value: unknown): void };

/** 用到的遥测面。 */
interface ArtifactsTelemetry {
  runSpan<T>(name: string, attributes: Record<string, unknown>, body: (span: SpanLike) => Promise<T>): Promise<T>;
  event(name: string, attributes?: Record<string, unknown>): void;
  counter(name: string, options: { description: string }): { add(delta: number, attributes?: Record<string, unknown>): void };
}

/** 只用到四个方法的键值表。 */
interface Table<V> {
  get(key: string): V | undefined;
  entries(): IterableIterator<[string, V]>;
  put(key: string, value: V): Promise<void>;
  delete(key: string): Promise<boolean>;
}

/** 数据根：制品内容写在这里的 `artifacts/` 下。 */
function dataRoot(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

/** 内容字节的 sha256。 */
function digestOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * 制品服务。
 *
 * 版本写入是追加式的：每次 `put` 生成一个新版本文件，旧版本保留，`version` 字段指向最新。
 */
export class ChatdshArtifactsService extends TypertRemoteService {
  /** 结构化存储是唯一依赖。 */
  static inject = ['storageDomain'];

  private artifacts: Table<ArtifactRecord> | undefined;
  private versions: Table<ArtifactVersionRecord> | undefined;

  constructor(ctx: Context) {
    super(ctx, SERVICE_NAME);
  }

  /** 打开存储域。失败按 fiber 启动失败上报。 */
  async [TypertRemoteService.init](): Promise<void> {
    const domain = await storageDomainOf(this.ctx).open(ARTIFACTS_DOMAIN);
    this.artifacts = domain.table('artifacts') as unknown as Table<ArtifactRecord>;
    this.versions = domain.table('versions') as unknown as Table<ArtifactVersionRecord>;
  }

  /** 写入一份内容，返回更新后的制品记录。已有标识时递增版本。 */
  @Remote('put')
  async put(input: ArtifactInput): Promise<ArtifactRecord> {
    return this.access('put', {}, async (span) => {
      const artifacts = this.require(this.artifacts);
      const versions = this.require(this.versions);
      if (input.sessionId.trim() === '') throw new ArtifactError(ARTIFACT_ERROR_CODES.requestInvalid, '写入制品需要会话标识');
      if (input.title.trim() === '') throw new ArtifactError(ARTIFACT_ERROR_CODES.requestInvalid, '写入制品需要标题');
      if (input.mimeType.trim() === '') throw new ArtifactError(ARTIFACT_ERROR_CODES.requestInvalid, '写入制品需要媒体类型');
      const bytes = typeof input.content === 'string'
        ? Buffer.from(input.content, input.encoding === 'base64' ? 'base64' : 'utf8')
        : Buffer.from(input.content);
      const now = Date.now();
      const existing = input.id === undefined ? undefined : artifacts.get(input.id);
      if (input.id !== undefined && existing === undefined) {
        throw new ArtifactError(ARTIFACT_ERROR_CODES.objectNotFound, `制品 ${input.id} 不存在`);
      }
      const id = existing?.id ?? input.id ?? randomUUID();
      const version = (existing?.version ?? 0) + 1;
      const storageKey = join(id, `v${version}`);
      const absolute = join(dataRoot(), 'artifacts', storageKey);
      // 历史版本不可改写：同一版本号已经有记录或已经有内容文件时拒绝写入。
      if (versions.get(`${id}@${version}`) !== undefined || existsSync(absolute)) {
        throw new ArtifactError(ARTIFACT_ERROR_CODES.versionImmutable, `制品 ${id} 的第 ${version} 版已经存在，历史版本不可改写`);
      }
      await mkdir(dirname(absolute), { recursive: true });
      // 独占创建：即使并发写同一版本，也不会覆盖已有字节。
      await writeFile(absolute, bytes, { flag: 'wx' });
      const record: ArtifactRecord = {
        id,
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        title: input.title,
        kind: input.kind ?? existing?.kind ?? 'other',
        mimeType: input.mimeType,
        size: bytes.byteLength,
        version,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        sourceEventSeq: input.sourceEventSeq,
      };
      await versions.put(`${id}@${version}`, {
        artifactId: id,
        version,
        size: bytes.byteLength,
        mimeType: input.mimeType,
        createdAt: now,
        storageKey,
        sessionId: input.sessionId,
        ...(input.sourceTurn === undefined ? {} : { sourceTurn: input.sourceTurn }),
        digest: digestOf(bytes),
      });
      await artifacts.put(id, record);
      span?.setAttribute('version', version);
      return record;
    });
  }

  /** 读取一份内容；省略版本时取最新。内容以 base64 返回，跨 wire 无损。 */
  @Remote('read')
  async read(id: string, version?: number): Promise<ArtifactReadResult> {
    return this.access('read', {}, async (span) => {
      const record = this.recordOf(id);
      const selected = version ?? record.version;
      span?.setAttribute('version', selected);
      const entry = this.require(this.versions).get(`${id}@${selected}`);
      if (entry === undefined) {
        throw new ArtifactError(ARTIFACT_ERROR_CODES.versionUnknown, `制品 ${id} 没有第 ${selected} 版`);
      }
      const content = await readFile(join(dataRoot(), 'artifacts', entry.storageKey));
      const view = this.viewOf(record, entry);
      return {
        record,
        version: view,
        base64: content.toString('base64'),
        contentType: contentTypeOf(entry.mimeType),
        preview: previewOf(entry.mimeType),
      };
    });
  }

  /** 列出制品；给出会话标识时只列该会话的。 */
  @Remote('list')
  list(sessionId?: string): ArtifactRecord[] {
    const artifacts = this.require(this.artifacts);
    const all = [...artifacts.entries()].map(([, record]) => record);
    return sessionId === undefined ? all : all.filter((record) => record.sessionId === sessionId);
  }

  /** 列出某个制品的全部版本记录，按版本号升序。 */
  @Remote('versions')
  versionsOf(id: string): ArtifactVersionRecord[] {
    const versions = this.require(this.versions);
    return [...versions.entries()]
      .filter(([, entry]) => entry.artifactId === id)
      .map(([, entry]) => entry)
      .sort((a, b) => a.version - b.version);
  }

  /**
   * 版本列表。
   *
   * 当前版本必须出现在版本列表里，并且是最高版本；版本记录与制品记录不一致时就地拒绝，
   * 不把不一致的状态交给客户端。
   * @param id - 制品标识。
   * @returns 版本列表。
   */
  @Remote('versionList')
  async versionList(id: string): Promise<ArtifactVersionList> {
    return this.access('versions', {}, async (span) => {
      const record = this.recordOf(id);
      const entries = this.versionsOf(id);
      span?.setAttribute('version', record.version);
      if (entries.length === 0) {
        throw new ArtifactError(ARTIFACT_ERROR_CODES.versionUnknown, `制品 ${id} 没有任何版本记录`);
      }
      const highest = entries[entries.length - 1] as ArtifactVersionRecord;
      if (highest.version !== record.version) {
        throw new ArtifactError(
          ARTIFACT_ERROR_CODES.versionUnknown,
          `制品 ${id} 的当前版本 ${record.version} 与版本记录最高版本 ${highest.version} 不一致`,
        );
      }
      return { artifactId: id, currentVersion: record.version, versions: entries.map((entry) => this.viewOf(record, entry)) };
    });
  }

  /**
   * 计算删除范围。
   *
   * 删除确认需要列出全部版本与占用空间，这一层只计算不删除。
   * @param id - 制品标识。
   * @returns 删除范围。
   */
  @Remote('deleteScope')
  async deleteScope(id: string): Promise<ArtifactDeleteScope> {
    return this.access('delete', {}, async (span) => {
      const record = this.recordOf(id);
      const entries = this.versionsOf(id);
      span?.setAttribute('version', record.version);
      if (entries.length === 0) {
        throw new ArtifactError(ARTIFACT_ERROR_CODES.versionUnknown, `制品 ${id} 没有任何版本记录`);
      }
      const versions = entries.map((entry) => entry.version);
      return {
        artifactId: id,
        allVersions: true,
        versions,
        affectedVersions: versions,
        totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
        requiresConfirm: true,
      };
    });
  }

  /**
   * 核对版本记录与内容字节是否一致。
   * @param id - 制品标识。
   * @returns 版本一致性事实。
   */
  @Remote('verify')
  async verify(id: string): Promise<ArtifactIntegrity> {
    return this.access('verify', {}, async (span) => {
      const record = this.recordOf(id);
      const entries = this.versionsOf(id);
      span?.setAttribute('version', record.version);
      const missingFiles: number[] = [];
      const digestMismatches: number[] = [];
      let contentBytes = 0;
      for (const entry of entries) {
        const absolute = join(dataRoot(), 'artifacts', entry.storageKey);
        if (!existsSync(absolute)) {
          missingFiles.push(entry.version);
          continue;
        }
        const content = await readFile(absolute);
        contentBytes += content.byteLength;
        if (entry.digest !== undefined && entry.digest !== digestOf(content)) digestMismatches.push(entry.version);
      }
      return {
        artifactId: id,
        currentVersion: record.version,
        versions: entries.map((entry) => entry.version),
        declaredBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
        contentBytes,
        missingFiles,
        digestMismatches,
      };
    });
  }

  /**
   * 校验版本引用。
   *
   * 制品标识与版本号必须成对成立：制品存在、版本记录存在、版本记录属于该制品。
   * @param ref - 版本引用。
   * @returns 被引用版本的对外形状。
   */
  @Remote('resolveRef')
  async resolveRef(ref: ArtifactVersionRef): Promise<ArtifactVersionView> {
    return this.access('resolve', { version: ref.version }, async (span) => {
      if (typeof ref.artifactId !== 'string' || ref.artifactId.trim() === '') {
        throw new ArtifactError(ARTIFACT_ERROR_CODES.requestInvalid, '版本引用缺少制品标识');
      }
      if (typeof ref.version !== 'number' || !Number.isInteger(ref.version) || ref.version < 1) {
        throw new ArtifactError(ARTIFACT_ERROR_CODES.requestInvalid, '版本引用缺少合法的版本号');
      }
      const record = this.recordOf(ref.artifactId);
      const entry = this.require(this.versions).get(`${ref.artifactId}@${ref.version}`);
      if (entry === undefined || entry.artifactId !== ref.artifactId) {
        throw new ArtifactError(ARTIFACT_ERROR_CODES.versionUnknown, `制品 ${ref.artifactId} 没有第 ${ref.version} 版`);
      }
      span?.setAttribute('version', entry.version);
      return this.viewOf(record, entry);
    });
  }

  /** 删除一个制品及其全部版本文件。 */
  @Remote({ name: 'delete' })
  async remove(id: string): Promise<boolean> {
    return this.access('delete', {}, async () => {
      const artifacts = this.require(this.artifacts);
      const versions = this.require(this.versions);
      if (artifacts.get(id) === undefined) return false;
      for (const entry of this.versionsOf(id)) await versions.delete(`${id}@${entry.version}`);
      await rm(join(dataRoot(), 'artifacts', id), { recursive: true, force: true });
      return artifacts.delete(id);
    });
  }

  /**
   * 在一个动作 span 里执行，失败时补事件与计数。
   * @param action - 动作名。
   * @param attributes - 附加到 span 的属性。
   * @param body - 动作主体。
   * @returns 动作结果。
   */
  private async access<T>(
    action: ArtifactAction,
    attributes: Record<string, unknown>,
    body: (span: SpanLike | undefined) => Promise<T>,
  ): Promise<T> {
    const telemetry = telemetryOf<ArtifactsTelemetry>(this.ctx);
    const run = async (span?: SpanLike): Promise<T> => {
      try {
        const value = await body(span);
        span?.setAttribute('action', action);
        span?.setAttribute('outcome', 'ok');
        telemetry?.counter('chatdsh_artifact_operations_total', { description: '制品操作结果' }).add(1, { action, outcome: 'ok' });
        return value;
      } catch (error) {
        const type = error instanceof Error ? error.name : 'Unknown';
        const code = error instanceof ArtifactError ? error.code : 'internal-error';
        span?.setAttribute('action', action);
        span?.setAttribute('outcome', 'failed');
        span?.setAttribute('error.type', type);
        telemetry?.event('chatdsh.runtime.artifact.rejected', {
          action,
          outcome: 'failed',
          'error.type': type,
          'error.code': code,
        });
        telemetry?.counter('chatdsh_artifact_operations_total', { description: '制品操作结果' }).add(1, { action, outcome: 'failed' });
        throw error;
      }
    };
    if (telemetry === undefined) return run();
    return telemetry.runSpan('chatdsh.runtime.artifact.access', { action, ...attributes }, run);
  }

  /** 取一条制品记录，缺失时就地抛出。 */
  private recordOf(id: string): ArtifactRecord {
    const record = this.require(this.artifacts).get(id);
    if (record === undefined) throw new ArtifactError(ARTIFACT_ERROR_CODES.objectNotFound, `制品 ${id} 不存在`);
    return record;
  }

  /** 把一条版本记录转成对外形状。 */
  private viewOf(record: ArtifactRecord, entry: ArtifactVersionRecord): ArtifactVersionView {
    return {
      artifactId: entry.artifactId,
      version: entry.version,
      mimeType: entry.mimeType,
      size: entry.size,
      createdAt: entry.createdAt,
      immutable: true,
      sourceSessionId: entry.sessionId ?? record.sessionId,
      ...(entry.sourceTurn === undefined ? {} : { sourceTurn: entry.sourceTurn }),
      downloadable: true,
    };
  }

  private require<V>(table: Table<V> | undefined): Table<V> {
    if (table === undefined) throw new Error('artifact storage is not ready');
    return table;
  }
}

export default ChatdshArtifactsService;
