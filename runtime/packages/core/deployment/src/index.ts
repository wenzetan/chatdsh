/**
 * 部署核心的出口。
 *
 * 控制平面在启动前用这里的监听计划校验与传输材料加载，在运行期用请求守卫校验每个入站请求，
 * 用组合包装卸接口管理可选能力，用能力探测声明平台事实。
 * @module @chatdsh/core-deployment
 */

export {
  assertBindable,
  assertRuntimeRemote,
  assertRuntimeTarget,
  classifyAddress,
  isWildcard,
  type AddressClassification,
  type AddressKind,
} from './address.ts';
export { DeploymentError, type DeploymentErrorType, type GuardRejection, type GuardSource } from './errors.ts';
export {
  DEFAULT_WARN_BEFORE_DAYS,
  loadTlsMaterial,
  type TlsMaterial,
  type TlsPaths,
} from './tls.ts';
export {
  DEFAULT_IDENTITY_HEADERS,
  addAddressSpec,
  blockContains,
  isWriteMethod,
  normalizeRemote,
  startListener,
  validateListenerPlan,
  type ListenerPlan,
  type ListenerStartOptions,
  type TransportMode,
  type ValidatedListenerPlan,
} from './policy.ts';
export {
  createRequestGuard,
  stripIdentityHeaders,
  type AllowedRequestVerdict,
  type GuardRequest,
  type GuardVerdict,
  type RequestGuard,
  type RequestKind,
} from './guard.ts';
export {
  CapabilityDeployment,
  type BundleEndpoint,
  type BundleMenuEntry,
  type BundleMountContext,
  type BundleMountHandle,
  type BundleResourceKind,
  type BundleState,
  type CapabilityBundle,
  type CapabilityDeploymentOptions,
  type DeploymentSnapshot,
  type PlatformCapability,
  type PushMessage,
} from './bundles.ts';
export { createMemoryBundle, type MemoryBundleOptions } from './memory.ts';
export { createPwaBundle, type PwaBundleOptions, type PwaStaticContentLike } from './pwa.ts';
export {
  fileProbe,
  globalProbe,
  moduleProbe,
  probeCapabilities,
  type CapabilityProbe,
} from './capabilities.ts';
