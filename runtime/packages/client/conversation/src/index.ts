/**
 * ChatDSH 会话增强客户端：消息呈现、组合输入、在线队列、命令与触发面板、引用对象、准确
 * 停止与来源标记。
 *
 * 模块按职责拆分：
 * - `messages`：事件投影、流式装配、运行与停止、长会话分页、消息反馈与消息区组件；
 * - `composer`：输入法组合、快捷键、字数、附件条目与草稿；
 * - `queue`：待发送条目的编辑、删除、暂停、恢复与顺序消费；
 * - `commands`：命令过滤、层级返回、最近使用与类型触发；
 * - `references`：引用对象、失效标记、移除与草稿持久化规则；
 * - `a11y`：实时播报、焦点管理与整屏按键意图；
 * - `client`：跟随流订阅、席位控制器与挂载入口。
 * @module @chatdsh/client-conversation
 */

export * from './messages/index.ts';
export * from './composer/index.ts';
export * from './queue/index.ts';
export * from './commands/index.ts';
export * from './references/index.ts';
export {
  LiveAnnouncer,
  conversationKeyIntent,
  focusNeighborAfterRemove,
  isEditableTarget,
  restoreFocus,
  tabbableWithin,
  trapFocus,
  type Announcement,
  type ConversationKeyIntent,
  type KeyEventLike,
  type LiveAnnouncerOptions,
} from './a11y.ts';
export {
  CSRF_HEADER,
  RELAY_PATH,
  SCOPE,
  createConversationTelemetry,
  randomHex,
  type CommandSpanRecord,
  type ConversationFailureRecord,
  type ConversationMetric,
  type ConversationOutcome,
  type ConversationTelemetry,
  type ConversationTelemetryOptions,
  type MessageSpanRecord,
  type OtlpAttribute,
  type OtlpAttributeValue,
  type QueueActionName,
  type QueueSpanRecord,
  type ReferenceChangeRecord,
  type StreamSpanRecord,
} from './telemetry.ts';
export { CONVERSATION_CSS } from './styles.ts';
export {
  FollowStream,
  FOLLOW_STATUSES,
  type FollowStatus,
  type FollowStreamOptions,
} from './client/follow-stream.ts';
export {
  ConversationController,
  type ConversationEndpoints,
  type ConversationSeatOptions,
  type PaletteView,
  type QueueActionOutcome,
  type QueueResumeOutcome,
  type SeatKeyEvent,
  type SeatState,
  type SendOutcome,
  type StopOutcome,
  type TriggerView,
} from './client/controller.ts';
export {
  ConversationSeatView,
  createSeatRuntime,
  type MountOptions,
  type SeatRuntime,
} from './client/root.tsx';
