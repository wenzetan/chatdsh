/**
 * MCP 协议层的常量与校验。
 *
 * 协议版本与请求 schema 取上游 `@modelcontextprotocol/core` 的公开导出，不在这里另写
 * 一份。服务端只处理 JSON-RPC 请求，通知不产生响应。
 * @module @chatdsh/host-mcp-server/protocol
 */

import {
  CallToolRequestSchema,
  InitializeRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/core';

/** 服务端实现的协议版本。 */
export const PROTOCOL_VERSION = '2025-11-25';

/** 支持协商的协议版本，按偏好排序。 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

/** JSON-RPC 错误码。 */
export const JSON_RPC_ERRORS = {
  /** 请求体不是合法 JSON。 */
  parseError: -32700,
  /** 请求体不是合法的 JSON-RPC 请求。 */
  invalidRequest: -32600,
  /** 方法不存在。 */
  methodNotFound: -32601,
  /** 参数不合法，或工具不可见。 */
  invalidParams: -32602,
  /** 服务端内部失败。 */
  internalError: -32603,
} as const;

/** 一条 JSON-RPC 请求。 */
export interface Request {
  readonly jsonrpc: '2.0';
  readonly id: string | number;
  readonly method: string;
  readonly params?: unknown;
}

/** 解析结果。 */
export type ParsedRequest =
  | { readonly ok: true; readonly request: Request }
  | { readonly ok: false; readonly error: { code: number; message: string } };

/**
 * 解析一条 JSON-RPC 请求。
 * @param body - 请求体原文。
 * @returns 请求或错误。
 */
export function parseRequest(body: string): ParsedRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, error: { code: JSON_RPC_ERRORS.parseError, message: '请求体不是合法 JSON' } };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: { code: JSON_RPC_ERRORS.invalidRequest, message: '请求体必须是 JSON 对象' } };
  }
  const record = parsed as Record<string, unknown>;
  if (record.jsonrpc !== '2.0' || typeof record.method !== 'string') {
    return { ok: false, error: { code: JSON_RPC_ERRORS.invalidRequest, message: '缺少 jsonrpc 或 method' } };
  }
  if (record.id === undefined) {
    return { ok: false, error: { code: JSON_RPC_ERRORS.invalidRequest, message: '通知不产生响应，服务端不接受无 id 的请求' } };
  }
  if (typeof record.id !== 'string' && typeof record.id !== 'number') {
    return { ok: false, error: { code: JSON_RPC_ERRORS.invalidRequest, message: 'id 必须是字符串或数字' } };
  }
  return { ok: true, request: record as unknown as Request };
}

/** 用上游 schema 校验一次工具调用。 */
export function parseCallTool(request: Request): { ok: true; name: string; args: Record<string, unknown> } | { ok: false } {
  const parsed = CallToolRequestSchema.safeParse(request);
  if (!parsed.success) return { ok: false };
  return { ok: true, name: parsed.data.params.name, args: parsed.data.params.arguments ?? {} };
}

/** 校验一次工具目录列举。 */
export function isListTools(request: Request): boolean {
  return ListToolsRequestSchema.safeParse(request).success;
}

/** 校验一次初始化请求。 */
export function isInitialize(request: Request): boolean {
  return InitializeRequestSchema.safeParse(request).success;
}
