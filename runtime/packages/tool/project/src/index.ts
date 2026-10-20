/**
 * 项目工具：读取与写入工作目录对应的项目记录。
 *
 * 一个工具带 `action` 参数，避免把读写拆成两个工具占用模型的选择空间。项目说明的注入
 * 由宿主平面的项目插件负责，工具只做记录的读写。
 * @module @chatdsh/tool-project
 */

import { defineTool, type Context } from '@chatdsh/adapter';

/** 插件名。 */
export const name = 'chatdsh-tool-project';

/** 依赖：工具注册表与项目服务。 */
export const inject = ['tools', 'chatdshProjects'];

/** 项目记录。 */
interface ProjectRecord {
  readonly path: string;
  readonly title: string;
  readonly instructions: string;
  readonly defaultModel?: string;
  readonly updatedAt: number;
}

/** 项目服务的形状。 */
interface ProjectsService {
  list(): ProjectRecord[];
  get(path: string): ProjectRecord | undefined;
  set(input: { path: string; title?: string; instructions?: string; defaultModel?: string }): Promise<ProjectRecord>;
}

/** 可执行的动作。 */
const ACTIONS = ['get', 'set', 'list'] as const;

/**
 * 注册项目工具。
 * @param ctx - 宿主上下文。
 */
export function apply(ctx: Context): void {
  const projects = (ctx as unknown as { chatdshProjects: ProjectsService }).chatdshProjects;

  ctx.tools.register(defineTool({
    name: 'project',
    description: '读取或写入当前工作目录的项目记录。list 列出全部项目；get 读取一个目录的项目说明；set 写入标题、项目说明或默认模型。',
    parameters: {
      action: { type: 'string', required: true, enum: [...ACTIONS], description: 'get 读取一个目录，set 写入，list 列出全部。' },
      path: { type: 'string', description: '工作目录的绝对路径；get 与 set 需要。' },
      title: { type: 'string', description: 'set 时的展示名。' },
      instructions: { type: 'string', description: 'set 时的项目说明，会注入该项目下的会话上下文。' },
      defaultModel: { type: 'string', description: 'set 时的默认模型路由名。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          result: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.result }],
    },
    async execute(args) {
      if (args.action === 'list') {
        const all = projects.list();
        if (all.length === 0) return { action: 'list', result: '还没有任何项目记录。' };
        const lines = all.map((record) => `- ${record.path}${record.title === '' ? '' : `（${record.title}）`}`);
        return { action: 'list', result: `共 ${all.length} 个项目：\n${lines.join('\n')}` };
      }
      if (args.path === undefined) throw new Error(`${args.action} 需要 path`);
      if (args.action === 'get') {
        const record = projects.get(args.path);
        if (record === undefined) return { action: 'get', result: `${args.path} 还没有项目记录。` };
        return {
          action: 'get',
          result: [
            `路径：${record.path}`,
            `标题：${record.title === '' ? '（未设置）' : record.title}`,
            `默认模型：${record.defaultModel ?? '（未设置）'}`,
            `项目说明：${record.instructions === '' ? '（未设置）' : record.instructions}`,
          ].join('\n'),
        };
      }
      const record = await projects.set({
        path: args.path,
        title: args.title,
        instructions: args.instructions,
        defaultModel: args.defaultModel,
      });
      return { action: 'set', result: `已写入 ${record.path} 的项目记录。` };
    },
  }));
}
