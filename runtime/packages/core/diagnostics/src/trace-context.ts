/**
 * W3C Trace Context 的解析、格式化与载体读写。
 *
 * 本模块保持零 DSH 依赖，可同时用于服务端、浏览器与独立诊断工具。所有解析函数在输入
 * 不合规时返回 `undefined`，不抛异常；随机标识由 Web Crypto 生成，避免使用可预测的
 * 伪随机数。
 * @module @chatdsh/core-diagnostics/trace-context
 */

/** 一个 W3C 链路上下文。 */
export interface W3CTraceContext {
  /** 32 位小写十六进制 trace-id，不能全为零。 */
  traceId: string;
  /** 16 位小写十六进制 span-id，不能全为零。 */
  spanId: string;
  /** 两位小写十六进制 trace-flags。 */
  traceFlags: string;
  /** 可选的 tracestate 头值。 */
  traceState?: string;
}

/** 传播载体：只约定两个标准头，其他字段按原样保留。 */
export interface TraceCarrier {
  traceparent?: string;
  tracestate?: string;
}

/** 最多允许的 tracestate 字符数。 */
const TRACESTATE_LIMIT = 512;

/** 版本号格式：两位小写十六进制。 */
const VERSION_PATTERN = /^[0-9a-f]{2}$/;

/** trace-id 格式：32 位小写十六进制。 */
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;

/** span-id 格式：16 位小写十六进制。 */
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;

/** trace-flags 格式：两位小写十六进制。 */
const TRACE_FLAGS_PATTERN = /^[0-9a-f]{2}$/;

/** 简单 key：小写字母开头。 */
const SIMPLE_KEY_PATTERN = /^[a-z][a-z0-9_\-*/]*$/;

/** 多租户 key：tenant-id@system-id，两段均使用允许字符。 */
const MULTI_TENANT_KEY_PATTERN = /^[a-z0-9][a-z0-9_\-*/]*@[a-z][a-z0-9_\-*/]*$/;

/** 合法 tracestate 值字符：可见 ASCII（排除逗号与等号）以及 obs-text。 */
const TRACESTATE_VALUE_PATTERN = /^[\x20-\x2b\x2d-\x3c\x3e-\x7e\u0080-\u00ff]+$/;

/** tracestate 内不允许出现的控制字符。 */
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

/** 判断给定十六进制串是否全为零。 */
function isAllZero(value: string): boolean {
  return /^0+$/.test(value);
}

/** 从 Web Crypto 生成指定字节数的小写十六进制串。 */
function randomHex(byteLength: number): string {
  const crypto = globalThis.crypto;
  if (crypto === undefined || typeof crypto.getRandomValues !== 'function') {
    throw new Error('当前运行环境没有可用的 Web Crypto，无法生成链路标识');
  }
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 校验未来版本 traceparent 中追加的字段。 */
function isValidFutureField(value: string): boolean {
  // 未来版本字段的含义尚未定义，但分隔符之间必须是非空、无控制字符的可见 ASCII。
  return value.length > 0 && /^[\x21-\x7e]+$/.test(value);
}

/**
 * 严格解析 W3C traceparent。
 *
 * 版本 00 必须恰好为 55 个字符且不能有追加字段；更高版本允许在 flags 之后以 `-`
 * 追加字段。trace-id 与 span-id 必须是小写十六进制且不能全为零。
 * @param value - 原始 traceparent 头值。
 * @returns 解析结果；格式不合法时返回 `undefined`。
 */
export function parseTraceparent(value: string): W3CTraceContext | undefined {
  if (typeof value !== 'string') return undefined;

  const parts = value.split('-');
  if (parts.length < 4) return undefined;

  const version = parts[0];
  const traceId = parts[1];
  const spanId = parts[2];
  const traceFlags = parts[3];
  if (
    version === undefined ||
    traceId === undefined ||
    spanId === undefined ||
    traceFlags === undefined
  ) {
    return undefined;
  }

  if (!VERSION_PATTERN.test(version) || version === 'ff') return undefined;
  if (!TRACE_ID_PATTERN.test(traceId) || isAllZero(traceId)) return undefined;
  if (!SPAN_ID_PATTERN.test(spanId) || isAllZero(spanId)) return undefined;
  if (!TRACE_FLAGS_PATTERN.test(traceFlags)) return undefined;

  if (version === '00') {
    // 版本 00 的长度固定，不能携带任何扩展字段。
    if (value.length !== 55 || parts.length !== 4) return undefined;
  } else if (value.length < 55) {
    // 更高版本仍必须包含完整的四个基础字段。
    return undefined;
  } else if (parts.length > 4 && !parts.slice(4).every(isValidFutureField)) {
    return undefined;
  }

  return { traceId, spanId, traceFlags };
}

/**
 * 把链路上下文格式化为版本 00 的 traceparent，输出统一为小写。
 * @param context - 链路上下文。
 * @returns traceparent 头值。
 */
export function formatTraceparent(context: W3CTraceContext): string {
  return [
    '00',
    context.traceId.toLowerCase(),
    context.spanId.toLowerCase(),
    context.traceFlags.toLowerCase(),
  ].join('-');
}

/**
 * 生成随机 trace-id。
 * @returns 32 位小写十六进制且非全零的 trace-id。
 */
export function generateTraceId(): string {
  let traceId = randomHex(16);
  while (isAllZero(traceId)) traceId = randomHex(16);
  return traceId;
}

/**
 * 生成随机 span-id。
 * @returns 16 位小写十六进制且非全零的 span-id。
 */
export function generateSpanId(): string {
  let spanId = randomHex(8);
  while (isAllZero(spanId)) spanId = randomHex(8);
  return spanId;
}

/** 校验单个 tracestate 成员。 */
function isValidTracestateMember(member: string): boolean {
  if (member.length === 0) return false;

  const equalsIndex = member.indexOf('=');
  if (equalsIndex <= 0 || equalsIndex === member.length - 1) return false;

  const key = member.slice(0, equalsIndex);
  const memberValue = member.slice(equalsIndex + 1);
  if (key.includes('=') || memberValue.includes('=')) return false;

  if (!SIMPLE_KEY_PATTERN.test(key) && !MULTI_TENANT_KEY_PATTERN.test(key)) return false;
  if (!TRACESTATE_VALUE_PATTERN.test(memberValue)) return false;
  // 值可以包含内部空格，但按 W3C 语法不能以空格结尾。
  if (memberValue.endsWith(' ')) return false;

  return true;
}

/**
 * 解析并校验 tracestate。
 *
 * 超过 512 字符、包含控制字符或成员格式不合法时返回 `undefined`。
 * 合法的输入按原样返回，保留调用方传入的空格与大小写（key 只允许小写）。
 * @param value - 原始 tracestate 头值。
 * @returns 合法的 tracestate，或 `undefined`。
 */
export function parseTracestate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return undefined;
  if (value.length === 0 || value.length > TRACESTATE_LIMIT) return undefined;
  if (CONTROL_CHARACTER_PATTERN.test(value)) return undefined;

  for (const rawMember of value.split(',')) {
    const member = rawMember.trim();
    if (!isValidTracestateMember(member)) return undefined;
  }

  return value;
}

/**
 * 从载体中提取链路上下文。
 *
 * traceparent 不合法时整体返回 `undefined`；tracestate 不合法时只丢弃该字段，仍然返回
 * 由 traceparent 得到的上下文。
 * @param carrier - 传播载体。
 * @returns 链路上下文，或 `undefined`。
 */
export function extractTraceContext(carrier: TraceCarrier): W3CTraceContext | undefined {
  if (carrier === undefined || carrier === null) return undefined;

  const context = parseTraceparent(carrier.traceparent ?? '');
  if (context === undefined) return undefined;

  const traceState = parseTracestate(carrier.tracestate);
  if (traceState !== undefined) context.traceState = traceState;
  return context;
}

/**
 * 把链路上下文写入新的载体，不修改入参。
 *
 * 若上下文没有 tracestate，则从结果中移除旧值，避免向下游传播过期状态。
 * @param carrier - 原载体，其他自定义字段会被浅拷贝保留。
 * @param context - 要写入的链路上下文。
 * @returns 新的载体对象。
 */
export function writeTraceContext<T extends TraceCarrier>(
  carrier: T,
  context: W3CTraceContext,
): T & { traceparent: string; tracestate?: string } {
  const next = {
    ...carrier,
    traceparent: formatTraceparent(context),
  } as T & { traceparent: string; tracestate?: string };

  if (context.traceState === undefined) {
    delete next.tracestate;
  } else {
    next.tracestate = context.traceState;
  }

  return next;
}
