/**
 * 图像请求的构造。
 *
 * 这一层不依赖运行时：把工具参数整理成供应方的请求体，并校验尺寸与编辑输入。便于单独验证。
 * @module @chatdsh/tool-image/request
 */

/** 可用的尺寸。 */
export const SIZES = ['512x512', '1024x1024', '1024x1536', '1536x1024'] as const;

/** 一种尺寸。 */
export type ImageSize = typeof SIZES[number];

/** 工具参数。 */
export interface ImageArgs {
  readonly prompt: string;
  readonly size?: string;
  /** 编辑时的输入图像（base64）。 */
  readonly images?: readonly string[];
}

/** 请求体。 */
export interface ImageRequest {
  readonly prompt: string;
  readonly size: ImageSize;
  /** 编辑模式带上的输入图像；生成模式没有这一项。 */
  readonly images?: readonly string[];
}

/**
 * 构造供应方请求体。
 *
 * 尺寸缺省取 1024x1024；给了尺寸但不在清单里时报错，不做静默替换。带输入图像即编辑，
 * 不带即生成。
 * @param args - 工具参数。
 * @returns 请求体与是否为编辑模式。
 */
export function buildImageRequest(args: ImageArgs): { request: ImageRequest; mode: 'generate' | 'edit' } {
  const prompt = args.prompt.trim();
  if (prompt === '') throw new Error('图像提示词不能为空');
  const size = (args.size ?? '1024x1024') as ImageSize;
  if (!SIZES.includes(size)) throw new Error(`尺寸只支持 ${SIZES.join('、')}，收到 ${args.size}`);
  const images = args.images === undefined || args.images.length === 0 ? undefined : [...args.images];
  return {
    request: images === undefined ? { prompt, size } : { prompt, size, images },
    mode: images === undefined ? 'generate' : 'edit',
  };
}

/**
 * 从供应方响应里取第一张图像的字节。
 * @param payload - 供应方返回的 JSON。
 * @returns base64 图像字节；响应里没有图像时抛出。
 */
export function firstImageOf(payload: unknown): string {
  const data = (payload as { data?: { b64_json?: string }[] }).data;
  const first = data?.[0]?.b64_json;
  if (typeof first !== 'string' || first === '') throw new Error('供应方没有返回图像');
  return first;
}
