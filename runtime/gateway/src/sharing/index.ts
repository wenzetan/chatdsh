/**
 * 分享宿主：范围解析、内容过滤、固定快照、附件授权、生命周期与公开页路由。
 *
 * 控制平面的公共入口由发行集成挂载；`createShareHttpHandler` 提供挂载所需的路由函数。
 * @module @chatdsh/gateway/sharing
 */

export * from './types.ts';
export * from './events.ts';
export * from './filter.ts';
export * from './range.ts';
export * from './attachments.ts';
export * from './repository.ts';
export * from './service.ts';
export * from './http.ts';
