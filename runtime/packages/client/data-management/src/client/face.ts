/**
 * 数据管理界面的数据入口。
 *
 * 界面按同源相对路径访问控制平面的数据管理接口：用量读数、保留策略、清理预估与执行、只读
 * 副本、血缘、导入与分叉、删除收件箱、恢复与永久删除。应答在这里逐项交给 schema 解析，形状
 * 不符、缺少接口与网络不可达分别给出稳定错误码，界面据此显示具体失败。
 *
 * 写操作带同源标识请求头；跨站表单无法携带这个请求头。接口由控制平面入口接入，本包只声明
 * 路径与方法。
 * @module @chatdsh/client-data-management/face
 */

import { CSRF_HEADER, browserTelemetry, type DataManagementTelemetry } from './telemetry.ts';
import { DataCallError, LOCAL_ERROR_CODES } from './errors.ts';

/** 数据管理接口的挂载前缀。 */
export const DATA_PREFIX = '/chatdsh/client/data';

/** 用量读数。 */
export const USAGE_PATH = `${DATA_PREFIX}/usage`;

/** 保留策略的读取与写入。 */
export const RETENTION_PATH = `${DATA_PREFIX}/retention`;

/** 清理预估。 */
export const CLEANUP_ESTIMATE_PATH = `${DATA_PREFIX}/cleanup/estimate`;

/** 清理执行。 */
export const CLEANUP_EXECUTE_PATH = `${DATA_PREFIX}/cleanup/execute`;

/** 分叉预估。 */
export const FORK_ESTIMATE_PATH = `${DATA_PREFIX}/fork/estimate`;

/** 分叉建立。 */
export const FORK_PATH = `${DATA_PREFIX}/fork`;

/** 删除收件箱。 */
export const INBOX_PATH = `${DATA_PREFIX}/deletion/inbox`;

/** 恢复会话。 */
export const RESTORE_PATH = `${DATA_PREFIX}/deletion/restore`;

/** 永久删除。 */
export const PERMANENT_DELETE_PATH = `${DATA_PREFIX}/deletion/permanent`;

/**
 * 一条会话的血缘链路径。
 * @param sessionId - 会话标识。
 * @returns 请求路径。
 */
export function lineagePath(sessionId: string): string {
  return `${DATA_PREFIX}/lineage/${encodeURIComponent(sessionId)}`;
}

/**
 * 一条会话的只读副本路径。
 * @param sessionId - 会话标识。
 * @returns 请求路径。
 */
export function replicaPath(sessionId: string): string {
  return `${DATA_PREFIX}/replica/${encodeURIComponent(sessionId)}`;
}

/**
 * 一条会话的永久删除范围路径。
 * @param sessionId - 会话标识。
 * @returns 请求路径。
 */
export function permanentScopePath(sessionId: string): string {
  return `${DATA_PREFIX}/deletion/scope/${encodeURIComponent(sessionId)}`;
}

/** 清理预估的筛选条件。 */
export interface CleanupEstimateQuery {
  /** 覆盖保留周期；缺省取已保存的策略。 */
  readonly retentionDays?: number;
  /** 只预估该设备的副本。 */
  readonly deviceId?: string;
  /** 只预估该工作区的副本。 */
  readonly workspaceId?: string;
}

/** 清理执行的输入。 */
export interface CleanupExecuteInput {
  /** 预估标识。 */
  readonly estimateId: string;
  /** 依赖影响已经逐项确认。 */
  readonly confirmDependencies: boolean;
}

/** 导入与分叉的请求。 */
export interface ForkRequest {
  /** 源会话标识。 */
  readonly sourceSessionId: string;
  /** 源会话所在设备。 */
  readonly sourceDeviceId: string;
  /** 目标设备。 */
  readonly targetDeviceId: string;
  /** 目标工作目录的绝对路径。 */
  readonly targetCwd: string;
  /** 复制的历史范围结束回合，含该回合。 */
  readonly turnTo: number;
  /** 复制方式。 */
  readonly importMode: 'full-prefix' | 'compressed';
}

/** 恢复的请求。 */
export interface RestoreRequestInput {
  /** 会话标识。 */
  readonly sessionId: string;
  /** 操作标识。 */
  readonly operationId: string;
  /** 请求摘要。 */
  readonly requestDigest: string;
}

/** 永久删除的输入。 */
export interface PermanentDeleteInput {
  /** 会话标识。 */
  readonly sessionId: string;
  /** 已经过两级确认。 */
  readonly confirm: true;
  /** 依赖影响已经逐项确认。 */
  readonly confirmDependencies: boolean;
}

/**
 * 浏览器侧可用的数据管理服务面。
 *
 * 方法缺省表示控制平面没有接入对应接口，界面在调用处显示「没有提供这个接口」。
 */
export interface DataManagementFace {
  usage?: () => Promise<unknown>;
  retention?: () => Promise<unknown>;
  saveRetention?: (days: number) => Promise<unknown>;
  cleanupEstimate?: (query: CleanupEstimateQuery) => Promise<unknown>;
  cleanupExecute?: (input: CleanupExecuteInput) => Promise<unknown>;
  lineage?: (sessionId: string) => Promise<unknown>;
  replica?: (sessionId: string) => Promise<unknown>;
  forkEstimate?: (input: ForkRequest) => Promise<unknown>;
  fork?: (input: ForkRequest) => Promise<unknown>;
  inbox?: () => Promise<unknown>;
  restore?: (input: RestoreRequestInput) => Promise<unknown>;
  permanentScope?: (sessionId: string) => Promise<unknown>;
  permanentDelete?: (input: PermanentDeleteInput) => Promise<unknown>;
}

/**
 * 调用服务面里的一个方法并解析应答。
 * @param label - 操作名，写进缺少接口时的说明。
 * @param invoke - 实际调用；缺省表示控制平面没有接入该接口。
 * @param parse - 应答解析。
 * @returns 解析后的视图。
 * @throws DataCallError - 接口缺失、调用失败或应答形状不符。
 */
export async function callFace<T>(
  label: string,
  invoke: (() => Promise<unknown>) | undefined,
  parse: (value: unknown) => T,
): Promise<T> {
  if (invoke === undefined) {
    throw new DataCallError(LOCAL_ERROR_CODES.unavailable, `控制平面没有提供${label}接口`);
  }
  return parse(await invoke());
}

/** 从失败应答里取错误码。 */
async function rejected(response: Response): Promise<DataCallError> {
  const text = await response.text();
  let body: unknown;
  try {
    body = text === '' ? undefined : (JSON.parse(text) as unknown);
  } catch {
    throw new DataCallError(LOCAL_ERROR_CODES.invalidResponse, `控制平面拒绝了这次调用（HTTP ${String(response.status)}）`, response.status);
  }
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const code = typeof record['error'] === 'string' && record['error'] !== '' ? record['error'] : 'request-failed';
  const detail = typeof record['message'] === 'string' && record['message'] !== '' ? record['message'] : '控制平面拒绝了这次调用';
  return new DataCallError(code, detail, response.status);
}

/** 数据入口的构造依赖。 */
export interface HttpFaceOptions {
  /** 发请求的实现；浏览器里是全局 `fetch`。 */
  readonly fetchImpl?: typeof fetch;
  /** 遥测面。 */
  readonly telemetry?: DataManagementTelemetry;
}

/** 一次请求的参数。 */
interface FaceRequest {
  readonly method?: 'GET' | 'POST';
  readonly body?: unknown;
}

/**
 * 建立基于同源 HTTP 的数据入口。
 * @param options - 依赖覆盖。
 * @returns 数据入口。
 */
export function createHttpDataManagementFace(options: HttpFaceOptions = {}): DataManagementFace {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const telemetry = options.telemetry ?? browserTelemetry;

  /**
   * 发起一次数据管理请求。
   * @param method - 遥测调用名。
   * @param path - 请求路径。
   * @param request - 请求方法、请求体与是否写操作。
   * @returns 应答体。
   */
  const send = async (method: string, path: string, request: FaceRequest = {}): Promise<unknown> =>
    await telemetry.run(method, async () => {
      const headers: Record<string, string> = { accept: 'application/json' };
      const init: RequestInit = { headers, credentials: 'same-origin' };
      if (request.method === 'POST') {
        init.method = 'POST';
        headers['content-type'] = 'application/json';
        headers[CSRF_HEADER] = '1';
        init.body = JSON.stringify(request.body ?? {});
      }
      const traceparent = telemetry.traceparent();
      if (traceparent !== undefined) headers.traceparent = traceparent;
      const response = await fetchImpl(path, init).catch(() => {
        throw new DataCallError(LOCAL_ERROR_CODES.offline, '控制平面当前不可达');
      });
      if (response.status === 404) {
        throw new DataCallError(LOCAL_ERROR_CODES.unavailable, '控制平面没有提供这个接口', response.status);
      }
      if (!response.ok) throw await rejected(response);
      const text = await response.text();
      if (text === '') return undefined;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new DataCallError(LOCAL_ERROR_CODES.invalidResponse, '控制平面的应答不是合法 JSON', response.status);
      }
    });

  return {
    async usage(): Promise<unknown> {
      return await send('data/usage', USAGE_PATH);
    },

    async retention(): Promise<unknown> {
      return await send('data/retention', RETENTION_PATH);
    },

    async saveRetention(days: number): Promise<unknown> {
      return await send('data/retention-save', RETENTION_PATH, { method: 'POST', body: { days } });
    },

    async cleanupEstimate(query: CleanupEstimateQuery): Promise<unknown> {
      return await send('data/cleanup-estimate', CLEANUP_ESTIMATE_PATH, { method: 'POST', body: query });
    },

    async cleanupExecute(input: CleanupExecuteInput): Promise<unknown> {
      return await send('data/cleanup-execute', CLEANUP_EXECUTE_PATH, { method: 'POST', body: input });
    },

    async lineage(sessionId: string): Promise<unknown> {
      return await send('data/lineage', lineagePath(sessionId));
    },

    async replica(sessionId: string): Promise<unknown> {
      return await send('data/replica', replicaPath(sessionId));
    },

    async forkEstimate(input: ForkRequest): Promise<unknown> {
      return await send('data/fork-estimate', FORK_ESTIMATE_PATH, { method: 'POST', body: input });
    },

    async fork(input: ForkRequest): Promise<unknown> {
      return await send('data/fork', FORK_PATH, { method: 'POST', body: input });
    },

    async inbox(): Promise<unknown> {
      return await send('data/inbox', INBOX_PATH);
    },

    async restore(input: RestoreRequestInput): Promise<unknown> {
      return await send('data/restore', RESTORE_PATH, { method: 'POST', body: input });
    },

    async permanentScope(sessionId: string): Promise<unknown> {
      return await send('data/permanent-scope', permanentScopePath(sessionId));
    },

    async permanentDelete(input: PermanentDeleteInput): Promise<unknown> {
      return await send('data/permanent-delete', PERMANENT_DELETE_PATH, { method: 'POST', body: input });
    },
  };
}

/** 浏览器侧默认的数据入口。 */
export const browserFace: DataManagementFace = createHttpDataManagementFace();
