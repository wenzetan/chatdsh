/**
 * 制品的安全读取判定。
 *
 * 读取结果必须同时给出内容类型与受限预览标记：客户端据此决定用哪种查看器呈现，
 * 宿主据此声明脚本、表单提交与宿主访问一律不开放。HTML 走独立受限预览，SVG 按
 * 安全图片处理，两者都拿不到宿主桥。这一层是纯函数，不读存储、不碰文件系统。
 * @module @chatdsh/host-artifacts/safety
 */

/** 预览方式。 */
export const PREVIEW_MODES = ['text', 'html-sandbox', 'image', 'pdf', 'download-only'] as const;

/** 预览方式的取值。 */
export type PreviewMode = (typeof PREVIEW_MODES)[number];

/** 受限预览标记。三个开关恒为假：预览容器里不开放脚本、宿主桥与表单提交。 */
export interface ArtifactPreviewView {
  readonly mode: PreviewMode;
  readonly scriptAllowed: false;
  readonly hostBridgeAllowed: false;
  readonly formSubmitAllowed: false;
}

/** 默认内容类型：无法判定时按二进制下载。 */
export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/** 按扩展名后缀判定的文本类媒体类型。 */
const TEXT_SUFFIXES = ['+json', '+xml', '+yaml'];

/** 直接按媒体类型判定的文本类取值。 */
const TEXT_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/xhtml',
  'application/yaml',
  'application/x-yaml',
  'application/javascript',
  'application/typescript',
  'application/sql',
  'application/graphql',
]);

/**
 * 规范化媒体类型：去掉参数、转小写；空值按二进制处理。
 * @param mimeType - 记录里的媒体类型。
 * @returns 规范化后的媒体类型。
 */
export function normalizeMimeType(mimeType: string): string {
  const base = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  return base === '' ? DEFAULT_CONTENT_TYPE : base;
}

/**
 * 读取结果里报告的内容类型。
 * @param mimeType - 记录里的媒体类型。
 * @returns 报告给客户端的内容类型。
 */
export function contentTypeOf(mimeType: string): string {
  return normalizeMimeType(mimeType);
}

/**
 * 判定预览方式。
 *
 * HTML 与 SVG 是仅有的两种可以携带可执行内容的类型，它们分别走独立受限预览与安全
 * 图片通道；其余类型按文本、图片、PDF 与仅下载归类。
 * @param mimeType - 记录里的媒体类型。
 * @returns 预览方式。
 */
export function previewModeOf(mimeType: string): PreviewMode {
  const type = normalizeMimeType(mimeType);
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html-sandbox';
  if (type === 'image/svg+xml') return 'image';
  if (type === 'application/pdf') return 'pdf';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('text/')) return 'text';
  if (TEXT_TYPES.has(type)) return 'text';
  if (TEXT_SUFFIXES.some((suffix) => type.endsWith(suffix))) return 'text';
  return 'download-only';
}

/**
 * 造一份受限预览标记。
 *
 * 三个开关对全部类型恒为假。HTML 不允许执行脚本、提交表单或调用宿主接口；SVG 同样
 * 不获得宿主访问权，它只作为图片呈现。
 * @param mimeType - 记录里的媒体类型。
 * @returns 预览标记。
 */
export function previewOf(mimeType: string): ArtifactPreviewView {
  return {
    mode: previewModeOf(mimeType),
    scriptAllowed: false,
    hostBridgeAllowed: false,
    formSubmitAllowed: false,
  };
}
