/**
 * 全链路资源额度、守卫、公平调度与容量报告。
 *
 * 调用方在分配内存之前用守卫核对尺寸，用有界受理限制并发与排队，用公平调度把慢消费隔离在
 * 自己的额度里，用容量记录器按登记阈值产出报告。库本身不记遥测，信号由使用它的模块发出。
 * @module @chatdsh/core-limits
 */

export {
  RESOURCE_ERROR_CODES,
  RESOURCE_LIMITS,
  RESOURCE_SCOPES,
  limitOf,
  limitValueOf,
  toMiB,
  type HandlingEntry,
  type LimitUnit,
  type RejectionSpec,
  type ResourceErrorCode,
  type ResourceLimit,
  type ResourceScope,
} from './policy.ts';
export {
  ResourceLimitError,
  budgetRejection,
  isSizeRejection,
  rejectionOf,
  type ResourceRejection,
} from './errors.ts';
export {
  CountedBytes,
  GUARD_OK,
  createDeadline,
  guardBytes,
  guardCount,
  guardMilliseconds,
  guardDeclaredLength,
  type Deadline,
  type GuardVerdict,
} from './guard.ts';
export {
  BoundedAdmission,
  BoundedQueue,
  type AdmissionEvent,
  type AdmissionOptions,
  type AdmissionOutcome,
  type QueueResult,
  type QueueSnapshot,
} from './admission.ts';
export {
  FairDispatcher,
  type FairDispatcherOptions,
  type TargetSnapshot,
} from './scheduler.ts';
export {
  PeakTracker,
  readChildProcessCount,
  readFileDescriptorCount,
  sampleProcess,
  type ProcessSample,
} from './sampling.ts';
export { percentileOf, summarize, type Distribution } from './stats.ts';
export {
  CAPACITY_THRESHOLDS,
  CapacityRecorder,
  SCENARIO_GATES,
  type CapacityGate,
  type CapacityRecorderOptions,
  type CapacityScenario,
  type CapacityThresholds,
  type GateMetric,
  type GateResult,
  type ScenarioReport,
  type ScenarioSession,
} from './capacity.ts';
