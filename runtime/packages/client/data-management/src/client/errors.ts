/**
 * 数据管理界面的失败形状。
 *
 * 每一次读取与写入失败都带稳定错误码：控制平面拒绝时取响应体的 `error`，本地校验失败时用
 * 本文件登记的分类码，网络不可达时用 `gateway/offline`。界面按错误码给出具体原因，读不到
 * 的读数不做零值渲染。
 * @module @chatdsh/client-data-management/errors
 */

/** 本端登记的分类错误码。 */
export const LOCAL_ERROR_CODES = {
  /** 控制平面没有提供这个接口。 */
  unavailable: 'gateway/unavailable',
  /** 网络不可达。 */
  offline: 'gateway/offline',
  /** 应答形状不符合约定。 */
  invalidResponse: 'gateway/invalid-response',
  /** 应答里出现内部游标字段。 */
  internalCursor: 'dto/internal-cursor',
} as const;

/** 一次数据管理调用失败。 */
export class DataCallError extends Error {
  /** 稳定错误码。 */
  readonly code: string;
  /** HTTP 状态码；没有拿到应答时为 0。 */
  readonly status: number;

  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = 'DataCallError';
    this.code = code;
    this.status = status;
  }
}

/** 读取状态：加载中、宿主未提供接口、失败与就绪。 */
export type Loadable<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'failed'; readonly failure: DataCallError }
  | { readonly status: 'ready'; readonly value: T };

/**
 * 把任意异常转成带错误码的失败。
 * @param error - 抛出的异常。
 * @returns 带错误码的失败。
 */
export function failureOf(error: unknown): DataCallError {
  if (error instanceof DataCallError) return error;
  if (typeof error === 'object' && error !== null) {
    const record = error as { readonly name?: unknown; readonly message?: unknown; readonly code?: unknown };
    const code = typeof record.code === 'string' && record.code !== '' ? record.code : LOCAL_ERROR_CODES.invalidResponse;
    const message = typeof record.message === 'string' && record.message !== '' ? record.message : '数据管理调用失败';
    return new DataCallError(code, message);
  }
  return new DataCallError(LOCAL_ERROR_CODES.invalidResponse, String(error));
}

/**
 * 失败的可读文字：说明后附错误码。
 * @param failure - 失败。
 * @returns 供界面显示的完整句子。
 */
export function failureText(failure: DataCallError): string {
  return `${failure.message}（错误码 ${failure.code}）`;
}

/** 错误码对应的界面说明。 */
const CODE_REASONS: Readonly<Record<string, string>> = {
  'auth-required': '需要先登录访问会话。',
  'access-session-revoked': '访问会话已经失效，请重新登录。',
  'origin-rejected': '请求来源不被控制平面接受。',
  'csrf-rejected': '写操作缺少同源标识，请刷新页面后重试。',
  'permission-denied': '当前客户端没有这台设备的权限。',
  'request-invalid': '提交的参数不合法。',
  'session-not-found': '这台会话在控制平面没有记录。',
  'object-not-found': '清理预估或对象已经不存在，请重新计算。',
  'object-in-use': '范围内还有依赖，需要逐项确认影响。',
  'replica-unavailable': '控制平面没有这段会话的副本。',
  'restore-expired': '保留期已过，这个条目不能再恢复。',
  'already-handled': '这个条目已经处理过，列表已经刷新。',
  'replica-retention-invalid': '保留期必须是 1 到 3650 之间的整数天。',
  'internal-error': '控制平面处理失败。',
  'gateway/offline': '控制平面当前不可达。',
  'gateway/unavailable': '控制平面没有提供这个接口。',
  'gateway/invalid-response': '控制平面的应答形状不符合约定。',
  'dto/internal-cursor': '应答里出现内部游标字段，界面拒绝渲染。',
};

/**
 * 取错误码对应的说明。
 * @param code - 错误码。
 * @returns 界面说明；没有登记时给通用说明。
 */
export function reasonOf(code: string): string {
  return CODE_REASONS[code] ?? '控制平面返回了未登记的错误码。';
}
