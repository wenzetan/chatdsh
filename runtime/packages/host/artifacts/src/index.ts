/**
 * 制品：可版本化的产出文件。
 *
 * 元数据进结构化存储，内容字节写在产品数据目录下（不是用户工作区），因此制品不参与
 * 工作区文件的沙箱判定；制品与工作区文件是两类东西。版本只增不改，读取可以指定版本。
 *
 * 对外方法走 typert Remote：客户端与控制平面按 `chatdshArtifacts` 命名空间调用。
 * @module @chatdsh/host-artifacts
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Remote, storageDomainOf, TypertRemoteService, type Context } from '@chatdsh/adapter';
import { ARTIFACTS_DOMAIN, type ArtifactRecord, type ArtifactVersionRecord } from './domain.ts';

export type { ArtifactRecord, ArtifactVersionRecord } from './domain.ts';
export { ARTIFACTS_DOMAIN, artifactSchema, versionSchema } from './domain.ts';

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
}

/** 一次读取的结果，内容以 base64 传出，保证跨 wire 无损。 */
export interface ArtifactReadResult {
  readonly record: ArtifactRecord;
  readonly base64: string;
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
    const artifacts = this.require(this.artifacts);
    const versions = this.require(this.versions);
    const bytes = typeof input.content === 'string'
      ? Buffer.from(input.content, input.encoding === 'base64' ? 'base64' : 'utf8')
      : Buffer.from(input.content);
    const now = Date.now();
    const existing = input.id === undefined ? undefined : artifacts.get(input.id);
    if (input.id !== undefined && existing === undefined) throw new Error(`artifact ${input.id} does not exist`);
    const id = existing?.id ?? input.id ?? randomUUID();
    const version = (existing?.version ?? 0) + 1;
    const storageKey = join(id, `v${version}`);
    const absolute = join(dataRoot(), 'artifacts', storageKey);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes);
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
    });
    await artifacts.put(id, record);
    return record;
  }

  /** 读取一份内容；省略版本时取最新。内容以 base64 返回，跨 wire 无损。 */
  @Remote('read')
  async read(id: string, version?: number): Promise<ArtifactReadResult> {
    const artifacts = this.require(this.artifacts);
    const versions = this.require(this.versions);
    const record = artifacts.get(id);
    if (record === undefined) throw new Error(`artifact ${id} does not exist`);
    const selected = version ?? record.version;
    const entry = versions.get(`${id}@${selected}`);
    if (entry === undefined) throw new Error(`artifact ${id} has no version ${selected}`);
    const content = await readFile(join(dataRoot(), 'artifacts', entry.storageKey));
    return { record, base64: content.toString('base64') };
  }

  /** 列出制品；给出会话标识时只列该会话的。 */
  @Remote('list')
  list(sessionId?: string): ArtifactRecord[] {
    const artifacts = this.require(this.artifacts);
    const all = [...artifacts.entries()].map(([, record]) => record);
    return sessionId === undefined ? all : all.filter((record) => record.sessionId === sessionId);
  }

  /** 列出某个制品的全部版本，按版本号升序。 */
  @Remote('versions')
  versionsOf(id: string): ArtifactVersionRecord[] {
    const versions = this.require(this.versions);
    return [...versions.entries()]
      .filter(([, entry]) => entry.artifactId === id)
      .map(([, entry]) => entry)
      .sort((a, b) => a.version - b.version);
  }

  /** 删除一个制品及其全部版本文件。 */
  @Remote('remove')
  async remove(id: string): Promise<boolean> {
    const artifacts = this.require(this.artifacts);
    const versions = this.require(this.versions);
    for (const entry of this.versionsOf(id)) await versions.delete(`${id}@${entry.version}`);
    await rm(join(dataRoot(), 'artifacts', id), { recursive: true, force: true });
    return artifacts.delete(id);
  }

  private require<V>(table: Table<V> | undefined): Table<V> {
    if (table === undefined) throw new Error('artifact storage is not ready');
    return table;
  }
}

export default ChatdshArtifactsService;
