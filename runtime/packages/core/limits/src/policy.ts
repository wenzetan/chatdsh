/**
 * 全链路资源额度表。
 *
 * 每项额度带单位、拒绝码与允许的处理入口。数值取自系统完成设计第九节的固定预算：请求体
 * 1 MiB、单次消息 256 KiB、单附件 25 MiB、单回合附件 100 MiB 与最多 10 个、录音 10 分钟
 * 与 25 MiB、预览 1 MiB 与工具展示 256 KiB、列表默认 50 与最多 200、每会话 20 条待处理
 * 消息、每访问会话 4 条事件流与单连接 1 MiB 缓冲、导出与备份各 1 个并发与 4 项队列、读取
 * 15 秒与写入受理 30 秒、每设备 128 个通道与 8 MiB 发送缓冲与 256 KiB 初始额度。
 *
 * 守卫在读取请求体之前读这张表，容量报告在测量之前读同一张表，两处不会各自维护数字。
 * 表本身冻结，运行期不能改写额度。
 * @module @chatdsh/core-limits/policy
 */

/** 额度单位。时间用毫秒，尺寸用字节，数量用个。 */
export type LimitUnit = 'bytes' | 'items' | 'milliseconds';

/** 资源种类。每个种类对应一个额度与一条拒绝语义。 */
export type ResourceScope =
  | 'request-body'
  | 'message'
  | 'event'
  | 'replica-batch-bytes'
  | 'replica-batch-items'
  | 'webhook-body'
  | 'device-frame'
  | 'device-frame-payload'
  | 'channel-count'
  | 'channel-credit'
  | 'link-buffer'
  | 'attachment'
  | 'turn-attachments'
  | 'attachment-count'
  | 'recording-bytes'
  | 'recording-duration'
  | 'preview'
  | 'tool-display'
  | 'list-page'
  | 'list-page-default'
  | 'pending-messages'
  | 'sse-connection'
  | 'sse-buffer'
  | 'export-concurrency'
  | 'export-queue'
  | 'backup-concurrency'
  | 'backup-queue'
  | 'read-timeout'
  | 'write-accept-timeout'
  | 'stream-idle-timeout'
  | 'cancel-timeout'
  | 'control-plane-memory'
  | 'client-memory';

/** 允许的处理入口。超限响应带上它，调用方据此改走可完成的路径。 */
export type HandlingEntry =
  | 'chunked-upload'
  | 'split-recording'
  | 'paged-preview'
  | 'full-download'
  | 'pagination'
  | 'narrower-request'
  | 'draft-preserved'
  | 'existing-connection'
  | 'resume-cursor'
  | 'queued-retry'
  | 'later-retry';

/** 资源拒绝码。同时是遥测的 `error.code` 取值。 */
export const RESOURCE_ERROR_CODES = {
  /** 尺寸超过额度。 */
  payloadTooLarge: 'payload-too-large',
  /** 请求的分页条数超过上限。 */
  pageLimitExceeded: 'page-limit-exceeded',
  /** 订阅连接数超过额度。 */
  subscriptionLimit: 'subscription-limit',
  /** 并发已满且队列也满，明确拒绝。 */
  queueFull: 'queue-full',
  /** 慢消费超过预算，终止该目标并给出续读入口。 */
  backpressureExceeded: 'backpressure-exceeded',
  /** 超过读取或写入受理期限。 */
  deadlineExceeded: 'deadline-exceeded',
  /** 预估负载超过安全资源预算，验证与承载都不开始。 */
  resourceBudgetExceeded: 'resource-budget-exceeded',
} as const;

/** 资源拒绝码类型。 */
export type ResourceErrorCode = (typeof RESOURCE_ERROR_CODES)[keyof typeof RESOURCE_ERROR_CODES];

/** 一类额度的拒绝语义。 */
export interface RejectionSpec {
  /** 拒绝码。 */
  readonly code: ResourceErrorCode;
  /** HTTP 状态码。 */
  readonly status: number;
  /** 允许的处理入口。 */
  readonly entry: HandlingEntry;
  /** 给调用方的处理说明。 */
  readonly guidance: string;
}

/** 一项额度。 */
export interface ResourceLimit {
  /** 种类。 */
  readonly scope: ResourceScope;
  /** 上限数值，配合 {@link ResourceLimit.unit} 使用。 */
  readonly value: number;
  /** 单位。 */
  readonly unit: LimitUnit;
  /** 说明文字，写明来源与作用位置。 */
  readonly description: string;
  /** 超限时的拒绝语义。 */
  readonly rejection: RejectionSpec;
}

const KiB = 1024;
const MiB = 1024 * 1024;

/** 尺寸类拒绝：响应 413，处理入口按资源种类指向可完成路径。 */
function sizeRejection(entry: HandlingEntry, guidance: string): RejectionSpec {
  return { code: RESOURCE_ERROR_CODES.payloadTooLarge, status: 413, entry, guidance };
}

/** 库存类拒绝：响应 429，处理入口说明何时可以再来。 */
function capacityRejection(code: ResourceErrorCode, status: number, entry: HandlingEntry, guidance: string): RejectionSpec {
  return { code, status, entry, guidance };
}

/** 额度表。键与 {@link ResourceScope} 一一对应。 */
const LIMITS: { readonly [S in ResourceScope]: ResourceLimit } = {
  'request-body': {
    scope: 'request-body',
    value: 1 * MiB,
    unit: 'bytes',
    description: '普通 JSON 请求体；读取前校验声明长度，流读取中再次计数',
    rejection: sizeRejection('narrower-request', '把请求拆成多次提交，或改用分页读取需要的内容'),
  },
  message: {
    scope: 'message',
    value: 256 * KiB,
    unit: 'bytes',
    description: '单次消息的 UTF-8 字节数',
    rejection: sizeRejection('draft-preserved', '保留草稿并显示单条消息上限，缩短后再发送'),
  },
  event: {
    scope: 'event',
    value: 1 * MiB,
    unit: 'bytes',
    description: '单条事件的序列化字节数',
    rejection: sizeRejection('pagination', '把大结果拆成多条事件提交，单条控制在额度以内'),
  },
  'replica-batch-bytes': {
    scope: 'replica-batch-bytes',
    value: 1 * MiB,
    unit: 'bytes',
    description: '一次副本上报批次的字节上限',
    rejection: sizeRejection('pagination', '按事件序号把上报拆成多个批次'),
  },
  'replica-batch-items': {
    scope: 'replica-batch-items',
    value: 256,
    unit: 'items',
    description: '一次副本上报批次的事件条数上限',
    rejection: sizeRejection('pagination', '按事件序号把上报拆成多个批次'),
  },
  'webhook-body': {
    scope: 'webhook-body',
    value: 1 * MiB,
    unit: 'bytes',
    description: '外部 webhook 请求体上限',
    rejection: sizeRejection('narrower-request', '在外部系统里裁掉不需要的字段后重发'),
  },
  'device-frame': {
    scope: 'device-frame',
    value: 64 * KiB,
    unit: 'bytes',
    description: '设备长连接的完整 MessagePack 消息上限',
    rejection: sizeRejection('chunked-upload', '按通道额度把内容拆成多帧'),
  },
  'device-frame-payload': {
    scope: 'device-frame-payload',
    value: 32 * KiB,
    unit: 'bytes',
    description: '设备长连接单帧 data.payload 上限',
    rejection: sizeRejection('chunked-upload', '按通道额度把内容拆成多帧'),
  },
  'channel-count': {
    scope: 'channel-count',
    value: 128,
    unit: 'items',
    description: '每台设备同时打开的通道数上限',
    rejection: capacityRejection(RESOURCE_ERROR_CODES.queueFull, 429, 'existing-connection', '先关闭空闲通道，或复用已有通道'),
  },
  'channel-credit': {
    scope: 'channel-credit',
    value: 256 * KiB,
    unit: 'bytes',
    description: '每通道初始单向发送额度',
    rejection: sizeRejection('chunked-upload', '等待消费完成后补充额度再发送'),
  },
  'link-buffer': {
    scope: 'link-buffer',
    value: 8 * MiB,
    unit: 'bytes',
    description: '每连接发送缓冲上限',
    rejection: capacityRejection(RESOURCE_ERROR_CODES.backpressureExceeded, 503, 'resume-cursor', '从最近确认的事件游标重新订阅'),
  },
  attachment: {
    scope: 'attachment',
    value: 25 * MiB,
    unit: 'bytes',
    description: '单个附件上限',
    rejection: sizeRejection('chunked-upload', '改用分块上传，或压缩后重新上传'),
  },
  'turn-attachments': {
    scope: 'turn-attachments',
    value: 100 * MiB,
    unit: 'bytes',
    description: '单个回合全部附件的字节上限',
    rejection: sizeRejection('chunked-upload', '把附件分成多个回合提交'),
  },
  'attachment-count': {
    scope: 'attachment-count',
    value: 10,
    unit: 'items',
    description: '单个回合的附件个数上限',
    rejection: sizeRejection('pagination', '把附件分成多个回合提交'),
  },
  'recording-bytes': {
    scope: 'recording-bytes',
    value: 25 * MiB,
    unit: 'bytes',
    description: '单段录音的字节上限',
    rejection: sizeRejection('split-recording', '把录音分成多段，停止后逐段确认上传'),
  },
  'recording-duration': {
    scope: 'recording-duration',
    value: 10 * 60 * 1000,
    unit: 'milliseconds',
    description: '单段录音的最长时长',
    rejection: sizeRejection('split-recording', '把录音分成多段，停止后逐段确认上传'),
  },
  preview: {
    scope: 'preview',
    value: 1 * MiB,
    unit: 'bytes',
    description: '文本预览的字节上限',
    rejection: sizeRejection('full-download', '改为完整下载，或按页读取预览'),
  },
  'tool-display': {
    scope: 'tool-display',
    value: 256 * KiB,
    unit: 'bytes',
    description: '工具结果在界面里的展示上限',
    rejection: sizeRejection('paged-preview', '按页读取工具结果，完整内容另走下载'),
  },
  'list-page': {
    scope: 'list-page',
    value: 200,
    unit: 'items',
    description: '列表分页的上限条数',
    rejection: capacityRejection(RESOURCE_ERROR_CODES.pageLimitExceeded, 400, 'pagination', '把页大小降到 200 条以内后重试'),
  },
  'list-page-default': {
    scope: 'list-page-default',
    value: 50,
    unit: 'items',
    description: '列表分页的默认条数',
    rejection: sizeRejection('pagination', '把页大小降到 200 条以内后重试'),
  },
  'pending-messages': {
    scope: 'pending-messages',
    value: 20,
    unit: 'items',
    description: '每会话在线待处理消息上限',
    rejection: capacityRejection(RESOURCE_ERROR_CODES.queueFull, 429, 'draft-preserved', '保留输入，等待队列消化后再提交'),
  },
  'sse-connection': {
    scope: 'sse-connection',
    value: 4,
    unit: 'items',
    description: '每个访问会话的事件流连接数上限',
    rejection: capacityRejection(RESOURCE_ERROR_CODES.subscriptionLimit, 429, 'existing-connection', '复用已建立的连接，先关闭不再使用的连接'),
  },
  'sse-buffer': {
    scope: 'sse-buffer',
    value: 1 * MiB,
    unit: 'bytes',
    description: '单条事件流连接的待发送缓冲上限',
    rejection: capacityRejection(RESOURCE_ERROR_CODES.backpressureExceeded, 503, 'resume-cursor', '从最近确认的事件游标重新订阅'),
  },
  'export-concurrency': {
    scope: 'export-concurrency',
    value: 1,
    unit: 'items',
    description: '每次部署同时进行的导出任务数上限',
    rejection: capacityRejection(RESOURCE_ERROR_CODES.queueFull, 429, 'queued-retry', '等待当前导出结束，或排进队列后重试'),
  },
  'export-queue': {
    scope: 'export-queue',
    value: 4,
    unit: 'items',
    description: '导出任务的排队深度上限',
    rejection: capacityRejection(RESOURCE_ERROR_CODES.queueFull, 429, 'queued-retry', '等待队列消化后重试'),
  },
  'backup-concurrency': {
    scope: 'backup-concurrency',
    value: 1,
    unit: 'items',
    description: '每次部署同时进行的备份任务数上限',
    rejection: capacityRejection(RESOURCE_ERROR_CODES.queueFull, 429, 'queued-retry', '等待当前备份结束，或排进队列后重试'),
  },
  'backup-queue': {
    scope: 'backup-queue',
    value: 4,
    unit: 'items',
    description: '备份任务的排队深度上限',
    rejection: capacityRejection(RESOURCE_ERROR_CODES.queueFull, 429, 'queued-retry', '等待队列消化后重试'),
  },
  'read-timeout': {
    scope: 'read-timeout',
    value: 15 * 1000,
    unit: 'milliseconds',
    description: '读取请求体的期限',
    rejection: capacityRejection(RESOURCE_ERROR_CODES.deadlineExceeded, 408, 'narrower-request', '缩小请求体或提高上行速率后重试'),
  },
  'write-accept-timeout': {
    scope: 'write-accept-timeout',
    value: 30 * 1000,
    unit: 'milliseconds',
    description: '写入受理的期限',
    rejection: capacityRejection(RESOURCE_ERROR_CODES.deadlineExceeded, 504, 'queued-retry', '写入受理未完成，稍后用同一操作标识查询实际结果'),
  },
  'stream-idle-timeout': {
    scope: 'stream-idle-timeout',
    value: 75 * 1000,
    unit: 'milliseconds',
    description: '事件流空闲期限',
    rejection: capacityRejection(RESOURCE_ERROR_CODES.deadlineExceeded, 408, 'resume-cursor', '重新订阅并从最近游标继续读取'),
  },
  'cancel-timeout': {
    scope: 'cancel-timeout',
    value: 2 * 1000,
    unit: 'milliseconds',
    description: '取消确认的期限',
    rejection: capacityRejection(RESOURCE_ERROR_CODES.deadlineExceeded, 504, 'resume-cursor', '取消未确认时继续查询，不宣称已经停止'),
  },
  'control-plane-memory': {
    scope: 'control-plane-memory',
    value: 512 * MiB,
    unit: 'bytes',
    description: '控制平面常驻内存上限',
    rejection: capacityRejection(RESOURCE_ERROR_CODES.resourceBudgetExceeded, 503, 'later-retry', '停止当前验证并报告实际条件，等资源回到预算内再继续'),
  },
  'client-memory': {
    scope: 'client-memory',
    value: 768 * MiB,
    unit: 'bytes',
    description: '当前活动客户端常驻内存上限',
    rejection: capacityRejection(RESOURCE_ERROR_CODES.resourceBudgetExceeded, 503, 'later-retry', '停止当前验证并报告实际条件，等资源回到预算内再继续'),
  },
};

/** 冻结后的额度表。 */
export const RESOURCE_LIMITS: Readonly<Record<ResourceScope, ResourceLimit>> = Object.freeze(LIMITS);

/** 全部资源种类。 */
export const RESOURCE_SCOPES: readonly ResourceScope[] = Object.freeze(Object.keys(RESOURCE_LIMITS) as ResourceScope[]);

/**
 * 取一项额度。
 * @param scope - 资源种类。
 * @returns 该种类的额度。
 */
export function limitOf(scope: ResourceScope): ResourceLimit {
  return RESOURCE_LIMITS[scope];
}

/**
 * 取一项额度的上限数值。
 * @param scope - 资源种类。
 * @returns 上限数值；单位见 {@link limitOf}。
 */
export function limitValueOf(scope: ResourceScope): number {
  return RESOURCE_LIMITS[scope].value;
}

/**
 * 把字节数换算成 MiB 便于阅读。
 * @param bytes - 字节数。
 * @returns MiB 数值。
 */
export function toMiB(bytes: number): number {
  return bytes / MiB;
}
