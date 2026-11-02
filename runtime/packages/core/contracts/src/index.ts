/**
 * ChatDSH 的跨组件契约包。
 *
 * 本包只含类型与校验辅助，不注册任何服务。上游包只以类型方式引用：消息来源的
 * `kind` 需要声明合并，声明合并必须写上游的真实包名（见 `message-sources.ts`）。
 * 客户端领域契约按域分文件：写操作信封、分页、内容范围、草稿、继续会话、访问认证、
 * 通知、设备、记忆组、导出、设置、导航、分享、审批、提问、制品版本、自动化投递与数据管理。
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
export * from './memory-groups.ts';
export * from './exports.ts';
export * from './settings.ts';
export * from './navigation.ts';
export * from './shares.ts';
export * from './approvals.ts';
export * from './questions.ts';
export * from './artifact-versions.ts';
export * from './automation-delivery.ts';
export * from './data-management.ts';
export * from './coverage.ts';
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
