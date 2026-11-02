/**
 * 连续副本、持久补传与已提交事件的接收端。
 *
 * 存储层在事务里同时写入事件、连续前缀、字节账本与通知登记；HTTP 层在提交之后广播
 * 通知并返回确认；DTO 层只暴露界面与导出需要的字段。设备侧的意图与扫描在
 * `@chatdsh/host-push` 内实现，两侧通过本模块的路由交换幂等批次。
 * @module @chatdsh/gateway/replica-continuity
 */

export { REPLICA_ERROR_CODES, ReplicaContinuityError, type ReplicaErrorCode } from './errors.ts';
export {
  ReplicaContinuityStore,
  canonicalJson,
  replicaBytesOf,
  replicaDigestOf,
  type CommittedReplicaEvent,
  type ReplicaAppendRequest,
  type ReplicaAppendResult,
  type ReplicaCursorView,
  type ReplicaEventInput,
  type ReplicaNotificationRecord,
  type ReplicaRetentionState,
  type StoredReplicaEvent,
} from './store.ts';
export {
  REPLICA_BODY_LIMIT,
  REPLICA_HEALTH_PATH,
  REPLICA_PATH,
  REPLICA_RETENTION_PATH,
  startReplicaServer,
  type ReplicaServerHandle,
  type ReplicaServerOptions,
} from './http.ts';
export {
  INTERNAL_REPLICA_FIELDS,
  replicaExportOf,
  replicaOverviewOf,
  type ReplicaExportEntry,
  type ReplicaOverview,
} from './dto.ts';
