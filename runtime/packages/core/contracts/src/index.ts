/**
 * ChatDSH 的跨组件契约包。
 *
 * 本包只含类型与校验辅助，不注册任何服务。客户端领域契约按域分文件：写操作信封、
 * 分页、内容范围、草稿、继续会话、访问认证、通知、设备、设置、导航、节点标识、
 * 遥测服务与会话事件扩展。
 * @module @chatdsh/core-contracts
 */

export * from './errors.ts';
export * from './primitives.ts';
export * from './operations.ts';
export * from './client-state.ts';
export * from './pagination.ts';
export * from './content-scope.ts';
export * from './drafts.ts';
export * from './fork.ts';
export * from './access.ts';
export * from './notifications.ts';
export * from './devices.ts';
export * from './settings.ts';
export * from './navigation.ts';
export * from './node.ts';
export * from './telemetry.ts';
export * from './session-events.ts';
