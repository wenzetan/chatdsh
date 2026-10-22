/**
 * MCP 服务端宿主插件。
 *
 * 把宿主平面的工具目录暴露为 MCP 服务端，供外部程序接入。协议入口是一条独立的 HTTP
 * 路由：它不经过 `remoteAccess.decide()`，鉴权由本插件自己的令牌校验承担；工具目录按
 * 控制平面注入的会话归属过滤后再暴露。
 *
 * 默认关闭。打开需要同时给出访问令牌的环境变量名与挂载路径；缺任一项时插件在构造阶段
 * 就地抛出，不留下半个可用的协议入口。
 * @module @chatdsh/host-mcp-server
 */

import { agentsOf, hostWebServerOf, schema as z, toolsOf, telemetryOf, type Context } from '@chatdsh/adapter';
import { createMcpServer, type McpTelemetry, type McpTool } from './server.ts';

export { createMcpServer } from './server.ts';
export type { McpCaller, McpServer, McpServerOptions, McpTelemetry, McpTool, McpToolResult } from './server.ts';
export { JSON_RPC_ERRORS, PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from './protocol.ts';

/** 插件名。 */
export const name = 'chatdsh-mcp-server';

/** 默认挂载路径。 */
export const DEFAULT_PATH = '/mcp';

/** 配置。 */
export interface McpServerConfig {
  /** 是否打开协议入口。 */
  readonly enabled: boolean;
  /** 挂载路径，必须以斜杠开头。 */
  readonly path?: string;
  /** 访问令牌所在的环境变量名；令牌本身不落配置。 */
  readonly tokenEnv?: string;
}

/** 配置 schema。 */
export const Config: z<McpServerConfig> = z.object({
  enabled: z.boolean(),
  path: z.string(),
  tokenEnv: z.string(),
});

/**
 * 注册 MCP 服务端。
 *
 * 工具目录从 `ctx.tools` 读一次快照；工具执行走同一个注册表，因此权限、审批与超时策略
 * 与模型直接调用时一致。外部程序看到的工具与当前会话可见的工具集合相同。
 */
export class ChatdshMcpServerService {
  /** 依赖：Web 服务器与工具注册表。 */
  static inject = ['webServer', 'tools'];

  constructor(ctx: Context, config: McpServerConfig) {
    if (!config.enabled) return;
    if (config.tokenEnv === undefined || config.tokenEnv === '') {
      throw new Error('打开 MCP 服务端时必须给出 tokenEnv：访问令牌的环境变量名');
    }
    const path = config.path ?? DEFAULT_PATH;
    if (!path.startsWith('/')) throw new Error(`MCP 挂载路径必须以斜杠开头：${path}`);
    const token = process.env[config.tokenEnv];
    if (token === undefined || token === '') {
      throw new Error(`环境变量 ${config.tokenEnv} 没有给出 MCP 访问令牌`);
    }
    const telemetry = telemetryOf<McpTelemetry>(ctx);
    const tools = toolsOf(ctx);
    const catalog: McpTool[] = tools.schemas().map((schema) => ({
      name: schema.name,
      description: schema.description,
      parameters: schema.parameters,
    }));
    const server = createMcpServer({
      tools: catalog,
      // 带会话标识时按该会话的 agent 解析工具目录：外部程序看到的是这个会话能用的工具，
      // 与模型自己看到的集合一致。会话不在活动列表里时退回全局目录。
      toolsFor: (caller) => {
        if (caller.sessionId === undefined) return catalog;
        const agent = agentsOf(ctx).get(caller.sessionId as never);
        if (agent === undefined) return catalog;
        return tools.schemas(agent).map((schema) => ({
          name: schema.name,
          description: schema.description,
          parameters: schema.parameters,
        }));
      },
      sessionOf: (request) => {
        const header = request.headers['x-chatdsh-session-id'];
        return typeof header === 'string' && header !== '' ? header : undefined;
      },
      authorize: (request) => {
        const header = request.headers.authorization;
        if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
        return header.slice('Bearer '.length) === token;
      },
      callTool: async (toolName, args) => {
        const result = await tools.execute({
          callId: `mcp-${Date.now()}` as never,
          name: toolName,
          arguments: args,
          signal: AbortSignal.timeout(120_000),
        });
        const content = result.content.flatMap((block) => (block.type === 'text' ? [{ type: 'text' as const, text: block.text }] : []));
        return { content, isError: result.isError };
      },
      ...(telemetry === undefined ? {} : { telemetry }),
    });
    ctx.effect(() => hostWebServerOf(ctx).register({
      kind: 'exact',
      path,
      handler: (request, response) => server.handle(request, response),
    }), 'chatdsh-mcp-server');
  }
}

/**
 * 注册插件。
 * @param ctx - 宿主上下文。
 * @param config - 开关、挂载路径与令牌环境变量名。
 */
export function apply(ctx: Context, config: McpServerConfig): void {
  ctx.plugin(ChatdshMcpServerService, config);
}
