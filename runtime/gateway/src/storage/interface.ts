/**
 * 持久化接口。
 *
 * 控制平面、连续副本、备份与 Postgres 后端共用这一组端口。实现方负责把记录落到具体
 * 引擎（默认 SQLite，Postgres 为可替换实现）；调用方只经事务句柄读写，不直接持有连接。
 *
 * 三条语义对所有端口成立：同一事务内的写入一同提交或一同回滚；带幂等键的写入在重复
 * 调用时返回既有结果，内容不同则抛出冲突；归属、游标与账本必须与事件同时提交。
 * @module @chatdsh/gateway/storage/interface
 */

/** 事务句柄。端口方法在事务内执行，不自行开启事务。 */
export interface StorageTransaction {
  /** 事务标识，用于日志与排错。 */
  readonly id: string;
}

/** 幂等操作的状态。 */
export type OperationState = 'pending' | 'applied' | 'failed';

/** 一条幂等操作记录。 */
export interface OperationRecord {
  /** 调用方给出的操作标识。 */
  readonly operationId: string;
  /** 请求摘要；同一标识的摘要不同即拒绝。 */
  readonly requestDigest: string;
  /** 发起设备。 */
  readonly deviceId: string;
  /** 状态。 */
  readonly state: OperationState;
  /** 完成结果的引用；未完成时为空。 */
  readonly resultRef?: string;
  /** 创建时刻的毫秒时间戳。 */
  readonly createdAt: number;
  /** 过期时刻的毫秒时间戳。 */
  readonly expiresAt: number;
}

/** 一条访问会话记录。凭据只保存哈希。 */
export interface AccessSessionRecord {
  /** 令牌摘要。 */
  readonly tokenHash: string;
  /** 创建时刻的毫秒时间戳。 */
  readonly createdAt: number;
  /** 过期时刻的毫秒时间戳。 */
  readonly expiresAt: number;
  /** 撤销时刻；未撤销时为空。 */
  readonly revokedAt?: number;
  /** 最近一次校验通过的时刻。 */
  readonly lastVerifiedAt?: number;
}

/** 一台设备当前代次。 */
export interface DeviceGenerationRecord {
  /** 设备标识。 */
  readonly deviceId: string;
  /** 代次；递增，旧代次令牌一律失效。 */
  readonly generation: number;
  /** 节点令牌摘要。 */
  readonly tokenDigest: string;
  /** 撤销时刻；未撤销时为空。 */
  readonly revokedAt?: number;
}

/** 一张配对码。 */
export interface PairingCodeRecord {
  /** 配对码摘要。 */
  readonly digest: string;
  /** 配对后的角色。 */
  readonly role: 'host' | 'executor' | 'both';
  /** 过期时刻的毫秒时间戳。 */
  readonly expiresAt: number;
  /** 已使用时刻；未使用为空。 */
  readonly consumedAt?: number;
}

/** 一条副本连续游标。 */
export interface ReplicaCursorRecord {
  /** 会话标识。 */
  readonly sessionId: string;
  /** 保留代次；清理后旧代次的补传不得重建内容。 */
  readonly retentionGeneration: number;
  /** 内部连续前缀，从 -1 开始。 */
  readonly continuousSeq: number;
  /** 该前缀处的内容摘要。 */
  readonly digest: string;
}

/** 一条待补传的副本事件。 */
export interface ReplicaOutboxRecord {
  /** 会话标识。 */
  readonly sessionId: string;
  /** 事件序号。 */
  readonly seq: number;
  /** 内容摘要。 */
  readonly digest: string;
  /** 保留代次。 */
  readonly retentionGeneration: number;
}

/** 一条运行期入站事件。 */
export interface RunInboxRecord {
  /** 运行标识。 */
  readonly runId: string;
  /** 事件标识。 */
  readonly eventId: string;
  /** 事件在该运行内的序号。 */
  readonly seq: number;
  /** 事件正文的引用。 */
  readonly payloadRef: string;
  /** 已应用时刻的毫秒时间戳。 */
  readonly appliedAt: number;
}

/** 一条记忆出站任务。 */
export interface MemoryOutboxRecord {
  /** 操作标识，幂等键。 */
  readonly operationId: string;
  /** 会话标识。 */
  readonly sessionId: string;
  /** 触发写入的结束序号。 */
  readonly endSeq: number;
  /** 记忆库标识。 */
  readonly bank: string;
  /** 状态。 */
  readonly state: 'pending' | 'delivered' | 'failed';
  /** 已尝试次数。 */
  readonly attempts: number;
  /** 下一次尝试的毫秒时间戳。 */
  readonly nextAttemptAt: number;
}

/** 一条通知出站任务。 */
export interface NotificationOutboxRecord {
  /** 业务关联键。 */
  readonly key: string;
  /** 接收客户端标识。 */
  readonly clientId: string;
  /** 状态。 */
  readonly state: 'pending' | 'delivered' | 'failed';
  /** 通知标签，用于替换同一标签的旧通知。 */
  readonly tag: string;
  /** 过期时刻的毫秒时间戳。 */
  readonly expiresAt: number;
}

/** 一份备份清单的登记。 */
export interface BackupManifestRecord {
  /** 清单标识。 */
  readonly manifestId: string;
  /** 备份时的 schema 版本。 */
  readonly schemaVersion: number;
  /** 生成时刻的毫秒时间戳。 */
  readonly createdAt: number;
  /** 覆盖的数据域。 */
  readonly domains: readonly string[];
  /** 加密密钥版本。 */
  readonly keyVersion: string;
  /** 清单正文的引用。 */
  readonly manifestRef: string;
}

/** 一条迁移任务记录。 */
export interface MigrationJobRecord {
  /** 任务标识。 */
  readonly jobId: string;
  /** 目标 schema 版本。 */
  readonly schemaVersion: number;
  /** 源摘要。 */
  readonly sourceDigest: string;
  /** 目标摘要。 */
  readonly targetDigest: string;
  /** 检查点位置，分批复制的最后一小批序号。 */
  readonly checkpoint: number;
  /** 任务状态。 */
  readonly state: 'planned' | 'copying' | 'verified' | 'switched' | 'failed' | 'aborted';
  /** 备份清单引用；尚未生成备份时为空。 */
  readonly manifestRef?: string;
}

/** 幂等操作端口。 */
export interface OperationPort {
  /** 登记一次操作；同一标识同一摘要返回既有记录，摘要不同抛出冲突。 */
  begin(tx: StorageTransaction, input: { operationId: string; requestDigest: string; deviceId: string; expiresAt: number; now: number }): OperationRecord;
  /** 记录完成结果。 */
  complete(tx: StorageTransaction, operationId: string, resultRef: string, now: number): OperationRecord;
  /** 读取一条操作。 */
  read(operationId: string): OperationRecord | undefined;
  /** 清理已过期且已完成的操作；未确认的操作不得按时间删除。 */
  purgeExpired(tx: StorageTransaction, now: number): number;
}

/** 访问会话端口。 */
export interface AccessSessionPort {
  /** 登记一条凭据摘要。 */
  create(tx: StorageTransaction, record: AccessSessionRecord): void;
  /** 校验令牌摘要；过期或已撤销返回空。 */
  verify(tx: StorageTransaction, tokenHash: string, now: number): AccessSessionRecord | undefined;
  /** 撤销一条凭据。 */
  revoke(tx: StorageTransaction, tokenHash: string, now: number): void;
}

/** 设备代次端口。 */
export interface DeviceGenerationPort {
  /** 递增代次并签发新令牌摘要，旧代次立即失效。 */
  issue(tx: StorageTransaction, deviceId: string, tokenDigest: string): DeviceGenerationRecord;
  /** 取当前代次。 */
  current(deviceId: string): DeviceGenerationRecord | undefined;
  /** 撤销设备全部代次。 */
  revoke(tx: StorageTransaction, deviceId: string, now: number): void;
}

/** 配对码端口。 */
export interface PairingCodePort {
  /** 登记一张配对码。 */
  issue(tx: StorageTransaction, record: PairingCodeRecord): void;
  /** 使用一张配对码；已使用、已过期或不存在返回空。 */
  consume(tx: StorageTransaction, digest: string, now: number): PairingCodeRecord | undefined;
}

/** 连续副本端口。 */
export interface ReplicaPort {
  /** 读连续游标。 */
  cursor(sessionId: string): ReplicaCursorRecord | undefined;
  /** 推进连续游标；同序号同摘要幂等，异摘要或跨过缺口抛出冲突。 */
  advance(tx: StorageTransaction, record: ReplicaCursorRecord): ReplicaCursorRecord;
  /** 追加待补传事件。 */
  appendOutbox(tx: StorageTransaction, record: ReplicaOutboxRecord): void;
  /** 读取待补传事件，按会话与序号升序。 */
  pendingOutbox(limit: number): readonly ReplicaOutboxRecord[];
  /** 确认已补传事件。 */
  ackOutbox(tx: StorageTransaction, record: { sessionId: string; seq: number }): void;
}

/** 运行期入站端口。 */
export interface RunInboxPort {
  /** 应用一条事件；同一 `(runId, eventId)` 重复应用幂等。 */
  apply(tx: StorageTransaction, record: RunInboxRecord): RunInboxRecord;
  /** 读已应用的事件，按序号升序。 */
  applied(runId: string): readonly RunInboxRecord[];
  /** 回收已应用且已归档的入站记录。 */
  reclaim(tx: StorageTransaction, runId: string, appliedBefore: number): number;
}

/** 记忆出站端口。 */
export interface MemoryOutboxPort {
  /** 登记一次记忆写入；同一操作标识重复登记幂等。 */
  enqueue(tx: StorageTransaction, record: MemoryOutboxRecord): MemoryOutboxRecord;
  /** 取到期的待投递任务。 */
  claim(now: number, limit: number): readonly MemoryOutboxRecord[];
  /** 结算一次投递。 */
  settle(tx: StorageTransaction, operationId: string, state: MemoryOutboxRecord['state'], nextAttemptAt: number): void;
}

/** 通知出站端口。 */
export interface NotificationOutboxPort {
  /** 登记一条通知；同一业务关联键与标签替换旧通知。 */
  enqueue(tx: StorageTransaction, record: NotificationOutboxRecord): void;
  /** 取到期通知。 */
  due(now: number, limit: number): readonly NotificationOutboxRecord[];
  /** 结算一条通知。 */
  settle(tx: StorageTransaction, key: string, state: NotificationOutboxRecord['state']): void;
}

/** 迁移任务端口。 */
export interface MigrationPort {
  /** 读取任务记录。 */
  job(jobId: string): MigrationJobRecord | undefined;
  /** 写入或更新任务记录。 */
  save(tx: StorageTransaction, record: MigrationJobRecord): void;
}

/** 备份清单端口。 */
export interface BackupPort {
  /** 登记一份备份清单。 */
  record(tx: StorageTransaction, record: BackupManifestRecord): void;
  /** 读取一份清单；不存在返回空。 */
  manifest(manifestId: string): BackupManifestRecord | undefined;
  /** 列出全部清单，按生成时刻升序。 */
  list(): readonly BackupManifestRecord[];
}

/** 全部端口的集合。 */
export interface ChatdshStorage {
  /** 已应用的 schema 版本。 */
  readonly schemaVersion: number;
  /** 在一个事务里执行；回调抛出时整体回滚。 */
  transaction<T>(fn: (tx: StorageTransaction) => T): T;
  /** 幂等操作。 */
  readonly operations: OperationPort;
  /** 访问会话与凭据。 */
  readonly accessSessions: AccessSessionPort;
  /** 设备代次。 */
  readonly deviceGenerations: DeviceGenerationPort;
  /** 配对码。 */
  readonly pairingCodes: PairingCodePort;
  /** 连续副本。 */
  readonly replicas: ReplicaPort;
  /** 运行期入站。 */
  readonly runInbox: RunInboxPort;
  /** 记忆出站。 */
  readonly memoryOutbox: MemoryOutboxPort;
  /** 通知出站。 */
  readonly notifications: NotificationOutboxPort;
  /** 迁移任务。 */
  readonly migrations: MigrationPort;
  /** 备份清单。 */
  readonly backups: BackupPort;
  /** 释放连接。 */
  close(): void;
}
