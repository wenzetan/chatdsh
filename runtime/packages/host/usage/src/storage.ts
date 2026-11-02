/**
 * 存储用量：在数据根上按真实字节清点会话日志、副本、附件、记忆与其他文件。
 *
 * 清点只走文件系统：目录用 `readdir` 展开，每个条目用 `lstat` 取真实字节数，符号链接不跟随，
 * 因此总计与 `du -sb` 的口径一致（目录自身不计，符号链接按自身长度计）。副本的每会话字节
 * 与附件归属由调用方给出的索引补上：控制平面持有副本行，附件元数据属于结构化存储，这两处
 * 都不由本模块猜测。
 *
 * 读取失败一律就地抛出并带上失败的绝对路径，绝不把读不到的对象按零字节计入。界面据此显示
 * 错误状态，界面上不会出现看起来正常的零值。
 * @module @chatdsh/host-usage/storage
 */

import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** 字节来源的分类，与数据管理契约的用量维度一起构成用量读数。 */
export const STORAGE_BUCKETS = ['session', 'replica', 'attachment', 'memory', 'other'] as const;

/** 字节来源分类的取值。 */
export type StorageBucket = (typeof STORAGE_BUCKETS)[number];

/** 用量聚合的维度。 */
export const STORAGE_DIMENSIONS = ['device', 'workspace', 'session'] as const;

/** 用量聚合维度的取值。 */
export type StorageDimension = (typeof STORAGE_DIMENSIONS)[number];

/** 副本保留周期的允许范围，单位天，与跨组件契约一致。 */
export const STORAGE_RETENTION_RANGE = { min: 1, max: 3650, default: 90 } as const;

/** 附件标识的写法；同时挡住越出 `attachments/` 的路径。 */
const ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** 存储用量失败的错误码。 */
export type StorageUsageErrorCode = 'request-invalid' | 'internal-error';

/** 一次清点失败的异常。`path` 是读不到的那个绝对路径。 */
export class StorageUsageError extends Error {
  /** 稳定错误码，写入遥测的 `error.code`。 */
  readonly code: StorageUsageErrorCode;
  /** 失败发生在哪个路径上。 */
  readonly path?: string;

  constructor(code: StorageUsageErrorCode, message: string, path?: string) {
    super(message);
    this.name = 'StorageUsageError';
    this.code = code;
    if (path !== undefined) this.path = path;
  }
}

/** 一个会话的归属。 */
export interface StorageSessionRef {
  /** 会话标识。 */
  readonly sessionId: string;
  /** 会话归属的设备。 */
  readonly deviceId: string;
  /** 工作会话的工作区标识；聊天会话缺省。 */
  readonly workspaceId?: string;
  /** 会话记录的最近活动时刻；缺省按磁盘上的最新修改时刻计算。 */
  readonly lastActiveAt?: number;
}

/** 一个附件的归属。 */
export interface StorageAttachmentRef {
  /** 附件标识，对应数据根下 `attachments/<附件标识>/` 目录。 */
  readonly attachmentId: string;
  /** 附件所属的会话。 */
  readonly sessionId: string;
}

/** 控制平面副本里一个会话的字节数与最近活动时刻。 */
export interface StorageReplicaRef {
  /** 会话标识。 */
  readonly sessionId: string;
  /** 副本里该会话的真实事件字节数。 */
  readonly bytes: number;
  /** 副本里最新事件的时间。 */
  readonly lastActiveAt: number;
}

/** 一次清点的输入。 */
export interface StorageUsageInput {
  /** 数据根的绝对路径。 */
  readonly root: string;
  /** 本机设备标识。 */
  readonly deviceId: string;
  /** 副本保留周期，单位天。 */
  readonly retentionDays: number;
  /** 本机的会话归属。 */
  readonly sessions: readonly StorageSessionRef[];
  /** 附件的会话归属。 */
  readonly attachments: readonly StorageAttachmentRef[];
  /** 控制平面副本的每会话字节。 */
  readonly replicas: readonly StorageReplicaRef[];
}

/** 一个维度上的一行用量。 */
export interface StorageUsageRow {
  /** 维度。 */
  readonly dimension: StorageDimension;
  /** 维度取值：设备、工作区或会话标识。 */
  readonly key: string;
  /** 会话数量。 */
  readonly sessionCount: number;
  /** 文本副本字节数。 */
  readonly textReplicaBytes: number;
  /** 附件空间字节数。 */
  readonly attachmentBytes: number;
  /** 最近活动时刻的毫秒时间戳。 */
  readonly lastActiveAt: number;
  /** 副本保留周期，单位天。 */
  readonly retentionDays: number;
}

/** 一个来源分类的读数。 */
export interface StorageBucketUsage {
  /** 该分类的真实字节数。 */
  readonly bytes: number;
  /** 该分类的文件与符号链接个数。 */
  readonly files: number;
}

/** 一次清点的结果。 */
export interface StorageUsageReport {
  /** 被清点的数据根。 */
  readonly root: string;
  /** 本机设备标识。 */
  readonly deviceId: string;
  /** 清点时刻的毫秒时间戳。 */
  readonly measuredAt: number;
  /** 数据根下全部文件与符号链接的真实字节数，与 `du -sb` 一致。 */
  readonly totalBytes: number;
  /** 参与计数的文件与符号链接个数。 */
  readonly fileCount: number;
  /** 按来源分类的读数，五项之和等于 {@link StorageUsageReport.totalBytes}。 */
  readonly buckets: Readonly<Record<StorageBucket, StorageBucketUsage>>;
  /** 按设备、工作区与会话三个维度聚合的行。 */
  readonly rows: readonly StorageUsageRow[];
  /** 副本来源：索引为空时报告 `absent`，此时的副本字节读数按缺省处理。 */
  readonly replicaSource: 'measured' | 'absent';
}

/** 清点的中间累加器。 */
interface WalkAccumulator {
  readonly buckets: Record<StorageBucket, { bytes: number; files: number }>;
  readonly sessionBytes: Map<string, number>;
  readonly sessionMtime: Map<string, number>;
  readonly attachmentBytes: Map<string, number>;
  fileCount: number;
  newestMtime: number;
}

/** 一个会话在清点里的聚合读数。 */
interface SessionUsage {
  sessionId: string;
  deviceId: string;
  workspaceId?: string;
  replicaBytes: number;
  attachmentBytes: number;
  lastActiveAt: number;
}

/** 把底层异常转成一句可读的失败原因。 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? `${error.name}：${error.message}` : String(error);
}

/**
 * 数据根顶层的目录决定字节来源分类；其余路径归入「其他」。
 * @param segments - 相对数据根的路径分段。
 * @returns 字节来源分类。
 */
export function bucketOfPath(segments: readonly string[]): StorageBucket {
  const top = segments[0];
  if (top === 'sessions') return 'session';
  if (top === 'gateway') return 'replica';
  if (top === 'attachments') return 'attachment';
  if (top === 'memory') return 'memory';
  return 'other';
}

/**
 * 递归清点一个目录，把每个条目按路径分类累加。
 * @param absolute - 当前目录的绝对路径。
 * @param segments - 当前目录相对数据根的路径分段。
 * @param accumulator - 累加器。
 */
async function walk(absolute: string, segments: readonly string[], accumulator: WalkAccumulator): Promise<void> {
  let names: string[];
  try {
    const entries = await readdir(absolute, { withFileTypes: true });
    names = entries.map((entry) => entry.name);
  } catch (error) {
    throw new StorageUsageError('internal-error', `读取目录失败：${reasonOf(error)}`, absolute);
  }
  for (const name of names) {
    const child = join(absolute, name);
    const childSegments = [...segments, name];
    let info;
    try {
      info = await lstat(child);
    } catch (error) {
      throw new StorageUsageError('internal-error', `读取条目失败：${reasonOf(error)}`, child);
    }
    if (info.isDirectory()) {
      await walk(child, childSegments, accumulator);
      continue;
    }
    const bucket = bucketOfPath(childSegments);
    accumulator.buckets[bucket].bytes += info.size;
    accumulator.buckets[bucket].files += 1;
    accumulator.fileCount += 1;
    if (info.mtimeMs > accumulator.newestMtime) accumulator.newestMtime = Math.floor(info.mtimeMs);
    if (childSegments[0] === 'sessions' && childSegments.length >= 3) {
      const sessionId = childSegments[1] as string;
      accumulator.sessionBytes.set(sessionId, (accumulator.sessionBytes.get(sessionId) ?? 0) + info.size);
      const seen = accumulator.sessionMtime.get(sessionId) ?? 0;
      if (info.mtimeMs > seen) accumulator.sessionMtime.set(sessionId, Math.floor(info.mtimeMs));
    }
    if (childSegments[0] === 'attachments' && childSegments.length >= 3) {
      const attachmentId = childSegments[1] as string;
      accumulator.attachmentBytes.set(attachmentId, (accumulator.attachmentBytes.get(attachmentId) ?? 0) + info.size);
    }
  }
}

/** 新建一个空累加器。 */
function emptyAccumulator(): WalkAccumulator {
  return {
    buckets: {
      session: { bytes: 0, files: 0 },
      replica: { bytes: 0, files: 0 },
      attachment: { bytes: 0, files: 0 },
      memory: { bytes: 0, files: 0 },
      other: { bytes: 0, files: 0 },
    },
    sessionBytes: new Map<string, number>(),
    sessionMtime: new Map<string, number>(),
    attachmentBytes: new Map<string, number>(),
    fileCount: 0,
    newestMtime: 0,
  };
}

/**
 * 校验清点输入。缺项与越界字段就地拒绝，不进入文件系统。
 * @param input - 清点输入。
 */
function assertInput(input: StorageUsageInput): void {
  if (typeof input.root !== 'string' || input.root.trim() === '') {
    throw new StorageUsageError('request-invalid', '清点存储用量需要数据根');
  }
  if (typeof input.deviceId !== 'string' || input.deviceId.trim() === '') {
    throw new StorageUsageError('request-invalid', '清点存储用量需要设备标识');
  }
  if (!Number.isInteger(input.retentionDays)
    || input.retentionDays < STORAGE_RETENTION_RANGE.min
    || input.retentionDays > STORAGE_RETENTION_RANGE.max) {
    throw new StorageUsageError(
      'request-invalid',
      `副本保留周期必须是 ${String(STORAGE_RETENTION_RANGE.min)} 到 ${String(STORAGE_RETENTION_RANGE.max)} 之间的整数天`,
    );
  }
  const sessionIds = new Set<string>();
  for (const session of input.sessions) {
    if (typeof session.sessionId !== 'string' || session.sessionId.trim() === '') {
      throw new StorageUsageError('request-invalid', '会话归属缺少会话标识');
    }
    if (sessionIds.has(session.sessionId)) {
      throw new StorageUsageError('request-invalid', `会话归属重复：${session.sessionId}`);
    }
    sessionIds.add(session.sessionId);
  }
  const attachmentIds = new Set<string>();
  for (const attachment of input.attachments) {
    if (typeof attachment.attachmentId !== 'string' || attachment.attachmentId.trim() === '') {
      throw new StorageUsageError('request-invalid', '附件归属缺少附件标识');
    }
    if (!ATTACHMENT_ID_PATTERN.test(attachment.attachmentId)) {
      throw new StorageUsageError('request-invalid', `附件标识不合法：${attachment.attachmentId}`);
    }
    if (attachmentIds.has(attachment.attachmentId)) {
      throw new StorageUsageError('request-invalid', `附件归属重复：${attachment.attachmentId}`);
    }
    attachmentIds.add(attachment.attachmentId);
  }
  const replicaIds = new Set<string>();
  for (const replica of input.replicas) {
    if (typeof replica.sessionId !== 'string' || replica.sessionId.trim() === '') {
      throw new StorageUsageError('request-invalid', '副本读数缺少会话标识');
    }
    if (replicaIds.has(replica.sessionId)) {
      throw new StorageUsageError('request-invalid', `副本读数重复：${replica.sessionId}`);
    }
    if (!Number.isInteger(replica.bytes) || replica.bytes < 0) {
      throw new StorageUsageError('request-invalid', `副本字节数必须是非负整数：${String(replica.bytes)}`);
    }
    replicaIds.add(replica.sessionId);
  }
}

/**
 * 按真实字节清点数据根，并聚合出设备、工作区与会话三个维度的用量行。
 * @param input - 清点输入。
 * @returns 清点结果。
 * @throws StorageUsageError - 输入不合法，或某个目录与条目读不到。
 */
export async function measureStorageUsage(input: StorageUsageInput): Promise<StorageUsageReport> {
  assertInput(input);
  const accumulator = emptyAccumulator();
  const rootInfo = await lstat(input.root).catch((error: unknown) => {
    throw new StorageUsageError('internal-error', `读取数据根失败：${reasonOf(error)}`, input.root);
  });
  if (!rootInfo.isDirectory()) {
    throw new StorageUsageError('request-invalid', '数据根不是目录', input.root);
  }
  // 索引里登记过的附件必须真的在磁盘上；缺失或不是目录都算读取失败，不按零字节记。
  for (const attachment of input.attachments) {
    const path = join(input.root, 'attachments', attachment.attachmentId);
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      throw new StorageUsageError('internal-error', `读取附件目录失败：${reasonOf(error)}`, path);
    }
    if (!info.isDirectory()) {
      throw new StorageUsageError('internal-error', '附件内容不是目录', path);
    }
  }
  await walk(input.root, [], accumulator);

  const measuredAt = Date.now();
  const aggregates = new Map<string, SessionUsage>();
  const ensure = (sessionId: string): SessionUsage => {
    const existing = aggregates.get(sessionId);
    if (existing !== undefined) return existing;
    const created: SessionUsage = {
      sessionId,
      deviceId: input.deviceId,
      replicaBytes: 0,
      attachmentBytes: 0,
      lastActiveAt: 0,
    };
    aggregates.set(sessionId, created);
    return created;
  };

  for (const session of input.sessions) {
    const aggregate = ensure(session.sessionId);
    aggregate.deviceId = session.deviceId;
    if (session.workspaceId !== undefined) aggregate.workspaceId = session.workspaceId;
    if (session.lastActiveAt !== undefined) aggregate.lastActiveAt = Math.max(aggregate.lastActiveAt, session.lastActiveAt);
  }
  for (const sessionId of accumulator.sessionBytes.keys()) ensure(sessionId);
  for (const sessionId of accumulator.sessionMtime.keys()) {
    const aggregate = ensure(sessionId);
    aggregate.lastActiveAt = Math.max(aggregate.lastActiveAt, accumulator.sessionMtime.get(sessionId) as number);
  }
  for (const replica of input.replicas) {
    const aggregate = ensure(replica.sessionId);
    aggregate.replicaBytes = replica.bytes;
    aggregate.lastActiveAt = Math.max(aggregate.lastActiveAt, replica.lastActiveAt);
  }
  for (const attachment of input.attachments) {
    const bytes = accumulator.attachmentBytes.get(attachment.attachmentId) ?? 0;
    const aggregate = ensure(attachment.sessionId);
    aggregate.attachmentBytes += bytes;
  }
  for (const aggregate of aggregates.values()) {
    if (aggregate.lastActiveAt === 0) aggregate.lastActiveAt = measuredAt;
  }

  const rows: StorageUsageRow[] = [];
  for (const aggregate of aggregates.values()) {
    rows.push({
      dimension: 'session',
      key: aggregate.sessionId,
      sessionCount: 1,
      textReplicaBytes: aggregate.replicaBytes,
      attachmentBytes: aggregate.attachmentBytes,
      lastActiveAt: aggregate.lastActiveAt,
      retentionDays: input.retentionDays,
    });
  }

  const byWorkspace = new Map<string, SessionUsage[]>();
  for (const aggregate of aggregates.values()) {
    if (aggregate.workspaceId === undefined) continue;
    const bucket = byWorkspace.get(aggregate.workspaceId) ?? [];
    bucket.push(aggregate);
    byWorkspace.set(aggregate.workspaceId, bucket);
  }
  for (const [workspaceId, members] of byWorkspace) {
    rows.push(summarize('workspace', workspaceId, members, input.retentionDays));
  }

  let attributedAttachmentBytes = 0;
  for (const attachment of input.attachments) {
    attributedAttachmentBytes += accumulator.attachmentBytes.get(attachment.attachmentId) ?? 0;
  }
  const unattributedAttachmentBytes = accumulator.buckets.attachment.bytes - attributedAttachmentBytes;
  const byDevice = new Map<string, SessionUsage[]>();
  for (const aggregate of aggregates.values()) {
    const bucket = byDevice.get(aggregate.deviceId) ?? [];
    bucket.push(aggregate);
    byDevice.set(aggregate.deviceId, bucket);
  }
  const localDevice = byDevice.get(input.deviceId) ?? [];
  byDevice.set(input.deviceId, localDevice);
  for (const [deviceId, members] of byDevice) {
    const summary = summarize('device', deviceId, members, input.retentionDays);
    const extra = deviceId === input.deviceId ? unattributedAttachmentBytes : 0;
    rows.push({
      ...summary,
      attachmentBytes: summary.attachmentBytes + extra,
      lastActiveAt: summary.lastActiveAt === 0 ? accumulator.newestMtime || measuredAt : summary.lastActiveAt,
    });
  }

  rows.sort((left, right) => {
    if (left.dimension !== right.dimension) return STORAGE_DIMENSIONS.indexOf(left.dimension) - STORAGE_DIMENSIONS.indexOf(right.dimension);
    if (right.lastActiveAt !== left.lastActiveAt) return right.lastActiveAt - left.lastActiveAt;
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
  });

  return {
    root: input.root,
    deviceId: input.deviceId,
    measuredAt,
    totalBytes: STORAGE_BUCKETS.reduce((sum, bucket) => sum + accumulator.buckets[bucket].bytes, 0),
    fileCount: accumulator.fileCount,
    buckets: {
      session: { ...accumulator.buckets.session },
      replica: { ...accumulator.buckets.replica },
      attachment: { ...accumulator.buckets.attachment },
      memory: { ...accumulator.buckets.memory },
      other: { ...accumulator.buckets.other },
    },
    rows,
    replicaSource: input.replicas.length === 0 ? 'absent' : 'measured',
  };
}

/**
 * 把一组会话聚合成一行用量。
 * @param dimension - 维度。
 * @param key - 维度取值。
 * @param members - 组内的会话读数。
 * @param retentionDays - 副本保留周期。
 * @returns 一行用量。
 */
function summarize(dimension: StorageDimension, key: string, members: readonly SessionUsage[], retentionDays: number): StorageUsageRow {
  let lastActiveAt = 0;
  for (const member of members) lastActiveAt = Math.max(lastActiveAt, member.lastActiveAt);
  return {
    dimension,
    key,
    sessionCount: members.length,
    textReplicaBytes: members.reduce((sum, member) => sum + member.replicaBytes, 0),
    attachmentBytes: members.reduce((sum, member) => sum + member.attachmentBytes, 0),
    lastActiveAt,
    retentionDays,
  };
}
