export type CapabilityDomain =
  | 'execution' | 'memory' | 'skills' | 'retrieval'
  | 'scheduling' | 'orchestration' | 'artifacts' | 'tools';

export type MemoryScope =
  | { kind: 'global'; deviceId: string }
  | { kind: 'project'; deviceId: string; projectId: string }
  | { kind: 'session'; deviceId: string; sessionId: string };

export type SessionRole = 'ordinary' | 'router' | 'worker' | 'subagent';
export type LifecycleOwner = 'native' | 'platform' | 'manual';

// 身份和允许范围由宿主解析，公共请求只携带待验证的对象标识。
export interface InvocationContext {
  readonly invocationId: string;
  readonly operationId: string;
  readonly actorId: string;
  readonly actorKind: 'human' | 'agent' | 'automation';
  readonly deviceId: string;
  readonly sessionId?: string;
  readonly projectId?: string;
  readonly role?: SessionRole;
  readonly bindingRevision: number;
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  readonly traceparent?: string;
}

export type CapabilityErrorCode =
  | 'capability/not-configured' | 'capability/unsupported'
  | 'capability/incompatible' | 'capability/conflict'
  | 'capability/forbidden' | 'capability/unavailable'
  | 'capability/deadline-exceeded' | 'capability/cancelled'
  | 'capability/invalid-result' | 'capability/unconfirmed';

export interface CapabilityError {
  code: CapabilityErrorCode;
  message: string;
  invocationId: string;
  operationId?: string;
}

export interface ProviderIdentity {
  integrationId: string;
  integrationVersion: string;
  instanceId: string;
  pluginPackage: string;
  pluginVersion: string;
  artifactDigest: string;
  sourceRevision?: string;
}

export interface OperationSupport {
  idempotency: 'native' | 'none';
  cancellation: 'native' | 'wait-only';
  completion: 'synchronous' | 'asynchronous';
  queryable: boolean;
  conditionalWrite: boolean;
}

export type MemoryOperation = keyof MemoryPort;

export interface MemoryDescriptor {
  apiVersion: 'chatdsh.memory/v1';
  provider: ProviderIdentity;
  operations: Readonly<Partial<Record<MemoryOperation, OperationSupport>>>;
  writeModes: readonly ('append' | 'replace')[];
  deleteModes: readonly ('archive' | 'soft-delete' | 'permanent-delete')[];
  archiveFormats: readonly { format: string; version: string }[];
  scopes: readonly MemoryScope['kind'][];
  supportedRoles: readonly SessionRole[];
  lifecycleOwners: readonly LifecycleOwner[];
  nativeRoleFiltering: boolean;
  dataLocation: 'device' | 'external-service';
  reconfigure: 'live' | 'restart';
}

export interface MemoryBindingSnapshot {
  bindingId: string;
  revision: number;
  dshVersion: string;
  dependencyLockDigest: string;
  scope: MemoryScope;
  primary: ProviderIdentity | null;
  readSources: readonly {
    provider: ProviderIdentity;
    nativeScope: string;
    required: boolean;
    maxResults: number;
    maxTokens: number;
  }[];
  writeNativeScope?: string;
  lifecycleOwner: LifecycleOwner;
  configurationDigest: string;
}

export interface MemoryReference {
  integrationId: string;
  instanceId: string;
  nativeScope: string;
  nativeId: string;
  nativeRevision?: string;
}

export interface MemoryRecord {
  reference: MemoryReference;
  scope: MemoryScope;
  text: string;
  title?: string;
  updatedAt?: string;
  state: 'active' | 'archived' | 'deleted' | 'unknown';
  score?: { value: number; meaning: string };
}

export interface MemoryPage {
  records: readonly MemoryRecord[];
  cursor?: string;
}

export interface MemoryReceiptBase {
  operationId: string;
  provider: ProviderIdentity;
  nativeOperationId?: string;
}

export type MemoryReceipt = MemoryReceiptBase & (
  | { state: 'committed'; references: readonly MemoryReference[]; durability: string }
  | { state: 'accepted' | 'pending-approval'; queryable: boolean }
  | { state: 'unconfirmed'; queryable: boolean }
  | { state: 'rejected' | 'cancelled'; reason: string }
);

export interface MemoryArchive {
  provider: ProviderIdentity;
  scope: MemoryScope;
  format: string;
  formatVersion: string;
  artifactId: string;
  digest: string;
  coverage: readonly string[];
}

// 适配器只实现已声明的操作，服务对缺少操作返回明确错误。
export interface MemoryPort {
  recall(input: {
    scope: MemoryScope;
    nativeScope: string;
    query: string;
    maxResults: number;
    maxTokens: number;
  }, context: InvocationContext): Promise<MemoryPage>;
  list(input: {
    scope: MemoryScope;
    nativeScope: string;
    limit: number;
    cursor?: string;
  }, context: InvocationContext): Promise<MemoryPage>;
  get(input: {
    scope: MemoryScope;
    reference: MemoryReference;
  }, context: InvocationContext): Promise<MemoryRecord>;
  write(input: {
    scope: MemoryScope;
    target:
      | { kind: 'append'; nativeScope: string }
      | { kind: 'replace'; reference: MemoryReference; expectedRevision: string };
    text: string;
    source: { sessionId?: string; taskId?: string; artifactId?: string };
  }, context: InvocationContext): Promise<MemoryReceipt>;
  delete(input: {
    scope: MemoryScope;
    reference: MemoryReference;
    mode: 'archive' | 'soft-delete' | 'permanent-delete';
    expectedRevision?: string;
  }, context: InvocationContext): Promise<MemoryReceipt>;
  export(input: {
    scope: MemoryScope;
    nativeScope: string;
    format: string;
  }, context: InvocationContext): Promise<MemoryArchive>;
  import(input: {
    scope: MemoryScope;
    nativeScope: string;
    archive: MemoryArchive;
    conflictPolicy: 'reject' | 'provider-merge';
  }, context: InvocationContext): Promise<MemoryReceipt>;
  getOperation(input: {
    scope: MemoryScope;
    operationId: string;
    nativeOperationId?: string;
  }, context: InvocationContext): Promise<MemoryReceipt>;
}

export type MemoryAdapter = {
  [K in MemoryOperation]: {
    operation: K;
    support: OperationSupport;
    invoke: MemoryPort[K];
  }
}[MemoryOperation];

export interface MemoryIntegration {
  descriptor: MemoryDescriptor;
  operations: readonly MemoryAdapter[];
  dispose(): Promise<void>;
}

export type CapabilityStatus =
  | 'not-installed' | 'no-adapter' | 'not-bound' | 'disabled' | 'incompatible'
  | 'pending-restart' | 'unavailable' | 'available';

export interface MemorySourceResult {
  provider: ProviderIdentity;
  result:
    | { state: 'succeeded'; page: MemoryPage }
    | { state: 'failed'; error: CapabilityError };
}

export interface MemoryService {
  describe(scope: MemoryScope, context: InvocationContext): Promise<{
    status: CapabilityStatus;
    binding: { bindingId: string; revision: number } | null;
    providers: readonly MemoryDescriptor[];
  }>;
  recall(input: {
    scope: MemoryScope;
    query: string;
  }, context: InvocationContext): Promise<{
    bindingRevision: number;
    sources: readonly MemorySourceResult[];
  }>;
  list(input: {
    scope: MemoryScope;
    instanceId: string;
    limit: number;
    cursor?: string;
  }, context: InvocationContext): Promise<MemoryPage>;
  get(input: {
    scope: MemoryScope;
    reference: MemoryReference;
  }, context: InvocationContext): Promise<MemoryRecord>;
  write(input: {
    scope: MemoryScope;
    target:
      | { kind: 'append' }
      | { kind: 'replace'; reference: MemoryReference; expectedRevision: string };
    text: string;
    source: { sessionId?: string; taskId?: string; artifactId?: string };
  }, context: InvocationContext): Promise<MemoryReceipt>;
  delete(input: {
    scope: MemoryScope;
    reference: MemoryReference;
    mode: 'archive' | 'soft-delete' | 'permanent-delete';
    expectedRevision?: string;
  }, context: InvocationContext): Promise<MemoryReceipt>;
  export(input: {
    scope: MemoryScope;
    instanceId: string;
    format: string;
  }, context: InvocationContext): Promise<MemoryArchive>;
  import(input: {
    scope: MemoryScope;
    archive: MemoryArchive;
    conflictPolicy: 'reject' | 'provider-merge';
  }, context: InvocationContext): Promise<MemoryReceipt>;
  getOperation(input: {
    scope: MemoryScope;
    operationId: string;
  }, context: InvocationContext): Promise<MemoryReceipt>;
}
