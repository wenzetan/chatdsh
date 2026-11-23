/**
 * 客户端插件在浏览器侧的类型面：宿主服务、Remote 调用与界面快照。
 * @module @chatdsh/client-remote/types
 */

import type { OverviewDevice, OverviewSession, ReplicaItem } from './model.ts';
import type { RelayStatus } from './state.ts';

/** 分叉输入的副本记录。 */
export interface ForkRecordInput {
  readonly seq: number;
  readonly kind: string;
  readonly time: number;
  readonly payload?: unknown;
}

/** 宿主导入服务的分叉输入。 */
export interface ForkInput {
  readonly sessionId: string;
  readonly cwd: string;
  readonly records: readonly ForkRecordInput[];
  readonly sourceSessionId: string;
  readonly sourceDeviceId: string;
  readonly turnTo: number;
  readonly importMode: 'full-prefix' | 'compressed';
  readonly availableAttachmentIds: readonly string[];
  readonly scheduledTasks: number;
}

/** 分叉内容范围。 */
export interface ForkContentScope {
  readonly turnFrom: number;
  readonly turnTo: number;
  readonly eventCount: number;
  readonly charCount: number;
  readonly compressed: boolean;
  readonly attachmentsComplete: boolean;
}

/** 分叉预估。 */
export interface ForkEstimate {
  readonly importMode: 'full-prefix' | 'compressed';
  readonly scope: ForkContentScope;
  readonly eventCount: number;
  readonly charCount: number;
  readonly missingAttachmentIds: readonly string[];
  readonly compressionLoss: boolean;
}

/** 分叉的校验记录。 */
export interface ForkReplayRecord {
  readonly toolCalls: number;
  readonly scheduledTasks: number;
  readonly retainedScheduledTasks: number;
  readonly unresolvedToolCalls: number;
  readonly droppedToolCalls: number;
  readonly droppedToolResults: number;
}

/** 分叉结果。 */
export interface ForkOutcome {
  readonly sessionId: string;
  readonly cwd: string;
  readonly parentSession: string;
  readonly createdAt: number;
  readonly estimate: ForkEstimate;
  readonly replay: ForkReplayRecord;
}

/** Remote 调用的结果信封。 */
export interface RemoteResult<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: { readonly code?: string };
}

/** 宿主导入服务的客户端命名空间。 */
export interface ImportNamespace {
  fork(input: ForkInput): Promise<RemoteResult<ForkOutcome>>;
}

/** 客户端 Remote 服务的最小面。 */
export interface RemoteClient {
  readonly $host: { readonly home: string | undefined };
  $mount(contribution: unknown): Promise<() => Promise<void>>;
  readonly chatdshImport?: ImportNamespace;
}

/** 浏览器侧插件上下文的最小面。 */
export interface ClientContext {
  readonly slots: ChatdshRemoteSlotsService;
  readonly locale: ChatdshRemoteLocale;
  readonly layout: ChatdshRemoteLayout;
  readonly remote: RemoteClient;
  effect(execute: () => unknown, label?: string): unknown;
}

/** 设置区段的遥测状态。 */
export interface TelemetrySettingState {
  readonly enabled: boolean;
  readonly reason?: string;
}

/** 设置区段的数据。 */
export interface RemoteSettingsSnapshot {
  readonly controlUrl: string;
  readonly identity: string | null;
  readonly identityError: string | null;
  readonly telemetry: TelemetrySettingState | null;
  readonly telemetryError: string | null;
  readonly loading: boolean;
}

/** 配对结果。 */
export type PairingOutcome =
  | { readonly deviceId: string; readonly token: string }
  | { readonly error: string };

/** 界面动作的结果提示。 */
export interface Notice {
  readonly kind: 'ok' | 'error';
  readonly code: string;
  readonly detail?: string;
}

/** 当前打开的只读副本。 */
export interface ReplicaSelection {
  readonly session: OverviewSession;
  readonly deviceOnline: boolean;
  readonly items: readonly ReplicaItem[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly forking: boolean;
  readonly fork: ForkOutcome | null;
  readonly forkError: string | null;
  readonly turnTo: number;
  readonly canFork: boolean;
}

/** 界面一次渲染读取的完整快照。 */
export interface RemoteSnapshot {
  readonly relay: RelayStatus;
  readonly devices: readonly OverviewDevice[];
  readonly sessions: readonly OverviewSession[];
  readonly loadingOverview: boolean;
  readonly overviewError: string | null;
  readonly replica: ReplicaSelection | null;
  readonly settings: RemoteSettingsSnapshot;
  readonly pairing: PairingOutcome | null;
  readonly notice: Notice | null;
}
