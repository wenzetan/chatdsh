/**
 * ChatDSH 的跨组件契约包。
 *
 * 本包只含类型与校验辅助，不注册任何服务。上游包只以类型方式引用：消息来源的
 * `kind` 需要声明合并，声明合并必须写上游的真实包名（见 `message-sources.ts`）。
 * @module @chatdsh/core-contracts
 */

export * from './errors.ts';
export * from './node.ts';
export * from './telemetry.ts';
export * from './approval.ts';
export * from './artifacts.ts';
export * from './session-events.ts';
export * from './assembly.ts';
export * from './tool-tiers.ts';
export * from './services.ts';
export * from './chat-backend.ts';
export * from './memory-backend.ts';
export * from './model-backend.ts';
export * from './automation.ts';
export * from './mcp.ts';
export * from './message-sources.ts';
