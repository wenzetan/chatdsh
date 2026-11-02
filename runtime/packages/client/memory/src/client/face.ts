import { unwrapRemoteResult } from '@chatdsh/core-remote-client';
/**
 * 记忆面板的数据形状与 Remote 调用封装。
 *
 * 形状与宿主侧的记忆视图一一对应：状态视图、检索结果、记忆组与未确认写入计数。请求失败
 * 统一转成带错误码的 `MemoryFailure`，界面据此显示明确失败，不伪报成功。
 * @module @chatdsh/client-memory/face
 */

/** 工作区关联：设备标识与绝对路径。 */
export interface MemoryWorkspaceRef {
  readonly deviceId: string;
  readonly path: string;
}

/** 记忆后端状态。 */
export type MemoryState = 'enabled-available' | 'enabled-unreachable' | 'disabled' | 'read-failed';

/** 记忆配置视图。地址与凭据值不进入视图。 */
export interface MemorySettingsView {
  readonly enabled: boolean;
  readonly state: MemoryState;
  readonly maxTokens: number;
  readonly extraBanks: readonly string[];
  readonly configSource: string;
  readonly endpointConfigured: boolean;
  readonly credentialEnvConfigured: boolean;
  readonly lastSuccessAt?: number;
  readonly lastFailureAt?: number;
  readonly lastErrorCode?: string;
  readonly revision: number;
}

/** 一条检索命中。 */
export interface MemoryRecallHit {
  readonly bank: string;
  readonly text: string;
  readonly source?: string;
  readonly score?: number;
  readonly at?: number;
}

/** 检索结果；后端不可达时 `degraded` 为真并带错误码。 */
export interface MemoryRecallResult {
  readonly hits: readonly MemoryRecallHit[];
  readonly readAt: number;
  readonly degraded: boolean;
  readonly code?: string;
}

/** 记忆组视图；条目数缺省表示统计接口未读取到。 */
export interface MemoryGroupView {
  readonly memoryGroupId: string;
  readonly displayName: string;
  readonly workspaces: readonly MemoryWorkspaceRef[];
  readonly entryCount?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revision: number;
}

/** 记忆组保存请求。 */
export interface MemoryGroupSaveInput {
  readonly memoryGroupId?: string;
  readonly displayName: string;
  readonly workspaces: readonly MemoryWorkspaceRef[];
  readonly revision?: number;
}

/** 未确认写入的计数视图：只有数量、时间与错误码。 */
export interface MemoryWriteQueueView {
  readonly pendingCount: number;
  readonly oldestPendingAt?: number;
  readonly discardedCount: number;
  readonly lastErrorCode?: string;
}

/** 一条待修改的记忆条目。 */
export interface MemoryEntryRef {
  readonly bank: string;
  readonly source: string;
}

/** 检索请求。 */
export interface MemorySearchRequest {
  readonly banks: readonly string[];
  readonly text: string;
  readonly limit: number;
  readonly maxTokens?: number;
}

/**
 * 浏览器侧可用的记忆服务面。
 *
 * 方法缺省表示宿主没有注册对应接口；界面在调用处明确失败。
 */
export interface MemoryRemoteFace {
  settings?: () => Promise<unknown>;
  search?: (request: MemorySearchRequest) => Promise<unknown>;
  listGroups?: () => Promise<unknown>;
  saveGroup?: (input: MemoryGroupSaveInput) => Promise<unknown>;
  detachWorkspace?: (memoryGroupId: string, workspace: MemoryWorkspaceRef, revision: number) => Promise<unknown>;
  removeGroup?: (memoryGroupId: string, revision: number) => Promise<unknown>;
  writeQueue?: () => Promise<unknown>;
  discardWrite?: (id: string) => Promise<unknown>;
  updateEntry?: (bank: string, source: string, text: string) => Promise<unknown>;
  deleteEntry?: (bank: string, source: string) => Promise<unknown>;
  deleteEntries?: (targets: readonly MemoryEntryRef[]) => Promise<unknown>;
}

/** 加载状态：加载中、宿主未注册、失败与就绪。 */
export type Loadable<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'failed'; readonly failure: MemoryFailure }
  | { readonly status: 'ready'; readonly value: T };

/** 个人 bank 名。 */
export const ACCOUNT_BANK = 'acct';

/** 记忆组 bank 的前缀。 */
export const GROUP_BANK_PREFIX = 'ws:';

/** 召回令牌的产品范围。 */
export const MEMORY_TOKEN_RANGE = { min: 100, max: 16000 } as const;

/** 每次检索可选的条数。 */
export const PAGE_SIZES = [5, 10, 20] as const;

/** 单次检索的服务端条数上限。 */
export const SEARCH_LIMIT_MAX = 50;

/** 一次 Remote 调用的失败。 */
export class MemoryFailure extends Error {
  /** 宿主返回的错误码；本地校验失败时缺省。 */
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'MemoryFailure';
    this.code = code;
  }
}

/**
 * 取异常里的错误码。
 * @param error - 抛出的异常。
 * @returns 错误码；没有错误码时为 `undefined`。
 */
function codeOf(error: unknown): string | undefined {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === 'string' && code !== '') return code;
  }
  const message = error instanceof Error ? error.message : '';
  const matched = /Remote 调用失败：(\S+)/.exec(message);
  return matched?.[1];
}

/**
 * 把任意异常转成 `MemoryFailure`。
 * @param error - 抛出的异常。
 * @returns 带错误码的失败。
 */
export function failureOf(error: unknown): MemoryFailure {
  if (error instanceof MemoryFailure) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new MemoryFailure(message, codeOf(error));
}

/**
 * 失败的可读文字：说明后附错误码。
 * @param failure - 失败。
 * @returns 供界面显示的完整句子。
 */
export function failureText(failure: MemoryFailure): string {
  return failure.code === undefined ? failure.message : `${failure.message}（错误码 ${failure.code}）`;
}

/** 成功信封里取错误码，失败信封里取不到。 */
function envelopeErrorCode(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== 'object' || !('ok' in raw)) return undefined;
  if ((raw as { readonly ok?: unknown }).ok !== false) return undefined;
  const error = (raw as { readonly error?: { readonly code?: unknown } }).error;
  return typeof error?.code === 'string' ? error.code : undefined;
}

/**
 * 调用一个 Remote 方法并解包结果。
 *
 * 方法缺省、调用抛出与失败信封三种情况都按明确失败处理，调用方保留用户输入。
 * @param label - 操作名，用于本地缺省方法的说明。
 * @param invoke - 实际调用；缺省表示宿主没有注册该接口。
 * @returns 解包后的结果。
 */
export async function callRemote<T>(label: string, invoke: (() => Promise<unknown>) | undefined): Promise<T> {
  if (invoke === undefined) throw new MemoryFailure(`记忆服务没有提供${label}接口`);
  let raw: unknown;
  try {
    raw = await invoke();
  } catch (error) {
    throw failureOf(error);
  }
  try {
    return unwrapRemoteResult<T>(raw);
  } catch (error) {
    const code = envelopeErrorCode(raw) ?? codeOf(error);
    throw new MemoryFailure(`记忆服务拒绝了${label}调用`, code);
  }
}

/**
 * 判断失败是否表示宿主没有注册记忆服务。
 *
 * 网关在服务缺失时返回 `gateway/service-unavailable`，端点未注册时返回
 * `gateway/definition-unavailable`；两种情况都按「未启用」呈现。
 * @param failure - Remote 调用的失败。
 * @returns 服务缺失时为 true。
 */
export function isServiceMissing(failure: MemoryFailure): boolean {
  return failure.code === 'gateway/service-unavailable' || failure.code === 'gateway/definition-unavailable';
}

/**
 * 把毫秒时间戳格式化成 `YYYY-MM-DD HH:mm:ss`。
 * @param millis - 毫秒时间戳。
 * @returns 本地时间文本。
 */
export function formatTimestamp(millis: number): string {
  const date = new Date(millis);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 把相关性得分格式化成百分比。
 * @param score - 0 到 1 的得分。
 * @returns 百分比文本；缺省时为「未提供」。
 */
export function formatScore(score: number | undefined): string {
  return score === undefined ? '未提供' : `${Math.round(score * 100).toString()}%`;
}

/**
 * 一条命中的稳定键：bank 与来源标识；没有来源时用位置区分。
 * @param hit - 命中的记忆条目。
 * @param index - 在结果里的位置。
 * @returns 页面内存里使用的键。
 */
export function hitKey(hit: MemoryRecallHit, index: number): string {
  return `${hit.bank}\u0000${hit.source ?? `#${String(index)}`}`;
}

/**
 * 记忆组的检索 bank。
 * @param memoryGroupId - 记忆组标识。
 * @returns `ws:<memoryGroupId>`。
 */
export function groupBank(memoryGroupId: string): string {
  return `${GROUP_BANK_PREFIX}${memoryGroupId}`;
}

