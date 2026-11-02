/**
 * 全链路资源限制、背压与容量报告。
 *
 * 额度表、守卫、有界受理与公平调度来自 `@chatdsh/core-limits`；本目录把它们接在控制平面的
 * 真实 HTTP 路径上，并提供可直接监听的服务、容量场景驱动与冷启动探针。公共路由接入由发行
 * 集成负责，本模块只交付可装配的能力与验收测量。
 * @module @chatdsh/gateway/resource-limits
 */

export {
  ResourceGovernor,
  declaredLengthOf,
  guardFrame,
  type BodyRead,
  type GovernorOptions,
  type GovernorSnapshot,
  type SseAdmission,
} from './governor.ts';
export {
  FairFanout,
  FANOUT_SPAN,
  eventTooLarge,
  guardReplayLimit,
  type FanoutEvent,
  type FanoutOptions,
  type FanoutSubscription,
  type PublishResult,
} from './fanout.ts';
export {
  RESOURCE_EVENTS,
  RESOURCE_METRICS,
  RESOURCE_SPANS,
  ResourceTelemetry,
} from './telemetry.ts';
export {
  defaultRejection,
  guardEventBytes,
  rejectionBodyOf,
  startResourceLimitServer,
  type BackupJobOutcome,
  type ExportJobOutcome,
  type RejectionBody,
  type ResourceLimitServerHandle,
  type ResourceLimitServerOptions,
  type ServerStats,
} from './server.ts';
export {
  createResourceJobs,
  type ResourceExportScope,
  type ResourceJobOptions,
  type ResourceJobs,
} from './jobs.ts';
export {
  createRemoteProbe,
  type RemoteProbe,
  type RemoteState,
} from './remote.ts';
export {
  call,
  measureBusinessActivation,
  measureColdStart,
  measureConcurrentStreaming,
  measureExportBackup,
  measureLongSessionPagination,
  measureOverLimitUpload,
  measureQueueRecovery,
  measureReconnect,
  measureReplicaCatchup,
  measureShellStatic,
  measureSlowConsumer,
  measureSubscriptions,
  runCapacityScenarios,
  type CapacityRunOptions,
  type HttpResult,
  type OpenStream,
} from './capacity.ts';
