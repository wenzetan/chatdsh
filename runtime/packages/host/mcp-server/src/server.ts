/**
 * MCP 服务端的 HTTP 处理。
 *
 * 一次请求走四步：鉴权、解析 JSON-RPC、按调用方可见范围解析工具、交给工具运行时执行。
 * 工具目录的过滤发生在协议层：不可见的工具在 `tools/list` 里不出现，`tools/call` 也按
 * 参数错误拒绝，不让调用方借错误码探测别的会话有什么工具。
 *
 * 服务端只接受 POST 的单个 JSON-RPC 请求。流式与通知由调用方按 MCP 规范自行处理，
 * 本实现不提供 SSE 订阅。
 * @module @chatdsh/host-mcp-server/server
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  isInitialize,
  isListTools,
  JSON_RPC_ERRORS,
  parseCallTool,
  parseRequest,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  type Request,
} from './protocol.ts';

/** 一条对外暴露的工具。 */
export interface McpTool {
  /** 工具名。 */
  readonly name: string;
  /** 工具说明。 */
  readonly description: string;
  /** 参数 JSON Schema。 */
  readonly parameters: Record<string, unknown>;
  /** 可见范围；缺省表示对所有调用方可见。 */
  readonly scope?: string;
}

/** 工具调用结果。 */
export interface McpToolResult {
  /** 结果内容块。 */
  readonly content: readonly { readonly type: 'text'; readonly text: string }[];
  /** 工具本身是否报告失败。 */
  readonly isError?: boolean;
}

/** 调用方的可见范围。 */
export interface McpCaller {
  /** 会话标识，用于审计。 */
  readonly sessionId?: string;
  /** 作用域标识，工具目录按它过滤。 */
  readonly scope?: string;
}

/** 服务端需要的遥测面。 */
export interface McpTelemetry {
  startSpan(name: string, attributes?: Record<string, unknown>): {
    setAttribute(key: string, value: unknown): void;
    recordException(error: unknown): void;
    end(): void;
  };
  event(name: string, attributes?: Record<string, unknown>): void;
  counter(name: string, options?: { description: string }): { add(delta: number, attributes?: Record<string, unknown>): void };
  histogram(name: string, options?: { unit?: string; description?: string }): { record(value: number, attributes?: Record<string, unknown>): void };
}

/** 服务端配置。 */
export interface McpServerOptions {
  /** 工具目录；没有按调用方解析时使用这一份。 */
  readonly tools: readonly McpTool[];
  /** 按调用方解析工具目录；给出时优先于 `tools`。 */
  readonly toolsFor?: (caller: McpCaller) => readonly McpTool[];
  /** 执行一次工具调用。 */
  readonly callTool: (name: string, args: Record<string, unknown>, caller: McpCaller) => Promise<McpToolResult>;
  /** 鉴权；缺省放行。 */
  readonly authorize?: (request: IncomingMessage) => boolean | Promise<boolean>;
  /** 调用方的可见范围；缺省不限制。 */
  readonly scopeOf?: (request: IncomingMessage) => string | undefined;
  /** 调用方请求的会话标识，用于解析该会话可见的工具。 */
  readonly sessionOf?: (request: IncomingMessage) => string | undefined;
  /** 遥测面。 */
  readonly telemetry?: McpTelemetry;
}

/** 服务端实例。 */
export interface McpServer {
  /** 处理一次 HTTP 请求。 */
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
}

/** 把工具声明转成 MCP 的 wire 形状。 */
function wireTool(tool: McpTool): Record<string, unknown> {
  return { name: tool.name, description: tool.description, inputSchema: tool.parameters };
}

/** 写一条 JSON 响应。 */
function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
}

/** 写一条 JSON-RPC 错误响应。 */
function sendRpcError(response: ServerResponse, id: string | number | null, code: number, message: string): void {
  sendJson(response, 200, { jsonrpc: '2.0', id, error: { code, message } });
}

/** 读取请求体。 */
async function readBody(request: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) throw new Error('payload too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 协商协议版本：客户端给的支持就用它，否则用服务端的最新版。 */
function negotiate(version: unknown): string {
  if (typeof version === 'string' && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version)) return version;
  return PROTOCOL_VERSION;
}

/**
 * 建立 MCP 服务端。
 * @param options - 工具目录、执行回调、鉴权与遥测。
 * @returns 服务端实例。
 */
export function createMcpServer(options: McpServerOptions): McpServer {
  const catalogOf = (caller: McpCaller): readonly McpTool[] => options.toolsFor?.(caller) ?? options.tools;
  const visibleTo = (caller: McpCaller): McpTool[] => {
    const catalog = catalogOf(caller);
    if (caller.scope === undefined) return catalog.filter((tool) => tool.scope === undefined);
    return catalog.filter((tool) => tool.scope === undefined || tool.scope === caller.scope);
  };

  const dispatch = async (request: Request, caller: McpCaller, response: ServerResponse): Promise<void> => {
    const { telemetry } = options;
    if (isInitialize(request)) {
      const params = request.params as { protocolVersion?: unknown } | undefined;
      const version = negotiate(params?.protocolVersion);
      const span = telemetry?.startSpan('chatdsh.mcp.session.initialize', { 'protocol.version': version });
      telemetry?.counter('chatdsh_mcp_calls_total', { description: 'MCP 调用数' }).add(1, { method: 'initialize', outcome: 'ok' });
      span?.setAttribute('outcome', 'ok');
      span?.end();
      sendJson(response, 200, {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'chatdsh', version: '0.1.0' },
        },
      });
      return;
    }

    if (isListTools(request)) {
      const started = Date.now();
      const tools = visibleTo(caller);
      const span = telemetry?.startSpan('chatdsh.mcp.tools.list', { 'tool.count': tools.length });
      telemetry?.counter('chatdsh_mcp_calls_total', { description: 'MCP 调用数' }).add(1, { method: 'tools/list', outcome: 'ok' });
      telemetry?.histogram('chatdsh_mcp_call_duration_seconds', { unit: 's', description: 'MCP 调用耗时' })
        .record((Date.now() - started) / 1000, { method: 'tools/list' });
      span?.end();
      sendJson(response, 200, { jsonrpc: '2.0', id: request.id, result: { tools: tools.map(wireTool) } });
      return;
    }

    if (request.method === 'tools/call') {
      const parsed = parseCallTool(request);
      const started = Date.now();
      if (!parsed.ok) {
        sendRpcError(response, request.id, JSON_RPC_ERRORS.invalidParams, '工具调用参数不合法');
        telemetry?.counter('chatdsh_mcp_calls_total', { description: 'MCP 调用数' }).add(1, { method: 'tools/call', outcome: 'invalid' });
        return;
      }
      const tool = visibleTo(caller).find((entry) => entry.name === parsed.name);
      if (tool === undefined) {
        // 不可见与不存在用同一个错误码，避免探测别的会话的工具。
        sendRpcError(response, request.id, JSON_RPC_ERRORS.invalidParams, `未知工具：${parsed.name}`);
        telemetry?.counter('chatdsh_mcp_calls_total', { description: 'MCP 调用数' }).add(1, { method: 'tools/call', outcome: 'unknown-tool' });
        return;
      }
      const span = telemetry?.startSpan('chatdsh.mcp.tools.call', { 'tool.name': parsed.name });
      try {
        const result = await options.callTool(parsed.name, parsed.args, caller);
        span?.setAttribute('outcome', 'ok');
        telemetry?.counter('chatdsh_mcp_calls_total', { description: 'MCP 调用数' }).add(1, { method: 'tools/call', outcome: 'ok' });
        sendJson(response, 200, {
          jsonrpc: '2.0',
          id: request.id,
          result: { content: result.content, isError: result.isError ?? false },
        });
      } catch (error) {
        span?.setAttribute('outcome', 'failed');
        span?.setAttribute('error.type', error instanceof Error ? error.name : 'Unknown');
        span?.recordException(error);
        telemetry?.counter('chatdsh_mcp_calls_total', { description: 'MCP 调用数' }).add(1, { method: 'tools/call', outcome: 'failed' });
        sendRpcError(response, request.id, JSON_RPC_ERRORS.internalError, error instanceof Error ? error.message : '工具执行失败');
      } finally {
        telemetry?.histogram('chatdsh_mcp_call_duration_seconds', { unit: 's', description: 'MCP 调用耗时' })
          .record((Date.now() - started) / 1000, { method: 'tools/call' });
        span?.end();
      }
      return;
    }

    sendRpcError(response, request.id, JSON_RPC_ERRORS.methodNotFound, `未知方法：${request.method}`);
    telemetry?.counter('chatdsh_mcp_calls_total', { description: 'MCP 调用数' }).add(1, { method: request.method, outcome: 'method-not-found' });
  };

  return {
    async handle(request, response) {
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'method-not-allowed' });
        return;
      }
      const authorized = options.authorize === undefined ? true : await options.authorize(request);
      if (!authorized) {
        options.telemetry?.event('chatdsh.mcp.auth.rejected', { 'error.code': 'auth-required' });
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
      const body = await readBody(request, 1024 * 1024);
      const parsed = parseRequest(body);
      if (!parsed.ok) {
        sendRpcError(response, null, parsed.error.code, parsed.error.message);
        return;
      }
      const scope = options.scopeOf?.(request);
      const sessionId = options.sessionOf?.(request);
      const caller: McpCaller = {
        ...(scope === undefined ? {} : { scope }),
        ...(sessionId === undefined ? {} : { sessionId }),
      };
      await dispatch(parsed.request, caller, response);
    },
  };
}
