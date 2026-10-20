/**
 * 分享工具：为当前会话建立一条只读快照链接。
 *
 * 快照由控制平面渲染，运行时不参与。工具只发出建立请求并回传路径与令牌，内容边界由
 * 控制平面的 `upToSeq` 固定。
 * @module @chatdsh/tool-share
 */

import { defineTool, schema as z, type Context } from '@chatdsh/adapter';
import { buildShareRequest } from './request.ts';

export { buildShareRequest, type ShareRequest } from './request.ts';

/** 插件名。 */
export const name = 'chatdsh-tool-share';

/** 依赖：工具注册表。 */
export const inject = ['tools'];

/** 配置。 */
export interface ShareToolConfig {
  /** 控制平面地址。 */
  gatewayUrl: string;
}

/** 配置 schema。 */
export const Config: z<ShareToolConfig> = z.object({
  gatewayUrl: z.string().default('http://127.0.0.1:3170'),
});

/**
 * 注册分享工具。
 * @param ctx - 宿主上下文。
 * @param config - 配置。
 */
export function apply(ctx: Context, config: ShareToolConfig): void {
  ctx.tools.register(defineTool({
    name: 'share_session',
    description: '为当前会话建立一条只读快照链接。链接内容是建立时刻的快照，源会话之后的新内容不会出现在里面。',
    parameters: {
      upToSeq: { type: 'integer', description: '快照上界的事件序号；省略时取该会话已同步到的最新序号。' },
      ttlMs: { type: 'integer', description: '有效期，单位毫秒；省略表示不设期限。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          upToSeq: { type: 'integer', required: true },
          expiresAt: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `分享链接已建立：${value.path}（截至序号 ${value.upToSeq}，${value.expiresAt}）。` },
      ],
    },
    async execute(args, exec) {
      const agent = exec.agent;
      if (agent === undefined) throw new Error('share_session 只能在会话内调用');
      const body = buildShareRequest({
        sessionId: agent.session.id,
        upToSeq: args.upToSeq,
        ttlMs: args.ttlMs,
      });
      const response = await fetch(`${config.gatewayUrl}/chatdsh/gateway/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`控制平面拒绝了分享请求：${response.status}`);
      const payload = (await response.json()) as { path: string; upToSeq: number; expiresAt: number | null };
      return {
        path: payload.path,
        upToSeq: payload.upToSeq,
        expiresAt: payload.expiresAt === null ? '不设期限' : new Date(payload.expiresAt).toISOString(),
      };
    },
  }));
}
