/**
 * 制品面板的纯逻辑：筛选、格式化、预览判定、缩放与失败说明。
 *
 * 这一层不接触网络、DOM 与 React，便于单独核对筛选口径、预览分支的判定与错误码文案。
 * 预览判定只依据宿主给出的内容类型与受限预览标记，并在客户端复核一遍三个恒为假的开关。
 * @module @chatdsh/client-artifacts/state
 */

import type {
  ArtifactDeleteScope,
  ArtifactReadResult,
  ArtifactRecord,
  ArtifactVersionList,
  ArtifactVersionView,
} from './types.ts';

/** 预览的字节上限：超过后只提供下载与大小说明。 */
export const PREVIEW_BYTE_LIMIT = 8 * 1024 * 1024;

/** 缩放档位，单位是相对原尺寸的百分比。 */
export const ZOOM_STOPS = [25, 50, 75, 100, 125, 150, 200, 300, 400] as const;

/** 复位后的缩放百分比，等于原尺寸。 */
export const DEFAULT_ZOOM_PERCENT = 100;

/** PDF 查看器需要成熟库；当前工作区没有安装它，页面与文本能力因此不可用。 */
export const PDF_VIEWER_LIBRARY = 'pdfjs-dist';

/** 宿主报告过的预览方式取值。 */
export const PREVIEW_MODES = ['text', 'html-sandbox', 'image', 'pdf', 'download-only'] as const;

/** 客户端自己的失败码。 */
export const CLIENT_ERROR_CODES = {
  /** 控制平面不可达。 */
  offline: 'client/offline',
  /** 当前部署没有提供制品命名空间。 */
  unavailable: 'client/unavailable',
  /** 返回形状不符合约定。 */
  internal: 'gateway/internal',
} as const;

/** 预览分支的失败码。 */
export const PREVIEW_ERROR_CODES = {
  /** 内容字节无法解码。 */
  corrupt: 'artifact/corrupt',
  /** 二进制内容不提供预览。 */
  binary: 'artifact/binary',
  /** 超出预览上限。 */
  tooLarge: 'artifact/preview-too-large',
  /** PDF 查看器依赖缺失。 */
  pdfUnavailable: 'artifact/pdf-viewer-unavailable',
  /** 宿主返回的预览标记没有关闭脚本、宿主访问或表单提交。 */
  unsafePreview: 'artifact/unsafe-preview',
} as const;

/** 一次面向用户的失败，带稳定错误码。 */
export class ArtifactClientError extends Error {
  /**
   * @param code - 稳定错误码，显示在提示里并按码聚合上报。
   * @param message - 面向用户的说明。
   */
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ArtifactClientError';
  }
}

/**
 * 失败码对应的说明。
 *
 * 宿主抛出的错误码与客户端自己产生的错误码都在这里给出面向用户的说法，界面因此在
 * 任何分支都说得出"发生了什么"与下一步可以做什么。
 */
const FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  'object-not-found': '源设备离线或制品内容已被移除，这个版本读取失败。',
  'artifact-version-unknown': '版本记录里没有这个版本，可能已经被删除。',
  'artifact-version-immutable': '历史版本不可改写，宿主拒绝了这次写入。',
  'request-invalid': '请求字段不完整，宿主拒绝了这次操作。',
  'client/offline': '控制平面不可达，请恢复连接后重新加载。',
  'client/unavailable': '当前部署没有提供制品接口。',
  'gateway/internal': '宿主返回的形状不符合约定。',
  'artifact/corrupt': '内容不是完整的字节，无法解码。',
  'artifact/binary': '这是二进制内容，浏览器不提供预览。',
  'artifact/preview-too-large': '内容超出预览上限。',
  'artifact/pdf-viewer-unavailable': 'PDF 查看器依赖缺失。',
  'artifact/unsafe-preview': '宿主返回的预览标记允许脚本或宿主访问，已拒绝渲染。',
};

/** 取一个失败对象的错误码。 */
function codeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const record = error as { readonly code?: unknown };
    if (typeof record.code === 'string' && record.code !== '') return record.code;
  }
  return '';
}

/** 取一个失败对象的消息。 */
function messageOf(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message;
  if (typeof error === 'string' && error !== '') return error;
  return '操作失败';
}

/**
 * 把失败翻成一句带错误码的说明。
 * @param error - 失败对象。
 * @returns 面向用户的说明，末尾带错误码。
 */
export function describeFailure(error: unknown): string {
  const code = codeOf(error);
  const known = FAILURE_MESSAGES[code];
  const text = known ?? messageOf(error);
  return code === '' ? text : `${text}（${code}）`;
}

/** 一次筛选的三个口径。 */
export interface ArtifactFilter {
  /** 按名称与媒体类型做大小写不敏感的匹配。 */
  readonly query: string;
  /** 会话标识；空串表示全部会话。 */
  readonly sessionId: string;
  /** 媒体类型；空串表示全部类型。 */
  readonly mimeType: string;
}

/** 默认筛选：不限制任何口径。 */
export const EMPTY_FILTER: ArtifactFilter = { query: '', sessionId: '', mimeType: '' };

/**
 * 按会话、类型与名称过滤。
 * @param records - 全部记录。
 * @param filter - 三个口径。
 * @returns 符合全部口径的记录。
 */
export function filterArtifacts(records: readonly ArtifactRecord[], filter: ArtifactFilter): ArtifactRecord[] {
  const needle = filter.query.trim().toLocaleLowerCase();
  return records.filter((record) => {
    if (filter.sessionId !== '' && record.sessionId !== filter.sessionId) return false;
    if (filter.mimeType !== '' && record.mimeType !== filter.mimeType) return false;
    if (needle === '') return true;
    return record.title.toLocaleLowerCase().includes(needle)
      || record.mimeType.toLocaleLowerCase().includes(needle);
  });
}

/** 最新写入的排在前面；时间相同时按名称与标识，保证顺序确定。 */
export function sortArtifacts(records: readonly ArtifactRecord[]): ArtifactRecord[] {
  const sorted = [...records];
  sorted.sort((left, right) => {
    if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt;
    const byTitle = left.title.localeCompare(right.title);
    return byTitle !== 0 ? byTitle : left.id.localeCompare(right.id);
  });
  return sorted;
}

/** 一张过滤器下拉选项。 */
export interface FilterOption {
  readonly value: string;
  readonly label: string;
}

/** 会话下拉的选项，按出现次数从多到少排列。 */
export function sessionOptionsOf(records: readonly ArtifactRecord[]): FilterOption[] {
  const counts = new Map<string, number>();
  for (const record of records) counts.set(record.sessionId, (counts.get(record.sessionId) ?? 0) + 1);
  return [...counts.entries()]
    .map(([sessionId, count]) => ({ value: sessionId, label: `${shortSessionOf(sessionId)}（${String(count)} 个）` }))
    .sort((left, right) => left.value.localeCompare(right.value));
}

/** 类型下拉的选项，取记录里出现过的媒体类型。 */
export function typeOptionsOf(records: readonly ArtifactRecord[]): FilterOption[] {
  const counts = new Map<string, number>();
  for (const record of records) counts.set(record.mimeType, (counts.get(record.mimeType) ?? 0) + 1);
  return [...counts.entries()]
    .map(([mimeType, count]) => ({ value: mimeType, label: `${mimeType}（${String(count)} 个）` }))
    .sort((left, right) => left.value.localeCompare(right.value));
}

/** 会话标识在界面上的短写法：保留前八位。 */
export function shortSessionOf(sessionId: string): string {
  return sessionId.length <= 8 ? sessionId : `${sessionId.slice(0, 8)}…`;
}

/** 字节数的可读写法。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) throw new ArtifactClientError(CLIENT_ERROR_CODES.internal, '字节数必须是非负的有限数值');
  if (bytes < 1024) return `${String(bytes)} 字节`;
  const units = ['KB', 'MB', 'GB', 'TB'] as const;
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const text = value >= 100 ? String(Math.round(value)) : value.toFixed(1);
  return `${text} ${units[index]}`;
}

/** 时间戳的显示写法：`YYYY-MM-DD HH:mm`。 */
export function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 一个版本的一行说明。 */
export function versionNoteOf(version: ArtifactVersionView): string {
  const turn = version.sourceTurn === undefined ? '' : ` · 回合 ${String(version.sourceTurn)}`;
  return `第 ${String(version.version)} 版 · ${formatBytes(version.size)} · ${formatTimestamp(version.createdAt)} · 来源会话 ${shortSessionOf(version.sourceSessionId)}${turn}`;
}

/** 版本列表的摘要。 */
export function versionSummaryOf(list: ArtifactVersionList): string {
  return `共 ${String(list.versions.length)} 个版本，当前第 ${String(list.currentVersion)} 版`;
}

/** 某个版本是否是当前版本。 */
export function isCurrentVersion(list: ArtifactVersionList, version: number): boolean {
  return version === list.currentVersion;
}

/** 删除范围的摘要：版本数与占用空间。 */
export function deleteScopeNoteOf(scope: ArtifactDeleteScope): string {
  return `共 ${String(scope.affectedVersions.length)} 个版本，占用 ${formatBytes(scope.totalBytes)}`;
}

/** 预览判定的结果。 */
export type PreviewPlan =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'html'; readonly html: string }
  | { readonly kind: 'svg'; readonly dataUrl: string }
  | { readonly kind: 'image'; readonly dataUrl: string; readonly contentType: string }
  | { readonly kind: 'notice'; readonly code: string; readonly title: string; readonly message: string };

/** 造一条不可预览的说明。 */
function notice(code: string, title: string, message: string): PreviewPlan {
  return { kind: 'notice', code, title, message };
}

/**
 * base64 的形状核对。
 *
 * 逐字符核对字符集与长度补齐，避免把损坏的字节当成内容渲染。
 * @param base64 - 待核对的内容。
 * @returns 是否可以直接解码。
 */
function base64Verdict(base64: string): 'ok' | 'corrupt' {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(base64)) return 'corrupt';
  if (base64.length % 4 !== 0) return 'corrupt';
  return 'ok';
}

/**
 * 把 base64 内容解码成字节。
 * @param base64 - 内容。
 * @param what - 出现在失败说明里的对象名称。
 * @returns 解码后的字节。
 * @throws ArtifactClientError 内容不是完整的 base64 时抛出。
 */
export function decodeBase64(base64: string, what = '内容'): Uint8Array<ArrayBuffer> {
  if (base64Verdict(base64) === 'corrupt') {
    throw new ArtifactClientError(PREVIEW_ERROR_CODES.corrupt, `${what}不是完整的 base64，无法解码`);
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** 内容里是否含控制字节；含 0 字节的内容按二进制处理。 */
function hasControlBytes(bytes: Uint8Array): boolean {
  return bytes.includes(0);
}

/**
 * 造一个 data URL。图片内容只以这种方式交给 `<img>`，脚本在图片上下文里不会执行。
 * @param contentType - 内容类型。
 * @param base64 - 内容。
 * @returns data URL。
 */
export function dataUrlOf(contentType: string, base64: string): string {
  return `data:${contentType};base64,${base64}`;
}

/**
 * 按读取结果决定用哪个查看器。
 *
 * 判定顺序：损坏的字节、超出上限、PDF 查看器缺失、二进制、受限 HTML、SVG、其余图片、
 * 文本。每一种不可预览的结果都带一个错误码与下一步说明。
 * @param read - 一次读取的结果。
 * @param limit - 预览的字节上限。
 * @returns 预览判定。
 */
export function previewPlanOf(read: ArtifactReadResult, limit = PREVIEW_BYTE_LIMIT): PreviewPlan {
  const { preview, contentType, version } = read;
  if (base64Verdict(read.base64) === 'corrupt') {
    return notice(
      PREVIEW_ERROR_CODES.corrupt,
      '内容无法解码',
      `读取结果不是完整的 base64 字节，${formatBytes(version.size)} 的内容无法呈现。可以重新读取，或下载后核对本地文件。`,
    );
  }
  if (version.size > limit) {
    return notice(
      PREVIEW_ERROR_CODES.tooLarge,
      '超出预览上限',
      `内容 ${formatBytes(version.size)} 超过预览上限 ${formatBytes(limit)}，浏览器只提供下载与外部打开。`,
    );
  }
  if (preview.mode === 'pdf') {
    return notice(
      PREVIEW_ERROR_CODES.pdfUnavailable,
      'PDF 查看器依赖缺失',
      `PDF 预览需要成熟查看器（${PDF_VIEWER_LIBRARY}），当前工作区没有安装这个库：页码、缩略图、文本选择与中文搜索都不可用，也无法判定文件是否加密。可以下载后用外部查看器打开。`,
    );
  }
  if (preview.mode === 'download-only') {
    return notice(
      PREVIEW_ERROR_CODES.binary,
      '二进制内容不提供预览',
      `${contentType} 属于二进制内容，大小 ${formatBytes(version.size)}，浏览器只提供下载。`,
    );
  }
  const bytes = decodeBase64(read.base64);
  if (preview.mode === 'html-sandbox') {
    return { kind: 'html', html: new TextDecoder('utf-8').decode(bytes) };
  }
  if (preview.mode === 'image') {
    if (contentType === 'image/svg+xml') return { kind: 'svg', dataUrl: dataUrlOf(contentType, read.base64) };
    return { kind: 'image', dataUrl: dataUrlOf(contentType, read.base64), contentType };
  }
  if (hasControlBytes(bytes)) {
    return notice(
      PREVIEW_ERROR_CODES.binary,
      '内容按二进制处理',
      `读取结果里含控制字节，按 ${contentType} 记录的内容实际是二进制内容，大小 ${formatBytes(version.size)}，浏览器只提供下载。`,
    );
  }
  return { kind: 'text', text: new TextDecoder('utf-8').decode(bytes) };
}

/** 缩放百分比的合法范围是档位的两端。 */
export function clampZoomPercent(percent: number): number {
  const lowest = ZOOM_STOPS[0];
  const highest = ZOOM_STOPS[ZOOM_STOPS.length - 1];
  if (lowest === undefined || highest === undefined) throw new ArtifactClientError(CLIENT_ERROR_CODES.internal, '缩放档位表为空');
  return Math.max(lowest, Math.min(highest, Math.round(percent)));
}

/**
 * 按方向取下一个缩放档位。
 * @param percent - 当前百分比。
 * @param direction - 放大或缩小。
 * @returns 相邻档位；已经到端点时保持当前值。
 */
export function zoomStepOf(percent: number, direction: 'in' | 'out'): number {
  const current = clampZoomPercent(percent);
  if (direction === 'in') {
    const next = ZOOM_STOPS.find((stop) => stop > current);
    return next ?? current;
  }
  const previous = [...ZOOM_STOPS].reverse().find((stop) => stop < current);
  return previous ?? current;
}

/**
 * 适应宽度对应的百分比。
 * @param containerWidth - 查看区域的宽度。
 * @param naturalWidth - 图片的原宽度。
 * @returns 百分比；尺寸不可用时返回未定义。
 */
export function fitPercentOf(containerWidth: number, naturalWidth: number): number | undefined {
  if (!Number.isFinite(containerWidth) || !Number.isFinite(naturalWidth)) return undefined;
  if (containerWidth <= 0 || naturalWidth <= 0) return undefined;
  return clampZoomPercent((containerWidth / naturalWidth) * 100);
}

/**
 * 把按键翻成缩放动作。
 * @param key - 键盘事件的 `key`。
 * @returns 动作；未定义表示这个按键不负责缩放。
 */
export function keyboardZoomOf(key: string): 'in' | 'out' | 'reset' | undefined {
  if (key === '+' || key === '=') return 'in';
  if (key === '-' || key === '_') return 'out';
  if (key === 'Home') return 'reset';
  return undefined;
}
