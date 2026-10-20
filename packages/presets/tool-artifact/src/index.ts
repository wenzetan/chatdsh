/**
 * 制品工具：让模型把一段内容写成可版本化的制品。
 *
 * 工具只做一件事，参数与宿主平面 `chatdshArtifacts` 服务的输入一一对应；制品本身由服务
 * 负责落盘与版本管理。工具不直接读写文件系统。
 * @module @chatdsh/tool-artifact
 */

import { defineTool, type Context } from '@chatdsh/adapter';

/** 插件名。 */
export const name = 'chatdsh-tool-artifact';

/** 依赖：工具注册表与制品服务。 */
export const inject = ['tools', 'chatdshArtifacts'];

/** 制品服务的形状，只用到写入。 */
interface ArtifactsService {
  put(input: {
    id?: string;
    sessionId: string;
    title: string;
    kind?: string;
    mimeType: string;
    content: string;
    sourceEventSeq?: number;
  }): Promise<{ id: string; version: number; size: number; title: string }>;
}

/** 可选的制品种类。 */
const KINDS = ['document', 'code', 'html', 'svg', 'markdown', 'image', 'other'] as const;

/**
 * 注册制品工具。
 * @param ctx - 宿主上下文。
 */
export function apply(ctx: Context): void {
  // 契约包不依赖 cordis，服务按名读取；inject 保证它一定存在。
  const artifacts = (ctx as unknown as { chatdshArtifacts: ArtifactsService }).chatdshArtifacts;

  ctx.tools.register(defineTool({
    name: 'artifact_write',
    description: '把一段内容写成制品并返回版本号。给出 artifactId 时在已有制品上追加一个新版本，省略时新建。',
    parameters: {
      title: { type: 'string', required: true, description: '制品的展示名。' },
      kind: { type: 'string', enum: [...KINDS], description: '制品种类；省略按 other 处理。' },
      mimeType: { type: 'string', required: true, description: '内容的媒体类型，例如 text/markdown、text/html。' },
      content: { type: 'string', required: true, description: '内容本体。' },
      artifactId: { type: 'string', description: '更新已有制品时给出它的标识；省略则新建一个制品。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          version: { type: 'integer', required: true },
          size: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `制品「${value.title}」第 ${value.version} 版已保存，${value.size} 字节，标识 ${value.id}。` },
      ],
    },
    async execute(args, exec) {
      const agent = exec.agent;
      if (agent === undefined) throw new Error('artifact_write 只能在会话内调用');
      const record = await artifacts.put({
        id: args.artifactId,
        sessionId: agent.session.id,
        title: args.title,
        kind: args.kind,
        mimeType: args.mimeType,
        content: args.content,
      });
      return { id: record.id, title: record.title, version: record.version, size: record.size };
    },
  }));
}
