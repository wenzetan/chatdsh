/**
 * 导出内容的脱敏。
 *
 * 默认脱敏隐藏凭据形态的片段、`file://` 地址与产品内部路径（数据根与其等价写法）。工作区
 * 里的用户文件路径属于导出内容本身，默认保留；严格脱敏在默认之上再隐藏邮箱、手机号与内网
 * 地址。替换标记固定，命中次数按类别计数并写进导出说明。
 * @module @chatdsh/gateway/exports/redact
 */

/** 脱敏方式。 */
export type RedactionMode = 'default' | 'strict';

/** 路径替换标记。 */
const PATH_MARKER = '[路径已隐藏]';

/** 凭据替换标记。 */
const CREDENTIAL_MARKER = '[凭据已隐藏]';

/** 严格模式下联系方式的替换标记。 */
const CONTACT_MARKER = '[联系方式已隐藏]';

/** 严格模式下内网地址的替换标记。 */
const ADDRESS_MARKER = '[内网地址已隐藏]';

/** 脱敏选项。 */
export interface RedactionOptions {
  /** 脱敏方式。 */
  readonly mode: RedactionMode;
  /** 产品内部路径的根：命中这些前缀的路径按内部路径处理。 */
  readonly internalRoots: readonly string[];
}

/** 一次脱敏的结果。 */
export interface RedactionResult {
  readonly text: string;
  readonly paths: number;
  readonly credentials: number;
  readonly contacts: number;
  readonly addresses: number;
}

/** 逐条替换并计数。 */
function replaceEach(
  text: string,
  patterns: readonly RegExp[],
  marker: string,
  counter: { count: number },
): string {
  let out = text;
  for (const pattern of patterns) {
    out = out.replace(pattern, () => {
      counter.count += 1;
      return marker;
    });
  }
  return out;
}

/** 凭据形态。 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gu,
  /\bsk-[A-Za-z0-9_-]{16,}/gu,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/gu,
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/gu,
  /\b(?:api[-_]?key|access[-_]?key|secret|token|password|passwd|authorization|credential)\b\s*[:=]\s*["']?[^\s"'，。；）)]{6,}/giu,
];

/** 联系方式形态。 */
const CONTACT_PATTERNS: readonly RegExp[] = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gu,
  /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/gu,
];

/** 内网地址形态：私有网段、回环与常见内网域名。 */
const ADDRESS_PATTERNS: readonly RegExp[] = [
  /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|127\.0\.0\.1)\b/gu,
  /\b[a-z0-9-]+\.(?:internal|local|lan|corp)\b/gu,
];

/** 转义正则表达式里的元字符。 */
function escapePattern(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** 把内部根写成一个匹配「根及其后续路径片段」的表达式。 */
function rootPattern(root: string): RegExp {
  const trimmed = root.replace(/\/+$/u, '');
  if (trimmed === '') throw new Error('内部路径的根不能为空');
  return new RegExp(`${escapePattern(trimmed)}(?:[\\/][^\\s"'<>）)，。；]*)?`, 'gu');
}

/**
 * 生成内部路径的匹配式：数据根本身、带反斜杠的等价写法与 `~/` 形式。
 * @param internalRoots - 内部路径的根。
 * @returns 匹配式。
 */
function internalPathPatterns(internalRoots: readonly string[]): readonly RegExp[] {
  const patterns: RegExp[] = [/file:\/\/[^\s"'<>）)，。；]+/gu, /~\/\.dsh(?:[\\/][^\s"'<>）)，。；]*)?/gu];
  for (const root of internalRoots) {
    if (root.trim() === '') continue;
    patterns.push(rootPattern(root));
    if (root.includes('/')) patterns.push(rootPattern(root.replaceAll('/', '\\')));
  }
  return patterns;
}

/**
 * 脱敏一段文本。
 * @param text - 原文。
 * @param options - 脱敏方式与内部路径的根。
 * @returns 脱敏文本与逐类命中次数。
 */
export function redactText(text: string, options: RedactionOptions): RedactionResult {
  const credentials = { count: 0 };
  const paths = { count: 0 };
  const contacts = { count: 0 };
  const addresses = { count: 0 };

  let out = replaceEach(text, CREDENTIAL_PATTERNS, CREDENTIAL_MARKER, credentials);
  out = replaceEach(out, internalPathPatterns(options.internalRoots), PATH_MARKER, paths);
  if (options.mode === 'strict') {
    out = replaceEach(out, CONTACT_PATTERNS, CONTACT_MARKER, contacts);
    out = replaceEach(out, ADDRESS_PATTERNS, ADDRESS_MARKER, addresses);
  }
  return {
    text: out,
    paths: paths.count,
    credentials: credentials.count,
    contacts: contacts.count,
    addresses: addresses.count,
  };
}

/**
 * 实际生效的脱敏类别。
 * @param mode - 脱敏方式。
 * @returns 类别名。
 */
export function redactionLabels(mode: RedactionMode): readonly string[] {
  if (mode === 'strict') return ['credentials', 'internal-paths', 'contacts', 'internal-addresses'];
  return ['credentials', 'internal-paths'];
}
