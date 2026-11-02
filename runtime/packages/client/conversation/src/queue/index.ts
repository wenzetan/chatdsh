/**
 * 在线队列模块的出口。
 * @module @chatdsh/client-conversation/queue
 */

export {
  PendingQueue,
  QUEUE_ITEM_STATES,
  QUEUE_STATE_TEXT,
  type PendingQueueOptions,
  type QueueConsumeResult,
  type QueueItem,
  type QueueItemState,
  type QueueResumeResult,
  type QueueSnapshot,
  type QueueStatusQuery,
  type QueueStatusResult,
  type QueueSubmission,
  type QueueSubmitResult,
  type QueueSubmitter,
} from './queue.ts';
export { QueuePanel, queueSummary, type QueuePanelProps } from './view.tsx';
