/**
 * fork 预估：从副本事件算出复制范围、事件与字符数、缺失附件与压缩损失。
 *
 * 「在本机继续」把一个会话的历史复制成本机上的新会话。表单在提交前必须说明复制多少内容、
 * 复制方式会不会丢工具输出原文、哪些附件需要源设备。预估只使用控制平面副本里的事件，
 * 不显示内部副本水位。
 * @module @chatdsh/client-shell/estimate
 */

/** 复制方式。与会话事件契约的 `IMPORT_MODES` 一致。 */
export const IMPORT_MODES = ['full-prefix', 'compressed'] as const;

/** 复制方式取值。 */
export type ImportMode = (typeof IMPORT_MODES)[number];

/** 一条副本事件。 */
export interface ReplicaEvent {
  readonly seq: number;
  readonly kind: string;
  readonly time: number;
  readonly bytes: number;
  readonly payload?: unknown;
}

/** 内容范围：按完整回合编号表达。与内容范围契约一致。 */
export interface ContentScope {
  readonly turnFrom: number;
  readonly turnTo: number;
  readonly eventCount: number;
  readonly charCount: number;
  readonly compressed: boolean;
  readonly attachmentsComplete: boolean;
}

/** 副本可用状态与可读范围。与内容范围契约一致。 */
export interface ReplicaAvailability {
  readonly state: 'complete' | 'partial' | 'missing';
  readonly scope?: ContentScope;
  readonly readAt?: number;
}

/** fork 预估。与 fork 契约的 `forkEstimateSchema` 一致。 */
export interface ForkEstimate {
  readonly importMode: ImportMode;
  readonly scope: ContentScope;
  readonly eventCount: number;
  readonly charCount: number;
  readonly source: ReplicaAvailability;
  readonly missingAttachmentIds: readonly string[];
  readonly compressionLoss: boolean;
}

/** 预估结论。 */
export type ForkEstimateResult =
  | { readonly ok: true; readonly estimate: ForkEstimate }
  | { readonly ok: false; readonly reason: 'replica-unavailable' };

/**
 * 判断复制方式是否合法。
 * @param value - 待判定值。
 * @returns 属于登记取值时为真。
 */
export function isImportMode(value: unknown): value is ImportMode {
  return typeof value === 'string' && (IMPORT_MODES as readonly string[]).includes(value);
}

/**
 * 校验一条副本事件。
 * @param value - 事件。
 * @returns 形状合法时为真。
 */
export function isReplicaEvent(value: unknown): value is ReplicaEvent {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record['seq'] !== 'number' || !Number.isInteger(record['seq'])) return false;
  if (typeof record['kind'] !== 'string' || record['kind'] === '') return false;
  if (typeof record['time'] !== 'number' || !Number.isFinite(record['time'])) return false;
  if (typeof record['bytes'] !== 'number' || !Number.isFinite(record['bytes'])) return false;
  return true;
}

/**
 * 取事件载荷里的 `data` 对象。
 * @param payload - 事件载荷。
 * @returns `data` 对象；没有时返回 `undefined`。
 */
function dataOf(payload: unknown): Record<string, unknown> | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const data = (payload as Record<string, unknown>)['data'];
  if (typeof data !== 'object' || data === null) return undefined;
  return data as Record<string, unknown>;
}

/**
 * 判断值是否是可用的附件标识。
 * @param value - 待判定值。
 * @returns 非空且不超长时为真。
 */
function isAttachmentId(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.length <= 200;
}

/**
 * 取一条事件载荷里引用的附件标识。
 *
 * 附件引用出现在消息内容块的 `attachment.attachmentId` 与载荷的 `attachments[].attachmentId`
 * 上。两者都按结构读取，没有引用时返回空数组。
 * @param payload - 事件载荷。
 * @returns 去重后的附件标识。
 */
function attachmentIdsOf(payload: unknown): string[] {
  const data = dataOf(payload);
  if (data === undefined) return [];
  const ids = new Set<string>();
  const content = data['content'];
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part !== 'object' || part === null) continue;
      const attachment = (part as Record<string, unknown>)['attachment'];
      if (typeof attachment !== 'object' || attachment === null) continue;
      const id = (attachment as Record<string, unknown>)['attachmentId'];
      if (isAttachmentId(id)) ids.add(id);
    }
  }
  const attachments = data['attachments'];
  if (Array.isArray(attachments)) {
    for (const entry of attachments) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const id = record['attachmentId'] ?? record['id'];
      if (isAttachmentId(id)) ids.add(id);
    }
  }
  return [...ids];
}

/**
 * 取一条事件载荷里的正文。
 *
 * 消息事件的正文在 `data.text` 或 `data.content[].text` 上；工具事件的结果也在
 * `data.content[].text` 上。两者都算进复制的字符数。
 * @param payload - 事件载荷。
 * @returns 正文。
 */
export function textOfEvent(payload: unknown): string {
  const data = dataOf(payload);
  if (data === undefined) return '';
  const parts: string[] = [];
  const text = data['text'];
  if (typeof text === 'string') parts.push(text);
  const content = data['content'];
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part !== 'object' || part === null) continue;
      const value = (part as Record<string, unknown>)['text'];
      if (typeof value === 'string') parts.push(value);
    }
  }
  return parts.join('');
}

/**
 * 算 fork 预估。
 * @param events - 源会话的副本事件；空数组表示副本缺失。
 * @param options - 复制方式、源设备是否在线与读取时刻。
 * @returns 预估结论；副本缺失时明确拒绝。
 */
export function estimateFork(
  events: readonly ReplicaEvent[],
  options: { readonly importMode: ImportMode; readonly sourceOnline: boolean; readonly readAt: number }
): ForkEstimateResult {
  if (events.length === 0) return { ok: false, reason: 'replica-unavailable' };
  let turns = 0;
  let chars = 0;
  let hasToolBody = false;
  const attachmentIds = new Set<string>();
  for (const event of events) {
    if (event.kind === 'turn/start') turns += 1;
    if (event.kind === 'tool/result' || event.kind === 'tool/call') hasToolBody = true;
    chars += textOfEvent(event.payload).length;
    for (const id of attachmentIdsOf(event.payload)) attachmentIds.add(id);
  }
  const eventCount = events.length;
  const missingAttachmentIds = [...attachmentIds];
  const compressed = options.importMode === 'compressed';
  const scope: ContentScope = {
    turnFrom: 1,
    turnTo: Math.max(1, turns),
    eventCount,
    charCount: chars,
    compressed,
    attachmentsComplete: missingAttachmentIds.length === 0,
  };
  const source: ReplicaAvailability = {
    state: options.sourceOnline ? 'complete' : 'partial',
    scope,
    readAt: options.readAt,
  };
  return {
    ok: true,
    estimate: {
      importMode: options.importMode,
      scope,
      eventCount,
      charCount: chars,
      source,
      missingAttachmentIds,
      compressionLoss: compressed && hasToolBody,
    },
  };
}
