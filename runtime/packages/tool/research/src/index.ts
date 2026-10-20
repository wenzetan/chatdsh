/**
 * 检索工具：按角度展开多个子智能体并行检索，合并结论。
 *
 * 每个角度派一个子智能体，`delivery` 取 `caller`——结果回到工具，不额外通知父会话。
 * 任一子任务失败时整体失败并说明是哪个角度，避免把残缺结论当成完整结果。
 * @module @chatdsh/tool-research
 */

import { defineTool, schema as z, type Context } from '@chatdsh/adapter';
import { MAX_ANGLES, mergeFindings, planResearch, type ResearchFinding } from './plan.ts';

export { MAX_ANGLES, mergeFindings, planResearch } from './plan.ts';
export type { ResearchAngle, ResearchFinding } from './plan.ts';

/** 插件名。 */
export const name = 'chatdsh-tool-research';

/** 依赖：工具注册表与子智能体运行时。 */
export const inject = ['tools', 'subagents'];

/** 配置。 */
export interface ResearchConfig {
  /** 子智能体的提供方名。 */
  provider: string;
  /** 单个子任务的标签前缀。 */
  labelPrefix: string;
}

/** 配置 schema。 */
export const Config: z<ResearchConfig> = z.object({
  provider: z.string().default('spawn'),
  labelPrefix: z.string().default('research'),
});

/** 内容块。 */
interface ContentBlock {
  readonly type: string;
  readonly text?: string;
}

/** 启动规格。 */
interface ActivationSpec {
  readonly provider: string;
  readonly label: string;
  readonly request: {
    readonly prompt: ContentBlock[];
    readonly parent: unknown;
    readonly signal: AbortSignal;
  };
  readonly signal: AbortSignal;
  readonly delivery: 'parent' | 'caller';
}

/** 激活结果。 */
interface Activation {
  readonly result: Promise<{ readonly output: readonly ContentBlock[] }>;
  dispose(): Promise<void>;
}

/** 子智能体运行时。 */
interface SubagentRuntime {
  startActivation(spec: ActivationSpec): Promise<Activation>;
}

/**
 * 从内容块里拼出文本。
 * @param blocks - 内容块。
 * @returns 文本；没有文本块时为空串。
 */
export function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
    .trim();
}

/**
 * 注册检索工具。
 * @param ctx - 宿主上下文。
 * @param config - 配置。
 */
export function apply(ctx: Context, config: ResearchConfig): void {
  const subagents = (ctx as unknown as { subagents: SubagentRuntime }).subagents;

  ctx.tools.register(defineTool({
    name: 'research',
    description: '围绕一个问题按多个角度并行检索，汇总各角度的结论。适合需要从几个不同方向查证的问题；简单问题不必用它。',
    parameters: {
      question: { type: 'string', required: true, description: '要检索的问题。' },
      angles: {
        type: 'array',
        description: `可选的角度名，最多 ${MAX_ANGLES} 个；省略时按事实、对比、风险三个角度展开。`,
        items: { type: 'string' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          angles: { type: 'integer', required: true },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const plan = planResearch(args.question, args.angles);
      const agent = exec.agent;
      if (agent === undefined) throw new Error('research 只能在会话内调用');

      const findings = await Promise.all(plan.map(async (item): Promise<ResearchFinding> => {
        const activation = await subagents.startActivation({
          provider: config.provider,
          label: `${config.labelPrefix}:${item.angle}`,
          request: {
            prompt: [{ type: 'text', text: item.prompt }],
            parent: agent,
            signal: exec.signal,
          },
          signal: exec.signal,
          delivery: 'caller',
        });
        try {
          const result = await activation.result;
          return { angle: item.angle, text: textOf(result.output) };
        } finally {
          await activation.dispose();
        }
      }));

      return { angles: findings.length, summary: mergeFindings(findings) };
    },
  }));
}
