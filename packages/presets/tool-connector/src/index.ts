/**
 * 连接器工具：让模型看到本部署已登记的外部能力。
 *
 * 工具只读：登记与启停走宿主平面的连接器服务与设置页。它回答的是「这台机器上接了哪些
 * 外部能力、它们的传输方式与凭据来源」，凭据值不在返回内容里。
 * @module @chatdsh/tool-connector
 */

import { defineTool, type Context } from '@chatdsh/adapter';
import { describeConnectors, type ConnectorSummary } from './format.ts';

export { describeConnectors, type ConnectorSummary } from './format.ts';

/** 插件名。 */
export const name = 'chatdsh-tool-connector';

/** 依赖：工具注册表与连接器服务。 */
export const inject = ['tools', 'chatdshConnectors'];

/** 连接器服务的形状，只用到读取。 */
interface ConnectorsService {
  list(): ConnectorSummary[];
}

/**
 * 注册连接器工具。
 * @param ctx - 宿主上下文。
 */
export function apply(ctx: Context): void {
  const connectors = (ctx as unknown as { chatdshConnectors: ConnectorsService }).chatdshConnectors;

  ctx.tools.register(defineTool({
    name: 'connector',
    description: '列出本部署已登记的外部连接器：名字、传输方式、目标与凭据来源的环境变量名。停用的条目会标注状态。',
    parameters: {
      includeDisabled: { type: 'boolean', description: '是否包含已停用的连接器；默认包含。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args) {
      const all = connectors.list();
      const shown = args.includeDisabled === false ? all.filter((record) => record.enabled) : all;
      return { count: shown.length, summary: describeConnectors(shown) };
    },
  }));
}
