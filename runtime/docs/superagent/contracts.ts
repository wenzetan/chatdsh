// 本文件是开发设计附件，只定义契约和固定数据，不参与业务构建。

export type Id = string;
export type Digest = string;
export type GitOid = string;
export type Revision = number;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Mode = 'single-session' | 'super-agent';
export type Role = 'router' | 'worker' | 'subagent';
export const TASK_STATES = ['queued', 'preparing', 'running', 'waiting', 'review', 'completed', 'cancelled', 'failed'] as const;
export type TaskState = typeof TASK_STATES[number];
export const WAIT_REASONS = ['dependency', 'question', 'approval', 'budget', 'recovery', 'resource', 'unconfirmed', 'paused'] as const;
export type WaitReason = typeof WAIT_REASONS[number];
export const APPLY_PHASES = ['preparing', 'prepared', 'authorized', 'files_applying', 'files_applied', 'index_applied', 'ref_published', 'verified', 'completed', 'needs_decision', 'conflict', 'aborted'] as const;
export type ApplyPhase = typeof APPLY_PHASES[number];
export const DEFAULT_LIMITS = {
  projectWorkers: 4, deviceWorkers: 8, projectModelCalls: 4, deviceModelCalls: 8,
  workerChildren: 4, queuedTasks: 20, taskModelRequests: 100, taskProcessCount: 16,
  goalModelRequests: 500, goalTasks: 50,
  taskDiskBytes: 10 * 1024 ** 3, modelRequestMs: 120_000, prepareMs: 600_000,
  stopConfirmMs: 2000, readMs: 15_000, writeAcceptMs: 30_000,
  eventBufferBytes: 1024 ** 2, artifactPageBytes: 256 * 1024,
  pageBytes: 256 * 1024, messagePreviewBytes: 16 * 1024,
  resourceProbeMs: 1000,
  maxMessageBytes: 256 * 1024, maxRequestBytes: 1024 ** 2,
} as const;
export interface Limits { projectWorkers: number; projectModelCalls: number; workerChildren: number; queuedTasks: number; taskModelRequests: number; taskProcessCount: number; taskDiskBytes: number; goalModelRequests: number; goalTasks: number; }
export interface ModelChoice { provider: string; model: string; reasoning?: string; }
export interface Reference { id: Id; sourcePath: string; targetPath: string; readOnly: true; }
export interface ExclusiveResource { id: Id; scope: 'project' | 'device'; }
export type NetworkPolicy = { kind: 'deny' } | { kind: 'domains'; allowedDomains: string[] } | { kind: 'network'; permissionRevision: Revision };
export interface ProjectConfig {
  revision: Revision; defaultMode: Mode; routerModel: ModelChoice; workerModel: ModelChoice;
  workerAssistant?: Id; references: Reference[]; limits: Limits; network: NetworkPolicy;
  executor: 'srt' | 'docker'; executionOs: 'linux' | 'darwin' | 'windows'; imageDigest?: string;
  prepareCommands: string[][]; verifyCommands: string[][]; memoryScopes: string[]; externalToolIds: Id[]; resources: ExclusiveResource[];
}
export interface ProjectIdentity { projectId: Id; ownerDeviceId: Id; canonicalPath: string; repositoryRoot: string; gitCommonDirectory: string; projectRelativePath: string; }
export type Base = { kind: 'commit'; oid: GitOid; ref: string | null } | { kind: 'empty'; oid: null; ref: string };
export interface Eligibility { git: 'ready' | 'empty' | 'missing' | 'unreadable' | 'bare'; executable: boolean; reasons: ErrorCode[]; base?: Base; }
export interface ProjectView { identity: ProjectIdentity; config: ProjectConfig; mainConversationId: Id; routerGeneration: number; state: 'enabled' | 'disabled' | 'recovery' | 'archived'; revision: Revision; eligibility: Eligibility; cursor: string; }
export interface GoalView { goalId: Id; projectId: Id; originMessageId: Id; state: 'active' | 'waiting' | 'completed' | 'cancelled'; modelRequestsUsed: number; modelRequestsLimit: number; tasksCreated: number; tasksLimit: number; revision: Revision; }
export interface AttemptView { attemptId: Id; taskId: Id; generation: number; workerSessionId: Id; state: 'pending' | 'running' | 'ended' | 'interrupted'; endReason?: string; }
export interface TaskView { taskId: Id; projectId: Id; title: string; goalRef: Id; base: Base; targetRef: string | null; state: TaskState; waitReasons: WaitReason[]; revision: Revision; attempt?: AttemptView; latestArtifactId?: Id; configRevision: Revision; createdAt: number; updatedAt: number; }
export interface ArtifactFile { path: string; operation: 'create' | 'modify' | 'delete' | 'rename'; oldPath?: string; before: Digest | null; after: Digest | null; beforeMode: number | null; afterMode: number | null; kind: 'text' | 'binary' | 'symlink' | 'gitlink' | 'lfs'; objectRef?: Id; }
export interface ArtifactView { artifactId: Id; taskId: Id; attemptId: Id; producerSessionId: Id; scope: 'task-output' | 'internal'; version: number; purpose: 'code' | 'report' | 'mixed'; manifestDigest: Digest; base: Base; effectiveBaseTree: GitOid; outputTree: GitOid; patchRef?: Digest; inputs: { artifactId: Id; manifestDigest: Digest }[]; files: ArtifactFile[]; nextFilesCursor?: string; checks: { commandRef: Id; result: 'passed' | 'failed' | 'unavailable'; evidenceRef: Id }[]; createdAt: number; }
export interface ReviewView { reviewId: Id; projectId: Id; taskIds: Id[]; artifactIds: Id[]; dependencies: { artifactId: Id; status: 'included' | 'previously-applied' | 'changed'; applyId?: Id }[]; action: 'apply' | 'apply_commit'; manifestDigest: Digest; expectedHead: GitOid | null; expectedRef: string; expectedIndexDigest: Digest; expectedWorktreeDigest: Digest; commitMessage: string; candidateTree: GitOid; status: 'building' | 'ready' | 'stale' | 'consumed' | 'conflict'; revision: Revision; }
export interface DecisionView { decisionId: Id; kind: 'dependency' | 'question' | 'approval' | 'recovery' | 'budget'; projectId: Id; taskIds: Id[]; scopeDigest: Digest; revision: Revision; payload: Json; state: 'pending' | 'allowed' | 'denied' | 'expired' | 'revoked'; }
export interface ApplyView { applyId: Id; reviewId: Id; phase: ApplyPhase; action: 'apply' | 'apply_commit'; commitOid?: GitOid; nextAction?: 'inspect' | 'continue' | 'restore_files' | 'abort'; revision: Revision; }
export interface Page<T> { items: T[]; nextCursor?: string; }
export interface Write<T> { operationId: Id; expectedRevision: Revision; request: T; }
export type Outcome<T> = { outcome: 'applied'; operationId: Id; replayed: boolean; value: T } | { outcome: 'accepted'; operationId: Id; resultRef: Id } | { outcome: 'unconfirmed'; operationId: Id; resultRef: Id } | { outcome: 'conflict' | 'rejected'; operationId: Id; code: ErrorCode; currentRevision?: Revision };
export interface StreamEvent { id: string; projectId: Id; kind: 'message' | 'goal_changed' | 'task_changed' | 'decision_changed' | 'artifact_created' | 'apply_changed' | 'config_changed' | 'router_changed'; entityId: Id; revision: Revision; data: Json; }
export interface MessageView { messageId: Id; goalId: Id; position: number; role: 'user' | 'assistant'; text: string; textRef: Digest; truncated: boolean; source: { operationId?: Id; sessionId?: Id; eventSeq?: number }; state: 'streaming' | 'final' | 'interrupted'; revision: Revision; createdAt: number; }
export const ERROR_CODES = ['git-required', 'git-unreadable', 'git-bare', 'executor-unavailable', 'isolation-unavailable', 'network-policy-unsupported', 'owner-offline', 'owner-conflict', 'generation-stale', 'revision-conflict', 'operation-conflict', 'request-invalid', 'queue-full', 'budget-exhausted', 'depth-exceeded', 'dependency-unapproved', 'dependency-cycle', 'artifact-stale', 'review-stale', 'permission-denied', 'recovery-required', 'stop-unconfirmed', 'apply-unconfirmed', 'git-conflict', 'hook-failed', 'object-missing', 'resource-busy', 'internal-error'] as const;
export type ErrorCode = typeof ERROR_CODES[number];

// 读写参数中的身份均由接收端认证层提供，业务请求不能指定调用者角色。
export interface HumanApi {
  getProject(projectId: Id): Promise<ProjectView>;
  getEligibility(projectId: Id): Promise<Eligibility>;
  enter(projectId: Id, input: Write<Record<string, never>>): Promise<Outcome<ProjectView>>;
  configure(projectId: Id, input: Write<ProjectConfig>): Promise<Outcome<ProjectView>>;
  send(projectId: Id, input: Write<{ text: string; references: Id[]; goalId?: Id; targetTaskId?: Id }>): Promise<Outcome<{ messageId: Id; goalId: Id }>>;
  listMessages(projectId: Id, cursor?: string): Promise<Page<MessageView>>;
  listGoals(projectId: Id, cursor?: string): Promise<Page<GoalView>>;
  listTasks(projectId: Id, query?: { cursor?: string; state?: TaskState; limit?: number }): Promise<Page<TaskView>>;
  getTask(projectId: Id, taskId: Id): Promise<TaskView>;
  getArtifact(projectId: Id, artifactId: Id): Promise<ArtifactView>;
  artifactPages(projectId: Id, artifactId: Id, query?: { cursor?: string; path?: string }): Promise<Page<ArtifactFile>>;
  listDecisions(projectId: Id, cursor?: string): Promise<Page<DecisionView>>;
  getReview(projectId: Id, reviewId: Id): Promise<ReviewView>;
  reviewPages(projectId: Id, reviewId: Id, query?: { cursor?: string; path?: string; view?: 'project' | 'commit' | 'staged' }): Promise<Page<ArtifactFile>>;
  getApply(projectId: Id, applyId: Id): Promise<ApplyView>;
  acceptArtifact(projectId: Id, input: Write<{ artifactIds: Id[]; scopeDigest: Digest }>): Promise<Outcome<TaskView[]>>;
  decide(projectId: Id, input: Write<{ decisionId: Id; scopeDigest: Digest; choice: 'allow' | 'deny'; answer?: Json }>): Promise<Outcome<DecisionView>>;
  control(projectId: Id, input: Write<{ taskIds: Id[]; goalIds: Id[]; includeRouter: boolean; action: 'pause' | 'stop' | 'resume'; scopeDigest: Digest }>): Promise<Outcome<TaskView[]>>;
  prepareReview(projectId: Id, input: Write<{ artifactIds: Id[]; targetRef: string; commitMessage: string; action: 'apply' | 'apply_commit' }>): Promise<Outcome<ReviewView>>;
  apply(projectId: Id, input: Write<{ reviewId: Id; manifestDigest: Digest; action: 'apply' | 'apply_commit' }>): Promise<Outcome<ApplyView>>;
  recoverApply(projectId: Id, input: Write<{ applyId: Id; action: 'continue' | 'restore_files' | 'abort'; inspectedDigest: Digest }>): Promise<Outcome<ApplyView>>;
  getOperation(projectId: Id, operationId: Id): Promise<Outcome<Json>>;
  getObject(projectId: Id, digest: Digest): Promise<{ mediaType: string; bytes: number; digest: Digest; body: AsyncIterable<Uint8Array> }>;
  enable(projectId: Id, input: Write<{ scopeDigest: Digest }>): Promise<Outcome<ProjectView>>;
  disable(projectId: Id, input: Write<{ scopeDigest: Digest }>): Promise<Outcome<ProjectView>>;
  events(projectId: Id, cursor?: string): AsyncIterable<StreamEvent>;
}
export type AgentCommand =
  | { kind: 'create_task'; originMessageId: Id; title: string; goal: string; dependencies: Id[]; resourceIds: Id[] }
  | { kind: 'deliver'; taskId: Id; inputRef: Id }
  | { kind: 'report'; state: 'progress' | 'waiting' | 'ready' | 'failed'; evidenceRefs: Id[]; files?: string[]; filesManifestPath?: string; reportText?: string }
  | { kind: 'request_dependency'; artifactId: Id; consumerTaskIds: Id[] }
  | { kind: 'request_stop'; originMessageId: Id; taskIds: Id[]; includeRouter: boolean }
  | { kind: 'ask'; question: Json }
  | { kind: 'spawn_child'; goal: string; inputRefs: Id[] }
  | { kind: 'read'; resource: Id; cursor?: string };
export interface AgentActor { projectId: Id; taskId?: Id; attemptId?: Id; sessionId: Id; role: Role; generation: number; policyRevision: Revision; }
export interface AgentApi { execute(actor: AgentActor, operationId: Id, command: AgentCommand): Promise<Outcome<Json>>; }
export interface ExecutionPolicy { projectId: Id; taskId: Id; sessionId: Id; workspace: string; scratch: string; baselineObjectDirectory?: string; inputObjectDirectories: string[]; references: Reference[]; network: NetworkPolicy; generation: number; policyRevision: Revision; }
export interface ExecutionPort {
  probe(policy: ExecutionPolicy): Promise<{ usable: boolean; code?: ErrorCode; evidenceRef: Id }>;
  prepare(policy: ExecutionPolicy, base: Base, inputs: ArtifactView[], seed?: ArtifactView): Promise<{ workspaceId: Id }>;
  run(policy: ExecutionPolicy, argv: string[], signal: AbortSignal): Promise<{ processId: Id }>;
  inspect(processId: Id): Promise<{ state: 'running' | 'exited' | 'unknown'; exitCode?: number }>;
  stop(processId: Id, signal: AbortSignal): Promise<{ stopped: boolean }>;
  seal(policy: ExecutionPolicy): Promise<ArtifactView>;
}
