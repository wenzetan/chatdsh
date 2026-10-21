/**
 * 技能管理工具：让模型按标识启用或停用一个技能。
 *
 * 工具只改本项目的目录视图，不改变上游提供方自己的注册；参数与 `chatdshSkills.toggle`
 * 一一对应。失败时把错误原样抛出，由工具运行时记录失败结果。
 * @module @chatdsh/tool-skill-manage
 */

import { defineTool, type Context } from '@chatdsh/adapter';

/** 插件名。 */
export const name = 'chatdsh-tool-skill-manage';

/** 依赖：工具注册表与技能目录服务。 */
export const inject = ['tools', 'chatdshSkills'];

/** 技能目录服务的形状，只用到切换。 */
interface SkillsService {
  toggle(id: string, enabled: boolean): { id: string; enabled: boolean };
}

/**
 * 注册技能管理工具。
 * @param ctx - 宿主上下文。
 */
export function apply(ctx: Context): void {
  // 契约包不依赖 cordis，服务按名读取；inject 保证它一定存在。
  const skills = (ctx as unknown as { chatdshSkills: SkillsService }).chatdshSkills;

  ctx.tools.register(defineTool({
    name: 'skill_manage',
    description: '按标识启用或停用一个技能。启用后技能重新出现在技能目录里，停用后不再列出。',
    parameters: {
      id: { type: 'string', required: true, description: '技能标识，取 skills 目录里的名字。' },
      enabled: { type: 'boolean', required: true, description: 'true 表示启用，false 表示停用。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          enabled: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `技能 ${value.id} 已${value.enabled ? '启用' : '停用'}。` },
      ],
    },
    async execute(args) {
      return skills.toggle(args.id, args.enabled);
    },
  }));
}
