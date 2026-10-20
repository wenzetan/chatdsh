/**
 * 分享请求的构造。
 *
 * 这一层不依赖任何 DSH 包：请求体的形状是协议约定，与插件装配无关，可以单独验证。
 * @module @chatdsh/tool-share/request
 */

/** 建立分享所需的最小请求体。 */
export interface ShareRequest {
  readonly sessionId: string;
  readonly upToSeq?: number;
  readonly ttlMs?: number;
}

/**
 * 构造请求体：省略的字段不写入，交给控制平面取默认值（上界缺省为副本水位）。
 * @param request - 工具参数。
 * @returns 请求体。
 */
export function buildShareRequest(request: ShareRequest): Record<string, unknown> {
  const body: Record<string, unknown> = { sessionId: request.sessionId };
  if (request.upToSeq !== undefined) body.upToSeq = request.upToSeq;
  if (request.ttlMs !== undefined) body.ttlMs = request.ttlMs;
  return body;
}
