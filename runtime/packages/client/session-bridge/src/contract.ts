/**
 * 设备内导航桥的消息契约。
 *
 * 宿主与内容席位通过 `postMessage` 交换五类消息。宿主先用 `source` 声明内容席位要服务的
 * 设备与状态，内容端就绪后回 `ready`；之后宿主用 `navigate` 请求打开指定会话，内容端按
 * 真实打开结果回 `selected` 或 `rejected`。
 *
 * 字段形状与[导航契约](../../core/contracts/src/navigation.ts)一致：宿主发往内容端的消息用
 * `action` 判别，内容端回给宿主的消息用 `outcome` 判别，协议版本固定为 1，原因码取自
 * `CHATDSH_ERROR_CODES` 已登记的取值。每条消息逐字段校验，未知版本与缺少字段都被明确拒绝。
 * @module @chatdsh/client-session-bridge/contract
 */

import { z } from 'zod';

/** 导航桥的协议版本。与导航契约的 `NAVIGATION_MESSAGE_VERSION` 相同。 */
export const NAVIGATION_VERSION = 1;

/** 一次导航回执的等待时限，单位毫秒。与导航契约的 `NAVIGATION_TIMEOUT_MS` 相同。 */
export const DEFAULT_NAVIGATION_TIMEOUT_MS = 5000;

/** 一次导航的尝试次数缺省值，含首次尝试。 */
export const DEFAULT_NAVIGATION_ATTEMPTS = 2;

/** 一次导航的尝试次数上限。超时重试有限次，等待不会无限延长。 */
export const MAX_NAVIGATION_ATTEMPTS = 4;

/** 内容席位的数据状态。越靠后越严格。 */
export const CONTENT_STATES = ['writable', 'readonly', 'offline'] as const;

/** 内容席位的数据状态。 */
export type ContentState = (typeof CONTENT_STATES)[number];

/** 内容席位声明的能力。 */
export const BRIDGE_CAPABILITIES = [
  'open-session',
  'report-selection',
  'readonly-mode',
  'offline-mode',
] as const;

/** 内容席位声明的能力。 */
export type BridgeCapability = (typeof BRIDGE_CAPABILITIES)[number];

/** 导航失败的原因码。全部取自 `CHATDSH_ERROR_CODES` 已登记的取值。 */
export const NAVIGATION_REJECTION_CODES = [
  'origin-rejected',
  'message-source-mismatch',
  'message-schema-invalid',
  'navigation-not-ready',
  'navigation-rejected',
  'navigation-timeout',
  'device-mismatch',
  'session-not-found',
  'device-offline',
] as const;

/** 导航失败的原因码。 */
export type NavigationRejectionCode = (typeof NAVIGATION_REJECTION_CODES)[number];

/** 导航失败的分类。写入遥测的 `error.type`。 */
export type NavigationErrorType =
  | 'unsupported-version'
  | 'schema-invalid'
  | 'origin-mismatch'
  | 'source-mismatch'
  | 'not-ready'
  | 'device-mismatch'
  | 'session-mismatch'
  | 'device-offline'
  | 'open-failed'
  | 'timeout'
  | 'superseded'
  | 'cancelled';

/** 一次被拒绝的消息或请求。 */
export interface NavigationRejection {
  /** 原因码，回给对端或写进界面。 */
  readonly code: NavigationRejectionCode;
  /** 分类，写进遥测的 `error.type`。 */
  readonly type: NavigationErrorType;
  /** 具体字段或窗口的说明，用于诊断，不含会话内容。 */
  readonly detail: string;
}

/** 宿主发往内容端的席位声明。 */
export interface SourceDeclaration {
  readonly action: 'source';
  readonly version: number;
  /** 声明标识；内容端在就绪上报里原样带回，用于区分本次声明与更早的自主上报。 */
  readonly requestId?: string;
  /** 内容席位要服务的设备。 */
  readonly deviceId: string;
  /** 宿主认定的设备状态，内容端取它与自身状态中较严格的一项。 */
  readonly state: ContentState;
  /** 宿主允许使用的能力。 */
  readonly capabilities: readonly BridgeCapability[];
  /** 声明时已经选中的会话；缺省表示没有选中。 */
  readonly sessionId?: string;
}

/** 内容端回给宿主的就绪上报。 */
export interface ReadyReport {
  readonly outcome: 'ready';
  readonly version: number;
  /** 对应的声明标识；自主上报时缺省。 */
  readonly requestId?: string;
  /** 内容端实际所属设备。 */
  readonly deviceId: string;
  /** 生效的数据状态。 */
  readonly state: ContentState;
  /** 内容端实际提供的能力。 */
  readonly capabilities: readonly BridgeCapability[];
  /** 就绪时已经选中的会话；缺省表示没有选中。 */
  readonly sessionId?: string;
}

/** 宿主发往内容端的会话导航请求。 */
export interface NavigateRequest {
  readonly action: 'navigate';
  readonly version: number;
  /** 请求标识，回执必须带回同一个标识。 */
  readonly requestId: string;
  /** 目标设备。 */
  readonly deviceId: string;
  /** 目标会话。 */
  readonly sessionId: string;
}

/** 内容端确认选中后的回执。 */
export interface SelectedReport {
  readonly outcome: 'selected';
  readonly version: number;
  readonly requestId: string;
  /** 内容端所属设备。 */
  readonly deviceId: string;
  /** 实际选中的会话，必须与请求一致。 */
  readonly sessionId: string;
  /** 会话标题，供宿主更新界面。 */
  readonly title?: string;
}

/** 内容端拒绝导航后的回执。 */
export interface RejectedReport {
  readonly outcome: 'rejected';
  readonly version: number;
  readonly requestId: string;
  readonly code: NavigationRejectionCode;
}

/** 宿主发往内容端的消息。 */
export type HostToContentMessage = SourceDeclaration | NavigateRequest;

/** 内容端回给宿主的消息。 */
export type ContentToHostMessage = ReadyReport | SelectedReport | RejectedReport;

/** 导航桥的全部消息。 */
export type BridgeMessage = HostToContentMessage | ContentToHostMessage;

/** 解析结果。 */
export type BridgeParseResult =
  | { readonly ok: true; readonly message: BridgeMessage }
  | { readonly ok: false; readonly rejection: NavigationRejection };

const identifierSchema = z.string().min(1).max(200);
const versionSchema = z.literal(NAVIGATION_VERSION);
const stateSchema = z.enum(CONTENT_STATES);
const capabilitySchema = z.enum(BRIDGE_CAPABILITIES);
const capabilityListSchema = z.array(capabilitySchema).max(BRIDGE_CAPABILITIES.length);
const rejectionCodeSchema = z.enum(NAVIGATION_REJECTION_CODES);

const sourceSchema = z.object({
  action: z.literal('source'),
  version: versionSchema,
  requestId: identifierSchema.optional(),
  deviceId: identifierSchema,
  state: stateSchema,
  capabilities: capabilityListSchema,
  sessionId: identifierSchema.optional(),
});

const navigateSchema = z.object({
  action: z.literal('navigate'),
  version: versionSchema,
  requestId: identifierSchema,
  deviceId: identifierSchema,
  sessionId: identifierSchema,
});

const readySchema = z.object({
  outcome: z.literal('ready'),
  version: versionSchema,
  requestId: identifierSchema.optional(),
  deviceId: identifierSchema,
  state: stateSchema,
  capabilities: capabilityListSchema,
  sessionId: identifierSchema.optional(),
});

const selectedSchema = z.object({
  outcome: z.literal('selected'),
  version: versionSchema,
  requestId: identifierSchema,
  deviceId: identifierSchema,
  sessionId: identifierSchema,
  title: z.string().min(1).max(300).optional(),
});

const rejectedSchema = z.object({
  outcome: z.literal('rejected'),
  version: versionSchema,
  requestId: identifierSchema,
  code: rejectionCodeSchema,
});

/** 判据：非空对象，且不是数组。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 校验消息里的协议版本。
 * @param record - 待校验的消息。
 * @returns 拒绝结果；版本合法时为空。
 */
function checkVersion(record: Record<string, unknown>): NavigationRejection | undefined {
  const version = record['version'];
  if (typeof version !== 'number') {
    return { code: 'message-schema-invalid', type: 'schema-invalid', detail: 'version 缺失或不是数字' };
  }
  if (version !== NAVIGATION_VERSION) {
    return {
      code: 'message-schema-invalid',
      type: 'unsupported-version',
      detail: `不支持的协议版本 ${version}，当前版本 ${NAVIGATION_VERSION}`,
    };
  }
  return undefined;
}

/**
 * 把 zod 的校验失败转成拒绝结果。
 * @param error - zod 的错误。
 * @returns 拒绝结果。
 */
function fromZodError(error: z.ZodError): NavigationRejection {
  const issue = error.issues[0];
  const path = issue === undefined || issue.path.length === 0 ? '(根)' : issue.path.join('.');
  return {
    code: 'message-schema-invalid',
    type: 'schema-invalid',
    detail: `${path}: ${issue === undefined ? '字段校验失败' : issue.message}`,
  };
}

/**
 * 解析一条来自消息通道的载荷。
 *
 * 载荷可以是任意值：不是对象、判别字段未知、版本不符或任一必需字段不合法都返回拒绝结果。
 * 未登记的附加字段被忽略，与导航契约的 schema 语义一致。
 * @param raw - 消息通道投递的原始载荷。
 * @returns 解析结果。
 */
export function parseBridgeMessage(raw: unknown): BridgeParseResult {
  if (!isRecord(raw)) {
    return { ok: false, rejection: { code: 'message-schema-invalid', type: 'schema-invalid', detail: '消息不是对象' } };
  }
  const action = raw['action'];
  const outcome = raw['outcome'];
  if (typeof action !== 'string' && typeof outcome !== 'string') {
    return {
      ok: false,
      rejection: { code: 'message-schema-invalid', type: 'schema-invalid', detail: '消息缺少 action 或 outcome 判别字段' },
    };
  }
  const versionRejection = checkVersion(raw);
  if (versionRejection !== undefined) return { ok: false, rejection: versionRejection };

  const schema = action === 'source'
    ? sourceSchema
    : action === 'navigate'
      ? navigateSchema
      : outcome === 'ready'
        ? readySchema
        : outcome === 'selected'
          ? selectedSchema
          : outcome === 'rejected'
            ? rejectedSchema
            : undefined;
  if (schema === undefined) {
    const discriminator = typeof action === 'string' ? `action=${action}` : `outcome=${String(outcome)}`;
    return {
      ok: false,
      rejection: { code: 'message-schema-invalid', type: 'schema-invalid', detail: `未登记的消息判别值 ${discriminator}` },
    };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, rejection: fromZodError(parsed.error) };
  return { ok: true, message: parsed.data as BridgeMessage };
}

/**
 * 构造席位声明。
 * @param input - 设备、状态、能力与可选会话。
 * @returns 席位声明消息。
 */
export function sourceMessage(input: {
  readonly requestId?: string;
  readonly deviceId: string;
  readonly state: ContentState;
  readonly capabilities: readonly BridgeCapability[];
  readonly sessionId?: string;
}): SourceDeclaration {
  const message: SourceDeclaration = {
    action: 'source',
    version: NAVIGATION_VERSION,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    deviceId: input.deviceId,
    state: input.state,
    capabilities: [...input.capabilities],
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
  };
  return message;
}

/**
 * 构造就绪上报。
 * @param input - 设备、状态、能力与可选会话。
 * @returns 就绪上报消息。
 */
export function readyMessage(input: {
  readonly requestId?: string;
  readonly deviceId: string;
  readonly state: ContentState;
  readonly capabilities: readonly BridgeCapability[];
  readonly sessionId?: string;
}): ReadyReport {
  const message: ReadyReport = {
    outcome: 'ready',
    version: NAVIGATION_VERSION,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    deviceId: input.deviceId,
    state: input.state,
    capabilities: [...input.capabilities],
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
  };
  return message;
}

/**
 * 构造导航请求。
 * @param input - 请求标识、设备与会话。
 * @returns 导航请求消息。
 */
export function navigateMessage(input: {
  readonly requestId: string;
  readonly deviceId: string;
  readonly sessionId: string;
}): NavigateRequest {
  return {
    action: 'navigate',
    version: NAVIGATION_VERSION,
    requestId: input.requestId,
    deviceId: input.deviceId,
    sessionId: input.sessionId,
  };
}

/**
 * 构造选中回执。
 * @param input - 请求标识、设备、会话与标题。
 * @returns 选中回执消息。
 */
export function selectedMessage(input: {
  readonly requestId: string;
  readonly deviceId: string;
  readonly sessionId: string;
  readonly title?: string;
}): SelectedReport {
  return {
    outcome: 'selected',
    version: NAVIGATION_VERSION,
    requestId: input.requestId,
    deviceId: input.deviceId,
    sessionId: input.sessionId,
    ...(input.title === undefined ? {} : { title: input.title }),
  };
}

/**
 * 构造拒绝回执。
 * @param input - 请求标识与原因码。
 * @returns 拒绝回执消息。
 */
export function rejectedMessage(input: {
  readonly requestId: string;
  readonly code: NavigationRejectionCode;
}): RejectedReport {
  return {
    outcome: 'rejected',
    version: NAVIGATION_VERSION,
    requestId: input.requestId,
    code: input.code,
  };
}

/**
 * 取数据状态的严格程度，数值越大越严格。
 * @param state - 数据状态。
 * @returns 0 到 2。
 */
export function stateRank(state: ContentState): number {
  return CONTENT_STATES.indexOf(state);
}

/**
 * 取两个状态里较严格的一项。
 * @param left - 第一个状态。
 * @param right - 第二个状态。
 * @returns 较严格的状态。
 */
export function stricterState(left: ContentState, right: ContentState): ContentState {
  return stateRank(left) >= stateRank(right) ? left : right;
}

/** 原因码到失败分类的映射。 */
const ERROR_TYPE_BY_CODE: Readonly<Record<NavigationRejectionCode, NavigationErrorType>> = {
  'origin-rejected': 'origin-mismatch',
  'message-source-mismatch': 'source-mismatch',
  'message-schema-invalid': 'schema-invalid',
  'navigation-not-ready': 'not-ready',
  'navigation-rejected': 'open-failed',
  'navigation-timeout': 'timeout',
  'device-mismatch': 'device-mismatch',
  'session-not-found': 'open-failed',
  'device-offline': 'device-offline',
};

/**
 * 取原因码对应的失败分类，写进遥测的 `error.type`。
 * @param code - 原因码。
 * @returns 失败分类。
 */
export function errorTypeOf(code: NavigationRejectionCode): NavigationErrorType {
  return ERROR_TYPE_BY_CODE[code];
}
