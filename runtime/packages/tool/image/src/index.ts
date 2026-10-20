/**
 * 图像工具：按提示词生成图像，或基于输入图像编辑，结果存成制品。
 *
 * 供应方地址与凭据来源从配置读，凭据只按环境变量名引用。生成出的字节写进宿主平面的制品
 * 服务，模型拿到的是制品标识而不是图像本身；展示与下载走制品的读取接口。
 * @module @chatdsh/tool-image
 */

import { defineTool, schema as z, type Context } from '@chatdsh/adapter';
import { buildImageRequest, firstImageOf, SIZES } from './request.ts';

export { SIZES, buildImageRequest, firstImageOf } from './request.ts';
export type { ImageArgs, ImageRequest, ImageSize } from './request.ts';

/** 插件名。 */
export const name = 'chatdsh-tool-image';

/** 依赖：工具注册表与制品服务。 */
export const inject = ['tools', 'chatdshArtifacts'];

/** 配置。 */
export interface ImageConfig {
  /** 供应方的生成接口地址。 */
  endpoint: string;
  /** 凭据所在的环境变量名；凭据本身不落配置。 */
  apiKeyEnv?: string;
  /** 请求超时。 */
  requestTimeoutMs: number;
}

/** 配置 schema。 */
export const Config: z<ImageConfig> = z.object({
  endpoint: z.string().default('http://127.0.0.1:8890/v1/images/generations'),
  apiKeyEnv: z.string(),
  requestTimeoutMs: z.number().default(60000),
});

/** 制品服务的形状，只用到写入。 */
interface ArtifactsService {
  put(input: {
    sessionId: string;
    title: string;
    kind?: string;
    mimeType: string;
    content: string;
    encoding?: 'utf8' | 'base64';
  }): Promise<{ id: string; version: number; size: number }>;
}

/**
 * 注册图像工具。
 * @param ctx - 宿主上下文。
 * @param config - 配置。
 */
export function apply(ctx: Context, config: ImageConfig): void {
  const artifacts = (ctx as unknown as { chatdshArtifacts: ArtifactsService }).chatdshArtifacts;

  ctx.tools.register(defineTool({
    name: 'image',
    description: '按提示词生成一张图像，或基于给定的输入图像做编辑。结果存为制品并返回制品标识。',
    parameters: {
      prompt: { type: 'string', required: true, description: '要生成或编辑成什么样。' },
      size: { type: 'string', enum: [...SIZES], description: '图像尺寸，缺省 1024x1024。' },
      images: {
        type: 'array',
        description: '编辑时的输入图像（base64），给出即进入编辑模式。',
        items: { type: 'string' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          mode: { type: 'string', required: true },
          size: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `已${value.mode === 'edit' ? '编辑' : '生成'}一张 ${value.size} 图像，制品标识 ${value.id}（${value.bytes} 字节）。` },
      ],
    },
    async execute(args, exec) {
      const agent = exec.agent;
      if (agent === undefined) throw new Error('image 只能在会话内调用');
      const { request, mode } = buildImageRequest(args);

      const key = config.apiKeyEnv === undefined ? undefined : process.env[config.apiKeyEnv];
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (key !== undefined) headers.Authorization = `Bearer ${key}`;

      const response = await fetch(config.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
      if (!response.ok) throw new Error(`图像供应方返回 ${response.status}`);
      const payload = await response.json();
      const base64 = firstImageOf(payload);

      const record = await artifacts.put({
        sessionId: agent.session.id,
        title: `图像 ${new Date().toISOString()}`,
        kind: 'image',
        mimeType: 'image/png',
        content: base64,
        encoding: 'base64',
      });
      return { id: record.id, mode, size: request.size, bytes: record.size };
    },
  }));
}
