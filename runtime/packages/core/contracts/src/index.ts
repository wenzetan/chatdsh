/**
 * ChatDSH 的跨组件契约包。
 *
 * 本包只包含类型与校验辅助，不注册任何服务。按领域划分：错误码、基础标量、
 * 分页、访问认证、通知、设备、设置、节点标识与遥测服务契约。
 * @module @chatdsh/core-contracts
 */

export * from './errors.ts';
export * from './primitives.ts';
export * from './pagination.ts';
export * from './access.ts';
export * from './notifications.ts';
export * from './devices.ts';
export * from './settings.ts';
export * from './node.ts';
export * from './telemetry.ts';
